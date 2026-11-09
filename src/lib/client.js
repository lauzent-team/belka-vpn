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
    // Registry of every account on this device. The active account's keys are
    // mirrored into `file` so older single-account paths keep working.
    this.accountsFile = path.join(userDataDir, 'sleephy-accounts.json');
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

  writeIdentity(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }

  clearIdentity() {
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
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
    return data.accounts.map((a) => ({
      username: a.username,
      publicKey: a.publicKey || null,
      active: a.username === data.active
    }));
  }

  setActiveAccount(username) {
    const data = this.readAccounts();
    const rec = data.accounts.find((a) => a.username === username);
    if (!rec) throw new Error('Unknown account on this device');
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
    if (msg.t === 'edited') {
      this.receiveEdit(msg).catch(() => {});
      return;
    }
    if (msg.t === 'deleted') {
      this.emit({ type: 'deleted', id: msg.id, from: msg.from || this.username });
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
    if (msg.t === 'announcement') {
      this.emit({ type: 'announcement', from: msg.from, text: msg.text, ts: msg.ts });
      return;
    }
    if (msg.t === 'kicked') {
      this.emit({ type: 'kicked', reason: msg.reason || 'Disconnected by an administrator' });
      return;
    }
    if (msg.t === 'presence') {
      this.emit({ type: 'presence', username: msg.username, online: !!msg.online });
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
    const record = {
      username, salt, sealed, nonce, publicKey: identity.publicKey, token: this.token
    };
    this.writeIdentity(record);
    this.upsertAccount(record);

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
    const updated = { ...id, token: this.token, publicKey: this.publicKey };
    this.writeIdentity(updated);
    this.upsertAccount(updated);

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
    if (res.profile) this.peerProfiles.set(res.username, res.profile);
    if (typeof res.online === 'boolean') this.peerPresence.set(res.username, res.online);
    return res.publicKey;
  }

  async sendMessage({ to, text, replyTo, attachment }) {
    if (!this.secretKey) throw new Error('Vault is locked');
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
      t: 'send', to, box, nonce, replyTo: replyTo || undefined, attachment: encAttachment || undefined
    });
    return {
      id: res.id, ts: res.ts, to, text: caption, replyTo: res.replyTo || null,
      mine: true, kind: res.kind || null,
      attachment: encAttachment ? { ...encAttachment, dataUrl: null } : null
    };
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

  async receiveMessage(msg) {
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
      kind: msg.kind || null, attachment: msg.attachment || null
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
        reactions: m.reactions || []
      });
    }
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

  /* ------------------------------- admin ------------------------------- */

  async adminOverview() {
    const res = await this.request({ t: 'admin.overview' });
    return { stats: res.stats, announcements: res.announcements || [] };
  }

  async adminUsers() {
    const res = await this.request({ t: 'admin.users' });
    return res.items || [];
  }

  async adminAction({ action, username, text }) {
    const res = await this.request({ t: 'admin.action', action, username, text });
    return { action: res.action, username: res.username };
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

  /* ------------------------------ settings ------------------------------ */
  async getSettings() {
    const res = await this.request({ t: 'settings.get' });
    return res.settings || {};
  }

  async saveSettings(settings) {
    const res = await this.request({ t: 'settings.set', settings });
    return res.settings || {};
  }

  /* ------------------------------ profile ------------------------------ */
  async getProfile(username) {
    const res = await this.request({ t: 'profile.get', username });
    if (res.profile && res.profile.username) {
      this.peerProfiles.set(res.profile.username, res.profile);
    }
    return { profile: res.profile, online: !!res.online, isSelf: !!res.isSelf };
  }

  async saveProfile({ displayName, bio, avatarColor }) {
    const res = await this.request({
      t: 'profile.set',
      displayName: displayName === undefined ? undefined : displayName,
      bio: bio === undefined ? undefined : bio,
      avatarColor
    });
    this.profile = res.profile;
    return res.profile;
  }

  async changeUsername(username) {
    const res = await this.request({ t: 'profile.username', username });
    const old = this.username;
    this.username = res.username;
    if (res.profile) this.profile = res.profile;

    // The rename rewrites history, so drop cached per-peer state.
    this.peerKeys.delete(old);
    const id = this.readIdentity();
    if (id) this.writeIdentity({ ...id, username: res.username });
    return { username: res.username, previous: old };
  }

  async searchUsers(query) {
    const res = await this.request({ t: 'users.search', query });
    return res.items || [];
  }

  /* ------------------------------- chats ------------------------------- */
  async listChats() {
    const res = await this.request({ t: 'chats.list' });
    return res.items || [];
  }

  async setChatSettings({ peer, pinned, muted, archived }) {
    const res = await this.request({ t: 'chat.settings', peer, pinned, muted, archived });
    return { peer: res.peer, pinned: res.pinned, muted: res.muted, archived: res.archived };
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
      hasStoredIdentity: !!this.readIdentity()
    };
  }
}

module.exports = { SleePhyClient };
