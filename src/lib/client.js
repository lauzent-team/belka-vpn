'use strict';

/**
 * SleePhy client. Lives in the Electron main process.
 *
 * Responsibilities:
 *  - keep the WebSocket connection to the relay
 *  - own the identity: keypair, token, and the password-protected key file
 *  - encrypt outgoing / decrypt incoming messages
 *  - push UI events to the renderer (which never sees private keys)
 */

const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const cryptoLib = require('./crypto');

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Where the app looks for a relay by default, in priority order:
//   1. SLEEPHY_SERVER environment variable
//   2. a bundled server-default.json (written at build time)
//   3. a local relay on this machine
function resolveDefaultServer() {
  if (process.env.SLEEPHY_SERVER) return process.env.SLEEPHY_SERVER;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'server-default.json'), 'utf8'));
    if (cfg && typeof cfg.server === 'string' && cfg.server) return cfg.server;
  } catch { /* no bundled config */ }
  return 'ws://127.0.0.1:8787';
}

const DEFAULT_SERVER = resolveDefaultServer();

class SleePhyClient {
  constructor({ userDataDir, onEvent }) {
    this.file = path.join(userDataDir, 'sleephy-identity.json');
    this.onEvent = onEvent;
    this.ws = null;
    this.serverUrl = DEFAULT_SERVER;
    this.username = null;
    this.secretKey = null; // base64, in memory only
    this.publicKey = null;
    this.token = null;
    this.pending = new Map(); // requestId -> {resolve, reject}
    this.reqSeq = 0;
    this.peerKeys = new Map(); // username -> publicKey
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.intentionalClose = false;
  }

  /* ------------------------- persisted identity ------------------------- */
  readIdentity() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  writeIdentity(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }

  clearIdentity() {
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
  }

  /* ----------------------------- connection ----------------------------- */
  connect(serverUrl) {
    const target = serverUrl || this.serverUrl;
    const changed = target !== this.serverUrl;
    this.serverUrl = target;
    this.intentionalClose = false;

    return new Promise((resolve) => {
      // Reuse a live socket only when the address has not changed; otherwise a
      // new address would silently keep talking to the old server.
      if (!changed && this.ws && this.ws.readyState === WebSocket.OPEN) return resolve();
      this.teardownSocket();

      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };

      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.emit({ type: 'connection', state: 'online' });
        settle();
        this.autoResume();
      });

      ws.on('message', (raw) => this.handleMessage(raw));

      ws.on('close', () => {
        this.emit({ type: 'connection', state: 'offline' });
        settle();
        this.scheduleReconnect();
      });

