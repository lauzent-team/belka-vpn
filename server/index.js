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
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.SLEEPHY_PORT ? Number(process.env.SLEEPHY_PORT) : 8787;
const DB_PATH = process.env.SLEEPHY_DB || path.join(__dirname, 'sleephy.db');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// The download page and the built installer, when they sit next to the relay.
// Only these names are ever served, so the relay cannot be walked for files.
const DOWNLOAD_DIR = process.env.SLEEPHY_DOWNLOADS || path.join(__dirname, '..', 'dist');
const DOWNLOAD_NAME = /^(index\.html|SleePhy-Setup-[\w.-]+\.exe)$/;

// The first admin. Listed by name, never by password: the server only ever holds
// a verifier, so there is no way to hand out an account and no way to recover one.
// Extra names can be added with SLEEPHY_ADMINS="alice,bob".
const ADMINS = new Set(
  (process.env.SLEEPHY_ADMINS || 'pidoras')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

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
  CREATE TABLE IF NOT EXISTS user_settings (
    username   TEXT PRIMARY KEY,
    settings   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL,
    username  TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, username)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    sender     TEXT NOT NULL,
    envelope   TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    reply_to   INTEGER,
    edited_at  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0,
    kind       TEXT,
    attachment TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gmsg_group ON group_messages(group_id, id);
  -- Channels are one-to-many: only the owner posts, subscribers read. They reuse
  -- the group_messages envelope layout (one ciphertext copy per subscriber) so a
  -- post is stored and delivered the same way a group message is.
  CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    owner       TEXT NOT NULL,
    description TEXT,
    verified    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_subs (
    channel_id INTEGER NOT NULL,
    username   TEXT NOT NULL,
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (channel_id, username)
  );
  CREATE TABLE IF NOT EXISTS channel_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    sender     TEXT NOT NULL,
    envelope   TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    reply_to   INTEGER,
    edited_at  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0,
    kind       TEXT,
    attachment TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cmsg_channel ON channel_messages(channel_id, id);
  CREATE TABLE IF NOT EXISTS announcements (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    sender   TEXT NOT NULL,
    text     TEXT NOT NULL,
    ts       INTEGER NOT NULL
  );
  -- One-time codes for phone sign-in. The relay only ever stores the code, its
  -- expiry and an attempt counter; the phone number itself lives on the users row.
  CREATE TABLE IF NOT EXISTS phone_codes (
    phone      TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  -- Issued session tokens. Kept on disk so a relay restart does not sign every
  -- device out: the token survives, and the client resumes without a password.
  CREATE TABLE IF NOT EXISTS sessions (
    token    TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    exp      INTEGER NOT NULL
  );
  -- The "огонёк" streak: how many days in a row the account has sent something.
  -- Only the day and the count are stored; the relay never sees a message.
  CREATE TABLE IF NOT EXISTS streaks (
    username TEXT PRIMARY KEY,
    day      TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0
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
  'ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE messages ADD COLUMN kind TEXT',
  'ALTER TABLE messages ADD COLUMN attachment TEXT',
  'ALTER TABLE chats ADD COLUMN pinned_message INTEGER',
  'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN phone TEXT',
  'ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 0',
  // A custom badge image (a small data: URL) that replaces the plain checkmark.
  'ALTER TABLE users ADD COLUMN badge_image TEXT',
  // A profile picture (a small data: URL). Distinct from the admin badge.
  'ALTER TABLE users ADD COLUMN avatar_image TEXT',
  // When this account was last seen online, so peers can show "last seen".
  'ALTER TABLE users ADD COLUMN last_seen INTEGER',
  // A public @handle for a channel, so it can be found and shared as `@name`
  // instead of by an opaque numeric id.
  'ALTER TABLE channels ADD COLUMN handle TEXT',
  // Privacy switches. The relay enforces them so a hidden "last seen" or bio is
  // never sent to another account in the first place, not merely hidden in the UI.
  'ALTER TABLE users ADD COLUMN last_seen_hidden INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN profile_hidden INTEGER NOT NULL DEFAULT 0'
]) {
  try { db.exec(sql); } catch { /* column already present */ }
}

// A channel handle is unique, like a username. SQLite exempts NULLs from a
// UNIQUE index, so legacy channels without a handle never collide.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_handle ON channels(handle)'); }
catch { /* a legacy database already holds a duplicate handle */ }

// One account per phone number. Username/password accounts keep phone NULL,
// and SQLite exempts NULLs from a UNIQUE index, so they never collide.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)'); }
catch { /* a legacy database already holds a duplicate number */ }

const q = {
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(
    `INSERT INTO users (username, salt, verifier, public_key, display_name, bio, avatar_color, created_at, updated_at, has_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getUserByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  setPhone: db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE username = ?'),
  setPassword: db.prepare(
    'UPDATE users SET salt = ?, verifier = ?, has_password = ?, updated_at = ? WHERE username = ?'
  ),
  insertPhoneCode: db.prepare(
    `INSERT INTO phone_codes (phone, code, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(phone) DO UPDATE SET
       code = excluded.code, expires_at = excluded.expires_at, attempts = 0,
       created_at = excluded.created_at`
  ),
  getPhoneCode: db.prepare('SELECT * FROM phone_codes WHERE phone = ?'),
  bumpPhoneCodeAttempts: db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE phone = ?'),
  deletePhoneCode: db.prepare('DELETE FROM phone_codes WHERE phone = ?'),
  setProfile: db.prepare(
    'UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, updated_at = ? WHERE username = ?'
  ),
  setAvatarImage: db.prepare('UPDATE users SET avatar_image = ?, updated_at = ? WHERE username = ?'),
  setLastSeen: db.prepare('UPDATE users SET last_seen = ? WHERE username = ?'),
  setPrivacy: db.prepare('UPDATE users SET last_seen_hidden = ?, profile_hidden = ? WHERE username = ?'),
  searchUsers: db.prepare(
    `SELECT username, display_name, bio, avatar_color, avatar_image FROM users
      WHERE username LIKE ? OR display_name LIKE ? ORDER BY username ASC LIMIT 20`
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (sender, recipient, box, nonce, ts, delivered, reply_to, kind, attachment)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markDelivered: db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?'),
  editMessage: db.prepare('UPDATE messages SET box = ?, nonce = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare(
    "UPDATE messages SET deleted = 1, box = '', nonce = '', attachment = NULL, pinned = 0 WHERE id = ?"
  ),
  setPinned: db.prepare('UPDATE messages SET pinned = ? WHERE id = ?'),
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
  reactionsFor: db.prepare('SELECT username, emoji FROM reactions WHERE message_id = ?'),
  // Pinned messages in a conversation, newest first.
  pinnedIn: db.prepare(
    `SELECT * FROM messages
      WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
        AND pinned = 1 AND deleted = 0
      ORDER BY id DESC`
  ),
  getUserSettings: db.prepare('SELECT settings FROM user_settings WHERE username = ?'),
  setUserSettings: db.prepare(
    `INSERT INTO user_settings (username, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`
  ),
  // The relay holds no plaintext, so a search can only prefilter on the peer and
  // the (client-supplied) attachment file name. The client filters message text.
  searchMessages: db.prepare(
    `SELECT * FROM messages
      WHERE (sender = ? OR recipient = ?) AND deleted = 0
        AND (sender LIKE ? OR recipient LIKE ? OR attachment LIKE ?)
      ORDER BY id DESC LIMIT ?`
  ),

  /* ------------------------------- groups ------------------------------- */
  insertGroup: db.prepare('INSERT INTO groups (name, owner, created_at) VALUES (?, ?, ?)'),
  getGroup: db.prepare('SELECT * FROM groups WHERE id = ?'),
  renameGroup: db.prepare('UPDATE groups SET name = ? WHERE id = ?'),
  deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
  addMember: db.prepare(
    `INSERT INTO group_members (group_id, username, joined_at) VALUES (?, ?, ?)
     ON CONFLICT(group_id, username) DO NOTHING`
  ),
  removeMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND username = ?'),
  membersOf: db.prepare('SELECT username FROM group_members WHERE group_id = ? ORDER BY joined_at ASC'),
  isMember: db.prepare('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND username = ?'),
  groupsFor: db.prepare(
    'SELECT group_id FROM group_members WHERE username = ? ORDER BY joined_at ASC'
  ),
  insertGroupMessage: db.prepare(
    `INSERT INTO group_messages (group_id, sender, envelope, ts, reply_to, kind, attachment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getGroupMessage: db.prepare('SELECT * FROM group_messages WHERE id = ?'),
  groupHistory: db.prepare(
    'SELECT * FROM group_messages WHERE group_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?'
  ),
  editGroupMessage: db.prepare('UPDATE group_messages SET envelope = ?, edited_at = ? WHERE id = ?'),
  deleteGroupMessage: db.prepare(
    "UPDATE group_messages SET deleted = 1, envelope = '', attachment = NULL WHERE id = ?"
  ),
  // Clear the relay copy of a group's messages (owner only).
  clearGroupMessages: db.prepare('DELETE FROM group_messages WHERE group_id = ?'),
  renameGroupMessages: db.prepare('UPDATE group_messages SET sender = ? WHERE sender = ?'),
  renameGroupMembers: db.prepare('UPDATE group_members SET username = ? WHERE username = ?'),
  renameGroupsOwner: db.prepare('UPDATE groups SET owner = ? WHERE owner = ?'),

  /* ------------------------------ channels ------------------------------ */
  insertChannel: db.prepare(
    'INSERT INTO channels (name, owner, description, handle, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  getChannel: db.prepare('SELECT * FROM channels WHERE id = ?'),
  getChannelByHandle: db.prepare('SELECT * FROM channels WHERE handle = ?'),
  renameChannel: db.prepare('UPDATE channels SET name = ?, description = ?, handle = ? WHERE id = ?'),
  setChannelVerified: db.prepare('UPDATE channels SET verified = ? WHERE id = ?'),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
  deleteChannelPosts: db.prepare('DELETE FROM channel_messages WHERE channel_id = ?'),
  deleteChannelSubs: db.prepare('DELETE FROM channel_subs WHERE channel_id = ?'),
  addSub: db.prepare(
    `INSERT INTO channel_subs (channel_id, username, joined_at) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, username) DO NOTHING`
  ),
  removeSub: db.prepare('DELETE FROM channel_subs WHERE channel_id = ? AND username = ?'),
  subsOf: db.prepare('SELECT username FROM channel_subs WHERE channel_id = ? ORDER BY joined_at ASC'),
  isSub: db.prepare('SELECT 1 AS ok FROM channel_subs WHERE channel_id = ? AND username = ?'),
  countSubs: db.prepare('SELECT COUNT(*) AS c FROM channel_subs WHERE channel_id = ?'),
  channelsFor: db.prepare(
    'SELECT channel_id FROM channel_subs WHERE username = ? ORDER BY joined_at ASC'
  ),
  channelsOwned: db.prepare('SELECT id FROM channels WHERE owner = ? ORDER BY created_at ASC'),
  // Discovery: every channel, newest first. The client filters by name.
  allChannels: db.prepare('SELECT * FROM channels ORDER BY created_at DESC LIMIT 200'),
  insertChannelMessage: db.prepare(
    `INSERT INTO channel_messages (channel_id, sender, envelope, ts, reply_to, kind, attachment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getChannelMessage: db.prepare('SELECT * FROM channel_messages WHERE id = ?'),
  channelHistory: db.prepare(
    'SELECT * FROM channel_messages WHERE channel_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?'
  ),
  editChannelMessage: db.prepare('UPDATE channel_messages SET envelope = ?, edited_at = ? WHERE id = ?'),
  deleteChannelMessage: db.prepare(
    "UPDATE channel_messages SET deleted = 1, envelope = '', attachment = NULL WHERE id = ?"
  ),
  countChannels: db.prepare('SELECT COUNT(*) AS c FROM channels'),
  deleteUserSubs: db.prepare('DELETE FROM channel_subs WHERE username = ?'),
  renameChannelMessages: db.prepare('UPDATE channel_messages SET sender = ? WHERE sender = ?'),
  renameChannelSubs: db.prepare('UPDATE channel_subs SET username = ? WHERE username = ?'),
  renameChannelsOwner: db.prepare('UPDATE channels SET owner = ? WHERE owner = ?'),

  /* -------------------------------- admin -------------------------------- */
  setAdmin: db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE username = ?'),
  setVerified: db.prepare('UPDATE users SET verified = ?, updated_at = ? WHERE username = ?'),
  setBadgeImage: db.prepare('UPDATE users SET badge_image = ?, updated_at = ? WHERE username = ?'),
  setBanned: db.prepare('UPDATE users SET banned = ?, updated_at = ? WHERE username = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE username = ?'),
  deleteUserSettings: db.prepare('DELETE FROM user_settings WHERE username = ?'),
  deleteUserChats: db.prepare('DELETE FROM chats WHERE owner = ? OR peer = ?'),
  deleteUserMessages: db.prepare('DELETE FROM messages WHERE sender = ? OR recipient = ?'),
  deleteUserGroupMessages: db.prepare('DELETE FROM group_messages WHERE sender = ?'),
  deleteUserReactions: db.prepare('DELETE FROM reactions WHERE username = ?'),
  deleteUserMemberships: db.prepare('DELETE FROM group_members WHERE username = ?'),
  adminListUsers: db.prepare(
    `SELECT u.username, u.display_name, u.bio, u.avatar_color, u.avatar_image, u.created_at,
            u.is_admin, u.verified, u.banned, u.badge_image,
            (SELECT COUNT(*) FROM messages m WHERE m.sender = u.username) AS sent
       FROM users u ORDER BY u.created_at ASC`
  ),
  countUsers: db.prepare('SELECT COUNT(*) AS c FROM users'),
  countMessages: db.prepare('SELECT COUNT(*) AS c FROM messages'),
  countGroups: db.prepare('SELECT COUNT(*) AS c FROM groups'),
  insertAnnouncement: db.prepare('INSERT INTO announcements (sender, text, ts) VALUES (?, ?, ?)'),
  recentAnnouncements: db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 20'),

  /* ------------------------------ sessions ------------------------------ */
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, username, exp) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE username = ?'),
  renameSessions: db.prepare('UPDATE sessions SET username = ? WHERE username = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE exp < ?'),

  /* ------------------------------- streaks ------------------------------- */
  getStreak: db.prepare('SELECT * FROM streaks WHERE username = ?'),
  setStreak: db.prepare(
    `INSERT INTO streaks (username, day, count) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET day = excluded.day, count = excluded.count`
  ),
  deleteUserStreak: db.prepare('DELETE FROM streaks WHERE username = ?')
};

/* Statements used only by the username rename, which rewrites every reference. */
const renameStmts = {
  user: db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE username = ?'),
  sent: db.prepare('UPDATE messages SET sender = ? WHERE sender = ?'),
  received: db.prepare('UPDATE messages SET recipient = ? WHERE recipient = ?'),
  chatsOwner: db.prepare('UPDATE chats SET owner = ? WHERE owner = ?'),
  chatsPeer: db.prepare('UPDATE chats SET peer = ? WHERE peer = ?'),
  reactions: db.prepare('UPDATE reactions SET username = ? WHERE username = ?'),
  groupMessages: db.prepare('UPDATE group_messages SET sender = ? WHERE sender = ?'),
  groupMembers: db.prepare('UPDATE group_members SET username = ? WHERE username = ?'),
  groupsOwner: db.prepare('UPDATE groups SET owner = ? WHERE owner = ?'),
  channelMessages: db.prepare('UPDATE channel_messages SET sender = ? WHERE sender = ?'),
  channelSubs: db.prepare('UPDATE channel_subs SET username = ? WHERE username = ?'),
  channelsOwner: db.prepare('UPDATE channels SET owner = ? WHERE owner = ?'),
  sessions: db.prepare('UPDATE sessions SET username = ? WHERE username = ?'),
  streaks: db.prepare('UPDATE streaks SET username = ? WHERE username = ?')
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
// Tokens are kept in memory for speed and mirrored to the `sessions` table so
// they survive a relay restart. A restart used to wipe every session, which
// signed every device out and forced the password again.
const tokens = new Map(); // token -> { username, exp }

function issueToken(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + TOKEN_TTL_MS;
  tokens.set(token, { username, exp });
  try { q.insertSession.run(token, username, exp); } catch { /* best effort */ }
  return token;
}

function resolveToken(token) {
  const rec = tokens.get(token);
  if (rec) {
    if (rec.exp < Date.now()) { tokens.delete(token); try { q.deleteSession.run(token); } catch { /* best effort */ } return null; }
    return rec.username;
  }
  // Not in memory: a token issued before the last restart. Fall back to disk.
  const row = q.getSession.get(token);
  if (!row) return null;
  if (row.exp < Date.now()) { try { q.deleteSession.run(token); } catch { /* best effort */ } return null; }
  tokens.set(token, { username: row.username, exp: row.exp });
  return row.username;
}

/* ------------------------------ helpers ------------------------------ */
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
// A username is stored bare (`alice`); the leading `@` is how people write and
// read it, so every entry point strips it before validating. Keeping the stored
// form bare means it stays a clean primary key and nothing about the schema
// changes.
function normalizeUsername(value) {
  if (typeof value !== 'string') return value;
  return value.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Turn a channel name into a candidate @handle: lowercase, ASCII letters,
 * digits and underscores, 3-32 chars. Returns null when nothing usable remains
 * (for example a name written only in Cyrillic), so the caller can ask for one.
 */
function slugHandle(name) {
  if (typeof name !== 'string') return null;
  const slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return USERNAME_RE.test(slug) ? slug : null;
}

/** A handle the caller asked for, validated; `undefined` when none was sent. */
function cleanHandle(value) {
  if (value === undefined) return undefined;
  const bare = normalizeUsername(value);
  if (!USERNAME_RE.test(bare)) return { error: 'Handle must be 3-32 chars: a-z, 0-9, _' };
  return { value: bare };
}
const VALID_B64 = /^[A-Za-z0-9+/=_-]+$/;
const AVATAR_COLORS = new Set(['mint', 'sky', 'violet', 'amber', 'rose', 'lime', 'cyan', 'coral']);

/**
 * A badge picture arrives as a small data: URL from the admin's device. Only
 * raster images are accepted, and the size is capped so a single account cannot
 * bloat the database or every profile broadcast.
 */
const BADGE_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_BADGE_IMAGE_CHARS = 128 * 1024;

function cleanBadgeImage(value) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Badge image must be a string' };
  if (value.length > MAX_BADGE_IMAGE_CHARS) return { error: 'Badge image is too large' };
  if (!BADGE_IMAGE_RE.test(value)) return { error: 'Badge image must be a PNG, JPEG, GIF or WebP' };
  return { value };
}

/**
 * A profile picture arrives as a small data: URL. Same rules as the badge, but
 * a tighter cap: every profile broadcast carries it, so it must stay tiny.
 */
const MAX_AVATAR_IMAGE_CHARS = 64 * 1024;

function cleanAvatarImage(value) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Avatar image must be a string' };
  if (value.length > MAX_AVATAR_IMAGE_CHARS) return { error: 'Avatar image is too large' };
  if (!BADGE_IMAGE_RE.test(value)) return { error: 'Avatar image must be a PNG, JPEG, GIF or WebP' };
  return { value };
}

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

/** The UTC day of a timestamp, as YYYY-MM-DD. The relay has no timezone. */
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * The current "огонёк" streak for an account: the number of days in a row it has
 * sent at least one message, and whether today is already counted. A streak that
 * missed a whole day reads as 0, so it visibly breaks the way it should.
 */
function streakView(username) {
  const row = q.getStreak.get(username);
  if (!row || !row.count) return { count: 0, active: false };
  const today = dayKey(Date.now());
  if (row.day === today) return { count: row.count, active: true };
  const yesterday = dayKey(Date.now() - 86400000);
  if (row.day === yesterday) return { count: row.count, active: false };
  return { count: 0, active: false };
}

/** Extend the streak when the account sends something today. */
function bumpStreak(username, ts) {
  const today = dayKey(ts);
  const row = q.getStreak.get(username);
  if (row && row.day === today) return;
  const yesterday = dayKey(ts - 86400000);
  const count = row && row.day === yesterday ? row.count + 1 : 1;
  q.setStreak.run(username, today, count);
}

/**
 * Count today's activity for the sender and, when the streak actually moved,
 * tell their peers so the fire updates live instead of on the next profile fetch.
 */
function touchStreak(username) {
  const before = streakView(username);
  bumpStreak(username, Date.now());
  const after = streakView(username);
  if (before.count !== after.count || before.active !== after.active) {
    const user = q.getUser.get(username);
    if (user) {
      const profile = publicProfile(user);
      // The sender's own other devices, and the sender, need the new count too.
      broadcastProfile(username, profile);
      deliverToUser(username, { t: 'profile', username, profile });
    }
  }
}

function publicProfile(user, viewer) {
  const isSelf = !viewer || viewer === user.username;
  // Profile privacy hides the name, bio, picture and streak from everyone else;
  // the @handle and the verification badge stay, so the account is still
  // reachable and recognisable.
  const hidden = !isSelf && !!user.profile_hidden;
  const streak = hidden ? { count: 0, active: false } : streakView(user.username);
  return {
    username: user.username,
    displayName: hidden ? user.username : (user.display_name || user.username),
    bio: hidden ? '' : (user.bio || ''),
    avatarColor: hidden ? 'mint' : (user.avatar_color || 'mint'),
    // A profile picture set by the user, shown instead of their initial.
    avatarImage: hidden ? null : (user.avatar_image || null),
    // When the account was last connected, for "last seen" under the name.
    // Hidden either when the owner turned it off or when the profile is hidden.
    lastSeen: (hidden || user.last_seen_hidden) && !isSelf ? null : (user.last_seen || null),
    verified: !!user.verified,
    // A custom badge picture replaces the plain checkmark when present.
    badgeImage: user.badge_image || null,
    // Days in a row the account has sent something, and whether today counts.
    streak: streak.count,
    streakActive: streak.active,
    admin: !!user.is_admin,
    // Named in ADMINS but not yet flagged: the relay still treats them as an
    // admin, so the client must show the panel. The flag is set on next login.
    adminByConfig: ADMINS.has(user.username),
    // The owner's own devices learn the privacy switches so the settings
    // controls reflect what the relay is enforcing. Never sent to anyone else.
    privacy: isSelf
      ? { lastSeenHidden: !!user.last_seen_hidden, profileHidden: !!user.profile_hidden }
      : undefined
  };
}

/** True when the account is an administrator (by name or by a granted flag). */
function isAdmin(username) {
  if (!username) return false;
  if (ADMINS.has(username)) return true;
  const user = q.getUser.get(username);
  return !!(user && user.is_admin);
}

function requireAdmin(ws, rid) {
  if (!ws.username) { bad(ws, rid, 'Not authenticated'); return false; }
  if (!isAdmin(ws.username)) { bad(ws, rid, 'Administrator access required'); return false; }
  return true;
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
    const seen = Date.now();
    q.setLastSeen.run(seen, ws.username);
    announcePresence(ws.username, false, seen);
  }
}

function isOnline(username) {
  return sockets.has(username);
}

function lastSeenOf(username, viewer) {
  if (isOnline(username)) return null;
  const user = q.getUser.get(username);
  if (!user) return null;
  // The owner's own devices always see the real value; everyone else sees
  // nothing when the owner hid last-seen or hid the whole profile.
  if (viewer && viewer !== username && (user.last_seen_hidden || user.profile_hidden)) return null;
  return user.last_seen || null;
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

function announcePresence(username, online, lastSeen) {
  const user = q.getUser.get(username);
  const hidesSeen = !!user && (user.last_seen_hidden || user.profile_hidden);
  const explicit = online ? null : (lastSeen !== undefined ? lastSeen : lastSeenOf(username));
  for (const who of audienceOf(username)) {
    // Each viewer gets their own privacy-filtered last-seen, so a hidden value
    // never leaves the relay to anyone but the owner's own devices.
    const seen = (!online && hidesSeen && who !== username) ? null : explicit;
    deliverToUser(who, { t: 'presence', username, online, lastSeen: online ? null : seen });
  }
}

function broadcastProfile(username, profile) {
  const user = q.getUser.get(username);
  for (const who of audienceOf(username)) {
    // Rebuild per viewer so profile privacy is enforced on the way out.
    const p = user ? publicProfile(user, who) : profile;
    deliverToUser(who, { t: 'profile', username, profile: p });
  }
}

function flushUndelivered(username) {
  for (const row of q.undeliveredFor.all(username)) {
    const delivered = deliverToUser(username, {
      t: 'message', id: row.id, from: row.sender, box: row.box, nonce: row.nonce,
      ts: row.ts, replyTo: row.reply_to,
      kind: row.kind || null, attachment: row.attachment || null
    });
    if (delivered) q.markDelivered.run(row.id);
  }
}

function reactionsOf(messageId) {
  return q.reactionsFor.all(messageId).map((r) => ({ username: r.username, emoji: r.emoji }));
}

/* --------------------------- phone sign-in --------------------------- */
// Codes are 6 digits and live for five minutes. Three wrong guesses drop the
// code, so a short code cannot be brute-forced inside its window.
const PHONE_CODE_TTL_MS = 5 * 60 * 1000;
const PHONE_CODE_MAX_ATTEMPTS = 3;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Deliver a login code. Without an SMS provider the relay prints the code to
 * its log so a self-hosted server can be used before one is wired up. Set
 * SLEEPHY_SMS_WEBHOOK to POST {phone, code} to a provider instead.
 */
async function deliverCode(phone, code) {
  const hook = process.env.SLEEPHY_SMS_WEBHOOK;
  if (hook) {
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, code })
      });
      return;
    } catch (err) {
      console.error('[sms] webhook failed:', err.message);
    }
  }
  console.log(`[sms] code for ${phone}: ${code}`);
}

/** A free username derived from the phone number, e.g. user_7f3a91c2. */
function freeUsername() {
  for (let i = 0; i < 50; i++) {
    const name = 'user_' + crypto.randomBytes(4).toString('hex');
    if (!q.getUser.get(name)) return name;
  }
  return 'user_' + crypto.randomBytes(8).toString('hex');
}

/**
 * First step of phone sign-in: create an account if the number is new and send
 * a one-time code. The account has no password yet — the owner sets one from
 * Privacy settings, and it only ever guards the keys on their device.
 */
async function handlePhoneRequest(ws, msg, rid) {
  const phone = typeof msg.phone === 'string' ? msg.phone.replace(/[\s()-]/g, '') : '';
  if (!PHONE_RE.test(phone)) {
    return bad(ws, rid, 'Enter a phone number in international format, e.g. +79991234567');
  }
  if (!validB64(msg.publicKey, 200)) return bad(ws, rid, 'Invalid public key');

  let user = q.getUserByPhone.get(phone);
  let created = false;
  if (!user) {
    const username = freeUsername();
    const now = Date.now();
    const salt = crypto.randomBytes(16).toString('base64');
    // A phone account starts passwordless: the verifier is a random secret the
    // client never learns, and has_password = 0 makes login refuse it.
    const verifier = crypto.randomBytes(32).toString('base64');
    q.insertUser.run(username, salt, verifier, msg.publicKey, null, null, null, now, now, 0);
    q.setPhone.run(phone, now, username);
    if (ADMINS.has(username)) q.setAdmin.run(1, now, username);
    user = q.getUser.get(username);
    created = true;
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  q.insertPhoneCode.run(phone, code, now + PHONE_CODE_TTL_MS, now);
  await deliverCode(phone, code);

  const res = { t: 'ok', action: 'phone.request', phone, isNew: created };
  // Handing the code back in the reply is opt-in, for tests and for a server
  // whose SMS delivery is not configured yet.
  if (process.env.SLEEPHY_DEV_CODES === '1') res.code = code;
  reply(ws, rid, res);
}

/** Second step: check the code and open a session. */
function handlePhoneVerify(ws, msg, rid) {
  const phone = typeof msg.phone === 'string' ? msg.phone.replace(/[\s()-]/g, '') : '';
  const code = typeof msg.code === 'string' ? msg.code.trim() : '';
  if (!PHONE_RE.test(phone)) return bad(ws, rid, 'Invalid phone number');
  if (!/^\d{6}$/.test(code)) return bad(ws, rid, 'Enter the 6-digit code');

  const rec = q.getPhoneCode.get(phone);
  if (!rec) return bad(ws, rid, 'Request a new code');
  if (rec.expires_at < Date.now()) {
    q.deletePhoneCode.run(phone);
    return bad(ws, rid, 'The code has expired, request a new one');
  }
  if (rec.attempts >= PHONE_CODE_MAX_ATTEMPTS) {
    q.deletePhoneCode.run(phone);
    return bad(ws, rid, 'Too many attempts, request a new code');
  }
  if (rec.code !== code) {
    q.bumpPhoneCodeAttempts.run(phone);
    return bad(ws, rid, 'Wrong code');
  }
  q.deletePhoneCode.run(phone);

  const user = q.getUserByPhone.get(phone);
  if (!user) return bad(ws, rid, 'No account for this number');
  if (user.banned) return bad(ws, rid, 'This account has been blocked by an administrator');
  if (ADMINS.has(user.username) && !user.is_admin) q.setAdmin.run(1, Date.now(), user.username);

  const token = issueToken(user.username);
  ws.username = user.username;
  bindSocket(user.username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'phone.verify', username: user.username, token,
    publicKey: user.public_key, hasPassword: !!user.has_password,
    profile: publicProfile(q.getUser.get(user.username))
  });
  announcePresence(user.username, true);
  flushUndelivered(user.username);
}

/** Set or change the account password. Guarded by the live session. */
function handlePasswordSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const { password, salt, verifier } = msg;
  if (typeof password !== 'string' || password.length < 8 || password.length > 512) {
    return bad(ws, rid, 'Password must be at least 8 characters');
  }
  if (!validB64(salt, 64)) return bad(ws, rid, 'Invalid salt');
  if (!validB64(verifier, 128)) return bad(ws, rid, 'Invalid verifier');

  // The client sends salt + verifier so the server never sees the password and
  // the same secret can protect the local key file.
  q.setPassword.run(salt, verifier, 1, Date.now(), ws.username);
  reply(ws, rid, { t: 'ok', action: 'password.set' });
}

/* ------------------------------- handlers ------------------------------- */
function handleRegister(ws, msg, rid) {
  const { password, publicKey, salt, verifier } = msg;
  const username = normalizeUsername(msg.username);
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
  q.insertUser.run(username, useSalt, useVerifier, publicKey, null, null, null, now, now, 1);
  if (ADMINS.has(username)) q.setAdmin.run(1, now, username);

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
  const password = msg.password;
  const username = normalizeUsername(msg.username);
  if (typeof username !== 'string' || typeof password !== 'string') {
    return bad(ws, rid, 'Username and password required');
  }
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Wrong username or password');
  // Phone accounts start without a password; they sign in by phone number.
  if (!user.has_password) return bad(ws, rid, 'This account signs in by phone number');
  if (!timingSafeEqual(scrypt(password, user.salt), user.verifier)) {
    return bad(ws, rid, 'Wrong username or password');
  }
  if (user.banned) return bad(ws, rid, 'This account has been blocked by an administrator');
  if (ADMINS.has(username) && !user.is_admin) q.setAdmin.run(1, Date.now(), username);

  const token = issueToken(username);
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'login', username, token, publicKey: user.public_key,
    profile: publicProfile(q.getUser.get(username))
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleResume(ws, msg, rid) {
  const username = resolveToken(msg.token);
  if (!username) return bad(ws, rid, 'Session expired');
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Unknown account');
  if (user.banned) return bad(ws, rid, 'This account has been blocked by an administrator');
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
  const user = q.getUser.get(normalizeUsername(msg.username));
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, {
    t: 'key', username: user.username, publicKey: user.public_key,
    profile: publicProfile(user, ws.username), online: isOnline(user.username)
  });
}

function handleProfileGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(normalizeUsername(msg.username) || ws.username);
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, {
    t: 'profile', profile: publicProfile(user, ws.username), online: isOnline(user.username),
    lastSeen: lastSeenOf(user.username, ws.username),
    isSelf: user.username === ws.username
  });
}

function handleStreakGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  reply(ws, rid, { t: 'streak', ...streakView(ws.username) });
}

/**
 * Privacy switches, enforced by the relay. The client also keeps the same
 * preferences locally for the UI, but the server is the authority: a hidden
 * last-seen or profile is filtered out of every reply and broadcast here.
 */
function handlePrivacySet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(ws.username);
  if (!user) return bad(ws, rid, 'Unknown account');
  const lastSeenHidden = msg.lastSeenHidden === undefined
    ? !!user.last_seen_hidden : !!msg.lastSeenHidden;
  const profileHidden = msg.profileHidden === undefined
    ? !!user.profile_hidden : !!msg.profileHidden;
  q.setPrivacy.run(lastSeenHidden ? 1 : 0, profileHidden ? 1 : 0, ws.username);
  const profile = publicProfile(q.getUser.get(ws.username), ws.username);
  reply(ws, rid, {
    t: 'privacy.saved',
    privacy: { lastSeenHidden, profileHidden },
    profile
  });
  // Tell peers the new view right away so a just-hidden profile disappears.
  broadcastProfile(ws.username, profile);
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
  // The picture is separate so a display-name edit never clears it, and a
  // picture edit never touches the name.
  if (msg.avatarImage !== undefined) {
    const parsed = cleanAvatarImage(msg.avatarImage);
    if (parsed.error) return bad(ws, rid, parsed.error);
    q.setAvatarImage.run(parsed.value, Date.now(), ws.username);
  }
  const updated = publicProfile(q.getUser.get(ws.username));
  reply(ws, rid, { t: 'profile.saved', profile: updated });
  broadcastProfile(ws.username, updated);
}

function handleUsernameSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const next = normalizeUsername(msg.username);
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
    renameStmts.groupMessages.run(next, prev);
    renameStmts.groupMembers.run(next, prev);
    renameStmts.groupsOwner.run(next, prev);
    renameStmts.channelMessages.run(next, prev);
    renameStmts.channelSubs.run(next, prev);
    renameStmts.channelsOwner.run(next, prev);
    renameStmts.sessions.run(next, prev);
    renameStmts.streaks.run(next, prev);
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
  const query = typeof msg.query === 'string' ? msg.query.trim().toLowerCase().replace(/^@+/, '') : '';
  if (query.length < 1) return reply(ws, rid, { t: 'users', items: [] });
  const like = `%${query}%`;
  const rows = q.searchUsers.all(like, like);
  const items = rows.map((r) => ({ ...publicProfile(r, ws.username), online: isOnline(r.username) }));
  reply(ws, rid, { t: 'users', items });
}

const ATTACHMENT_KINDS = new Set(['image', 'file', 'voice']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// The client caps the file the user picks; the ciphertext it sends is that file
// plus the 16-byte box MAC and base64 padding. The stored blob is checked
// against the file limit with this slack, so a file exactly at the limit is
// accepted instead of failing on the encryption overhead.
const ATTACHMENT_BOX_SLACK = 1024;

/** Shared metadata checks for both direct and group attachments. */
function attachmentMeta(value) {
  const kind = value.kind;
  if (!ATTACHMENT_KINDS.has(kind)) return { error: 'Unsupported attachment type' };
  const name = cleanText(value.name, 120) || null;
  const mime = cleanText(value.mime, 80) || null;
  const size = Number.isFinite(value.size) ? Math.max(0, Math.floor(value.size)) : 0;
  const duration = Number.isFinite(value.duration) ? Math.max(0, Math.floor(value.duration)) : null;
  if (size > MAX_ATTACHMENT_BYTES) return { error: 'Attachment is too large' };
  return { kind, name, mime, size, duration };
}

/** Validate the attachment envelope. Ciphertext only; the relay never sees plaintext. */
function parseAttachment(value) {
  if (value === undefined || value === null) return { kind: null, attachment: null };
  if (typeof value !== 'object') return { error: 'Malformed attachment' };
  const meta = attachmentMeta(value);
  if (meta.error) return meta;
  // The length cap only guards the frame budget; the byte check below produces
  // the user-facing "too large" message.
  if (!validB64(value.box, 12 * 1024 * 1024) || !validB64(value.nonce, 100)) {
    return { error: 'Malformed attachment payload' };
  }
  // base64 length overestimates bytes by ~4/3; this keeps the stored blob bounded.
  const approxBytes = Math.floor(value.box.length * 3 / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES + ATTACHMENT_BOX_SLACK) return { error: 'Attachment is too large' };
  return {
    kind: meta.kind,
    attachment: JSON.stringify({
      kind: meta.kind, name: meta.name, mime: meta.mime,
      size: meta.size || approxBytes, duration: meta.duration,
      box: value.box, nonce: value.nonce
    })
  };
}

/** A group attachment carries one encrypted blob per member under `perMember`. */
function parseGroupAttachment(value) {
  if (value === undefined || value === null) return { kind: null, attachment: null };
  if (typeof value !== 'object') return { error: 'Malformed attachment' };
  const meta = attachmentMeta(value);
  if (meta.error) return meta;
  if (!value.perMember || typeof value.perMember !== 'object') {
    return { error: 'Malformed attachment payload' };
  }
  const perMember = {};
  for (const [user, env] of Object.entries(value.perMember)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (!validB64(box, 12 * 1024 * 1024) || !validB64(nonce, 100)) {
      return { error: 'Malformed attachment payload' };
    }
    if (Math.floor(box.length * 3 / 4) > MAX_ATTACHMENT_BYTES + ATTACHMENT_BOX_SLACK) {
      return { error: 'Attachment is too large' };
    }
    perMember[user] = { box, nonce };
  }
  if (Object.keys(perMember).length === 0) return { error: 'Malformed attachment payload' };
  return {
    kind: meta.kind,
    attachment: JSON.stringify({
      kind: meta.kind, name: meta.name, mime: meta.mime,
      size: meta.size, duration: meta.duration, perMember
    })
  };
}

function handleSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const { to, box, nonce } = msg;
  // Sending to yourself is allowed: that is how Saved Messages works.
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such recipient');

  const parsed = parseAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);
  const isAttachment = !!parsed.attachment;

  // A caption-less text message must still carry a box; an attachment may have an
  // empty caption, in which case box/nonce are allowed to be blank.
  if (isAttachment) {
    if (box !== undefined && box !== '' && (!validB64(box, 100000) || !validB64(nonce, 100))) {
      return bad(ws, rid, 'Malformed payload');
    }
  } else if (!validB64(box, 100000) || !validB64(nonce, 100)) {
    return bad(ws, rid, 'Malformed payload');
  }

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const safeBox = typeof box === 'string' ? box : '';
  const safeNonce = typeof nonce === 'string' ? nonce : '';
  const kind = parsed.kind;
  const info = q.insertMessage.run(
    ws.username, to, safeBox, safeNonce, ts, replyTo, kind, parsed.attachment
  );
  const id = Number(info.lastInsertRowid);
  touchStreak(ws.username);

  reply(ws, rid, { t: 'sent', id, ts, to, replyTo, kind, attachment: parsed.attachment });
  const delivered = deliverToUser(to, {
    t: 'message', id, from: ws.username, box: safeBox, nonce: safeNonce, ts, replyTo,
    kind, attachment: parsed.attachment
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
      kind: r.kind || null, attachment: r.attachment || null, pinned: !!r.pinned,
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
    // Carry the peer's public profile so a fresh launch can draw the checkmark
    // and the badge/profile picture. The badge is usually granted while the
    // viewer is offline, so re-entry must not depend on having seen it live.
    const peerUser = q.getUser.get(chat.peer);
    items.push({
      peer: chat.peer,
      profile: peerUser ? publicProfile(peerUser, ws.username) : null,
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

function handleMessageGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username && row.recipient !== ws.username) {
    return bad(ws, rid, 'Not your conversation');
  }
  reply(ws, rid, {
    t: 'message', message: {
      id: row.id, from: row.sender, to: row.recipient, ts: row.ts,
      box: row.box, nonce: row.nonce, kind: row.kind || null,
      attachment: row.attachment || null, deleted: !!row.deleted
    }
  });
}

function handleMessagesPinned(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const peer = msg.peer;
  if (typeof peer !== 'string') return bad(ws, rid, 'Bad request');
  const rows = q.pinnedIn.all(ws.username, peer, peer, ws.username);
  reply(ws, rid, {
    t: 'messages.pinned',
    items: rows.map((r) => ({
      id: r.id, from: r.sender, to: r.recipient, ts: r.ts,
      box: r.box, nonce: r.nonce, kind: r.kind || null, attachment: r.attachment || null
    }))
  });
}

function handleMessagePin(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username && row.recipient !== ws.username) {
    return bad(ws, rid, 'Not your conversation');
  }
  if (row.deleted) return bad(ws, rid, 'Message was deleted');

  const pin = msg.pinned === undefined ? !row.pinned : !!msg.pinned;
  q.setPinned.run(pin ? 1 : 0, row.id);
  const peer = row.sender === ws.username ? row.recipient : row.sender;

  reply(ws, rid, { t: 'message.pinned', id: row.id, pinned: pin, peer });
  // Both sides see the pinned banner, so notify the counterpart too.
  if (peer !== ws.username) {
    deliverToUser(peer, { t: 'pinned', id: row.id, pinned: pin, peer: ws.username });
  }
}

function handleMessagesSearch(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const query = cleanText(msg.query, 120);
  if (!query) return bad(ws, rid, 'Empty query');
  const limit = Math.min(Math.max(Number(msg.limit) || 50, 1), 200);
  const peer = typeof msg.peer === 'string' ? msg.peer : null;

  // The relay cannot read message text, so it can only match metadata it holds:
  // the peer and the attachment file name. The client filters decrypted text.
  const rows = q.searchMessages.all(
    ws.username, ws.username, `%${query}%`, `%${query}%`, `%${query}%`, limit
  );
  reply(ws, rid, {
    t: 'messages.search',
    items: rows
      .filter((r) => !peer || r.sender === peer || r.recipient === peer)
      .map((r) => ({
        id: r.id, from: r.sender, to: r.recipient, ts: r.ts,
        replyTo: r.reply_to, editedAt: r.edited_at,
        kind: r.kind || null, attachment: r.attachment || null
      }))
  });
}

function handleSettingsGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getUserSettings.get(ws.username);
  let settings = {};
  if (row) { try { settings = JSON.parse(row.settings) || {}; } catch { settings = {}; } }
  reply(ws, rid, { t: 'settings', settings });
}

function handleSettingsSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const incoming = msg.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return bad(ws, rid, 'Malformed settings');
  }
  const row = q.getUserSettings.get(ws.username);
  let current = {};
  if (row) { try { current = JSON.parse(row.settings) || {}; } catch { current = {}; } }
  // Shallow merge so a partial update never wipes unrelated keys.
  const merged = { ...current, ...incoming };
  const json = JSON.stringify(merged);
  if (json.length > 20000) return bad(ws, rid, 'Settings too large');
  q.setUserSettings.run(ws.username, json, Date.now());
  reply(ws, rid, { t: 'settings', settings: merged });
}

/* -------------------------------- groups -------------------------------- */
const MAX_GROUP_MEMBERS = 200;

function groupView(groupId, viewer) {
  const group = q.getGroup.get(groupId);
  if (!group) return null;
  const members = q.membersOf.all(groupId).map((m) => ({
    username: m.username,
    profile: publicProfile(q.getUser.get(m.username), viewer),
    online: isOnline(m.username)
  }));
  return { id: group.id, name: group.name, owner: group.owner, members };
}

/** Send a payload to every member of a group except an optional sender. */
function deliverToGroup(groupId, payload, exceptUser) {
  for (const m of q.membersOf.all(groupId)) {
    if (m.username !== exceptUser) deliverToUser(m.username, payload);
  }
}

/**
 * Send a group view to each member built for that member, so profile privacy
 * inside the member list is enforced per viewer rather than once for everyone.
 */
function deliverGroupView(groupId, type, exceptUser, extra) {
  for (const m of q.membersOf.all(groupId)) {
    if (m.username === exceptUser) continue;
    deliverToUser(m.username, { t: type, ...(extra || {}), group: groupView(groupId, m.username) });
  }
}

function handleGroupCreate(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const name = cleanText(msg.name, 64);
  if (!name) return bad(ws, rid, 'Group needs a name');
  const raw = Array.isArray(msg.members) ? msg.members : [];
  const members = new Set([ws.username]);
  for (const u of raw.slice(0, MAX_GROUP_MEMBERS)) {
    if (typeof u === 'string' && q.getUser.get(u)) members.add(u);
  }

  const now = Date.now();
  const info = q.insertGroup.run(name, ws.username, now);
  const groupId = Number(info.lastInsertRowid);
  for (const u of members) q.addMember.run(groupId, u, now);

  reply(ws, rid, { t: 'group.created', group: groupView(groupId, ws.username) });
  // Everyone else learns about the new group, each with a view built for them.
  deliverGroupView(groupId, 'group.joined', ws.username);
}

function handleGroupList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const items = q.groupsFor.all(ws.username).map((r) => groupView(r.group_id, ws.username)).filter(Boolean);
  reply(ws, rid, { t: 'groups', items });
}

function handleGroupAdd(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  const group = q.getGroup.get(groupId);
  if (!group) return bad(ws, rid, 'No such group');
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  const target = msg.username;
  if (typeof target !== 'string' || !q.getUser.get(target)) return bad(ws, rid, 'No such user');
  if (q.isMember.get(groupId, target)) return bad(ws, rid, 'Already a member');

  q.addMember.run(groupId, target, Date.now());
  reply(ws, rid, { t: 'group.added', group: groupView(groupId, ws.username) });
  deliverGroupView(groupId, 'group.joined');
}

function handleGroupLeave(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  const group = q.getGroup.get(groupId);
  if (!group) return bad(ws, rid, 'No such group');
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');

  q.removeMember.run(groupId, ws.username);
  reply(ws, rid, { t: 'group.left', groupId });
  deliverGroupView(groupId, 'group.memberLeft', null, { groupId, username: ws.username });
}

function handleGroupMembers(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  reply(ws, rid, { t: 'group.members', group: groupView(groupId, ws.username) });
}

/**
 * Send to a group. The client sends one encrypted copy per member in
 * `envelopes: { username: {box, nonce} }`; the relay stores the map and hands
 * each member only their own copy. It never sees plaintext.
 */
function handleGroupSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const parsed = parseGroupAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);

  const envelopes = {};
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (box && (!validB64(box, 100000) || !validB64(nonce, 100))) continue;
    envelopes[user] = { box, nonce };
  }
  if (Object.keys(envelopes).length === 0) return bad(ws, rid, 'No valid envelopes');

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const info = q.insertGroupMessage.run(
    groupId, ws.username, JSON.stringify(envelopes), ts, replyTo, parsed.kind, parsed.attachment
  );
  const id = Number(info.lastInsertRowid);
  touchStreak(ws.username);

  reply(ws, rid, { t: 'group.sent', id, groupId, ts, replyTo, kind: parsed.kind, attachment: parsed.attachment });
  for (const [user, env] of Object.entries(envelopes)) {
    // The sender already rendered its own copy; a socket echo would duplicate it.
    if (user === ws.username) continue;
    deliverToUser(user, {
      t: 'group.message', id, groupId, from: ws.username, box: env.box, nonce: env.nonce,
      ts, replyTo, kind: parsed.kind, attachment: parsed.attachment
    });
  }
}

function handleGroupHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  const rows = q.groupHistory.all(groupId, limit).reverse();
  const items = rows.map((r) => {
    let envelopes = {};
    try { envelopes = JSON.parse(r.envelope) || {}; } catch { envelopes = {}; }
    return {
      id: r.id, groupId: r.group_id, from: r.sender, ts: r.ts,
      envelope: envelopes[ws.username] || null,
      replyTo: r.reply_to, editedAt: r.edited_at, deleted: !!r.deleted,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });
  reply(ws, rid, { t: 'group.history', groupId, items });
}

function handleGroupEdit(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getGroupMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');
  if (!q.isMember.get(row.group_id, ws.username)) return bad(ws, rid, 'Not a member');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const editedAt = Date.now();
  q.editGroupMessage.run(JSON.stringify(msg.envelopes), editedAt, row.id);
  reply(ws, rid, { t: 'group.edited', id: row.id, editedAt });
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (user === ws.username) continue;
    deliverToUser(user, { t: 'group.edited', id: row.id, groupId: row.group_id, from: row.sender, box: env.box, nonce: env.nonce, editedAt });
  }
}

function handleGroupDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getGroupMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');
  q.deleteGroupMessage.run(row.id);
  reply(ws, rid, { t: 'group.deleted', id: row.id });
  deliverToGroup(row.group_id, { t: 'group.deleted', id: row.id, groupId: row.group_id, from: row.sender }, ws.username);
}

function handleGroupMessageGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getGroupMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (!q.isMember.get(row.group_id, ws.username)) return bad(ws, rid, 'Not a member');
  let envelopes = {};
  try { envelopes = JSON.parse(row.envelope) || {}; } catch { envelopes = {}; }
  reply(ws, rid, {
    t: 'group.message', message: {
      id: row.id, groupId: row.group_id, from: row.sender, ts: row.ts,
      envelope: envelopes[ws.username] || null, attachment: row.attachment || null,
      kind: row.kind || null, deleted: !!row.deleted
    }
  });
}

/* ------------------------------- channels ------------------------------- */
// A channel is one-to-many. Only the owner posts; subscribers read. Posts are
// stored exactly like group messages (a ciphertext copy per subscriber), so the
// relay never holds plaintext and the delivery path is the same.

function channelView(channelId, viewer) {
  const ch = q.getChannel.get(channelId);
  if (!ch) return null;
  const owner = q.getUser.get(ch.owner);
  const isOwner = viewer === ch.owner;
  return {
    id: ch.id,
    name: ch.name,
    handle: ch.handle || null,
    description: ch.description || '',
    owner: ch.owner,
    ownerProfile: owner ? publicProfile(owner, viewer) : null,
    verified: !!ch.verified,
    subs: q.countSubs.get(ch.id).c,
    subscribed: viewer ? !!q.isSub.get(ch.id, viewer) : false,
    isOwner,
    // The owner needs every subscriber's name to encrypt one copy per reader.
    subscribers: isOwner ? q.subsOf.all(ch.id).map((s) => s.username) : undefined
  };
}

/** Send a payload to every subscriber of a channel except an optional user. */
function deliverToChannel(channelId, payload, exceptUser) {
  for (const s of q.subsOf.all(channelId)) {
    if (s.username !== exceptUser) deliverToUser(s.username, payload);
  }
}

/**
 * Tell everyone about a membership change. Each subscriber gets a view built
 * for them, so the owner receives the fresh list of names to encrypt against.
 */
function broadcastChannelUpdate(channelId, exceptUser) {
  for (const s of q.subsOf.all(channelId)) {
    if (s.username === exceptUser) continue;
    const view = channelView(channelId, s.username);
    if (view) deliverToUser(s.username, { t: 'channel.updated', channel: view });
  }
}

function handleChannelCreate(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const name = cleanText(msg.name, 64);
  if (!name) return bad(ws, rid, 'Channel needs a name');
  const description = cleanText(msg.description, 200) || null;

  // The handle is how a channel is shared and found. Use the one asked for, or
  // derive one from the name; if neither works, pick the next free `channel_N`.
  const asked = cleanHandle(msg.handle);
  if (asked && asked.error) return bad(ws, rid, asked.error);
  let handle = asked ? asked.value : slugHandle(name);
  if (handle && q.getChannelByHandle.get(handle)) {
    if (asked) return bad(ws, rid, 'That handle is already taken');
    handle = null;
  }
  if (!handle) {
    for (let i = 1; i < 1000 && !handle; i += 1) {
      const candidate = `channel_${i}`;
      if (!q.getChannelByHandle.get(candidate)) handle = candidate;
    }
  }

  const info = q.insertChannel.run(name, ws.username, description, handle, Date.now());
  const channelId = Number(info.lastInsertRowid);
  // The creator is the first subscriber, so the channel appears in their list.
  q.addSub.run(channelId, ws.username, Date.now());

  reply(ws, rid, { t: 'channel.created', channel: channelView(channelId, ws.username) });
}

function handleChannelList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const ids = new Set([
    ...q.channelsFor.all(ws.username).map((r) => r.channel_id),
    ...q.channelsOwned.all(ws.username).map((r) => r.id)
  ]);
  const items = [...ids].map((id) => channelView(id, ws.username)).filter(Boolean);
  reply(ws, rid, { t: 'channels', items });
}

function handleChannelDiscover(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const items = q.allChannels.all().map((c) => channelView(c.id, ws.username)).filter(Boolean);
  reply(ws, rid, { t: 'channels.discover', items });
}

/**
 * Resolve a channel from a request that may carry either a numeric id or a
 * `@handle` (the client sends `handle` when the user typed `@name`).
 */
function resolveChannel(msg) {
  if (msg.handle) return q.getChannelByHandle.get(normalizeUsername(msg.handle)) || null;
  return q.getChannel.get(Number(msg.channelId)) || null;
}

function handleChannelInfo(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const ch = resolveChannel(msg);
  if (!ch) return bad(ws, rid, 'No such channel');
  reply(ws, rid, { t: 'channel.info', channel: channelView(ch.id, ws.username) });
}

function handleChannelJoin(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const ch = resolveChannel(msg);
  if (!ch) return bad(ws, rid, 'No such channel');
  const channelId = ch.id;
  q.addSub.run(channelId, ws.username, Date.now());
  // Notify the rest of the channel so the owner picks up the new subscriber.
  broadcastChannelUpdate(channelId, ws.username);
  reply(ws, rid, { t: 'channel.joined', channel: channelView(channelId, ws.username) });
}

function handleChannelLeave(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner === ws.username) return bad(ws, rid, 'The owner cannot leave the channel');
  q.removeSub.run(channelId, ws.username);
  // Keep the owner's subscriber list current so posts stop going to the leaver.
  broadcastChannelUpdate(channelId);
  reply(ws, rid, { t: 'channel.left', channelId });
}

function handleChannelEdit(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can edit the channel');
  const name = cleanText(msg.name, 64) || ch.name;
  const description = msg.description === undefined ? ch.description : (cleanText(msg.description, 200) || null);
  // The handle is optional on edit; when sent it must be free and valid.
  let handle = ch.handle;
  if (msg.handle !== undefined) {
    const asked = cleanHandle(msg.handle);
    if (asked && asked.error) return bad(ws, rid, asked.error);
    if (asked.value !== ch.handle && q.getChannelByHandle.get(asked.value)) {
      return bad(ws, rid, 'That handle is already taken');
    }
    handle = asked.value;
  }
  q.renameChannel.run(name, description, handle, channelId);
  const view = channelView(channelId, ws.username);
  reply(ws, rid, { t: 'channel.edited', channel: view });
  broadcastChannelUpdate(channelId, ws.username);
}

function handleChannelDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can delete the channel');
  deliverToChannel(channelId, { t: 'channel.deleted', channelId });
  try {
    db.exec('BEGIN');
    q.deleteChannelPosts.run(channelId);
    q.deleteChannelSubs.run(channelId);
    q.deleteChannel.run(channelId);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    return bad(ws, rid, 'Could not delete the channel');
  }
  reply(ws, rid, { t: 'channel.deleted', channelId });
}

/**
 * Publish to a channel. The owner sends one encrypted copy per subscriber in
 * `envelopes: { username: {box, nonce} }`; the relay stores the map and hands
 * each subscriber only their own copy.
 */
function handleChannelPost(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can post');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const parsed = parseGroupAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);

  const envelopes = {};
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (box && (!validB64(box, 100000) || !validB64(nonce, 100))) continue;
    envelopes[user] = { box, nonce };
  }
  if (Object.keys(envelopes).length === 0) return bad(ws, rid, 'No valid envelopes');

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const info = q.insertChannelMessage.run(
    channelId, ws.username, JSON.stringify(envelopes), ts, replyTo, parsed.kind, parsed.attachment
  );
  const id = Number(info.lastInsertRowid);
  touchStreak(ws.username);

  reply(ws, rid, { t: 'channel.posted', id, channelId, ts, replyTo, kind: parsed.kind, attachment: parsed.attachment });
  for (const [user, env] of Object.entries(envelopes)) {
    if (user === ws.username) continue;
    deliverToUser(user, {
      t: 'channel.message', id, channelId, from: ws.username, box: env.box, nonce: env.nonce,
      ts, replyTo, kind: parsed.kind, attachment: parsed.attachment
    });
  }
}

function handleChannelHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  if (!q.isSub.get(channelId, ws.username)) return bad(ws, rid, 'Not subscribed');
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  const rows = q.channelHistory.all(channelId, limit).reverse();
  const items = rows.map((r) => {
    let envelopes = {};
    try { envelopes = JSON.parse(r.envelope) || {}; } catch { envelopes = {}; }
    return {
      id: r.id, channelId: r.channel_id, from: r.sender, ts: r.ts,
      envelope: envelopes[ws.username] || null,
      replyTo: r.reply_to, editedAt: r.edited_at, deleted: !!r.deleted,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });
  reply(ws, rid, { t: 'channel.history', channelId, items });
}

function handleChannelEditMessage(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getChannelMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  const ch = q.getChannel.get(row.channel_id);
  if (!ch || ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can edit a post');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const editedAt = Date.now();
  q.editChannelMessage.run(JSON.stringify(msg.envelopes), editedAt, row.id);
  reply(ws, rid, { t: 'channel.edited', id: row.id, editedAt });
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (user === ws.username) continue;
    deliverToUser(user, { t: 'channel.edited', id: row.id, channelId: row.channel_id, from: row.sender, box: env.box, nonce: env.nonce, editedAt });
  }
}

function handleChannelDeleteMessage(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getChannelMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  const ch = q.getChannel.get(row.channel_id);
  if (!ch || ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can delete a post');
  q.deleteChannelMessage.run(row.id);
  reply(ws, rid, { t: 'channel.deletedMessage', id: row.id });
  deliverToChannel(row.channel_id, { t: 'channel.deletedMessage', id: row.id, channelId: row.channel_id, from: row.sender }, ws.username);
}

function handleChannelMessageGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getChannelMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (!q.isSub.get(row.channel_id, ws.username)) return bad(ws, rid, 'Not subscribed');
  let envelopes = {};
  try { envelopes = JSON.parse(row.envelope) || {}; } catch { envelopes = {}; }
  reply(ws, rid, {
    t: 'channel.message', message: {
      id: row.id, channelId: row.channel_id, from: row.sender, ts: row.ts,
      envelope: envelopes[ws.username] || null, attachment: row.attachment || null,
      kind: row.kind || null, deleted: !!row.deleted
    }
  });
}

/* -------------------------------- admin -------------------------------- */
// Every admin operation is gated on requireAdmin. The relay still cannot read
// messages, so an admin can moderate accounts but never message contents.

function handleAdminOverview(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  reply(ws, rid, {
    t: 'admin.overview',
    stats: {
      users: q.countUsers.get().c,
      messages: q.countMessages.get().c,
      groups: q.countGroups.get().c,
      channels: q.countChannels.get().c,
      online: sockets.size
    },
    isAdmin: true,
    announcements: q.recentAnnouncements.all().map((a) => ({
      id: a.id, sender: a.sender, text: a.text, ts: a.ts
    }))
  });
}

function handleAdminUsers(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  const rows = q.adminListUsers.all();
  reply(ws, rid, {
    t: 'admin.users',
    items: rows.map((r) => ({
      username: r.username,
      displayName: r.display_name || r.username,
      bio: r.bio || '',
      avatarColor: r.avatar_color || 'mint',
      avatarImage: r.avatar_image || null,
      createdAt: r.created_at,
      sent: r.sent,
      admin: !!r.is_admin || ADMINS.has(r.username),
      verified: !!r.verified,
      badgeImage: r.badge_image || null,
      banned: !!r.banned,
      online: isOnline(r.username)
    }))
  });
}

function handleAdminChannels(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  const items = q.allChannels.all().map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description || '',
    owner: c.owner,
    verified: !!c.verified,
    subs: q.countSubs.get(c.id).c,
    createdAt: c.created_at
  }));
  reply(ws, rid, { t: 'admin.channels', items });
}

function handleAdminAction(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  const actor = ws.username;

  // Announcements are the one action that targets nobody, so handle them first.
  if (msg.action === 'announce') {
    const text = cleanText(msg.text, 300);
    if (!text) return bad(ws, rid, 'Announcement text is required');
    q.insertAnnouncement.run(actor, text, Date.now());
    broadcastAll({ t: 'announcement', from: actor, text, ts: Date.now() });
    return reply(ws, rid, { t: 'admin.ok', action: 'announce' });
  }

  // Channel moderation targets a channel id, not a username.
  if (msg.action === 'channelVerify' || msg.action === 'channelDelete') {
    const channelId = Number(msg.channelId);
    const ch = q.getChannel.get(channelId);
    if (!ch) return bad(ws, rid, 'No such channel');
    if (msg.action === 'channelVerify') {
      q.setChannelVerified.run(ch.verified ? 0 : 1, channelId);
      const view = channelView(channelId, actor);
      broadcastChannelUpdate(channelId);
      return reply(ws, rid, { t: 'admin.ok', action: 'channelVerify', channelId, channel: view });
    }
    deliverToChannel(channelId, { t: 'channel.deleted', channelId });
    try {
      db.exec('BEGIN');
      q.deleteChannelPosts.run(channelId);
      q.deleteChannelSubs.run(channelId);
      q.deleteChannel.run(channelId);
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      return bad(ws, rid, 'Could not delete the channel');
    }
    return reply(ws, rid, { t: 'admin.ok', action: 'channelDelete', channelId });
  }

  const target = typeof msg.username === 'string' ? msg.username : '';
  const user = q.getUser.get(target);
  if (!user) return bad(ws, rid, 'No such user');
  const now = Date.now();

  switch (msg.action) {
    case 'verify':
      q.setVerified.run(user.verified ? 0 : 1, now, target);
      break;
    case 'badge': {
      // An admin-supplied picture replaces the checkmark. `null` clears it, and
      // setting a picture also marks the account verified, since the badge is
      // what a verified account is meant to show.
      const parsed = cleanBadgeImage(msg.image === undefined ? null : msg.image);
      if (parsed.error) return bad(ws, rid, parsed.error);
      q.setBadgeImage.run(parsed.value, now, target);
      if (parsed.value && !user.verified) q.setVerified.run(1, now, target);
      break;
    }
    case 'grantAdmin':
      // Refuse self-demotion: it would hide the panel mid-click and, for the
      // last admin, lock everyone out of the panel entirely.
      if (target === actor && user.is_admin && !ADMINS.has(target)) {
        return bad(ws, rid, 'You cannot remove your own admin rights');
      }
      q.setAdmin.run(user.is_admin ? 0 : 1, now, target);
      break;
    case 'ban':
      if (target === actor) return bad(ws, rid, 'You cannot block your own account');
      q.setBanned.run(user.banned ? 0 : 1, now, target);
      if (!user.banned) kickUser(target, 'You were blocked by an administrator');
      break;
    case 'delete':
      if (target === actor) return bad(ws, rid, 'You cannot delete your own account');
      if (ADMINS.has(target)) return bad(ws, rid, 'That account is protected');
      deleteUserData(target);
      return reply(ws, rid, { t: 'admin.ok', action: 'delete', username: target });
    default:
      return bad(ws, rid, 'Unknown admin action');
  }

  const updated = q.getUser.get(target);
  if (updated) {
    const profile = publicProfile(updated);
    broadcastProfile(target, profile);
    deliverToUser(target, { t: 'profile', username: target, profile });
  }
  reply(ws, rid, { t: 'admin.ok', action: msg.action, username: target });
}

/** Disconnect every socket of a user, with a reason the client can display. */
function kickUser(username, reason) {
  const set = sockets.get(username);
  if (!set) return;
  for (const client of [...set]) {
    send(client, { t: 'kicked', reason });
    client.username = null;
    try { client.close(); } catch { /* already closing */ }
  }
  sockets.delete(username);
}

/** Erase an account and every row that references it. */
function deleteUserData(username) {
  kickUser(username, 'This account was deleted by an administrator');
  try {
    db.exec('BEGIN');
    q.deleteUserMessages.run(username, username);
    q.deleteUserGroupMessages.run(username);
    q.deleteUserSubs.run(username);
    q.deleteUserReactions.run(username);
    q.deleteUserMemberships.run(username);
    q.deleteUserChats.run(username, username);
    q.deleteUserSettings.run(username);
    q.deleteUserSessions.run(username);
    q.deleteUserStreak.run(username);
    q.deleteUser.run(username);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
  }
}

function broadcastAll(payload) {
  for (const ws of wss.clients) send(ws, payload);
}

const handlers = {
  register: handleRegister,
  login: handleLogin,
  resume: handleResume,
  'phone.request': handlePhoneRequest,
  'phone.verify': handlePhoneVerify,
  'password.set': handlePasswordSet,
  directory: handleDirectory,
  'profile.get': handleProfileGet,
  'profile.set': handleProfileSet,
  'streak.get': handleStreakGet,
  'profile.username': handleUsernameSet,
  'users.search': handleUserSearch,
  send: handleSend,
  history: handleHistory,
  'message.edit': handleMessageEdit,
  'message.delete': handleMessageDelete,
  'message.get': handleMessageGet,
  'message.pin': handleMessagePin,
  'messages.pinned': handleMessagesPinned,
  'messages.search': handleMessagesSearch,
  reaction: handleReaction,
  typing: handleTyping,
  'chats.list': handleChatsList,
  'chat.settings': handleChatSettings,
  'chat.read': handleChatRead,
  'chat.clear': handleChatClear,
  'chat.delete': handleChatDelete,
  'settings.get': handleSettingsGet,
  'settings.set': handleSettingsSet,
  'privacy.set': handlePrivacySet,
  'group.create': handleGroupCreate,
  'group.list': handleGroupList,
  'group.add': handleGroupAdd,
  'group.leave': handleGroupLeave,
  'group.members': handleGroupMembers,
  'group.send': handleGroupSend,
  'group.history': handleGroupHistory,
  'group.edit': handleGroupEdit,
  'group.delete': handleGroupDelete,
  'group.message.get': handleGroupMessageGet,
  'channel.create': handleChannelCreate,
  'channel.list': handleChannelList,
  'channel.discover': handleChannelDiscover,
  'channel.info': handleChannelInfo,
  'channel.join': handleChannelJoin,
  'channel.leave': handleChannelLeave,
  'channel.edit': handleChannelEdit,
  'channel.delete': handleChannelDelete,
  'channel.post': handleChannelPost,
  'channel.history': handleChannelHistory,
  'channel.message.edit': handleChannelEditMessage,
  'channel.message.delete': handleChannelDeleteMessage,
  'channel.message.get': handleChannelMessageGet,
  'admin.overview': handleAdminOverview,
  'admin.users': handleAdminUsers,
  'admin.channels': handleAdminChannels,
  'admin.action': handleAdminAction
};

/* -------------------------------- server -------------------------------- */
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'sleephy-relay' }));
    return;
  }
  // Serve the download page and the installer, if they were shipped alongside.
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (DOWNLOAD_NAME.test(name)) {
    const file = path.join(DOWNLOAD_DIR, name);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
      const headers = { 'content-type': type, 'content-length': data.length };
      if (name.endsWith('.exe')) headers['content-disposition'] = `attachment; filename="${name}"`;
      res.writeHead(200, headers);
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// Attachments are capped at 5 MB of ciphertext, which base64-encodes to ~6.7 MB,
// plus JSON overhead; 16 MB leaves headroom without allowing unbounded frames.
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

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

// One bad connection must not take the relay down for everyone. Log and keep
// serving: a relay that stays up is worth more than a crash that loses it.
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandled rejection:', reason);
});

server.listen(PORT, () => {
  console.log(`SleePhy relay listening on ws://0.0.0.0:${PORT}  (db: ${DB_PATH})`);
});

module.exports = { server, wss };
