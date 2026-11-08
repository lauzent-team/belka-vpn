'use strict';

/**
 * SleePhy relay server.
 *
 * A deliberately blind relay: it stores and forwards ciphertext. It never sees
 * plaintext, private keys, or password-derived decryption keys. What it does
 * know: usernames, profile fields, public keys, and message metadata
 * (who, to whom, when, how large).
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.SLEEPHY_PORT ? Number(process.env.SLEEPHY_PORT) : 8787;
const DB_PATH = process.env.SLEEPHY_DB || path.join(__dirname, 'sleephy.db');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/* ----------------------------- storage ----------------------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    salt         TEXT NOT NULL,
    verifier     TEXT NOT NULL,
    public_key   TEXT NOT NULL,
    display_name TEXT,
    bio          TEXT,
    avatar_color TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    box        TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 0,
    reply_to   INTEGER,
    edited_at  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender, recipient, id);
  CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient, delivered);
  CREATE TABLE IF NOT EXISTS chats (
    owner      TEXT NOT NULL,
    peer       TEXT NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0,
    muted      INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    last_read  INTEGER NOT NULL DEFAULT 0,
    cleared_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, peer)
  );
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    username   TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    PRIMARY KEY (message_id, username)
  );
`);

// Columns added after the first release. Existing databases are upgraded in
// place; a fresh database already has them and the statement is skipped.
for (const sql of [
  'ALTER TABLE users ADD COLUMN display_name TEXT',
  'ALTER TABLE users ADD COLUMN bio TEXT',
  'ALTER TABLE users ADD COLUMN avatar_color TEXT',
  'ALTER TABLE users ADD COLUMN updated_at INTEGER',
  'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
  'ALTER TABLE messages ADD COLUMN edited_at INTEGER',
  'ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0'
]) {
  try { db.exec(sql); } catch { /* column already present */ }
}

