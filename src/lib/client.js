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

/**
 * True only when the relay actively refused the session token (expired or
 * unknown), as opposed to a transport failure. `request()` rejects with the
 * server's message for a refused request and with its own text for a socket
 * problem, so the two are told apart by wording.
 */
function isSessionExpired(err) {
  const message = (err && err.message) || '';
  return /session expired|unknown account|blocked by an administrator/i.test(message);
}

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

// People write usernames as `@alice`. The leading `@` is presentation, not part
// of the name, so it is stripped wherever a name enters the client. The stored
// form stays bare and matches the server's primary key.
function bareUsername(value) {
  return typeof value === 'string' ? value.trim().replace(/^@+/, '').toLowerCase() : value;
}

/** The renderer's chat key for a one-to-one chat. Mirrors `chatKey()` there:
 *  a chat with yourself is Saved Messages, keyed "saved". */
function chatKeyFor(self, peer) {
  const other = bareUsername(peer);
  return other === bareUsername(self) ? 'saved' : other;
}

class SleePhyClient {
  constructor({ userDataDir, onEvent }) {
    this.file = path.join(userDataDir, 'sleephy-identity.json');
    // Registry of every account on this device. The active account's keys are
    // mirrored into `file` so older single-account paths keep working.
    this.accountsFile = path.join(userDataDir, 'sleephy-accounts.json');
    // Phone accounts start without a password, so their key is sealed with a
    // random per-device key kept beside the identity file. Setting a password
    // re-seals the key and removes this file.
    this.deviceKeyFile = path.join(userDataDir, 'sleephy-device.key');
    this.onEvent = onEvent;
    // Message frames are decrypted asynchronously, but a centered series note
    // needs no decryption. Chaining every message frame through this promise
    // keeps them in the order the relay sent them, so a note can never overtake
    // the real message that started the series.
    this.incoming = Promise.resolve();
    this.ws = null;
    // The relay the accounts on this device belong to. A chosen address is
    // remembered, so reopening the app reaches the same relay instead of the
    // bundled default — otherwise the stored session is unknown there and the
    // user is dropped on the sign-in screen.
    this.serverFile = path.join(userDataDir, 'sleephy-server.json');
    this.serverUrl = this.readServerUrl() || DEFAULT_SERVER;
    this.username = null;
    this.secretKey = null; // base64, in memory only
    this.publicKey = null;
    this.token = null;
    this.pending = new Map(); // requestId -> {resolve, reject}
    this.reqSeq = 0;
    this.peerKeys = new Map(); // username -> publicKey
    this.peerProfiles = new Map(); // username -> profile
    this.peerPresence = new Map(); // username -> bool
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.intentionalClose = false;
  }

  /* ------------------------- persisted identity ------------------------- */
  readIdentity() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  /** The relay this device last connected to, if any. */
  readServerUrl() {
    try {
      const data = JSON.parse(fs.readFileSync(this.serverFile, 'utf8'));
      if (data && typeof data.server === 'string' && data.server) return data.server;
    } catch { /* no saved address */ }
    return null;
  }

  writeServerUrl(url) {
    if (!url) return;
    try {
      fs.mkdirSync(path.dirname(this.serverFile), { recursive: true });
      fs.writeFileSync(this.serverFile, JSON.stringify({ server: url }), { mode: 0o600 });
    } catch { /* best effort: a failed write just means the default is used */ }
  }

  writeIdentity(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }

  clearIdentity() {
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
  }

  /* ----------------------------- device key ----------------------------- */
  /** The per-device key, created on first use. Protects passwordless accounts. */
  readDeviceKey() {
    try {
      const key = Buffer.from(fs.readFileSync(this.deviceKeyFile, 'utf8').trim(), 'base64');
      return key.length === 32 ? key : null;
    } catch { return null; }
  }