      ws.on('error', () => settle());
    });
  }

  /** Drop the current socket without triggering a reconnect. */
  teardownSocket() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.failPending('Connection closed');
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.removeAllListeners();
      try { old.close(); } catch { /* already closed */ }
    }
  }

  /** Reject in-flight requests so callers fail fast instead of waiting. */
  failPending(reason) {
    for (const [, { reject }] of this.pending) reject(new Error(reason));
    this.pending.clear();
  }

  scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  disconnect() {
    this.intentionalClose = true;
    this.teardownSocket();
  }

  emit(evt) { try { this.onEvent(evt); } catch { /* renderer may be gone */ } }

  /* ------------------------------- protocol ------------------------------- */
  request(obj, { expectReply = true } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(
          `No connection to the server (${this.serverUrl}). ` +
          'Check the server address and that the relay is running.'
        ));
      }
      if (!expectReply) { this.ws.send(JSON.stringify(obj)); return resolve(); }
      const id = ++this.reqSeq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...obj, _id: id }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('Server did not respond'));
        }
      }, 15000);
    });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg._id && this.pending.has(msg._id)) {
      const { resolve, reject } = this.pending.get(msg._id);
      this.pending.delete(msg._id);
      if (msg.t === 'error') reject(new Error(msg.message || 'Request failed'));
      else resolve(msg);
      return;
    }

    if (msg.t === 'message') {
      this.receiveMessage(msg).catch(() => {});
      return;
    }
    if (msg.t === 'key') {
      this.peerKeys.set(msg.username, msg.publicKey);
      this.emit({ type: 'key', username: msg.username, publicKey: msg.publicKey });
      return;
    }
    if (msg.t === 'ok') {
      this.applySession(msg);
    }
  }

  applySession(msg) {
    if (msg.token) this.token = msg.token;
    if (msg.username) this.username = msg.username;
    if (msg.publicKey) this.publicKey = msg.publicKey;
  }

  /* -------------------------------- actions -------------------------------- */
  async autoResume() {
    const id = this.readIdentity();
    if (!id || !id.token) return;
    try {
      const res = await this.request({ t: 'resume', token: id.token });
      this.applySession(res);
      this.username = res.username;
      this.emit({ type: 'session', state: 'locked', username: res.username });
    } catch {
      this.clearIdentity();
      this.emit({ type: 'session', state: 'signed-out' });
    }
  }

  async register({ username, password }) {
    const identity = await cryptoLib.generateIdentity();
    const salt = cryptoLib.makeSalt();
    const verifier = cryptoLib.passwordVerifier(password, salt);

    const res = await this.request({
      t: 'register', username, password, salt, verifier, publicKey: identity.publicKey
    });
    this.applySession(res);

    const key = cryptoLib.deriveKey(password, salt);
    const { sealed, nonce } = await cryptoLib.sealSecret(identity.secretKey, key);
    this.writeIdentity({
      username, salt, sealed, nonce, publicKey: identity.publicKey, token: this.token
    });

    this.secretKey = identity.secretKey;
    this.publicKey = identity.publicKey;
    this.emit({ type: 'session', state: 'unlocked', username });
    return { username };
  }

  async login({ username, password }) {
    const res = await this.request({ t: 'login', username, password });
    this.applySession(res);
    this.publicKey = res.publicKey;

    const id = this.readIdentity();
    if (!id || id.username !== username || !id.sealed) {
      throw new Error('No key material for this account on this device');
    }

    const key = cryptoLib.deriveKey(password, id.salt);
    const secretKey = await cryptoLib.openSecret(id.sealed, id.nonce, key);
    this.secretKey = secretKey;
    this.writeIdentity({ ...id, token: this.token, publicKey: this.publicKey });

    this.emit({ type: 'session', state: 'unlocked', username });
    return { username };
  }

  /** Unlock an already-authenticated session with the password (after resume). */
  async unlock(password) {
    const id = this.readIdentity();
    if (!id || !id.sealed) throw new Error('No key material on this device');
    const key = cryptoLib.deriveKey(password, id.salt);
    this.secretKey = await cryptoLib.openSecret(id.sealed, id.nonce, key);
    this.publicKey = id.publicKey;
    this.emit({ type: 'session', state: 'unlocked', username: id.username });
    return { username: id.username };
  }

  async ensurePeerKey(username) {
    if (this.peerKeys.has(username)) return this.peerKeys.get(username);
    const res = await this.request({ t: 'directory', username });
    this.peerKeys.set(res.username, res.publicKey);
    return res.publicKey;
  }

  async sendMessage({ to, text }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const peerKey = await this.ensurePeerKey(to);
    const { box, nonce } = await cryptoLib.encryptMessage(text, peerKey, this.secretKey);
    const res = await this.request({ t: 'send', to, box, nonce });
    return { id: res.id, ts: res.ts, to, text };
  }

  async receiveMessage(msg) {
    if (!this.secretKey) {
      this.emit({ type: 'queued', from: msg.from, id: msg.id });
      return;
    }
    const peerKey = await this.ensurePeerKey(msg.from);
    let text;
    try {
      text = await cryptoLib.decryptMessage(msg.box, msg.nonce, peerKey, this.secretKey);
    } catch {
      text = '⚠ Message could not be decrypted';
    }
    this.emit({ type: 'message', id: msg.id, from: msg.from, text, ts: msg.ts });
  }

  async history({ with: other, limit }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'history', with: other, limit });
    const peerKey = await this.ensurePeerKey(other);
    const items = [];
    for (const m of res.items) {
      let text;
      try {
        text = await cryptoLib.decryptMessage(m.box, m.nonce, peerKey, this.secretKey);
      } catch {
        text = '⚠ Message could not be decrypted';
      }
      items.push({ id: m.id, from: m.from, to: m.to, text, ts: m.ts, mine: m.from === this.username });
    }
    return items;
  }

  status() {
    return {
      online: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
      username: this.username,
      publicKey: this.publicKey,
      unlocked: !!this.secretKey,
      serverUrl: this.serverUrl
    };
  }
}

module.exports = { SleePhyClient };
