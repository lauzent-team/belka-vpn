'use strict';

/**
 * SleePhy relay server.
 *
 * A deliberately blind relay: it stores and forwards ciphertext. It never sees
 * plaintext, private keys, or password-derived decryption keys. What it does
 * know: usernames, public keys, message timestamps and sizes.
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
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
    username   TEXT PRIMARY KEY,
    salt       TEXT NOT NULL,
    verifier   TEXT NOT NULL,
    public_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    box        TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender, recipient, id);
  CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient, delivered);
`);

const q = {
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(
    'INSERT INTO users (username, salt, verifier, public_key, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  insertMessage: db.prepare(
    'INSERT INTO messages (sender, recipient, box, nonce, ts, delivered) VALUES (?, ?, ?, ?, ?, 0)'
  ),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markDelivered: db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?'),
  undeliveredFor: db.prepare(
    'SELECT * FROM messages WHERE recipient = ? AND delivered = 0 ORDER BY id ASC LIMIT 500'
  ),
  history: db.prepare(
    `SELECT * FROM messages
      WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
      ORDER BY id DESC LIMIT ?`
  )
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

function bad(ws, message, rid) {
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
  if (set.size === 0) sockets.delete(ws.username);
}

function deliverToUser(username, payload) {
  const set = sockets.get(username);
  if (!set) return false;
  let delivered = false;
  for (const ws of set) { send(ws, payload); delivered = true; }
  return delivered;
}

function flushUndelivered(username) {
  for (const row of q.undeliveredFor.all(username)) {
    const delivered = deliverToUser(username, {
      t: 'message', id: row.id, from: row.sender, box: row.box, nonce: row.nonce, ts: row.ts
    });
    if (delivered) q.markDelivered.run(row.id);
  }
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

  q.insertUser.run(username, useSalt, useVerifier, publicKey, Date.now());

  const token = issueToken(username);
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, { t: 'ok', action: 'register', username, token, publicKey });
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
  reply(ws, rid, { t: 'ok', action: 'login', username, token, publicKey: user.public_key });
  flushUndelivered(username);
}

function handleResume(ws, msg, rid) {
  const username = resolveToken(msg.token);
  if (!username) return bad(ws, rid, 'Session expired');
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Unknown account');
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, { t: 'ok', action: 'resume', username, token: msg.token, publicKey: user.public_key });
  flushUndelivered(username);
}

function handleDirectory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(msg.username);
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, { t: 'key', username: user.username, publicKey: user.public_key });
}

function handleSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const { to, box, nonce } = msg;
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such recipient');
  if (!validB64(box, 100000) || !validB64(nonce, 100)) return bad(ws, rid, 'Malformed payload');

  const ts = Date.now();
  const info = q.insertMessage.run(ws.username, to, box, nonce, ts);
  const id = Number(info.lastInsertRowid);

  reply(ws, rid, { t: 'sent', id, ts });
  const delivered = deliverToUser(to, { t: 'message', id, from: ws.username, box, nonce, ts });
  if (delivered) q.markDelivered.run(id);
}

function handleHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const other = msg.with;
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  if (typeof other !== 'string') return bad(ws, rid, 'Bad request');
  const rows = q.history.all(ws.username, other, other, ws.username, limit).reverse();
  reply(ws, rid, {
    t: 'history',
    with: other,
    items: rows.map((r) => ({ id: r.id, from: r.sender, to: r.recipient, box: r.box, nonce: r.nonce, ts: r.ts }))
  });
}

const handlers = {
  register: handleRegister,
  login: handleLogin,
  resume: handleResume,
  directory: handleDirectory,
  send: handleSend,
  history: handleHistory
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
    try { handler(ws, msg, msg._id); } catch (e) { reply(ws, msg._id, { t: 'error', message: 'Server error' }); }
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