  ensureDeviceKey() {
    const existing = this.readDeviceKey();
    if (existing) return existing;
    const key = require('crypto').randomBytes(32);
    fs.mkdirSync(path.dirname(this.deviceKeyFile), { recursive: true });
    fs.writeFileSync(this.deviceKeyFile, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  clearDeviceKey() {
    try { fs.unlinkSync(this.deviceKeyFile); } catch { /* nothing to remove */ }
  }

  /** Open a stored record with whichever key sealed it (password or device). */
  async openRecord(record, password) {
    if (record.sealedWith === 'device') {
      const key = this.readDeviceKey();
      if (!key) throw new Error('The device key for this account is missing');
      return cryptoLib.openSecret(record.sealed, record.nonce, key);
    }
    const key = cryptoLib.deriveKey(password, record.salt);
    return cryptoLib.openSecret(record.sealed, record.nonce, key);
  }

  /**
   * The stored key record for an account: the live identity file, or the
   * registry entry when only that survived a sign-out. Records without `sealed`
   * hold no key material and can never be unlocked, so they are ignored.
   */
  keyRecordFor(username) {
    if (!username) return null;
    const id = this.readIdentity();
    if (id && id.username === username && id.sealed) return id;
    const rec = this.readAccounts().accounts.find((a) => a.username === username);
    return rec && rec.sealed ? rec : null;
  }

  /* --------------------------- account registry --------------------------- */
  readAccounts() {
    try {
      const data = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8'));
      if (data && Array.isArray(data.accounts)) return data;
    } catch { /* no registry yet */ }
    return { accounts: [], active: null };
  }

  writeAccounts(data) {
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    fs.writeFileSync(this.accountsFile, JSON.stringify(data), { mode: 0o600 });
  }

  /** Add or update one account in the registry and make it the active one. */
  upsertAccount(record) {
    const data = this.readAccounts();
    const idx = data.accounts.findIndex((a) => a.username === record.username);
    if (idx >= 0) data.accounts[idx] = { ...data.accounts[idx], ...record };
    else data.accounts.push(record);
    data.active = record.username;
    this.writeAccounts(data);
  }

  listAccounts() {
    const data = this.readAccounts();
    // Records without `sealed` hold no key material: they can never be
    // unlocked, so they must not appear as a usable account.
    return data.accounts.filter((a) => a.sealed).map((a) => ({
      username: a.username,
      publicKey: a.publicKey || null,
      active: a.username === data.active
    }));
  }

  setActiveAccount(username) {
    const data = this.readAccounts();
    const rec = data.accounts.find((a) => a.username === username);
    if (!rec) throw new Error('Unknown account on this device');
    if (!rec.sealed) throw new Error('No key material for this account on this device');
    data.active = username;
    this.writeAccounts(data);
    // Mirror into the single-account file so unlock() keeps working unchanged.
    this.writeIdentity({ ...rec });
    return rec;
  }

  removeAccount(username) {
    const data = this.readAccounts();
    data.accounts = data.accounts.filter((a) => a.username !== username);
    if (data.active === username) data.active = data.accounts.length ? data.accounts[0].username : null;
    this.writeAccounts(data);
    const active = data.active ? data.accounts.find((a) => a.username === data.active) : null;
    if (active) this.writeIdentity({ ...active });
    else this.clearIdentity();
    return { active: data.active };
  }

  /* ----------------------------- connection ----------------------------- */
  connect(serverUrl) {
    const target = serverUrl || this.serverUrl;
    const changed = target !== this.serverUrl;
    this.serverUrl = target;
    this.writeServerUrl(target);
    this.intentionalClose = false;

    return new Promise((resolve) => {
      // Reuse a live socket only when the address has not changed; otherwise a
      // new address would silently keep talking to the old server. Even then,
      // wait for an in-flight resume so a caller that reads status() right
      // after still sees the signed-in user.
      if (!changed && this.ws && this.ws.readyState === WebSocket.OPEN) {
        return (this.resumePromise || Promise.resolve()).then(() => resolve());
      }
      this.teardownSocket();

      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };

      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.emit({ type: 'connection', state: 'online' });
        // Resume before resolving connect(): callers read status() straight
        // after, and a resume that finished later left them seeing no user —
        // which is what dropped a returning device on the sign-in screen.
        this.resumePromise = this.autoResume().catch(() => {});
        this.resumePromise.then(settle);
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

    if (msg.t === 'dialog.streak') {
      this.emit({
        type: 'dialog.streak', peer: msg.with, from: msg.from,
        count: msg.count || 0, active: !!msg.active
      });
      return;
    }
    if (msg.t === 'message') {
      // Keep the decrypt queue in lockstep with the socket order. `receiveMessage`
      // never rejects, but the catch is here so one bad frame cannot stall the
      // queue for every frame behind it.
      this.incoming = this.incoming
        .then(() => this.receiveMessage(msg))
        .catch(() => {});
      return;
    }
    if (msg.t === 'edited') {
      this.receiveEdit(msg).catch(() => {});
      return;
    }
    if (msg.t === 'deleted') {
      this.emit({ type: 'deleted', id: msg.id, from: msg.from || this.username });
      return;
    }
    if (msg.t === 'expired') {
      this.emit({ type: 'expired', id: msg.id, from: msg.from || this.username });
      return;
    }
    if (msg.t === 'scheduled.released') {
      this.emit({ type: 'scheduled.released', id: msg.id, to: msg.to });
      return;
    }
    if (msg.t === 'scheduled.new') {
      this.emit({ type: 'scheduled.new', item: msg.item });
      return;
    }
    if (msg.t === 'scheduled.cancelled') {
      this.emit({ type: 'scheduled.cancelled', id: msg.id });
      return;
    }
    if (msg.t === 'scheduled.rescheduled') {
      this.emit({ type: 'scheduled.rescheduled', id: msg.id, sendAt: msg.sendAt });
      return;
    }
    if (msg.t === 'chat.ttl') {
      this.emit({ type: 'chat.ttl', peer: msg.peer, ttl: msg.ttl || 0 });
      return;
    }
    if (msg.t === 'reactions') {
      this.emit({ type: 'reactions', id: msg.id, reactions: msg.reactions || [] });
      return;
    }
    if (msg.t === 'pinned') {
      this.emit({ type: 'pinned', id: msg.id, pinned: !!msg.pinned, peer: msg.peer });
      return;
    }
    if (msg.t === 'typing') {
      this.emit({ type: 'typing', from: msg.from, state: msg.state });
      return;
    }
    if (msg.t === 'call.incoming') {
      this.emit({ type: 'call.incoming', callId: msg.callId, from: msg.from, video: !!msg.video, groupId: msg.groupId ?? null });
      return;
    }
    if (msg.t === 'call.answered') {
      this.emit({ type: 'call.answered', callId: msg.callId, from: msg.from, video: !!msg.video });
      return;
    }
    if (msg.t === 'call.signal') {
      this.emit({ type: 'call.signal', callId: msg.callId, from: msg.from, sdp: msg.sdp || null, candidate: msg.candidate || null });
      return;
    }
    if (msg.t === 'call.declined') {
      this.emit({ type: 'call.declined', callId: msg.callId, from: msg.from });
      return;
    }
    if (msg.t === 'call.ended') {
      this.emit({ type: 'call.ended', callId: msg.callId, from: msg.from });
      return;
    }
    if (msg.t === 'call.left') {
      this.emit({ type: 'call.left', callId: msg.callId, from: msg.from });
      return;
    }
    if (msg.t === 'announcement') {
      this.emit({ type: 'announcement', from: msg.from, text: msg.text, ts: msg.ts });
      return;
    }
    if (msg.t === 'kicked') {
      this.emit({ type: 'kicked', reason: msg.reason || 'Disconnected by an administrator' });
      return;
    }
    if (msg.t === 'presence') {
      this.emit({
        type: 'presence', username: msg.username, online: !!msg.online,
        lastSeen: msg.lastSeen || null
      });
      return;
    }
    if (msg.t === 'profile') {
      this.peerProfiles.set(msg.username, msg.profile);
      this.emit({ type: 'profile', username: msg.username, profile: msg.profile });
      return;
    }
    if (msg.t === 'key') {
      this.peerKeys.set(msg.username, msg.publicKey);
      if (msg.profile) this.peerProfiles.set(msg.username, msg.profile);
      this.emit({
        type: 'key', username: msg.username, publicKey: msg.publicKey,
        profile: msg.profile, online: !!msg.online
      });
      return;
    }
    if (msg.t === 'group.message') {
      this.receiveGroupMessage(msg).catch(() => {});
      return;
    }
    if (msg.t === 'group.edited') {
      this.receiveGroupEdit(msg).catch(() => {});
      return;
    }
    if (msg.t === 'group.deleted') {
      this.emit({ type: 'group.deleted', id: msg.id, groupId: msg.groupId, from: msg.from });
      return;
    }
    if (msg.t === 'group.joined' || msg.t === 'group.memberLeft') {
      this.emit({ type: 'group.updated', group: msg.group, left: msg.t === 'group.memberLeft' ? msg.username : null });
      return;
    }
    if (msg.t === 'channel.message') {
      this.receiveChannelMessage(msg).catch(() => {});
      return;
    }
    if (msg.t === 'channel.edited') {
      this.receiveChannelEdit(msg).catch(() => {});
      return;
    }
    if (msg.t === 'channel.deletedMessage') {
      this.emit({ type: 'channel.deletedMessage', id: msg.id, channelId: msg.channelId, from: msg.from });
      return;
    }
    if (msg.t === 'channel.updated') {
      this.emit({ type: 'channel.updated', channel: msg.channel });
      return;
    }
    if (msg.t === 'channel.deleted') {
      this.emit({ type: 'channel.deleted', channelId: msg.channelId });
      return;
    }
    if (msg.t === 'story.new') {
      this.emit({
        type: 'story.new', id: msg.id, author: msg.author, ts: msg.ts,
        expiresAt: msg.expiresAt, kind: msg.kind || null, attachment: msg.attachment || null
      });
      return;
    }
    if (msg.t === 'story.views') {
      this.emit({ type: 'story.views', id: msg.id, count: msg.count || 0 });
      return;
    }
    if (msg.t === 'story.deleted') {
      this.emit({ type: 'story.deleted', id: msg.id, author: msg.author });
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
    if (msg.profile) this.profile = msg.profile;
  }

  /** Fold a late-arriving edit into a message we already showed. */
  async receiveEdit(msg) {
    const peer = msg.from === this.username ? (msg.to || msg.from) : msg.from;
    let text;
    if (this.secretKey) {
      try {
        const peerKey = await this.ensurePeerKey(msg.from);
        text = await cryptoLib.decryptMessage(msg.box, msg.nonce, peerKey, this.secretKey);
      } catch {
        text = '⚠ Message could not be decrypted';
      }
    }
    this.emit({ type: 'edited', id: msg.id, from: msg.from, text, ts: msg.ts, editedAt: msg.editedAt, peer });
  }

  /* -------------------------------- actions -------------------------------- */
  async autoResume() {
    const id = this.readIdentity();
    if (!id || !id.token) return;
    let res;
    try {
      res = await this.request({ t: 'resume', token: id.token });
    } catch (err) {
      // Only a definitive "this token is dead" answer may drop the token. A
      // network hiccup (relay restarting, no route) must leave the record —
      // and above all its sealed key — untouched, or a returning user is
      // stranded on the sign-in screen with no way back to their messages.
      if (isSessionExpired(err)) {
        this.writeIdentity({ ...id, token: null });
        this.emit({ type: 'session', state: 'signed-out' });
      } else {
        this.emit({ type: 'session', state: 'locked', username: id.username });
      }
      return;
    }
    this.applySession(res);
    this.username = res.username;
    // Persist the (possibly rotated) token so the next launch resumes too.
    this.writeIdentity({ ...id, username: res.username, token: this.token, publicKey: this.publicKey });
    this.upsertAccount({ ...id, username: res.username, token: this.token, publicKey: this.publicKey });
    // A device-sealed key (a phone account with no password yet) opens itself,
    // so the user lands straight in the app instead of an unlock prompt.
    if (id.sealedWith === 'device' && id.sealed) {
      try {
        this.secretKey = await this.openRecord(id, null);
        this.publicKey = id.publicKey || this.publicKey;
        this.emit({ type: 'session', state: 'unlocked', username: res.username });
        return;
      } catch { /* fall through to the locked state */ }
    }
    this.emit({ type: 'session', state: 'locked', username: res.username });
  }

  async register({ username, password }) {
    username = bareUsername(username);
    const identity = await cryptoLib.generateIdentity();
    const salt = cryptoLib.makeSalt();
    const verifier = cryptoLib.passwordVerifier(password, salt);

    const res = await this.request({
      t: 'register', username, password, salt, verifier, publicKey: identity.publicKey
    });
    this.applySession(res);

    const key = cryptoLib.deriveKey(password, salt);
    const { sealed, nonce } = await cryptoLib.sealSecret(identity.secretKey, key);
    const record = {
      username, salt, sealed, nonce, publicKey: identity.publicKey, token: this.token,
      sealedWith: 'password', hasPassword: true
    };
    this.writeIdentity(record);
    this.upsertAccount(record);

    this.secretKey = identity.secretKey;
    this.publicKey = identity.publicKey;
    this.emit({ type: 'session', state: 'unlocked', username });
    return { username };
  }

  async login({ username, password }) {
    username = bareUsername(username);
    const res = await this.request({ t: 'login', username, password });
    this.applySession(res);
    this.publicKey = res.publicKey;

    const id = this.keyRecordFor(username);
    if (!id) throw new Error('No key material for this account on this device');

    const secretKey = await this.openRecord(id, password);
    this.secretKey = secretKey;
    const updated = { ...id, username, token: this.token, publicKey: this.publicKey };
    this.writeIdentity(updated);
    this.upsertAccount(updated);

    this.emit({ type: 'session', state: 'unlocked', username });
    return { username };
  }

  /** Unlock an already-authenticated session with the password (after resume). */
  async unlock(password) {
    const id = this.keyRecordFor(this.username) || this.readIdentity();
    if (!id || !id.sealed) throw new Error('No key material on this device');
    this.secretKey = await this.openRecord(id, password);
    this.publicKey = id.publicKey;
    this.emit({ type: 'session', state: 'unlocked', username: id.username });
    return { username: id.username };
  }

  /* ---------------------------- phone sign-in ---------------------------- */
  /**
   * Ask the relay for a login code. On a new number the relay creates the
   * account; the identity is generated here and sealed with the device key, so
   * there is no password to type on first use.
   */
  async requestCode(phone) {
    const identity = await cryptoLib.generateIdentity();
    const res = await this.request({ t: 'phone.request', phone, publicKey: identity.publicKey });
    this.pendingPhone = { phone, identity };
    return { phone: res.phone, isNew: !!res.isNew, code: res.code || null };
  }

  async verifyCode({ phone, code }) {
    const pending = this.pendingPhone;
    if (!pending || pending.phone !== phone) {
      throw new Error('Request a new code for this number');
    }
    const res = await this.request({ t: 'phone.verify', phone, code });
    this.applySession(res);
    this.publicKey = res.publicKey;

    const deviceKey = this.ensureDeviceKey();
    const { sealed, nonce } = await cryptoLib.sealSecret(pending.identity.secretKey, deviceKey);
    const record = {
      username: res.username, phone, salt: null, sealed, nonce,
      publicKey: res.publicKey, token: this.token,
      sealedWith: 'device', hasPassword: !!res.hasPassword
    };
    this.writeIdentity(record);
    this.upsertAccount(record);

    this.secretKey = pending.identity.secretKey;
    this.pendingPhone = null;
    this.emit({ type: 'session', state: 'unlocked', username: res.username });
    return { username: res.username, hasPassword: !!res.hasPassword };
  }

  /** Set the account password from settings. Re-seals the key under it. */
  async setPassword(password) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const salt = cryptoLib.makeSalt();
    const verifier = cryptoLib.passwordVerifier(password, salt);
    await this.request({ t: 'password.set', password, salt, verifier });

    const key = cryptoLib.deriveKey(password, salt);
    const { sealed, nonce } = await cryptoLib.sealSecret(this.secretKey, key);
    const id = this.readIdentity() || {};
    const record = {
      ...id, username: this.username, salt, sealed, nonce, publicKey: this.publicKey,
      token: this.token, sealedWith: 'password', hasPassword: true
    };
    this.writeIdentity(record);
    this.upsertAccount(record);
    // Drop the device key only when no other account still leans on it.
    const stillUsed = this.readAccounts().accounts
      .some((a) => a.username !== this.username && a.sealedWith === 'device' && a.sealed);
    if (!stillUsed) this.clearDeviceKey();
    return { ok: true };
  }

  async ensurePeerKey(username) {
    username = bareUsername(username);
    if (this.peerKeys.has(username)) return this.peerKeys.get(username);
    const res = await this.request({ t: 'directory', username });
    this.peerKeys.set(res.username, res.publicKey);
    if (res.profile) this.peerProfiles.set(res.username, res.profile);
    if (typeof res.online === 'boolean') this.peerPresence.set(res.username, res.online);
    return res.publicKey;
  }

  /**
   * The safety number this account shares with a peer. Both devices derive the
   * same value from the two public keys, so comparing it out of band catches a
   * relay that swapped a key. Fetches the peer's key if it is not cached yet.
   */
  async safetyNumberWith(username) {
    if (!this.publicKey) throw new Error('Vault is locked');
    const peerKey = await this.ensurePeerKey(username);
    return cryptoLib.safetyNumber(this.publicKey, peerKey);
  }

  async sendMessage({ to, text, replyTo, attachment, ttl, sendAt }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    to = bareUsername(to);
    const peerKey = await this.ensurePeerKey(to);

    let box, nonce, kind = null, encAttachment = null;
    if (attachment) {
      const enc = await cryptoLib.encryptBytes(attachment.bytes, peerKey, this.secretKey);
      kind = attachment.kind;
      encAttachment = {
        kind, box: enc.box, nonce: enc.nonce,
        name: attachment.name || null, mime: attachment.mime || null,
        size: attachment.bytes ? attachment.bytes.length : 0,
        duration: attachment.duration || null
      };
    }
    // A caption may be empty for an attachment; an empty string still has to be
    // encrypted because the relay rejects a blank box on text-only messages.
    const caption = typeof text === 'string' ? text : '';
    if (caption || !attachment) {
      const enc = await cryptoLib.encryptMessage(caption, peerKey, this.secretKey);
      box = enc.box; nonce = enc.nonce;
    } else {
      box = ''; nonce = '';
    }

    const res = await this.request({
      t: 'send', to, box, nonce, replyTo: replyTo || undefined,
      attachment: encAttachment || undefined, ttl: ttl || undefined,
      sendAt: sendAt || undefined
    });
    // A message held for later is not delivered yet; the caller shows it in the
    // scheduled list instead of the transcript.
    if (res.scheduled) {
      return {
        id: res.id, ts: res.ts, to, text: caption, replyTo: res.replyTo || null,
        mine: true, kind: res.kind || null, expiresAt: res.expiresAt || null,
        sendAt: res.sendAt || null, scheduled: true,
        attachment: encAttachment ? { ...encAttachment, dataUrl: null } : null
      };
    }
    // The relay reports the pair's flame on every send, so the sender's header
    // updates without a second round trip.
    if (res.streak) this.emit({ type: 'dialog.streak', peer: to, from: this.username, count: res.streak.count, active: !!res.streak.active });
    return {
      id: res.id, ts: res.ts, to, text: caption, replyTo: res.replyTo || null,
      mine: true, kind: res.kind || null, expiresAt: res.expiresAt || null,
      attachment: encAttachment ? { ...encAttachment, dataUrl: null } : null
    };
  }

  /**
   * The messages this account scheduled but has not sent yet. Each is decrypted
   * here, like history, so the renderer only ever sees plaintext it can show.
   */
  async listScheduled() {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'scheduled.list' });
    const items = [];
    for (const m of res.items || []) {
      const peerKey = await this.ensurePeerKey(m.to);
      let text = '';
      if (m.box) {
        try { text = await cryptoLib.decryptMessage(m.box, m.nonce, peerKey, this.secretKey); }
        catch { text = '⚠ Message could not be decrypted'; }
      }
      items.push({
        id: m.id, to: m.to, text, ts: m.ts, sendAt: m.sendAt,
        replyTo: m.replyTo || null, kind: m.kind || null,
        attachment: m.attachment || null, expiresAt: m.expiresAt || null
      });
    }
    return items;
  }

  async cancelScheduled({ id }) {
    const res = await this.request({ t: 'scheduled.cancel', id });
    return res.id;
  }

  async rescheduleScheduled({ id, sendAt }) {
    const res = await this.request({ t: 'scheduled.reschedule', id, sendAt });
    return res.sendAt;
  }

  async sendScheduledNow({ id }) {
    const res = await this.request({ t: 'scheduled.sendNow', id });
    return res.id;
  }

  async editMessage({ id, to, text }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const peerKey = await this.ensurePeerKey(to);
    const { box, nonce } = await cryptoLib.encryptMessage(text, peerKey, this.secretKey);
    const res = await this.request({ t: 'message.edit', id, box, nonce });
    return { id: res.id, editedAt: res.editedAt, text };
  }

  async deleteMessage({ id }) {
    const res = await this.request({ t: 'message.delete', id });
    return { id: res.id };
  }

  async react({ id, emoji }) {
    const res = await this.request({ t: 'reaction', id, emoji: emoji || '' });
    return { id: res.id, reactions: res.reactions };
  }

  async typing({ to, state }) {
    try { await this.request({ t: 'typing', to, state }); } catch { /* best effort */ }
  }

  /* -------------------------------- calls -------------------------------- */
  // Signaling only. The relay forwards these tiny frames; the media itself
  // never passes through it. Each method returns quickly and its result is
  // best-effort — a call that fails to set up is not an error the UI must
  // handle, the ring simply stops.

  async callInvite({ to, groupId, video }) {
    const res = await this.request({ t: 'call.invite', to, groupId, video: !!video });
    return {
      callId: res.callId, video: !!res.video, groupId: res.groupId ?? null,
      participants: Array.isArray(res.participants) ? res.participants : []
    };
  }

  async callAnswer({ callId, video }) {
    try {
      const res = await this.request({ t: 'call.answer', callId, video: !!video });
      return { participants: Array.isArray(res.participants) ? res.participants : [] };
    } catch { return { participants: [] }; }
  }

  async callSignal({ callId, to, sdp, candidate }) {
    try { await this.request({ t: 'call.signal', callId, to, sdp: sdp || null, candidate: candidate || null }); }
    catch { /* a lost ICE candidate is not fatal; others will follow */ }
  }

  async callDecline({ callId }) {
    try { await this.request({ t: 'call.decline', callId }); } catch { /* best effort */ }
  }

  async callHangup({ callId }) {
    try { await this.request({ t: 'call.hangup', callId }); } catch { /* best effort */ }
  }

  async receiveMessage(msg) {
    // The centered "series started" note is written by the relay, carries no
    // ciphertext, and must not be run through the decryptor.
    if (msg.kind === 'system:series') {
      this.emit({ type: 'message', id: msg.id, from: msg.from, text: '', ts: msg.ts, kind: 'system:series' });
      return;
    }
    if (!this.secretKey) {
      this.emit({ type: 'queued', from: msg.from, id: msg.id });
      return;
    }
    const peerKey = await this.ensurePeerKey(msg.from);
    let text = '';
    if (msg.box) {
      try {
        text = await cryptoLib.decryptMessage(msg.box, msg.nonce, peerKey, this.secretKey);
      } catch {
        text = '⚠ Message could not be decrypted';
      }
    }
    this.emit({
      type: 'message', id: msg.id, from: msg.from, text, ts: msg.ts, replyTo: msg.replyTo || null,
      kind: msg.kind || null, attachment: msg.attachment || null, expiresAt: msg.expiresAt || null
    });
  }

  async history({ with: other, limit }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'history', with: other, limit });
    const peerKey = await this.ensurePeerKey(other);
    const items = [];
    for (const m of res.items) {
      let text = '';
      if (!m.deleted && m.box) {
        try {
          text = await cryptoLib.decryptMessage(m.box, m.nonce, peerKey, this.secretKey);
        } catch {
          text = '⚠ Message could not be decrypted';
        }
      }
      items.push({
        id: m.id, from: m.from, to: m.to, text, ts: m.ts,
        mine: m.from === this.username, replyTo: m.replyTo || null,
        editedAt: m.editedAt || null, deleted: !!m.deleted,
        kind: m.kind || null, attachment: m.attachment || null, pinned: !!m.pinned,
        expiresAt: m.expiresAt || null,
        reactions: m.reactions || []
      });
    }
    // The dialog flame travels with the history. It is hung on the array rather
    // than returned alongside it so every existing caller that just iterates the
    // messages keeps working unchanged.
    items.streak = res.streak || null;
    items.ttl = res.ttl || 0;
    return items;
  }

  /**
   * Decrypt an attachment for display. Returns a data URL the renderer can show
   * without ever holding key material.
   */
  async openAttachment({ id, peer }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'message.get', id });
    const row = res.message;
    if (!row) throw new Error('No such message');
    const attachment = row.attachment ? JSON.parse(row.attachment) : null;
    if (!attachment) throw new Error('Message has no attachment');
    const peerKey = await this.ensurePeerKey(peer);
    const bytes = await cryptoLib.decryptBytes(
      attachment.box, attachment.nonce, peerKey, this.secretKey
    );
    const mime = attachment.mime || 'application/octet-stream';
    return {
      name: attachment.name || null, mime, size: bytes.length,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    };
  }

  /* -------------------------------- groups -------------------------------- */
  async createGroup({ name, members }) {
    const res = await this.request({ t: 'group.create', name, members });
    return res.group;
  }

  async listGroups() {
    const res = await this.request({ t: 'group.list' });
    return res.items || [];
  }

  async addGroupMember({ groupId, username }) {
    const res = await this.request({ t: 'group.add', groupId, username });
    return res.group;
  }

  async leaveGroup({ groupId }) {
    await this.request({ t: 'group.leave', groupId });
  }

  async groupMembers({ groupId }) {
    const res = await this.request({ t: 'group.members', groupId });
    return res.group;
  }

  /** Encrypt one copy per member so the relay only ever stores ciphertext. */
  async groupEnvelopes(text, members) {
    const envelopes = {};
    const keys = {};
    for (const u of members) {
      const key = await this.ensurePeerKey(u);
      keys[u] = key;
      const enc = await cryptoLib.encryptMessage(text, key, this.secretKey);
      envelopes[u] = { box: enc.box, nonce: enc.nonce };
    }
    return { envelopes, keys };
  }

  async sendGroupMessage({ groupId, text, members, replyTo, attachment }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const caption = typeof text === 'string' ? text : '';

    let encAttachment = null;
    let kind = null;
    if (attachment) {
      kind = attachment.kind;
      // Attachments are encrypted once per member as well; the map keys stay the
      // same, values hold the per-member blob.
      const perMember = {};
      for (const u of members) {
        const key = await this.ensurePeerKey(u);
        const enc = await cryptoLib.encryptBytes(attachment.bytes, key, this.secretKey);
        perMember[u] = { box: enc.box, nonce: enc.nonce };
      }
      encAttachment = {
        kind,
        name: attachment.name || null, mime: attachment.mime || null,
        size: attachment.bytes ? attachment.bytes.length : 0,
        duration: attachment.duration || null,
        perMember
      };
    }

    const { envelopes } = await this.groupEnvelopes(caption, members);
    const res = await this.request({
      t: 'group.send', groupId, envelopes,
      replyTo: replyTo || undefined, attachment: encAttachment || undefined
    });
    return {
      id: res.id, groupId, ts: res.ts, text: caption, replyTo: res.replyTo || null,
      mine: true, kind: res.kind || null,
      attachment: encAttachment ? { ...encAttachment, dataUrl: null } : null
    };
  }

  async groupHistory({ groupId, limit }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'group.history', groupId, limit });
    const items = [];
    for (const m of res.items || []) {
      let text = '';
      if (!m.deleted && m.envelope && m.envelope.box) {
        try {
          const peerKey = await this.ensurePeerKey(m.from);
          text = await cryptoLib.decryptMessage(m.envelope.box, m.envelope.nonce, peerKey, this.secretKey);
        } catch {
          text = '⚠ Message could not be decrypted';
        }
      }
      let attachment = m.attachment ? JSON.parse(m.attachment) : null;
      if (attachment && attachment.perMember) {
        attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
      }
      items.push({
        id: m.id, groupId, from: m.from, text, ts: m.ts,
        mine: m.from === this.username, replyTo: m.replyTo || null,
        editedAt: m.editedAt || null, deleted: !!m.deleted,
        kind: m.kind || null, attachment, pinned: false, reactions: []
      });
    }
    return items;
  }

  async receiveGroupMessage(msg) {
    if (!this.secretKey) {
      this.emit({ type: 'group.queued', groupId: msg.groupId, from: msg.from });
      return;
    }
    let text = '';
    if (msg.box) {
      try {
        const peerKey = await this.ensurePeerKey(msg.from);
        text = await cryptoLib.decryptMessage(msg.box, msg.nonce, peerKey, this.secretKey);
      } catch {
        text = '⚠ Message could not be decrypted';
      }
    }
    let attachment = msg.attachment ? JSON.parse(msg.attachment) : null;
    if (attachment && attachment.perMember) {
      attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
    }
    this.emit({
      type: 'group.message', id: msg.id, groupId: msg.groupId, from: msg.from, text,
      ts: msg.ts, replyTo: msg.replyTo || null, kind: msg.kind || null, attachment
    });
  }

  async receiveGroupEdit(msg) {
    let text = '⚠ Message could not be decrypted';
    try {
      const peerKey = await this.ensurePeerKey(msg.from);
      text = await cryptoLib.decryptMessage(msg.box, msg.nonce, peerKey, this.secretKey);
    } catch { /* leave the warning */ }
    this.emit({ type: 'group.edited', id: msg.id, groupId: msg.groupId, from: msg.from, text, editedAt: msg.editedAt });
  }

  async editGroupMessage({ id, groupId, text, members }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const { envelopes } = await this.groupEnvelopes(text, members);
    const res = await this.request({ t: 'group.edit', id, envelopes });
    return { id: res.id, editedAt: res.editedAt, text };
  }

  async deleteGroupMessage({ id }) {
    const res = await this.request({ t: 'group.delete', id });
    return { id: res.id };
  }

  /** Decrypt a group attachment for the current member. */
  async openGroupAttachment({ id }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'group.message.get', id });
    const row = res.message;
    if (!row) throw new Error('No such message');
    const attachment = row.attachment ? JSON.parse(row.attachment) : null;
    if (!attachment) throw new Error('Message has no attachment');
    const mine = attachment.perMember ? attachment.perMember[this.username] : null;
    if (!mine) throw new Error('Attachment is not addressed to you');
    const peerKey = await this.ensurePeerKey(row.from);
    const bytes = await cryptoLib.decryptBytes(mine.box, mine.nonce, peerKey, this.secretKey);
    const mime = attachment.mime || 'application/octet-stream';
    return {
      name: attachment.name || null, mime, size: bytes.length,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    };
  }

  async pinMessage({ id, pinned }) {
    const res = await this.request({ t: 'message.pin', id, pinned });
    return { id: res.id, pinned: !!res.pinned, peer: res.peer };
  }

  /* ------------------------------ channels ------------------------------ */
  // A channel is one-to-many: only the owner posts. Every subscriber gets one
  // encrypted copy, exactly like a group message.

  async createChannel({ name, description, handle }) {
    const res = await this.request({ t: 'channel.create', name, description, handle });
    return res.channel;
  }

  async listChannels() {
    const res = await this.request({ t: 'channel.list' });
    return res.items || [];
  }

  async discoverChannels() {
    const res = await this.request({ t: 'channel.discover' });
    return res.items || [];
  }

  async channelInfo({ channelId, handle }) {
    const res = await this.request({ t: 'channel.info', channelId, handle });
    return res.channel;
  }

  async joinChannel({ channelId, handle }) {
    const res = await this.request({ t: 'channel.join', channelId, handle });
    return res.channel;
  }

  async leaveChannel({ channelId }) {
    await this.request({ t: 'channel.leave', channelId });
  }

  async editChannel({ channelId, name, description, handle }) {
    const res = await this.request({ t: 'channel.edit', channelId, name, description, handle });
    return res.channel;
  }

  async deleteChannel({ channelId }) {
    await this.request({ t: 'channel.delete', channelId });
  }

  async sendChannelPost({ channelId, text, members, replyTo, attachment }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const caption = typeof text === 'string' ? text : '';

    let encAttachment = null;
    let kind = null;
    if (attachment) {
      kind = attachment.kind;
      const perMember = {};
      for (const u of members) {
        const key = await this.ensurePeerKey(u);
        const enc = await cryptoLib.encryptBytes(attachment.bytes, key, this.secretKey);
        perMember[u] = { box: enc.box, nonce: enc.nonce };
      }
      encAttachment = {
        kind,
        name: attachment.name || null, mime: attachment.mime || null,
        size: attachment.bytes ? attachment.bytes.length : 0,
        duration: attachment.duration || null,
        perMember
      };
    }

    const { envelopes } = await this.groupEnvelopes(caption, members);
    const res = await this.request({
      t: 'channel.post', channelId, envelopes,
      replyTo: replyTo || undefined, attachment: encAttachment || undefined
    });
    return {
      id: res.id, channelId, ts: res.ts, text: caption, replyTo: res.replyTo || null,
      mine: true, kind: res.kind || null,
      attachment: encAttachment ? { ...encAttachment, dataUrl: null } : null
    };
  }

  async channelHistory({ channelId, limit }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'channel.history', channelId, limit });
    const items = [];
    for (const m of res.items || []) {
      let text = '';
      if (!m.deleted && m.envelope && m.envelope.box) {
        try {
          const ownerKey = await this.ensurePeerKey(m.from);
          text = await cryptoLib.decryptMessage(m.envelope.box, m.envelope.nonce, ownerKey, this.secretKey);
        } catch {
          text = '⚠ Message could not be decrypted';
        }
      }
      let attachment = m.attachment ? JSON.parse(m.attachment) : null;
      if (attachment && attachment.perMember) {
        attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
      }
      items.push({
        id: m.id, channelId, from: m.from, text, ts: m.ts,
        mine: m.from === this.username, replyTo: m.replyTo || null,
        editedAt: m.editedAt || null, deleted: !!m.deleted,
        kind: m.kind || null, attachment, pinned: false, reactions: []
      });
    }
    return items;
  }

  async receiveChannelMessage(msg) {
    if (!this.secretKey) {
      this.emit({ type: 'channel.queued', channelId: msg.channelId, from: msg.from });
      return;
    }
    let text = '';
    if (msg.box) {
      try {
        const ownerKey = await this.ensurePeerKey(msg.from);
        text = await cryptoLib.decryptMessage(msg.box, msg.nonce, ownerKey, this.secretKey);
      } catch {
        text = '⚠ Message could not be decrypted';
      }
    }
    let attachment = msg.attachment ? JSON.parse(msg.attachment) : null;
    if (attachment && attachment.perMember) {
      attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
    }
    this.emit({
      type: 'channel.message', id: msg.id, channelId: msg.channelId, from: msg.from, text,
      ts: msg.ts, replyTo: msg.replyTo || null, kind: msg.kind || null, attachment
    });
  }

  async receiveChannelEdit(msg) {
    let text = '⚠ Message could not be decrypted';
    try {
      const ownerKey = await this.ensurePeerKey(msg.from);
      text = await cryptoLib.decryptMessage(msg.box, msg.nonce, ownerKey, this.secretKey);
    } catch { /* leave the warning */ }
    this.emit({ type: 'channel.edited', id: msg.id, channelId: msg.channelId, from: msg.from, text, editedAt: msg.editedAt });
  }

  async editChannelMessage({ id, channelId, text, members }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const { envelopes } = await this.groupEnvelopes(text, members);
    const res = await this.request({ t: 'channel.message.edit', id, envelopes });
    return { id: res.id, editedAt: res.editedAt, text };
  }

  async deleteChannelMessage({ id }) {
    const res = await this.request({ t: 'channel.message.delete', id });
    return { id: res.id };
  }

  async openChannelAttachment({ id }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'channel.message.get', id });
    const row = res.message;
    if (!row) throw new Error('No such message');
    const attachment = row.attachment ? JSON.parse(row.attachment) : null;
    if (!attachment) throw new Error('Message has no attachment');
    const mine = attachment.perMember ? attachment.perMember[this.username] : null;
    if (!mine) throw new Error('Attachment is not addressed to you');
    const ownerKey = await this.ensurePeerKey(row.from);
    const bytes = await cryptoLib.decryptBytes(mine.box, mine.nonce, ownerKey, this.secretKey);
    const mime = attachment.mime || 'application/octet-stream';
    return {
      name: attachment.name || null, mime, size: bytes.length,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    };
  }

  async adminChannels() {
    const res = await this.request({ t: 'admin.channels' });
    return res.items || [];
  }

  /* ------------------------------- stories ------------------------------- */
  // A story is a 24-hour post shared with the author's contacts and peers. The
  // body is encrypted once per viewer, exactly like a group message, so the
  // relay stores only ciphertext and never learns the caption or the picture.

  /** The people who may see my story: my contacts, plus anyone I talk to. */
  async storyAudience() {
    const res = await this.request({ t: 'story.audience' });
    return res.items || [];
  }

  /** Encrypt one copy per viewer and publish the story. */
  async postStory({ text, audience, ttl, attachment }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const body = typeof text === 'string' ? text : '';
    const viewers = Array.isArray(audience) ? audience.slice() : [];
    // The author always keeps a copy so the story can be reopened later.
    if (!viewers.includes(this.username)) viewers.push(this.username);

    let encAttachment = null;
    let kind = null;
    if (attachment) {
      kind = attachment.kind;
      const perMember = {};
      for (const u of viewers) {
        const key = await this.ensurePeerKey(u);
        const enc = await cryptoLib.encryptBytes(attachment.bytes, key, this.secretKey);
        perMember[u] = { box: enc.box, nonce: enc.nonce };
      }
      encAttachment = {
        kind,
        name: attachment.name || null, mime: attachment.mime || null,
        size: attachment.bytes ? attachment.bytes.length : 0,
        duration: attachment.duration || null,
        perMember
      };
    }

    const { envelopes } = await this.groupEnvelopes(body, viewers);
    const res = await this.request({
      t: 'story.post', envelopes, audience: viewers, ttl,
      attachment: encAttachment || undefined
    });
    return { id: res.id, ts: res.ts, expiresAt: res.expiresAt };
  }

  async listStories() {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'story.list' });
    const items = [];
    for (const s of res.items || []) {
      let text = '';
      if (s.envelope && s.envelope.box) {
        try {
          const authorKey = await this.ensurePeerKey(s.author);
          text = await cryptoLib.decryptMessage(s.envelope.box, s.envelope.nonce, authorKey, this.secretKey);
        } catch {
          text = '⚠ Story could not be decrypted';
        }
      }
      let attachment = s.attachment ? JSON.parse(s.attachment) : null;
      if (attachment && attachment.perMember) {
        attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
      }
      items.push({
        id: s.id, author: s.author, text, ts: s.ts, expiresAt: s.expiresAt,
        kind: s.kind || null, attachment, seen: !!s.seen, views: s.views || 0,
        mine: s.author === this.username
      });
    }
    return items;
  }

  async viewStory({ id }) {
    const res = await this.request({ t: 'story.viewed', id });
    return { id: res.id, views: res.views };
  }

  /** Decrypt the picture attached to a story, for the signed-in viewer. */
  async openStoryAttachment({ id }) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'story.get', id });
    const story = res.story;
    if (!story) throw new Error('No such story');
    const attachment = story.attachment ? JSON.parse(story.attachment) : null;
    if (!attachment) throw new Error('Story has no attachment');
    const mine = attachment.perMember ? attachment.perMember[this.username] : null;
    if (!mine) throw new Error('Attachment is not addressed to you');
    const authorKey = await this.ensurePeerKey(story.author);
    const bytes = await cryptoLib.decryptBytes(mine.box, mine.nonce, authorKey, this.secretKey);
    const mime = attachment.mime || 'application/octet-stream';
    return {
      name: attachment.name || null, mime, size: bytes.length,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    };
  }

  async storyViewers({ id }) {
    const res = await this.request({ t: 'story.viewers', id });
    return res.viewers || [];
  }

  async deleteStory({ id }) {
    await this.request({ t: 'story.delete', id });
  }

  /* ------------------------------- admin ------------------------------- */

  async adminOverview() {
    const res = await this.request({ t: 'admin.overview' });
    return {
      stats: res.stats,
      announcements: res.announcements || [],
      log: res.log || []
    };
  }

  async adminUsers() {
    const res = await this.request({ t: 'admin.users' });
    return res.items || [];
  }

  async adminAction({ action, username, text, image, channelId, nickname, index }) {
    const res = await this.request({
      t: 'admin.action', action, username, text, image, channelId, nickname, index
    });
    return { action: res.action, username: res.username, channelId: res.channelId };
  }

  async pinnedMessages({ peer }) {
    const res = await this.request({ t: 'messages.pinned', peer });
    return res.items || [];
  }

  async searchMessages({ query, peer, limit }) {
    const res = await this.request({ t: 'messages.search', query, peer, limit });
    const items = res.items || [];
    // The relay matched metadata only; decrypt each hit so the client can filter
    // on the actual text and show a snippet.
    const out = [];
    for (const m of items) {
      const other = m.from === this.username ? m.to : m.from;
      let text = '';
      if (m.attachment) {
        try {
          const att = JSON.parse(m.attachment);
          text = att.name ? `📎 ${att.name}` : '📎 Attachment';
        } catch { text = '📎 Attachment'; }
      }
      const peerKey = await this.ensurePeerKey(other);
      if (m.box) {
        try {
          const dec = await cryptoLib.decryptMessage(m.box, m.nonce, peerKey, this.secretKey);
          text = dec ? `${dec}${text ? ` ${text}` : ''}` : text;
        } catch { /* keep the attachment label, if any */ }
      }
      out.push({
        id: m.id, from: m.from, to: m.to, peer: other, ts: m.ts, text,
        kind: m.kind || null, attachment: m.attachment || null
      });
    }
    const needle = String(query || '').toLowerCase();
    return out.filter((m) => !needle || m.text.toLowerCase().includes(needle) || m.peer.toLowerCase().includes(needle));
  }

  /**
   * Global search: decrypt the newest slice of every conversation the account
   * can open, then return one flat list of messages tagged with the chat they
   * came from. The relay never sees the query; the caller filters the text
   * with the shared chat-search rules.
   */
  async searchGlobal({ limit } = {}) {
    if (!this.secretKey) throw new Error('Vault is locked');
    const res = await this.request({ t: 'search.global', limit });
    const out = [];

    for (const m of res.direct || []) {
      let text = '';
      if (m.box) {
        try {
          const peerKey = await this.ensurePeerKey(m.peer);
          text = await cryptoLib.decryptMessage(m.box, m.nonce, peerKey, this.secretKey);
        } catch { text = '⚠ Message could not be decrypted'; }
      }
      out.push({
        id: m.id, chatKey: chatKeyFor(this.username, m.peer), from: m.from, to: m.peer,
        text, ts: m.ts, mine: m.from === this.username,
        replyTo: m.replyTo || null, editedAt: m.editedAt || null,
        kind: m.kind || null, attachment: m.attachment || null, deleted: false
      });
    }

    for (const m of res.groups || []) {
      let text = '';
      if (m.envelope && m.envelope.box) {
        try {
          const peerKey = await this.ensurePeerKey(m.from);
          text = await cryptoLib.decryptMessage(m.envelope.box, m.envelope.nonce, peerKey, this.secretKey);
        } catch { text = '⚠ Message could not be decrypted'; }
      }
      let attachment = m.attachment ? JSON.parse(m.attachment) : null;
      if (attachment && attachment.perMember) {
        attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
      }
      out.push({
        id: m.id, chatKey: `group:${m.groupId}`, from: m.from, groupId: m.groupId,
        text, ts: m.ts, mine: m.from === this.username,
        replyTo: m.replyTo || null, editedAt: m.editedAt || null,
        kind: m.kind || null, attachment, deleted: false
      });
    }

    for (const m of res.channels || []) {
      let text = '';
      if (m.envelope && m.envelope.box) {
        try {
          const peerKey = await this.ensurePeerKey(m.from);
          text = await cryptoLib.decryptMessage(m.envelope.box, m.envelope.nonce, peerKey, this.secretKey);
        } catch { text = '⚠ Message could not be decrypted'; }
      }
      let attachment = m.attachment ? JSON.parse(m.attachment) : null;
      if (attachment && attachment.perMember) {
        attachment = { ...attachment, ...(attachment.perMember[this.username] || {}), perMember: undefined };
      }
      out.push({
        id: m.id, chatKey: `channel:${m.channelId}`, from: m.from, channelId: m.channelId,
        text, ts: m.ts, mine: m.from === this.username,
        replyTo: m.replyTo || null, editedAt: m.editedAt || null,
        kind: m.kind || null, attachment, deleted: false
      });
    }

    return out;
  }

  /* ------------------------------ settings ------------------------------ */
  async getSettings() {
    const res = await this.request({ t: 'settings.get' });
    return res.settings || {};
  }

  async saveSettings(settings) {
    const res = await this.request({ t: 'settings.set', settings });
    return res.settings || {};
  }

  /** Privacy switches the relay enforces: hidden last-seen and hidden profile. */
  async setPrivacy(privacy) {
    const res = await this.request({ t: 'privacy.set', ...privacy });
    if (res.profile) this.profile = res.profile;
    return res.privacy || {};
  }

  /* ------------------------------ profile ------------------------------ */
  async getProfile(username) {
    const res = await this.request({ t: 'profile.get', username: bareUsername(username) });
    if (res.profile && res.profile.username) {
      this.peerProfiles.set(res.profile.username, res.profile);
    }
    return {
      profile: res.profile, online: !!res.online, isSelf: !!res.isSelf,
      lastSeen: res.lastSeen || null
    };
  }

  /** The account's own "огонёк" streak: days in a row it has been active. */
  async getStreak() {
    const res = await this.request({ t: 'streak.get' });
    return { count: res.count || 0, active: !!res.active };
  }

  /** The dialog flame for a peer: consecutive days the two have written. */
  async dialogStreak(withUser) {
    const res = await this.request({ t: 'streak.get', with: bareUsername(withUser) });
    return { count: res.dialog ? res.dialog.count : 0, active: res.dialog ? !!res.dialog.active : false };
  }

  async saveProfile({ displayName, bio, avatarColor, avatarImage, socials, nicknames }) {
    const res = await this.request({
      t: 'profile.set',
      displayName: displayName === undefined ? undefined : displayName,
      bio: bio === undefined ? undefined : bio,
      avatarColor,
      avatarImage: avatarImage === undefined ? undefined : avatarImage,
      socials: socials === undefined ? undefined : socials,
      nicknames: nicknames === undefined ? undefined : nicknames
    });
    this.profile = res.profile;
    return res.profile;
  }

  async changeUsername(username) {
    username = bareUsername(username);
    const res = await this.request({ t: 'profile.username', username });
    const old = this.username;
    this.username = res.username;
    if (res.profile) this.profile = res.profile;

    // The rename rewrites history, so drop cached per-peer state.
    this.peerKeys.delete(old);
    const id = this.readIdentity();
    const updated = { ...(id || {}), username: res.username, publicKey: this.publicKey, token: this.token };
    this.writeIdentity(updated);
    // The registry keys accounts by username, so carry the entry across too.
    const data = this.readAccounts();
    const idx = data.accounts.findIndex((a) => a.username === old);
    if (idx >= 0) { data.accounts.splice(idx, 1); }
    this.upsertAccount(updated);
    return { username: res.username, previous: old };
  }

  async searchUsers(query) {
    const res = await this.request({ t: 'users.search', query });
    return res.items || [];
  }

  /* ------------------------------- chats ------------------------------- */
  async listChats() {
    const res = await this.request({ t: 'chats.list' });
    const items = res.items || [];
    // Seed the peer-profile cache here, not only in the renderer: a chat row
    // carries the peer's checkmark and picture, and both the chat list and the
    // open conversation read them from this cache.
    for (const row of items) {
      if (row.peer && row.profile) this.peerProfiles.set(row.peer, row.profile);
    }
    return items;
  }

  async setChatSettings({ peer, pinned, muted, archived }) {
    const res = await this.request({ t: 'chat.settings', peer, pinned, muted, archived });
    return { peer: res.peer, pinned: res.pinned, muted: res.muted, archived: res.archived };
  }

  /** Set the conversation's auto-delete timer (ms; 0 turns it off). */
  async setChatTtl({ peer, ttl }) {
    const res = await this.request({ t: 'chat.ttl', peer, ttl });
    return { peer: res.peer, ttl: res.ttl };
  }

  async markRead(peer) {
    const res = await this.request({ t: 'chat.read', peer });
    return res.lastRead;
  }

  async clearChat(peer) {
    await this.request({ t: 'chat.clear', peer });
  }

  async deleteChat(peer) {
    await this.request({ t: 'chat.delete', peer });
  }

  /* -------------------------------- accounts -------------------------------- */
  accounts() {
    return this.listAccounts();
  }

  /** Make another stored account active. Returns its username so the UI can react. */
  async switchAccount(username) {
    this.disconnect();
    const rec = this.setActiveAccount(username);
    this.secretKey = null;
    this.publicKey = rec.publicKey || null;
    this.username = null;
    this.token = null;
    await this.connect();
    // Re-establish the socket session from the stored token so the account is
    // authenticated as soon as it is unlocked.
    if (rec.token) await this.autoResume();
    return { username: rec.username, hasKeys: !!rec.sealed, locked: !!rec.sealed };
  }

  /** Drop an account from this device. If it was active, fall back to another. */
  async forgetAccount(username) {
    const wasActive = this.username === username || this.readAccounts().active === username;
    const { active } = this.removeAccount(username);
    if (!wasActive) return { active, switched: false };
    this.disconnect();
    this.secretKey = null;
    this.username = null;
    this.token = null;
    if (active) {
      const rec = this.readAccounts().accounts.find((a) => a.username === active);
      this.publicKey = rec ? rec.publicKey : null;
      await this.connect();
      if (rec && rec.token) await this.autoResume();
    }
    return { active, switched: true };
  }

  /**
   * Sign out of the active account and return to the sign-in screen. The
   * sealed key record stays in the registry, so the same account can log back
   * in with its password — erasing it here would strand the username, which
   * the relay still reserves. Real erasure is `forgetAccount` in the switcher.
   */
  signOut() {
    this.disconnect();
    this.clearIdentity();
    this.secretKey = null;
    this.username = null;
    this.publicKey = null;
    this.token = null;
    this.profile = null;
  }

  /** Forget every account on this device. */
  forgetAllAccounts() {
    this.disconnect();
    this.clearIdentity();
    try { fs.unlinkSync(this.accountsFile); } catch { /* already gone */ }
    this.secretKey = null;
    this.username = null;
    this.publicKey = null;
    this.token = null;
  }

  status() {
    return {
      online: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
      username: this.username,
      publicKey: this.publicKey,
      profile: this.profile,
      unlocked: !!this.secretKey,
      serverUrl: this.serverUrl,
      accounts: this.listAccounts(),
      hasStoredIdentity: !!this.readIdentity(),
      hasPassword: !!(this.readIdentity() || {}).hasPassword
    };
  }
}

module.exports = { SleePhyClient };