const q = {
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(
    `INSERT INTO users (username, salt, verifier, public_key, display_name, bio, avatar_color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  setProfile: db.prepare(
    'UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, updated_at = ? WHERE username = ?'
  ),
  searchUsers: db.prepare(
    `SELECT username, display_name, bio, avatar_color FROM users
      WHERE username LIKE ? OR display_name LIKE ? ORDER BY username ASC LIMIT 20`
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (sender, recipient, box, nonce, ts, delivered, reply_to)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markDelivered: db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?'),
  editMessage: db.prepare('UPDATE messages SET box = ?, nonce = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare("UPDATE messages SET deleted = 1, box = '', nonce = '' WHERE id = ?"),
  undeliveredFor: db.prepare(
    'SELECT * FROM messages WHERE recipient = ? AND delivered = 0 AND deleted = 0 ORDER BY id ASC LIMIT 500'
  ),
  history: db.prepare(
    `SELECT * FROM messages
      WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
        AND id > ?
      ORDER BY id DESC LIMIT ?`
  ),
  clearChat: db.prepare(
    `DELETE FROM messages
      WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)`
  ),
  getChat: db.prepare('SELECT * FROM chats WHERE owner = ? AND peer = ?'),
  setChatFlags: db.prepare(
    `INSERT INTO chats (owner, peer, pinned, muted, archived, last_read, cleared_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(owner, peer) DO UPDATE SET
       pinned = excluded.pinned, muted = excluded.muted, archived = excluded.archived`
  ),
  setLastRead: db.prepare(
    `INSERT INTO chats (owner, peer, pinned, muted, archived, last_read, cleared_at)
     VALUES (?, ?, 0, 0, 0, ?, 0)
     ON CONFLICT(owner, peer) DO UPDATE SET last_read = excluded.last_read`
  ),
  setClearedAt: db.prepare('UPDATE chats SET cleared_at = ? WHERE owner = ? AND peer = ?'),
  deleteChat: db.prepare('DELETE FROM chats WHERE owner = ? AND peer = ?'),
  listChats: db.prepare('SELECT * FROM chats WHERE owner = ?'),
  // Every peer this user has a conversation with, either from messages or from
  // an explicit chat-settings row. Saved Messages (peer = self) is included.
  allPeers: db.prepare(
    `SELECT DISTINCT peer FROM (
       SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS peer
         FROM messages WHERE sender = ? OR recipient = ?
       UNION
       SELECT peer FROM chats WHERE owner = ?
     )`
  ),
  peersOf: db.prepare('SELECT peer FROM chats WHERE owner = ?'),
  // Unread = incoming messages newer than the last time the owner opened the chat.
  unreadCount: db.prepare(
    `SELECT COUNT(*) AS c FROM messages
      WHERE sender = ? AND recipient = ? AND deleted = 0 AND ts > ?`
  ),
  lastMessage: db.prepare(
    `SELECT * FROM messages
      WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
      ORDER BY id DESC LIMIT 1`
  ),
  setReaction: db.prepare(
    `INSERT INTO reactions (message_id, username, emoji, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, username) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`
  ),
  clearReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND username = ?'),
  reactionsFor: db.prepare('SELECT username, emoji FROM reactions WHERE message_id = ?')
};

/* Statements used only by the username rename, which rewrites every reference. */
const renameStmts = {
  user: db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE username = ?'),
  sent: db.prepare('UPDATE messages SET sender = ? WHERE sender = ?'),
  received: db.prepare('UPDATE messages SET recipient = ? WHERE recipient = ?'),
  chatsOwner: db.prepare('UPDATE chats SET owner = ? WHERE owner = ?'),
  chatsPeer: db.prepare('UPDATE chats SET peer = ? WHERE peer = ?'),
  reactions: db.prepare('UPDATE reactions SET username = ? WHERE username = ?')
};

/* --------------------------- password KDF --------------------------- */
// Server-side scrypt. The client derives its *key-encryption* key separately,
// so this verifier never doubles as an encryption key.
function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------ tokens ------------------------------ */
const tokens = new Map(); // token -> { username, exp }

function issueToken(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  tokens.set(token, { username, exp: Date.now() + TOKEN_TTL_MS });
  return token;
}

function resolveToken(token) {
  const rec = tokens.get(token);
  if (!rec) return null;
  if (rec.exp < Date.now()) { tokens.delete(token); return null; }
  return rec.username;
}

/* ------------------------------ helpers ------------------------------ */
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const VALID_B64 = /^[A-Za-z0-9+/=_-]+$/;
const AVATAR_COLORS = new Set(['mint', 'sky', 'violet', 'amber', 'rose', 'lime', 'cyan', 'coral']);

function bad(ws, rid, message) {
  reply(ws, rid, { t: 'error', message });
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/** Reply to a request, echoing its id so the client can match the response. */
function reply(ws, reqId, obj) {
  send(ws, reqId === undefined ? obj : { ...obj, _id: reqId });
}

function validB64(s, maxLen) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && VALID_B64.test(s);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function publicProfile(user) {
  return {
    username: user.username,
    displayName: user.display_name || user.username,
    bio: user.bio || '',
    avatarColor: user.avatar_color || 'mint'
  };
}

/* ----------------------------- connections ----------------------------- */
/** username -> Set<ws> (a user may be connected from several devices) */
const sockets = new Map();

function bindSocket(username, ws) {
  if (!sockets.has(username)) sockets.set(username, new Set());
  sockets.get(username).add(ws);
}

function unbindSocket(ws) {
  if (!ws.username) return;
  const set = sockets.get(ws.username);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(ws.username);
    announcePresence(ws.username, false);
  }
}

function isOnline(username) {
  return sockets.has(username);
}

function deliverToUser(username, payload) {
  const set = sockets.get(username);
  if (!set) return false;
  let delivered = false;
  for (const ws of set) { send(ws, payload); delivered = true; }
  return delivered;
}

/** Everyone who shares a conversation with this user, in either direction. */
function audienceOf(username) {
  const audience = new Set();
  for (const row of q.allPeers.all(username, username, username, username)) {
    if (row.peer !== username) audience.add(row.peer);
  }
  return audience;
}

function announcePresence(username, online) {
  for (const who of audienceOf(username)) {
    deliverToUser(who, { t: 'presence', username, online });
  }
}

function broadcastProfile(username, profile) {
  for (const who of audienceOf(username)) {
    deliverToUser(who, { t: 'profile', username, profile });
  }
}

function flushUndelivered(username) {
  for (const row of q.undeliveredFor.all(username)) {
    const delivered = deliverToUser(username, {
      t: 'message', id: row.id, from: row.sender, box: row.box, nonce: row.nonce,
      ts: row.ts, replyTo: row.reply_to
    });
    if (delivered) q.markDelivered.run(row.id);
  }
}

function reactionsOf(messageId) {
  return q.reactionsFor.all(messageId).map((r) => ({ username: r.username, emoji: r.emoji }));
}

/* ------------------------------- handlers ------------------------------- */
function handleRegister(ws, msg, rid) {
  const { username, password, publicKey, salt, verifier } = msg;
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return bad(ws, rid, 'Username must be 3-32 chars: a-z, 0-9, _');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 512) {
    return bad(ws, rid, 'Password must be at least 8 characters');
  }
  if (!validB64(publicKey, 200)) return bad(ws, rid, 'Invalid public key');
  if (q.getUser.get(username)) return bad(ws, rid, 'Username already taken');

  // The client sends its own salt + verifier so the same password can also
  // protect the local private key without the server ever seeing the password.
  const useSalt = typeof salt === 'string' && validB64(salt, 64)
    ? salt
    : crypto.randomBytes(16).toString('base64');
  const useVerifier = typeof verifier === 'string' && validB64(verifier, 128)
    ? verifier
    : scrypt(password, useSalt);

  const now = Date.now();
  q.insertUser.run(username, useSalt, useVerifier, publicKey, null, null, null, now, now);

  const token = issueToken(username);
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'register', username, token, publicKey,
    profile: publicProfile(q.getUser.get(username))
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleLogin(ws, msg, rid) {
  const { username, password } = msg;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return bad(ws, rid, 'Username and password required');
  }
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Wrong username or password');
  if (!timingSafeEqual(scrypt(password, user.salt), user.verifier)) {
    return bad(ws, rid, 'Wrong username or password');
  }

  const token = issueToken(username);
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'login', username, token, publicKey: user.public_key,
    profile: publicProfile(user)
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleResume(ws, msg, rid) {
  const username = resolveToken(msg.token);
  if (!username) return bad(ws, rid, 'Session expired');
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Unknown account');
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'resume', username, token: msg.token, publicKey: user.public_key,
    profile: publicProfile(user)
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleDirectory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(msg.username);
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, {
    t: 'key', username: user.username, publicKey: user.public_key,
    profile: publicProfile(user), online: isOnline(user.username)
  });
}

function handleProfileGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(msg.username || ws.username);
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, {
    t: 'profile', profile: publicProfile(user), online: isOnline(user.username),
    isSelf: user.username === ws.username
  });
}

function handleProfileSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(ws.username);
  if (!user) return bad(ws, rid, 'Unknown account');

  const displayName = msg.displayName === undefined ? user.display_name : cleanText(msg.displayName, 64);
  const bio = msg.bio === undefined ? user.bio : cleanText(msg.bio, 200);
  let avatarColor = user.avatar_color;
  if (msg.avatarColor !== undefined) {
    avatarColor = AVATAR_COLORS.has(msg.avatarColor) ? msg.avatarColor : null;
  }

  q.setProfile.run(displayName, bio, avatarColor, Date.now(), ws.username);
  const updated = publicProfile(q.getUser.get(ws.username));
  reply(ws, rid, { t: 'profile.saved', profile: updated });
  broadcastProfile(ws.username, updated);
}

function handleUsernameSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const next = msg.username;
  if (typeof next !== 'string' || !USERNAME_RE.test(next)) {
    return bad(ws, rid, 'Username must be 3-32 chars: a-z, 0-9, _');
  }
  if (next === ws.username) return bad(ws, rid, 'That is already your username');
  if (q.getUser.get(next)) return bad(ws, rid, 'Username already taken');

  const prev = ws.username;
  const now = Date.now();
  try {
    db.exec('BEGIN');
    renameStmts.user.run(next, now, prev);
    renameStmts.sent.run(next, prev);
    renameStmts.received.run(next, prev);
    renameStmts.chatsOwner.run(next, prev);
    renameStmts.chatsPeer.run(next, prev);
    renameStmts.reactions.run(next, prev);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    return bad(ws, rid, 'Could not change username');
  }

  // Rebind live sockets and issued tokens to the new name.
  const set = sockets.get(prev);
  if (set) { sockets.delete(prev); sockets.set(next, set); }
  for (const rec of tokens.values()) {
    if (rec.username === prev) rec.username = next;
  }
  for (const client of set || []) client.username = next;

  reply(ws, rid, {
    t: 'username.changed', username: next, profile: publicProfile(q.getUser.get(next))
  });
}

function handleUserSearch(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const query = typeof msg.query === 'string' ? msg.query.trim().toLowerCase() : '';
  if (query.length < 1) return reply(ws, rid, { t: 'users', items: [] });
  const like = `%${query}%`;
  const rows = q.searchUsers.all(like, like);
  const items = rows.map((r) => ({ ...publicProfile(r), online: isOnline(r.username) }));
  reply(ws, rid, { t: 'users', items });
}

function handleSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const { to, box, nonce } = msg;
  // Sending to yourself is allowed: that is how Saved Messages works.
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such recipient');
  if (!validB64(box, 100000) || !validB64(nonce, 100)) return bad(ws, rid, 'Malformed payload');

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const info = q.insertMessage.run(ws.username, to, box, nonce, ts, replyTo);
  const id = Number(info.lastInsertRowid);

  reply(ws, rid, { t: 'sent', id, ts, to, replyTo });
  const delivered = deliverToUser(to, {
    t: 'message', id, from: ws.username, box, nonce, ts, replyTo
  });
  if (delivered) q.markDelivered.run(id);
}

function handleHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const other = msg.with;
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  if (typeof other !== 'string') return bad(ws, rid, 'Bad request');

  const chat = q.getChat.get(ws.username, other);
  const after = chat ? chat.cleared_at : 0;
  const rows = q.history.all(ws.username, other, other, ws.username, after, limit).reverse();

  reply(ws, rid, {
    t: 'history',
    with: other,
    items: rows.map((r) => ({
      id: r.id, from: r.sender, to: r.recipient,
      box: r.box, nonce: r.nonce, ts: r.ts,
      replyTo: r.reply_to, editedAt: r.edited_at, deleted: !!r.deleted,
      reactions: reactionsOf(r.id)
    }))
  });
}

function handleMessageEdit(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');
  if (row.deleted) return bad(ws, rid, 'Message was deleted');
  if (!validB64(msg.box, 100000) || !validB64(msg.nonce, 100)) {
    return bad(ws, rid, 'Malformed payload');
  }

  const editedAt = Date.now();
  q.editMessage.run(msg.box, msg.nonce, editedAt, row.id);
  reply(ws, rid, { t: 'edited', id: row.id, editedAt });

  if (row.recipient !== ws.username) {
    deliverToUser(row.recipient, {
      t: 'edited', id: row.id, from: row.sender, box: msg.box, nonce: msg.nonce,
      ts: row.ts, editedAt
    });
  }
}

function handleMessageDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');

  q.deleteMessage.run(row.id);
  reply(ws, rid, { t: 'deleted', id: row.id });
  if (row.recipient !== ws.username) {
    deliverToUser(row.recipient, { t: 'deleted', id: row.id, from: row.sender });
  }
}

function handleReaction(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username && row.recipient !== ws.username) {
    return bad(ws, rid, 'Not your conversation');
  }
  const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, 8) : '';
  if (emoji) q.setReaction.run(row.id, ws.username, emoji, Date.now());
  else q.clearReaction.run(row.id, ws.username);

  const list = reactionsOf(row.id);
  reply(ws, rid, { t: 'reactions', id: row.id, reactions: list });

  const other = row.sender === ws.username ? row.recipient : row.sender;
  if (other !== ws.username) deliverToUser(other, { t: 'reactions', id: row.id, reactions: list });
}

function handleTyping(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.to !== 'string') return bad(ws, rid, 'Bad request');
  reply(ws, rid, { t: 'ok', action: 'typing' });
  deliverToUser(msg.to, {
    t: 'typing', from: ws.username, state: msg.state === 'stop' ? 'stop' : 'start'
  });
}

function handleChatsList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const items = [];
  const seen = new Set();
  const rows = q.listChats.all(ws.username).map((c) => ({ ...c, exists: true }));
  for (const row of rows) seen.add(row.peer);
  for (const p of q.allPeers.all(ws.username, ws.username, ws.username, ws.username)) {
    if (!seen.has(p.peer)) {
      rows.push({ peer: p.peer, pinned: 0, muted: 0, archived: 0, last_read: 0, cleared_at: 0 });
    }
  }

  for (const chat of rows) {
    const last = q.lastMessage.get(ws.username, chat.peer, chat.peer, ws.username);
    const unread = q.unreadCount.get(chat.peer, ws.username, chat.last_read).c;
    items.push({
      peer: chat.peer,
      pinned: !!chat.pinned,
      muted: !!chat.muted,
      archived: !!chat.archived,
      unread,
      lastRead: chat.last_read,
      last: last ? {
        id: last.id, from: last.sender, to: last.recipient, box: last.box,
        nonce: last.nonce, ts: last.ts, editedAt: last.edited_at, deleted: !!last.deleted
      } : null
    });
  }
  reply(ws, rid, { t: 'chats', items });
}

function handleChatSettings(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const peer = msg.peer;
  if (typeof peer !== 'string') return bad(ws, rid, 'Bad request');
  const current = q.getChat.get(ws.username, peer);
  const pinned = msg.pinned === undefined ? !!(current && current.pinned) : !!msg.pinned;
  const muted = msg.muted === undefined ? !!(current && current.muted) : !!msg.muted;
  const archived = msg.archived === undefined ? !!(current && current.archived) : !!msg.archived;

  q.setChatFlags.run(ws.username, peer, pinned ? 1 : 0, muted ? 1 : 0, archived ? 1 : 0);
  reply(ws, rid, { t: 'chat.settings', peer, pinned, muted, archived });
}

function handleChatRead(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.peer !== 'string') return bad(ws, rid, 'Bad request');
  const ts = Date.now();
  q.setLastRead.run(ws.username, msg.peer, ts);
  reply(ws, rid, { t: 'chat.read', peer: msg.peer, lastRead: ts });
}

function handleChatClear(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.peer !== 'string') return bad(ws, rid, 'Bad request');
  q.clearChat.run(ws.username, msg.peer, msg.peer, ws.username);
  q.setChatFlags.run(ws.username, msg.peer, 0, 0, 0);
  q.setClearedAt.run(Date.now(), ws.username, msg.peer);
  reply(ws, rid, { t: 'chat.cleared', peer: msg.peer });
}

function handleChatDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.peer !== 'string') return bad(ws, rid, 'Bad request');
  q.clearChat.run(ws.username, msg.peer, msg.peer, ws.username);
  q.deleteChat.run(ws.username, msg.peer);
  reply(ws, rid, { t: 'chat.deleted', peer: msg.peer });
}

const handlers = {
  register: handleRegister,
  login: handleLogin,
  resume: handleResume,
  directory: handleDirectory,
  'profile.get': handleProfileGet,
  'profile.set': handleProfileSet,
  'profile.username': handleUsernameSet,
  'users.search': handleUserSearch,
  send: handleSend,
  history: handleHistory,
  'message.edit': handleMessageEdit,
  'message.delete': handleMessageDelete,
  reaction: handleReaction,
  typing: handleTyping,
  'chats.list': handleChatsList,
  'chat.settings': handleChatSettings,
  'chat.read': handleChatRead,
  'chat.clear': handleChatClear,
  'chat.delete': handleChatDelete
};

/* -------------------------------- server -------------------------------- */
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'sleephy-relay' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.username = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return bad(ws, undefined, 'Bad JSON'); }
    if (!msg || typeof msg.t !== 'string') return bad(ws, undefined, 'Missing type');
    const handler = handlers[msg.t];
    if (!handler) return bad(ws, msg._id, 'Unknown request');
    try { handler(ws, msg, msg._id); } catch { reply(ws, msg._id, { t: 'error', message: 'Server error' }); }
  });

  ws.on('close', () => unbindSocket(ws));
  ws.on('error', () => unbindSocket(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`SleePhy relay listening on ws://0.0.0.0:${PORT}  (db: ${DB_PATH})`);
});

module.exports = { server, wss };
