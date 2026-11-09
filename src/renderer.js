'use strict';

/**
 * SleePhy UI. Talks to the main process through window.sleephy only.
 * No key material or plaintext crypto happens here.
 */

const api = window.sleephy;

const AVATAR_COLORS = ['mint', 'sky', 'violet', 'amber', 'rose', 'lime', 'cyan', 'coral'];
const SAVED = 'saved'; // pseudo-peer for Saved Messages (really "your own username")

/* --------------------------- element helpers --------------------------- */
const $ = (id) => document.getElementById(id);

const els = {
  screens: { auth: $('screen-auth'), unlock: $('screen-unlock'), main: $('screen-main') },
  authTabs: document.querySelector('.auth-tabs'),
  tabs: Array.from(document.querySelectorAll('.auth-tab')),
  formAuth: $('form-auth'),
  authUser: $('auth-username'),
  authPass: $('auth-password'),
  authConfirm: $('auth-confirm'),
  fieldConfirm: $('field-confirm'),
  authHint: $('auth-hint'),
  authError: $('auth-error'),
  btnAuth: $('btn-auth'),
  serverUrl: $('server-url'),
  authConn: $('auth-conn'),

  formUnlock: $('form-unlock'),
  unlockPass: $('unlock-password'),
  unlockError: $('unlock-error'),
  unlockUser: $('unlock-user'),
  btnSwitch: $('btn-switch-account'),

  btnMyProfile: $('btn-my-profile'),
  meName: $('me-name'),
  meAvatar: $('me-avatar'),
  meState: $('me-state'),
  search: $('search'),
  btnSearchClear: $('btn-search-clear'),
  searchPanel: $('search-panel'),
  searchResults: $('search-results'),
  searchEmpty: $('search-empty'),
  chatSections: $('chat-sections'),
  chatList: $('chat-list'),
  chatEmpty: $('chat-empty'),
  sectionArchived: $('section-archived'),
  btnArchivedToggle: $('btn-archived-toggle'),
  archivedList: $('archived-list'),
  archivedCount: $('archived-count'),
  btnSettings: $('btn-settings'),
  btnMenu: $('btn-menu'),
  drawer: $('drawer'),
  drawerBackdrop: $('drawer-backdrop'),
  drawerAvatar: $('drawer-avatar'),
  drawerName: $('drawer-name'),
  drawerHandle: $('drawer-handle'),
  drawerAccountsCount: $('drawer-accounts-count'),
  drawerArchivedCount: $('drawer-archived-count'),
  drawerVer: $('drawer-ver'),
  footVer: $('foot-ver'),
  accountsBackdrop: $('accounts-backdrop'),
  accountsList: $('accounts-list'),
  btnAccountsClose: $('btn-accounts-close'),
  btnAccountsAdd: $('btn-accounts-add'),
  contactsBackdrop: $('contacts-backdrop'),
  contactsList: $('contacts-list'),
  contactsEmpty: $('contacts-empty'),
  contactInput: $('contact-input'),
  btnContactAdd: $('btn-contact-add'),
  contactError: $('contact-error'),
  btnContactsClose: $('btn-contacts-close'),
  groupBackdrop: $('group-backdrop'),
  groupName: $('group-name'),
  groupMembers: $('group-members'),
  groupError: $('group-error'),
  btnGroupCreate: $('btn-group-create'),
  btnGroupClose: $('btn-group-close'),
  setNotify: $('set-notify'),
  setPreview: $('set-preview'),
  setSound: $('set-sound'),
  setLastSeen: $('set-lastseen'),
  setReceipts: $('set-receipts'),
  setAutoLock: $('set-autolock'),
  setBlockedSub: $('set-blocked-sub'),
  btnBlocked: $('btn-blocked'),
  setAutoPhoto: $('set-autophoto'),
  setKeepMedia: $('set-keepmedia'),
  setStorage: $('set-storage'),
  btnClearCache: $('btn-clear-cache'),
  setEnter: $('set-enter'),
  setLanguage: $('set-language'),

  chatBlank: $('chat-blank'),
  chatView: $('chat-view'),
  btnPeerProfile: $('btn-peer-profile'),
  peerName: $('peer-name'),
  peerAvatar: $('peer-avatar'),
  peerSub: $('peer-sub'),
  btnChatMenu: $('btn-chat-menu'),
  messages: $('messages'),
  composer: $('composer'),
  composerInput: $('composer-input'),
  replyBar: $('reply-bar'),
  replyBarTitle: $('reply-bar-title'),
  replyBarText: $('reply-bar-text'),
  btnReplyCancel: $('btn-reply-cancel'),
  editBar: $('edit-bar'),
  editBarText: $('edit-bar-text'),
  btnEditCancel: $('btn-edit-cancel'),

  profileBackdrop: $('profile-backdrop'),
  profileTitle: $('profile-title'),
  btnProfileClose: $('btn-profile-close'),
  profileAvatar: $('profile-avatar'),
  profileDisplay: $('profile-display'),
  profileHandle: $('profile-handle'),
  profilePresence: $('profile-presence'),
  profileView: $('profile-view'),
  profileViewUsername: $('profile-view-username'),
  profileViewBio: $('profile-view-bio'),
  profilePubkey: $('profile-pubkey'),
  profileActions: $('profile-actions'),
  btnProfileMessage: $('btn-profile-message'),
  btnProfileEdit: $('btn-profile-edit'),
  profileForm: $('profile-form'),
  profileName: $('profile-name'),
  profileBio: $('profile-bio'),
  profileColors: $('profile-colors'),
  profileError: $('profile-error'),
  btnProfileCancel: $('btn-profile-cancel'),
  usernameSep: $('username-sep'),
  usernameBlock: $('username-block'),
  usernameInput: $('username-input'),
  usernameError: $('username-error'),
  btnUsernameSave: $('btn-username-save'),

  settingsBackdrop: $('settings-backdrop'),
  btnSettingsClose: $('btn-settings-close'),
  setUsername: $('set-username'),
  btnOpenMyProfile: $('btn-open-my-profile'),
  btnOpenSaved: $('btn-open-saved'),
  setConn: $('set-conn'),
  setConnDot: $('set-conn-dot'),
  setServer: $('set-server'),
  btnApplyServer: $('btn-apply-server'),
  setPubkey: $('set-pubkey'),
  btnLogout: $('btn-logout'),

  chatmenuBackdrop: $('chatmenu-backdrop'),
  chatmenuTitle: $('chatmenu-title'),
  chatmenuBody: $('chatmenu-body'),
  btnChatmenuClose: $('btn-chatmenu-close'),
  menuPinLabel: $('menu-pin-label'),
  menuMuteLabel: $('menu-mute-label'),
  menuArchiveLabel: $('menu-archive-label'),

  ctxBackdrop: $('ctx-backdrop'),
  ctxMenu: $('ctx-menu'),
  ctxEdit: $('ctx-edit'),
  ctxDelete: $('ctx-delete'),
  ctxPin: $('ctx-pin'),
  ctxPinLabel: $('ctx-pin-label'),
  ctxReactions: $('ctx-reactions'),
  ctxForward: $('ctx-forward'),

  btnChatSearch: $('btn-chat-search'),
  chatSearchBar: $('chat-search-bar'),
  chatSearchInput: $('chat-search-input'),
  chatSearchCount: $('chat-search-count'),
  btnChatSearchClose: $('btn-chat-search-close'),

  pinnedBar: $('pinned-bar'),
  pinnedTitle: $('pinned-title'),
  pinnedText: $('pinned-text'),
  btnPinnedUnpin: $('btn-pinned-unpin'),

  btnAttach: $('btn-attach'),
  btnEmoji: $('btn-emoji'),
  btnVoice: $('btn-voice'),
  attachBackdrop: $('attach-backdrop'),
  attachMenu: $('attach-menu'),
  emojiPanel: $('emoji-panel'),
  emojiTabs: $('emoji-tabs'),
  emojiGrid: $('emoji-grid'),

  btnThemeToggle: $('btn-theme-toggle'),
  setThemeSub: $('set-theme-sub'),
  wallpaperPicker: $('wallpaper-picker'),

  forwardBackdrop: $('forward-backdrop'),
  forwardList: $('forward-list'),
  forwardEmpty: $('forward-empty'),
  btnForwardClose: $('btn-forward-close'),

  selectBar: $('select-bar'),
  selectCount: $('select-count'),
  btnSelectCancel: $('btn-select-cancel'),
  btnSelectForward: $('btn-select-forward'),
  btnSelectDelete: $('btn-select-delete'),

  confirmBackdrop: $('confirm-backdrop'),
  confirmText: $('confirm-text'),
  btnConfirmYes: $('btn-confirm-yes'),
  btnConfirmNo: $('btn-confirm-no'),
  confirmTitle: $('confirm-title'),
  promptBackdrop: $('prompt-backdrop'),
  promptTitle: $('prompt-title'),
  promptLabel: $('prompt-label'),
  promptInput: $('prompt-input'),
  btnPromptOk: $('btn-prompt-ok'),
  btnPromptCancel: $('btn-prompt-cancel'),

  meBadge: $('me-badge'),
  peerBadge: $('peer-badge'),
  profileBadge: $('profile-badge'),

  settingsNav: $('settings-nav'),
  settingsPanes: $('settings-panes'),
  setHeroAvatar: $('set-hero-avatar'),
  setHeroName: $('set-hero-name'),
  setAccountHandle: $('set-account-handle'),
  setVersionSub: $('set-version-sub'),
  setChatPreview: $('set-chatpreview'),
  setReduceMotion: $('set-reducemotion'),
  setEscClose: $('set-escclose'),
  setPlainPaste: $('set-plainpaste'),
  btnTestSound: $('btn-test-sound'),
  btnReconnect: $('btn-reconnect'),
  btnCheckUpdates: $('btn-check-updates'),
  btnResetSettings: $('btn-reset-settings'),
  settingsNavAdmin: $('settings-nav-admin'),
  adminStats: $('admin-stats'),
  adminUsers: $('admin-users'),
  adminUsersEmpty: $('admin-users-empty'),
  adminAnnounceInput: $('admin-announce-input'),
  btnAdminAnnounce: $('btn-admin-announce'),

  panelSwitch: $('panel-switch'),
  emojiMode: $('emoji-mode'),
  stickerMode: $('sticker-mode'),
  stickerGrid: $('sticker-grid'),

  toast: $('toast')
};

/* ------------------------------- state ------------------------------- */
const state = {
  mode: 'login', // login | register
  username: null,
  profile: null,
  online: false,
  unlocked: false,
  activePeer: null,
  chats: new Map(), // peerKey -> chat
  profiles: new Map(), // username -> profile
  presence: new Map(), // username -> bool
  typing: new Map(), // username -> timeout id
  replyTo: null, // { id, text, from, mine }
  editing: null, // { id, original }
  ctxTarget: null, // { id, mine, text, pinned }
  profileTarget: null, // username being shown
  editingProfile: false,
  searchQuery: '', // active in-chat search
  searchHits: [],
  searchIndex: -1,
  settings: { theme: 'dark', wallpaper: 'none' },
  groups: new Map(), // groupId -> { id, name, owner, members: [] }
  contacts: [], // usernames saved as contacts
  accounts: [], // [{ username, publicKey, active }]
  recording: null, // MediaRecorder state for voice notes
  selecting: null, // Set of message ids while in select mode
  isAdmin: false, // whether the signed-in account may open the admin panel
  settingsPane: 'account' // active settings section
};

/* ------------------------------ utilities ------------------------------ */
function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) el.classList.toggle('active', key === name);
}

function showError(el, message) {
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = message;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

let toastTimer = null;
function toast(message, duration = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, duration);
}

/** Deliver a new message alert, honouring the notification settings. */
function notifyNewMessage(from, text) {
  if (state.settings.notify === false) return;
  const body = state.settings.notifyPreview === false
    ? 'New message'
    : (text || 'Attachment').slice(0, 120);
  const title = displayNameFor(from);
  toast(`${title}: ${body}`);
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, silent: state.settings.notifySound === false });
    }
  } catch { /* notifications are best effort */ }
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function chatKey(peer) {
  return peer === state.username ? SAVED : peer;
}

/** Group chats use the key "group:<id>" so they can share the chat map. */
function groupKey(groupId) { return `group:${groupId}`; }
function isGroupKey(key) { return typeof key === 'string' && key.startsWith('group:'); }
function groupIdOf(key) { return Number(String(key).slice('group:'.length)); }

function peerUsername(key) {
  return key === SAVED ? state.username : key;
}

function displayNameFor(username) {
  if (isGroupKey(username)) {
    const g = state.groups.get(groupIdOf(username));
    return g ? g.name : 'Группа';
  }
  const p = state.profiles.get(username);
  if (!p) return username;
  return p.displayName || username;
}

function avatarColorFor(username) {
  if (isGroupKey(username)) return 'violet';
  const p = state.profiles.get(username);
  return (p && p.avatarColor) || 'mint';
}

/** A verified account (the checkmark) as far as the client knows. */
function isVerified(username) {
  if (isGroupKey(username)) return false;
  const p = state.profiles.get(username);
  return !!(p && p.verified);
}

/** Show or hide a checkmark badge for the given account. */
function paintBadge(el, username) {
  if (!el) return;
  el.hidden = !isVerified(username);
}

function paintAvatar(el, username, size) {
  el.className = 'avatar' + (size ? ' ' + size : '');
  el.dataset.color = avatarColorFor(username);
  el.textContent = initial(displayNameFor(username));
}

/* -------------------------------- auth UI -------------------------------- */
function setMode(mode, { clearError = true } = {}) {
  state.mode = mode;
  els.authTabs.dataset.active = mode;
  els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  els.fieldConfirm.hidden = mode !== 'register';
  els.btnAuth.textContent = mode === 'register' ? 'Create account' : 'Sign in';
  els.authHint.textContent = mode === 'register'
    ? 'We generate your encryption keys on this device. Your password protects them — it never leaves your device.'
    : 'Your password protects your encryption keys on this device. We can never read your messages.';
  if (clearError) showError(els.authError, null);
}

els.tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.tab)));

els.formAuth.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = els.authUser.value.trim().toLowerCase();
  const password = els.authPass.value;
  const confirm = els.authConfirm.value;
  showError(els.authError, null);

  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return showError(els.authError, 'Username: 3–32 characters, a–z, 0–9 or _');
  }
  if (password.length < 8) {
    return showError(els.authError, 'Password must be at least 8 characters');
  }
  if (state.mode === 'register' && password !== confirm) {
    return showError(els.authError, 'Passwords do not match');
  }

  els.btnAuth.disabled = true;
  els.btnAuth.textContent = state.mode === 'register' ? 'Creating…' : 'Signing in…';
  try {
    await api.connect(els.serverUrl.value.trim());
    if (state.mode === 'register') await api.register({ username, password });
    else await api.login({ username, password });
    els.authPass.value = '';
    els.authConfirm.value = '';
  } catch (err) {
    showError(els.authError, err.message || 'Something went wrong');
  } finally {
    els.btnAuth.disabled = false;
    setMode(state.mode, { clearError: false });
  }
});

els.formUnlock.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.unlockError, null);
  try {
    await api.unlock(els.unlockPass.value);
    els.unlockPass.value = '';
  } catch (err) {
    showError(els.unlockError, err.message || 'Could not unlock');
  }
});

els.btnSwitch.addEventListener('click', async () => {
  await api.logout();
  resetToAuth();
});

function resetToAuth() {
  state.username = null;
  state.profile = null;
  state.unlocked = false;
  state.activePeer = null;
  state.chats.clear();
  state.profiles.clear();
  state.presence.clear();
  els.chatList.innerHTML = '';
  els.archivedList.innerHTML = '';
  els.chatBlank.hidden = false;
  els.chatView.hidden = true;
  renderChatList();
  showScreen('auth');
}

/* -------------------------------- main UI -------------------------------- */
async function enterMain(username) {
  state.username = username;
  state.chats.clear();
  state.profiles.clear();
  state.presence.clear();
  state.groups.clear();
  await refreshStatus();
  showScreen('main');
  await Promise.all([loadChats(), loadGroups(), loadContacts()]);
  renderChatList();
}

async function loadChats() {
  try {
    const rows = await api.listChats();
    for (const row of rows) {
      const key = chatKey(row.peer);
      const chat = ensureChat(key);
      chat.pinned = row.pinned;
      chat.muted = row.muted;
      chat.archived = row.archived;
      chat.unread = row.unread;
      chat.lastTs = row.last ? row.last.ts : 0;
      chat.last = row.last
        ? (row.last.deleted ? 'Message deleted' : 'Encrypted message')
        : '';
      if (row.last && row.last.from && row.last.from !== state.username) chat.hasIncoming = true;
    }
    renderChatList();
    refreshVisibleLastMessages();
  } catch { /* offline: keep whatever we have */ }
}

/** Turn the placeholder previews into readable text for chats we can decrypt. */
async function refreshVisibleLastMessages() {
  for (const [key, chat] of state.chats) {
    if (!chat.lastTs || chat.messages.length) continue;
    try {
      const items = isGroupKey(key)
        ? await api.groupHistory({ groupId: groupIdOf(key), limit: 1 })
        : await api.history({ with: peerUsername(key), limit: 1 });
      const last = items.at(-1);
      if (last) chat.last = previewOf(last);
    } catch { /* leave the placeholder */ }
  }
  renderChatList();
}

/** One-line preview for the chat list, matching the message kind. */
function previewOf(m) {
  if (m.deleted) return 'Message deleted';
  if (m.kind === 'image') return '🖼️ Photo';
  if (m.kind === 'voice') return '🎤 Voice message';
  if (m.kind === 'file') return `📄 ${(m.attachment && m.attachment.name) || 'File'}`;
  return m.text || '';
}

/** Load every group the account belongs to and seed a chat row for each. */
async function loadGroups() {
  try {
    const groups = await api.listGroups();
    for (const g of groups) {
      state.groups.set(g.id, g);
      for (const m of g.members) {
        if (m.profile) state.profiles.set(m.username, m.profile);
        if (typeof m.online === 'boolean') state.presence.set(m.username, m.online);
      }
      ensureChat(groupKey(g.id));
    }
  } catch { /* offline: keep what we have */ }
}

async function loadContacts() {
  try {
    const s = await api.getSettings();
    if (s && Array.isArray(s.contacts)) state.contacts = s.contacts.slice();
  } catch { /* offline: keep what we have */ }
}

/** Persist the contact list into this account's server-side settings. */
async function saveContacts() {
  try { await api.saveSettings({ contacts: state.contacts }); } catch { /* best effort */ }
}

function ensureChat(key) {
  if (!state.chats.has(key)) {
    state.chats.set(key, {
      pinned: false, muted: false, archived: false, unread: 0,
      last: '', lastTs: 0, messages: [], loaded: false
    });
  }
  return state.chats.get(key);
}

function sortedKeys(list) {
  return list.sort((a, b) => {
    const ca = state.chats.get(a);
    const cb = state.chats.get(b);
    if (ca.pinned !== cb.pinned) return ca.pinned ? -1 : 1;
    return (cb.lastTs || 0) - (ca.lastTs || 0);
  });
}

function chatItemEl(key) {
  const chat = state.chats.get(key);
  const peer = peerUsername(key);
  const group = isGroupKey(key);
  const li = document.createElement('li');
  li.className = 'chat-item' + (key === state.activePeer ? ' active' : '');
  li.dataset.peer = key;
  const badge = chat.unread
    ? `<span class="chat-item-badge${chat.muted ? ' muted' : ''}">${chat.unread > 99 ? '99+' : chat.unread}</span>`
    : '';
  const flags = [
    chat.pinned ? '📌' : '',
    chat.muted ? '🔕' : ''
  ].filter(Boolean).join(' ');

  const name = key === SAVED ? 'Saved Messages' : displayNameFor(key);
  const avatarText = group ? '👥' : initial(displayNameFor(key));
  const tick = !group && isVerified(peer) ? '<span class="verified-badge verified-badge-sm" title="Проверенный аккаунт">✓</span>' : '';

  li.innerHTML = `
    <div class="avatar small" data-color="${escapeHtml(avatarColorFor(key))}">${escapeHtml(avatarText)}</div>
    <div class="chat-item-body">
      <div class="chat-item-top">
        <span class="chat-item-name">${escapeHtml(name)}${tick}</span>
        <span class="chat-item-time">${chat.lastTs ? escapeHtml(timeLabel(chat.lastTs)) : ''}</span>
      </div>
      <div class="chat-item-last">${escapeHtml(chat.last || 'No messages yet')}</div>
    </div>
    <div class="chat-item-flags">${flags}${badge}</div>
  `;
  li.addEventListener('click', () => openChat(key));
  return li;
}

function renderChatList() {
  const keys = Array.from(state.chats.keys());
  const active = sortedKeys(keys.filter((k) => !state.chats.get(k).archived));
  const archived = sortedKeys(keys.filter((k) => state.chats.get(k).archived));

  els.chatList.innerHTML = '';
  active.forEach((k) => els.chatList.appendChild(chatItemEl(k)));

  els.archivedList.innerHTML = '';
  archived.forEach((k) => els.archivedList.appendChild(chatItemEl(k)));
  els.sectionArchived.hidden = archived.length === 0;
  els.archivedCount.textContent = String(archived.length);

  if (els.drawerArchivedCount) {
    els.drawerArchivedCount.hidden = archived.length === 0;
    els.drawerArchivedCount.textContent = String(archived.length);
  }

  const total = active.length + archived.length;
  els.chatEmpty.hidden = total > 0;
}

function renderMessageBody(m) {
  if (m.deleted) return '<span class="deleted-text">This message was deleted</span>';
  if (m.kind && m.attachment) {
    const cap = m.text ? `<div class="caption">${escapeHtml(m.text)}</div>` : '';
    return `<div class="att-wrap" data-kind="${escapeHtml(m.kind)}"></div>${cap}`;
  }
  return escapeHtml(m.text);
}

function reactionsHtml(m) {
  if (!m.reactions || !m.reactions.length) return '';
  const grouped = new Map();
  for (const r of m.reactions) {
    grouped.set(r.emoji, (grouped.get(r.emoji) || 0) + 1);
  }
  const chips = Array.from(grouped.entries()).map(([emoji, count]) => {
    const mine = m.reactions.some((r) => r.emoji === emoji && r.username === state.username);
    return `<button class="reaction-chip${mine ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}${count > 1 ? ' ' + count : ''}</button>`;
  }).join('');
  return `<div class="reactions">${chips}</div>`;
}

function quoteHtml(m) {
  if (!m.replyTo || !m.quote) return '';
  return `
    <div class="quote">
      <span class="quote-who">${escapeHtml(m.quote.mine ? 'You' : displayNameFor(m.quote.from))}</span>
      <span class="quote-text">${escapeHtml(m.quote.text || 'Message deleted')}</span>
    </div>`;
}

function messageEl(m) {
  const el = document.createElement('div');
  const hit = state.searchQuery && state.searchHits.includes(m.id);
  const current = hit && state.searchHits[state.searchIndex] === m.id;
  el.className = 'msg ' + (m.mine ? 'out' : 'in')
    + (m.deleted ? ' deleted' : '')
    + (m.pending ? ' pending' : '')
    + (m.failed ? ' failed' : '')
    + (m.kind && m.attachment ? ' has-attachment' : '')
    + (hit ? ' search-hit' : '')
    + (current ? ' search-current' : '');
  el.dataset.id = m.id;
  const meta = [escapeHtml(timeLabel(m.ts))];
  if (m.editedAt) meta.push('<span class="edited">edited</span>');
  if (m.pinned) meta.push('<span class="pinned-mark" title="Pinned">📌</span>');
  const hasMedia = !!(m.kind && m.attachment);
  el.innerHTML = `
    <div class="bubble${hasMedia ? ' has-media' : ''}">${quoteHtml(m)}${renderMessageBody(m)}</div>
    ${reactionsHtml(m)}
    <div class="meta">${meta.join('')}</div>
  `;

  if (hasMedia) {
    const wrap = el.querySelector('.att-wrap');
    if (m.kind === 'image') renderImageAttachment(m, wrap);
    else renderFileAttachment(m, wrap, m.kind);
  }

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (m.pending || m.deleted) return;
    if (state.selecting) { toggleSelected(m.id); return; }
    openContextMenu(m, e.clientX, e.clientY);
  });
  if (state.selecting) {
    el.classList.add('selectable');
    if (state.selecting.has(m.id)) el.classList.add('selected');
    const tick = document.createElement('span');
    tick.className = 'select-tick';
    tick.textContent = state.selecting.has(m.id) ? '✓' : '';
    el.appendChild(tick);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelected(m.id);
    });
  }
  el.querySelectorAll('.reaction-chip').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleReaction(m.id, chip.dataset.emoji);
    });
  });
  return el;
}

function appendMessage(m) {
  els.messages.appendChild(messageEl(m));
  els.messages.scrollTop = els.messages.scrollHeight;
}

function scrollToMessage(id, { smooth = true } = {}) {
  const el = els.messages.querySelector(`.msg[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 900);
}

function findMessage(id) {
  for (const chat of state.chats.values()) {
    const m = chat.messages.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

/**
 * Attach the quoted text to any message that references another one. Live
 * messages resolve their quote as they arrive; messages loaded from history
 * need this pass once the whole page is in memory.
 */
function resolveQuotes(items) {
  const byId = new Map(items.map((m) => [m.id, m]));
  for (const m of items) {
    if (m.replyTo && !m.quote) {
      const orig = byId.get(m.replyTo);
      if (orig) m.quote = { from: orig.from, text: orig.deleted ? 'Message deleted' : orig.text, mine: orig.mine };
    }
  }
  return items;
}

function activeChat() {
  return state.activePeer ? state.chats.get(state.activePeer) : null;
}

/* --------------------------------- chat --------------------------------- */
async function openChat(key) {
  state.activePeer = key;
  const chat = ensureChat(key);
  chat.unread = 0;
  const group = isGroupKey(key);

  els.chatBlank.hidden = true;
  els.chatView.hidden = false;
  els.messages.innerHTML = '';
  clearReply();
  clearEditing();
  closeChatSearch();
  if (state.selecting) exitSelectMode();

  els.peerName.textContent = key === SAVED ? 'Saved Messages' : displayNameFor(key);
  paintBadge(els.peerBadge, key);
  paintAvatar(els.peerAvatar, key);
  updatePeerSub();
  renderChatList();

  if (!chat.loaded) {
    try {
      const items = group
        ? await api.groupHistory({ groupId: groupIdOf(key), limit: 200 })
        : await api.history({ with: peerUsername(key), limit: 200 });
      chat.messages = resolveQuotes(items);
      chat.loaded = true;
      renderMessages();
      const last = items.at(-1);
      if (last) { chat.last = previewOf(last); chat.lastTs = last.ts; }
    } catch (err) {
      appendMessage({ text: '⚠ ' + (err.message || 'Could not load history'), ts: Date.now(), mine: false });
    }
  } else {
    renderMessages();
  }
  if (!group) { try { await api.markRead(peerUsername(key)); } catch { /* best effort */ } }
  updatePinnedBar();
  renderChatList();
  els.composerInput.focus();
}

function renderMessages() {
  const chat = activeChat();
  if (!chat) return;
  els.messages.innerHTML = '';
  let lastDay = null;
  for (const m of chat.messages) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      els.messages.appendChild(sep);
      lastDay = day;
    }
    els.messages.appendChild(messageEl(m));
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function updatePeerSub() {
  const key = state.activePeer;
  if (!key) return;
  if (key === SAVED) {
    els.peerSub.textContent = 'Notes and files only you can read';
    els.peerSub.classList.remove('typing');
    return;
  }
  if (isGroupKey(key)) {
    const g = state.groups.get(groupIdOf(key));
    const n = g ? g.members.length : 0;
    els.peerSub.classList.remove('typing');
    els.peerSub.textContent = `${n} ${n === 1 ? 'участник' : 'участников'} · end-to-end encrypted`;
    return;
  }
  const peer = peerUsername(key);
  const timer = state.typing.get(peer);
  if (timer) {
    els.peerSub.textContent = 'typing…';
    els.peerSub.classList.add('typing');
    return;
  }
  els.peerSub.classList.remove('typing');
  const online = state.presence.get(peer);
  els.peerSub.textContent = online ? 'online' : 'end-to-end encrypted';
}

/* ------------------------------- searching ------------------------------- */
let searchTimer = null;
els.search.addEventListener('input', () => {
  const q = els.search.value.trim();
  els.btnSearchClear.hidden = q.length === 0;
  clearTimeout(searchTimer);
  if (!q) return closeSearchPanel();
  searchTimer = setTimeout(() => runSearch(q), 180);
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { els.search.value = ''; els.btnSearchClear.hidden = true; closeSearchPanel(); }
  if (e.key === 'Enter') {
    const q = els.search.value.trim().toLowerCase();
    if (/^[a-z0-9_]{3,32}$/.test(q)) {
      els.search.value = '';
      els.btnSearchClear.hidden = true;
      closeSearchPanel();
      startChatWith(q);
    }
  }
});

els.btnSearchClear.addEventListener('click', () => {
  els.search.value = '';
  els.btnSearchClear.hidden = true;
  closeSearchPanel();
});

function closeSearchPanel() {
  els.searchPanel.hidden = true;
  els.chatSections.hidden = false;
}

async function runSearch(query) {
  let items = [];
  try { items = await api.searchUsers(query); } catch { items = []; }
  for (const u of items) {
    state.profiles.set(u.username, u);
    state.presence.set(u.username, !!u.online);
  }
  els.searchPanel.hidden = false;
  els.chatSections.hidden = true;
  els.searchResults.innerHTML = '';
  els.searchEmpty.hidden = items.length > 0;

  for (const u of items) {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.dataset.username = u.username;
    li.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(u.avatarColor || 'mint')}">${escapeHtml(initial(u.displayName || u.username))}</div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(u.displayName || u.username)}</span>
        </div>
        <div class="chat-item-last">@${escapeHtml(u.username)}${u.online ? ' · online' : ''}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      els.search.value = '';
      els.btnSearchClear.hidden = true;
      closeSearchPanel();
      startChatWith(u.username);
    });
    els.searchResults.appendChild(li);
  }
}

function startChatWith(username) {
  const key = chatKey(username);
  ensureChat(key);
  renderChatList();
  openChat(key);
}

/* ------------------------------ sending ------------------------------ */
/** Members of a group, used to encrypt one copy per recipient. */
function groupMemberNames(groupId) {
  const g = state.groups.get(groupId);
  return g ? g.members.map((m) => m.username) : [];
}

async function sendCurrentMessage(text) {
  const key = state.activePeer;
  const chat = ensureChat(key);
  const replyTo = state.replyTo;

  const optimistic = {
    id: 'tmp-' + Date.now(), text, ts: Date.now(), mine: true,
    replyTo: replyTo ? replyTo.id : null,
    quote: replyTo ? { from: replyTo.from, text: replyTo.text, mine: replyTo.mine } : null,
    pending: true, reactions: []
  };
  chat.messages.push(optimistic);
  chat.last = text;
  chat.lastTs = optimistic.ts;
  clearReply();
  renderMessages();
  renderChatList();

  try {
    if (isGroupKey(key)) {
      const groupId = groupIdOf(key);
      const res = await api.sendGroup({
        groupId, text, members: groupMemberNames(groupId),
        replyTo: replyTo ? replyTo.id : undefined
      });
      optimistic.id = res.id;
    } else {
      const res = await api.send({ to: peerUsername(key), text, replyTo: replyTo ? replyTo.id : undefined });
      optimistic.id = res.id;
    }
    optimistic.pending = false;
    const el = els.messages.querySelector(`.msg[data-id="${optimistic.id}"]`);
    if (el) el.classList.remove('pending');
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    renderMessages();
    toast(err.message || 'Message not sent');
  }
}

els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text || !state.activePeer) return;

  if (state.editing) {
    const target = state.editing;
    els.composerInput.value = '';
    clearEditing();
    const chat = activeChat();
    const m = chat.messages.find((x) => x.id === target.id);
    if (m) {
      try {
        const res = isGroupKey(state.activePeer)
          ? await api.editGroupMessage({
              id: target.id, groupId: groupIdOf(state.activePeer), text,
              members: groupMemberNames(groupIdOf(state.activePeer))
            })
          : await api.edit({ id: target.id, to: peerUsername(state.activePeer), text });
        m.text = text;
        m.editedAt = res.editedAt;
      } catch (err) {
        m.text = target.original;
        toast(err.message || 'Could not edit');
      }
      renderMessages();
      renderChatList();
    }
    return;
  }

  els.composerInput.value = '';
  await sendCurrentMessage(text);
});

/* typing indicator (throttled) */
let typingSentAt = 0;
els.composerInput.addEventListener('input', () => {
  if (!state.activePeer || state.activePeer === SAVED || isGroupKey(state.activePeer)) return;
  const now = Date.now();
  if (now - typingSentAt < 2500) return;
  typingSentAt = now;
  api.typing({ to: peerUsername(state.activePeer), state: 'start' }).catch(() => {});
});

/* ------------------------------ reply / edit ------------------------------ */
function setReply(m) {
  state.replyTo = {
    id: m.id, text: m.deleted ? 'Message deleted' : m.text, from: m.mine ? state.username : peerUsername(state.activePeer), mine: m.mine
  };
  els.replyBarTitle.textContent = m.mine ? 'Reply to yourself' : `Reply to ${displayNameFor(peerUsername(state.activePeer))}`;
  els.replyBarText.textContent = state.replyTo.text;
  els.replyBar.hidden = false;
  clearEditing();
  els.composerInput.focus();
}

function clearReply() {
  state.replyTo = null;
  els.replyBar.hidden = true;
}

function setEditing(m) {
  state.editing = { id: m.id, original: m.text };
  els.editBarText.textContent = m.text;
  els.editBar.hidden = false;
  els.composerInput.value = m.text;
  clearReply();
  els.composerInput.focus();
}

function clearEditing() {
  state.editing = null;
  els.editBar.hidden = true;
}

els.btnReplyCancel.addEventListener('click', clearReply);
els.btnEditCancel.addEventListener('click', () => { clearEditing(); els.composerInput.value = ''; });

/* ---------------------------- context menu ---------------------------- */
function openContextMenu(m, x, y) {
  const inGroup = isGroupKey(state.activePeer);
  state.ctxTarget = { id: m.id, mine: m.mine, text: m.text, pinned: !!m.pinned, group: inGroup };
  els.ctxEdit.hidden = !m.mine || !!m.kind;
  els.ctxDelete.hidden = !m.mine;
  // Pins and reactions are per-conversation on the relay; groups do not carry
  // them yet, so the menu hides those entries there.
  els.ctxPin.hidden = inGroup;
  els.ctxPinLabel.textContent = m.pinned ? 'Unpin' : 'Pin';
  els.ctxReactions.innerHTML = '';
  if (!inGroup) {
    for (const emoji of QUICK_REACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-reaction';
      b.textContent = emoji;
      b.addEventListener('click', async () => {
        closeContextMenu();
        await toggleReaction(m.id, emoji);
      });
      els.ctxReactions.appendChild(b);
    }
  }
  els.ctxBackdrop.hidden = false;
  const menu = els.ctxMenu;
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 10;
  const maxY = window.innerHeight - rect.height - 10;
  menu.style.left = Math.max(10, Math.min(x, maxX)) + 'px';
  menu.style.top = Math.max(10, Math.min(y, maxY)) + 'px';
}

function closeContextMenu() {
  els.ctxBackdrop.hidden = true;
  state.ctxTarget = null;
}

els.ctxBackdrop.addEventListener('click', (e) => {
  if (e.target === els.ctxBackdrop) closeContextMenu();
});

els.ctxMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('.menu-item');
  if (!btn || !state.ctxTarget) return;
  const { id, mine, text } = state.ctxTarget;
  const action = btn.dataset.action;
  closeContextMenu();

  if (action === 'copy') {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Could not copy'); }
    return;
  }
  if (action === 'reply') {
    const m = findMessage(id);
    if (m) setReply(m);
    return;
  }
  if (action === 'edit') {
    const m = findMessage(id);
    if (m) setEditing(m);
    return;
  }
  if (action === 'pin') {
    const m = findMessage(id);
    if (!m || isGroupKey(state.activePeer)) return;
    try {
      const res = await api.pinMessage({ id, pinned: !m.pinned });
      m.pinned = res.pinned;
      updatePinnedBar();
      renderMessages();
      toast(res.pinned ? 'Pinned' : 'Unpinned');
    } catch (err) {
      toast(err.message || 'Could not pin');
    }
    return;
  }
  if (action === 'forward') {
    const m = findMessage(id);
    if (m) openForward(m);
    return;
  }
  if (action === 'select') {
    const m = findMessage(id);
    if (m) enterSelectMode(m);
    return;
  }
  if (action === 'delete') {
    const ok = await confirmDialog({
      title: 'Delete message?',
      text: 'This message will be removed for both you and the recipient.',
      confirmLabel: 'Delete'
    });
    if (!ok) return;
    try {
      if (isGroupKey(state.activePeer)) await api.deleteGroupMessage({ id });
      else await api.remove(id);
      applyDeleted(id);
      toast('Message deleted');
    } catch (err) {
      toast(err.message || 'Could not delete');
    }
  }
});

/* ---------------------------- reactions ---------------------------- */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];

async function toggleReaction(id, emoji) {
  const m = findMessage(id);
  if (!m) return;
  const mine = (m.reactions || []).find((r) => r.username === state.username);
  const next = mine && mine.emoji === emoji ? '' : emoji;
  try {
    const res = await api.react({ id, emoji: next });
    applyReactions(id, res.reactions);
  } catch (err) {
    toast(err.message || 'Could not react');
  }
}

function applyReactions(id, reactions) {
  const m = findMessage(id);
  if (!m) return;
  m.reactions = reactions;
  if (state.activePeer) renderMessages();
}

function applyDeleted(id) {
  const m = findMessage(id);
  if (!m) return;
  m.deleted = true;
  m.text = '';
  m.reactions = [];
  if (state.activePeer) renderMessages();
}

function applyEdited(id, text, editedAt) {
  const m = findMessage(id);
  if (!m) return;
  m.text = text;
  m.editedAt = editedAt;
  if (state.activePeer) renderMessages();
}

/* ------------------------------ chat menu ------------------------------ */
function openChatMenu() {
  const chat = activeChat();
  if (!chat) return;
  const isSaved = state.activePeer === SAVED;
  els.chatmenuTitle.textContent = isSaved ? 'Saved Messages' : displayNameFor(peerUsername(state.activePeer));
  els.menuPinLabel.textContent = chat.pinned ? 'Unpin' : 'Pin';
  els.menuMuteLabel.textContent = chat.muted ? 'Unmute' : 'Mute';
  els.menuArchiveLabel.textContent = chat.archived ? 'Unarchive' : 'Archive';
  els.chatmenuBody.querySelectorAll('[data-action="delete"]').forEach((b) => { b.hidden = isSaved; });
  els.chatmenuBackdrop.hidden = false;
}

els.btnChatMenu.addEventListener('click', openChatMenu);
els.btnChatmenuClose.addEventListener('click', () => { els.chatmenuBackdrop.hidden = true; });
els.chatmenuBackdrop.addEventListener('click', (e) => {
  if (e.target === els.chatmenuBackdrop) els.chatmenuBackdrop.hidden = true;
});

els.chatmenuBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.menu-item');
  if (!btn) return;
  const action = btn.dataset.action;
  const key = state.activePeer;
  const chat = activeChat();
  if (!key || !chat) return;
  const peer = peerUsername(key);
  els.chatmenuBackdrop.hidden = true;

  try {
    if (action === 'pin') {
      const res = await api.chatSettings({ peer, pinned: !chat.pinned });
      chat.pinned = res.pinned;
      renderChatList();
      toast(res.pinned ? 'Pinned' : 'Unpinned');
    } else if (action === 'mute') {
      const res = await api.chatSettings({ peer, muted: !chat.muted });
      chat.muted = res.muted;
      renderChatList();
      toast(res.muted ? 'Muted' : 'Unmuted');
    } else if (action === 'archive') {
      const res = await api.chatSettings({ peer, archived: !chat.archived });
      chat.archived = res.archived;
      renderChatList();
      toast(res.archived ? 'Archived' : 'Unarchived');
    } else if (action === 'read') {
      chat.unread = 0;
      await api.markRead(peer);
      renderChatList();
      toast('Marked as read');
    } else if (action === 'clear') {
      const ok = await confirmDialog({
        title: 'Clear history?',
        text: 'All messages in this chat will be removed for you. The other person keeps their copy.',
        confirmLabel: 'Clear'
      });
      if (!ok) return;
      await api.clearChat(peer);
      chat.messages = [];
      chat.last = '';
      chat.lastTs = 0;
      renderMessages();
      renderChatList();
      toast('History cleared');
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete chat?',
        text: 'This chat and its history will be removed from your list.',
        confirmLabel: 'Delete'
      });
      if (!ok) return;
      await api.deleteChat(peer);
      state.chats.delete(key);
      state.activePeer = null;
      els.chatBlank.hidden = false;
      els.chatView.hidden = true;
      renderChatList();
      toast('Chat deleted');
    }
  } catch (err) {
    toast(err.message || 'Something went wrong');
  }
});

els.btnArchivedToggle.addEventListener('click', () => {
  const open = els.archivedList.hidden;
  els.archivedList.hidden = !open;
  els.btnArchivedToggle.classList.toggle('open', open);
});

/* ------------------------------- profile ------------------------------- */
function openMyProfile() {
  showProfile(state.username, { self: true });
}

async function showProfile(username, { self = false } = {}) {
  state.profileTarget = username;
  state.editingProfile = false;
  els.profileBackdrop.hidden = false;
  els.profileForm.hidden = true;
  els.profileView.hidden = false;
  els.usernameBlock.hidden = !self;
  els.usernameSep.hidden = !self;
  els.profileTitle.textContent = self ? 'My profile' : 'Profile';
  showError(els.profileError, null);
  showError(els.usernameError, null);
  els.usernameInput.value = '';

  let info = { profile: state.profiles.get(username) || { username, displayName: username, bio: '', avatarColor: 'mint' }, online: state.presence.get(username), isSelf: self };
  try { info = await api.getProfile(username); } catch { /* use cache */ }

  const p = info.profile;
  state.profiles.set(p.username, p);
  if (typeof info.online === 'boolean') state.presence.set(p.username, info.online);
  const isSelf = info.isSelf || self;

  els.profileAvatar.className = 'avatar avatar-xl';
  els.profileAvatar.dataset.color = p.avatarColor || 'mint';
  els.profileAvatar.textContent = initial(p.displayName || p.username);
  els.profileDisplay.textContent = p.displayName || p.username;
  els.profileHandle.textContent = '@' + p.username;
  paintBadge(els.profileBadge, p.username);
  els.profileViewUsername.textContent = p.username;
  els.profileViewBio.textContent = p.bio || '—';
  els.profilePresence.textContent = isSelf ? 'This is you' : (info.online ? 'online' : 'offline');
  els.profilePresence.classList.toggle('online', !isSelf && !!info.online);
  els.profileViewBio.parentElement.hidden = false;

  els.btnProfileMessage.hidden = isSelf;
  els.btnProfileEdit.hidden = !isSelf;
  els.profileActions.hidden = false;

  // Fill the edit form for later use.
  els.profileName.value = p.displayName || '';
  els.profileBio.value = p.bio || '';
  buildSwatches(p.avatarColor || 'mint');
  renderPubkey(p.username);
}

async function renderPubkey(username) {
  els.profilePubkey.textContent = '…';
  try {
    const res = await api.directory(username);
    els.profilePubkey.textContent = res.publicKey || '—';
  } catch {
    els.profilePubkey.textContent = '—';
  }
}

function buildSwatches(selected) {
  els.profileColors.innerHTML = '';
  for (const color of AVATAR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (color === selected ? ' selected' : '');
    b.dataset.color = color;
    b.style.background = `var(--swatch-${color})`;
    b.title = color;
    b.addEventListener('click', () => {
      els.profileColors.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
      b.classList.add('selected');
    });
    els.profileColors.appendChild(b);
  }
}

els.btnMyProfile.addEventListener('click', openMyProfile);
els.btnOpenMyProfile.addEventListener('click', () => { els.settingsBackdrop.hidden = true; openMyProfile(); });
els.btnProfileClose.addEventListener('click', () => { els.profileBackdrop.hidden = true; });
els.profileBackdrop.addEventListener('click', (e) => {
  if (e.target === els.profileBackdrop) els.profileBackdrop.hidden = true;
});
els.btnPeerProfile.addEventListener('click', () => {
  if (!state.activePeer || state.activePeer === SAVED) return;
  showProfile(peerUsername(state.activePeer));
});
els.btnProfileMessage.addEventListener('click', () => {
  const target = state.profileTarget;
  els.profileBackdrop.hidden = true;
  if (target) startChatWith(target);
});

els.btnProfileEdit.addEventListener('click', () => {
  state.editingProfile = true;
  els.profileView.hidden = true;
  els.profileForm.hidden = false;
  els.usernameBlock.hidden = true;
  els.usernameSep.hidden = true;
  showError(els.profileError, null);
  els.profileName.focus();
});

els.btnProfileCancel.addEventListener('click', () => {
  state.editingProfile = false;
  els.profileForm.hidden = true;
  els.profileView.hidden = false;
  els.usernameBlock.hidden = false;
  els.usernameSep.hidden = false;
});

els.profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.profileError, null);
  const selected = els.profileColors.querySelector('.swatch.selected');
  try {
    const p = await api.saveProfile({
      displayName: els.profileName.value,
      bio: els.profileBio.value,
      avatarColor: selected ? selected.dataset.color : undefined
    });
    state.profile = p;
    state.profiles.set(p.username, p);
    applySelfProfile(p);
    state.editingProfile = false;
    els.profileForm.hidden = true;
    els.profileView.hidden = false;
    els.usernameBlock.hidden = false;
    els.usernameSep.hidden = false;
    showProfile(state.username, { self: true });
    toast('Profile saved');
  } catch (err) {
    showError(els.profileError, err.message || 'Could not save profile');
  }
});

els.btnUsernameSave.addEventListener('click', async () => {
  const next = els.usernameInput.value.trim().toLowerCase();
  showError(els.usernameError, null);
  if (!/^[a-z0-9_]{3,32}$/.test(next)) {
    return showError(els.usernameError, 'Username: 3–32 characters, a–z, 0–9 or _');
  }
  if (next === state.username) return showError(els.usernameError, 'That is already your username');
  els.btnUsernameSave.disabled = true;
  try {
    const res = await api.changeUsername(next);
    const old = res.previous;
    state.username = res.username;
    // Re-key Saved Messages and the profile cache to the new name.
    const savedChat = state.chats.get(SAVED);
    if (savedChat) { state.chats.delete(SAVED); state.chats.set(res.username, savedChat); }
    if (state.activePeer === SAVED) state.activePeer = res.username;
    state.profiles.delete(old);
    els.usernameInput.value = '';
    await refreshStatus();
    renderChatList();
    if (state.activePeer) { els.peerName.textContent = displayNameFor(state.activePeer); paintAvatar(els.peerAvatar, state.activePeer); }
    showProfile(res.username, { self: true });
    toast('Username changed to @' + res.username);
  } catch (err) {
    showError(els.usernameError, err.message || 'Could not change username');
  } finally {
    els.btnUsernameSave.disabled = false;
  }
});

function applySelfProfile(p) {
  state.profile = p;
  if (p.username === state.username) {
    els.meName.textContent = p.displayName || p.username;
    els.meAvatar.dataset.color = p.avatarColor || 'mint';
    els.meAvatar.textContent = initial(p.displayName || p.username);
    els.setUsername.textContent = '@' + p.username;
    if (els.setAccountHandle) els.setAccountHandle.textContent = '@' + p.username;
    paintBadge(els.meBadge, p.username);
    if (els.setHeroAvatar) {
      els.setHeroAvatar.dataset.color = p.avatarColor || 'mint';
      els.setHeroAvatar.textContent = initial(p.displayName || p.username);
    }
    if (els.setHeroName) els.setHeroName.textContent = p.displayName || p.username;
    setAdminMode(!!p.admin);
  }
}

/** Show or hide the admin section, and refresh it when it becomes visible. */
function setAdminMode(on) {
  if (state.isAdmin === on) { if (on && state.settingsPane === 'admin') loadAdminPanel(); return; }
  state.isAdmin = on;
  els.settingsNavAdmin.hidden = !on;
  if (!on && state.settingsPane === 'admin') selectSettingsPane('account');
}

/** Tell the user their account was blocked or deleted, and return to sign-in. */
function handleKicked(reason) {
  toast(reason || 'Disconnected by an administrator', 6000);
  state.isAdmin = false;
  els.settingsBackdrop.hidden = true;
  setTimeout(() => { showScreen('auth'); }, 1200);
}

/* ------------------------------- settings ------------------------------- */
els.btnSettings.addEventListener('click', () => {
  els.settingsBackdrop.hidden = false;
  els.setServer.value = els.serverUrl.value;
  if (els.setVersionSub) els.setVersionSub.textContent = `Версия ${els.footVer.textContent.replace(/^v/, '')} · сквозное шифрование`;
  selectSettingsPane(state.settingsPane);
  syncSettingsUI();
  api.status().then((s) => {
    els.setPubkey.textContent = s.publicKey || '—';
    updateConnIndicators(s.online);
  });
});

/** Mirror the stored settings into the settings controls. */
function syncSettingsUI() {
  const s = state.settings;
  els.setNotify.checked = s.notify !== false;
  els.setPreview.checked = s.notifyPreview !== false;
  els.setSound.checked = s.notifySound !== false;
  els.setLastSeen.checked = s.lastSeen !== false;
  els.setReceipts.checked = s.readReceipts !== false;
  els.setAutoLock.value = String(s.autoLock || 0);
  els.setAutoPhoto.checked = s.autoDownloadPhotos !== false;
  els.setKeepMedia.value = s.keepMedia || 'month';
  els.setEnter.checked = s.sendWithEnter !== false;
  els.setLanguage.value = s.language || 'ru';
  els.setChatPreview.checked = s.chatPreview !== false;
  els.setReduceMotion.checked = s.reduceMotion === true;
  els.setEscClose.checked = s.escClose !== false;
  els.setPlainPaste.checked = s.plainPaste === true;
  const blocked = Array.isArray(s.blocked) ? s.blocked : [];
  els.setBlockedSub.textContent = blocked.length ? `${blocked.length} blocked` : 'Никто не заблокирован';
  updateStorageLabel();
}

/* ------------------------- settings navigation ------------------------- */
// Telegram-style: a list of sections on the left, one pane on the right.

function selectSettingsPane(name) {
  state.settingsPane = name;
  els.settingsNav.querySelectorAll('.settings-nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.pane === name);
  });
  els.settingsPanes.querySelectorAll('.settings-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pane === name);
  });
  if (name === 'admin') loadAdminPanel();
}

els.settingsNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-item');
  if (btn) selectSettingsPane(btn.dataset.pane);
});

/** Render the admin summary and user table from the relay. */
async function loadAdminPanel() {
  if (!state.isAdmin) return;
  els.adminUsers.innerHTML = '<p class="panel-empty">Загрузка…</p>';
  try {
    const [{ stats, announcements }, users] = await Promise.all([
      api.adminOverview(),
      api.adminUsers()
    ]);
    els.adminStats.innerHTML = `
      <div class="admin-stat"><span class="admin-stat-num">${stats.users}</span><span class="admin-stat-label">Пользователей</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.online}</span><span class="admin-stat-label">Онлайн</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.messages}</span><span class="admin-stat-label">Сообщений</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.groups}</span><span class="admin-stat-label">Групп</span></div>
    `;
    renderAdminUsers(users);
    if (announcements.length) {
      toast(`Объявлений в истории: ${announcements.length}`, 2500);
    }
  } catch (err) {
    els.adminUsers.innerHTML = '';
    els.adminUsersEmpty.hidden = false;
    els.adminUsersEmpty.textContent = err.message || 'Не удалось загрузить панель';
  }
}

function renderAdminUsers(users) {
  els.adminUsers.innerHTML = '';
  els.adminUsersEmpty.hidden = users.length > 0;
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'admin-user';
    const flags = [
      u.admin ? '<span class="admin-tag">админ</span>' : '',
      u.verified ? '<span class="admin-tag verified">✓</span>' : '',
      u.banned ? '<span class="admin-tag banned">заблокирован</span>' : '',
      u.online ? '<span class="admin-tag online">онлайн</span>' : ''
    ].filter(Boolean).join(' ');
    row.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(u.avatarColor || 'mint')}">${escapeHtml(initial(u.displayName || u.username))}</div>
      <div class="admin-user-body">
        <div class="admin-user-name">${escapeHtml(u.displayName || u.username)} ${flags}</div>
        <div class="admin-user-sub">@${escapeHtml(u.username)} · ${u.sent} сообщ.</div>
      </div>
      <div class="admin-user-actions">
        <button class="admin-act" data-act="verify" data-user="${escapeHtml(u.username)}" title="Галочка">✓</button>
        <button class="admin-act" data-act="grantAdmin" data-user="${escapeHtml(u.username)}" title="Админ">🛡️</button>
        <button class="admin-act" data-act="ban" data-user="${escapeHtml(u.username)}" title="Блокировка">🚫</button>
        <button class="admin-act danger" data-act="delete" data-user="${escapeHtml(u.username)}" title="Удалить">🗑️</button>
      </div>
    `;
    els.adminUsers.appendChild(row);
  }
}

els.adminUsers.addEventListener('click', async (e) => {
  const btn = e.target.closest('.admin-act');
  if (!btn) return;
  const { act, user } = btn.dataset;
  if (act === 'delete') {
    const ok = await confirmDialog({
      title: 'Удалить аккаунт?',
      text: `Аккаунт @${user} и все его сообщения будут удалены безвозвратно.`,
      confirmLabel: 'Удалить'
    });
    if (!ok) return;
  }
  try {
    await api.adminAction({ action: act, username: user });
    toast('Готово');
    loadAdminPanel();
  } catch (err) {
    toast(err.message || 'Не удалось выполнить действие');
  }
});

els.btnAdminAnnounce.addEventListener('click', async () => {
  const text = els.adminAnnounceInput.value.trim();
  if (!text) return;
  try {
    await api.adminAction({ action: 'announce', text });
    els.adminAnnounceInput.value = '';
    toast('Объявление отправлено');
  } catch (err) {
    toast(err.message || 'Не удалось отправить объявление');
  }
});

function playTestSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch { /* audio is unavailable in some environments */ }
}
els.btnTestSound.addEventListener('click', playTestSound);

/** Approximate the local cache footprint from attachment sizes we know about. */
function updateStorageLabel() {
  let bytes = 0;
  for (const chat of state.chats.values()) {
    for (const m of chat.messages) {
      if (m.attachment && m.attachment.size) bytes += m.attachment.size;
    }
  }
  els.setStorage.textContent = bytes ? humanSize(bytes) : 'Nothing cached';
}

/** Wire one settings toggle to a boolean key on the account settings. */
function bindToggle(el, key, invert = false) {
  el.addEventListener('change', async () => {
    await persistSettings({ [key]: invert ? !el.checked : el.checked });
  });
}
bindToggle(els.setNotify, 'notify');
bindToggle(els.setPreview, 'notifyPreview');
bindToggle(els.setSound, 'notifySound');
bindToggle(els.setLastSeen, 'lastSeen');
bindToggle(els.setReceipts, 'readReceipts');
bindToggle(els.setAutoPhoto, 'autoDownloadPhotos');
bindToggle(els.setEnter, 'sendWithEnter');
bindToggle(els.setChatPreview, 'chatPreview');
bindToggle(els.setEscClose, 'escClose');
bindToggle(els.setPlainPaste, 'plainPaste');

// "Reduce motion" is applied straight to the document, not just stored.
els.setReduceMotion.addEventListener('change', async () => {
  document.documentElement.classList.toggle('reduce-motion', els.setReduceMotion.checked);
  await persistSettings({ reduceMotion: els.setReduceMotion.checked });
});

els.btnReconnect.addEventListener('click', async () => {
  try {
    await api.connect(els.setServer.value.trim() || els.serverUrl.value.trim());
    toast('Переподключено');
  } catch {
    toast('Не удалось подключиться');
  }
});

els.btnCheckUpdates.addEventListener('click', () => {
  toast('У вас последняя версия');
});

els.btnResetSettings.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Сбросить настройки?',
    text: 'Все настройки вернутся к значениям по умолчанию.',
    confirmLabel: 'Сбросить'
  });
  if (!ok) return;
  await persistSettings({
    notify: true, notifyPreview: true, notifySound: true, lastSeen: true,
    readReceipts: true, autoDownloadPhotos: true, sendWithEnter: true,
    chatPreview: true, escClose: true, plainPaste: false, reduceMotion: false,
    autoLock: 0, keepMedia: 'month', blocked: []
  });
  document.documentElement.classList.remove('reduce-motion');
  syncSettingsUI();
  toast('Настройки сброшены');
});

els.setAutoLock.addEventListener('change', async () => {
  await persistSettings({ autoLock: Number(els.setAutoLock.value) || 0 });
});
els.setKeepMedia.addEventListener('change', async () => {
  await persistSettings({ keepMedia: els.setKeepMedia.value });
});
els.setLanguage.addEventListener('change', async () => {
  await persistSettings({ language: els.setLanguage.value });
});

els.btnClearCache.addEventListener('click', async () => {
  for (const chat of state.chats.values()) {
    for (const m of chat.messages) { delete m.dataUrl; }
  }
  renderMessages();
  updateStorageLabel();
  toast('Кэш очищен');
});

els.btnBlocked.addEventListener('click', async () => {
  const blocked = Array.isArray(state.settings.blocked) ? state.settings.blocked.slice() : [];
  const who = (await promptDialog({
    title: 'Заблокировать пользователя',
    label: 'Ник (@username), пусто — разблокировать всех',
    value: blocked.join(', '),
    confirmLabel: 'Сохранить'
  }));
  if (who === null) return;
  const list = who.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  await persistSettings({ blocked: list });
  syncSettingsUI();
  toast(list.length ? 'Список блокировок обновлён' : 'Никто не заблокирован');
});
els.btnSettingsClose.addEventListener('click', () => { els.settingsBackdrop.hidden = true; });
els.settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.settingsBackdrop) els.settingsBackdrop.hidden = true;
});

els.btnOpenSaved.addEventListener('click', () => {
  els.settingsBackdrop.hidden = true;
  startChatWith(state.username);
});

els.btnApplyServer.addEventListener('click', async () => {
  const url = els.setServer.value.trim();
  els.serverUrl.value = url;
  try {
    await api.connect(url);
    toast('Server updated');
  } catch {
    toast('Could not reach server');
  }
});

els.btnLogout.addEventListener('click', async () => {
  els.settingsBackdrop.hidden = true;
  await api.logout();
  resetToAuth();
  toast('Signed out, local keys erased');
});

/* ------------------------------- confirm ------------------------------- */
let confirmResolve = null;
function confirmDialog({ title, text, confirmLabel, cancelLabel }) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.btnConfirmYes.textContent = confirmLabel || 'Confirm';
  els.btnConfirmNo.textContent = cancelLabel || 'Cancel';
  els.confirmBackdrop.hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function settleConfirm(value) {
  els.confirmBackdrop.hidden = true;
  if (confirmResolve) { confirmResolve(value); confirmResolve = null; }
}
els.btnConfirmYes.addEventListener('click', () => settleConfirm(true));
els.btnConfirmNo.addEventListener('click', () => settleConfirm(false));
els.confirmBackdrop.addEventListener('click', (e) => {
  if (e.target === els.confirmBackdrop) settleConfirm(false);
});

/* ------------------------------- prompt -------------------------------- */
let promptResolve = null;
function promptDialog({ title, label, value, confirmLabel }) {
  els.promptTitle.textContent = title || 'Enter a value';
  els.promptLabel.textContent = label || 'Value';
  els.promptInput.value = value || '';
  els.btnPromptOk.textContent = confirmLabel || 'Save';
  els.promptBackdrop.hidden = false;
  els.promptInput.focus();
  els.promptInput.select();
  return new Promise((resolve) => { promptResolve = resolve; });
}
function settlePrompt(value) {
  els.promptBackdrop.hidden = true;
  if (promptResolve) { promptResolve(value); promptResolve = null; }
}
els.btnPromptOk.addEventListener('click', () => settlePrompt(els.promptInput.value));
els.btnPromptCancel.addEventListener('click', () => settlePrompt(null));
els.promptBackdrop.addEventListener('click', (e) => {
  if (e.target === els.promptBackdrop) settlePrompt(null);
});
els.promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); settlePrompt(els.promptInput.value); }
  if (e.key === 'Escape') settlePrompt(null);
});

/* ------------------------------- status ------------------------------- */
function updateConnIndicators(online) {
  state.online = online;
  els.authConn.classList.toggle('on', online);
  els.authConn.classList.toggle('off', !online);
  els.setConnDot.classList.toggle('on', online);
  els.setConnDot.classList.toggle('off', !online);
  els.setConn.textContent = online ? 'Connected' : 'Offline';
  els.meState.textContent = online ? (state.unlocked ? 'online' : 'locked') : 'offline';
  const dot = document.querySelector('.me-status .dot');
  if (dot) dot.classList.toggle('on', online);
}

async function refreshStatus() {
  const s = await api.status();
  state.username = s.username || state.username;
  state.unlocked = s.unlocked;
  if (s.profile) { state.profile = s.profile; state.profiles.set(s.profile.username, s.profile); }
  if (state.username) {
    els.setUsername.textContent = '@' + state.username;
    if (s.profile) applySelfProfile(s.profile);
    else {
      els.meName.textContent = state.username;
      els.meAvatar.textContent = initial(state.username);
    }
  }
  els.setPubkey.textContent = s.publicKey || '—';
  updateConnIndicators(s.online);
}

/* -------------------------------- events -------------------------------- */
api.onEvent((evt) => {
  switch (evt.type) {
    case 'connection':
      updateConnIndicators(evt.state === 'online');
      if (evt.state === 'online' && state.unlocked) loadChats();
      break;

    case 'session':
      if (evt.state === 'unlocked') {
        state.unlocked = true;
        enterMain(evt.username);
      } else if (evt.state === 'locked') {
        state.username = evt.username;
        els.unlockUser.textContent = `Unlock your vault, ${evt.username}.`;
        showScreen('unlock');
      } else if (evt.state === 'signed-out') {
        showScreen('auth');
      }
      break;

    case 'profile':
      state.profiles.set(evt.username, evt.profile);
      if (evt.username === state.username) applySelfProfile(evt.profile);
      renderChatList();
      if (state.activePeer && peerUsername(state.activePeer) === evt.username) {
        els.peerName.textContent = displayNameFor(evt.username);
        paintBadge(els.peerBadge, evt.username);
        paintAvatar(els.peerAvatar, evt.username);
      }
      if (state.profileTarget === evt.username) showProfile(evt.username, { self: evt.username === state.username });
      break;

    case 'announcement':
      toast(`📣 ${evt.from}: ${evt.text}`, 6000);
      break;

    case 'kicked':
      handleKicked(evt.reason);
      break;

    case 'key':
      if (evt.profile) state.profiles.set(evt.username, evt.profile);
      if (typeof evt.online === 'boolean') state.presence.set(evt.username, evt.online);
      updatePeerSub();
      break;

    case 'presence':
      state.presence.set(evt.username, evt.online);
      updatePeerSub();
      break;

    case 'typing': {
      const peer = evt.from;
      const existing = state.typing.get(peer);
      if (existing) clearTimeout(existing);
      if (evt.state === 'start') {
        const t = setTimeout(() => { state.typing.delete(peer); updatePeerSub(); }, 4000);
        state.typing.set(peer, t);
      } else {
        state.typing.delete(peer);
      }
      updatePeerSub();
      break;
    }

    case 'message': {
      const key = chatKey(evt.from);
      const chat = ensureChat(key);
      const m = {
        id: evt.id, text: evt.text, ts: evt.ts, mine: false,
        replyTo: evt.replyTo || null, reactions: [],
        kind: evt.kind || null, attachment: evt.attachment || null
      };
      if (m.replyTo) {
        const orig = findMessage(m.replyTo);
        if (orig) m.quote = { from: orig.mine ? state.username : evt.from, text: orig.text, mine: orig.mine };
      }
      chat.messages.push(m);
      chat.last = m.kind === 'image' ? '🖼️ Photo'
        : m.kind === 'voice' ? '🎤 Voice message'
        : m.kind === 'file' ? `📄 ${(m.attachment && m.attachment.name) || 'File'}`
        : evt.text;
      chat.lastTs = evt.ts;
      if (state.activePeer === key) {
        renderMessages();
        updatePinnedBar();
        api.markRead(peerUsername(key)).catch(() => {});
      } else {
        chat.unread += 1;
        if (!chat.muted) notifyNewMessage(evt.from, evt.text);
      }
      renderChatList();
      break;
    }

    case 'pinned': {
      const key = chatKey(evt.peer);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) m.pinned = evt.pinned;
      }
      if (state.activePeer === key) { renderMessages(); updatePinnedBar(); }
      break;
    }

    case 'edited': {
      const key = chatKey(evt.from === state.username ? (evt.peer || state.activePeer) : evt.from);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.text = evt.text; m.editedAt = evt.editedAt; }
        if (chat.lastTs && m && chat.messages.at(-1) === m) chat.last = evt.text;
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'deleted': {
      for (const [key, chat] of state.chats) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.deleted = true; m.text = ''; m.reactions = []; if (state.activePeer === key) renderMessages(); break; }
      }
      renderChatList();
      break;
    }

    case 'reactions':
      applyReactions(evt.id, evt.reactions);
      break;

    case 'queued':
      toast(`New encrypted message from ${evt.from}`);
      break;

    case 'group.message': {
      const key = groupKey(evt.groupId);
      const chat = ensureChat(key);
      const m = {
        id: evt.id, text: evt.text, ts: evt.ts, mine: evt.from === state.username,
        replyTo: evt.replyTo || null, reactions: [],
        kind: evt.kind || null, attachment: evt.attachment || null
      };
      if (m.replyTo) {
        const orig = findMessage(m.replyTo);
        if (orig) m.quote = { from: orig.mine ? state.username : orig.from, text: orig.text, mine: orig.mine };
      }
      chat.messages.push(m);
      chat.last = previewOf(m);
      chat.lastTs = evt.ts;
      if (state.activePeer === key) {
        renderMessages();
        api.markRead(peerUsername(key)).catch(() => {});
      } else {
        chat.unread += 1;
        if (!chat.muted) notifyNewMessage(evt.from, evt.text);
      }
      renderChatList();
      break;
    }

    case 'group.edited': {
      const key = groupKey(evt.groupId);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.text = evt.text; m.editedAt = evt.editedAt; }
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'group.deleted': {
      const key = groupKey(evt.groupId);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.deleted = true; m.text = ''; m.reactions = []; }
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'group.updated': {
      const g = evt.group;
      if (g) {
        state.groups.set(g.id, g);
        for (const mem of g.members) {
          if (mem.profile) state.profiles.set(mem.username, mem.profile);
        }
        ensureChat(groupKey(g.id));
      }
      if (evt.left === state.username) {
        // We were removed or left; drop the chat row.
        state.chats.delete(groupKey(g ? g.id : evt.groupId));
        if (state.activePeer && groupIdOf(state.activePeer) === (g ? g.id : evt.groupId)) {
          state.activePeer = null;
          els.chatView.hidden = true;
          els.chatBlank.hidden = false;
        }
      }
      updatePeerSub();
      renderChatList();
      break;
    }

    case 'group.queued':
      toast('New encrypted group message');
      break;

    default:
      break;
  }
});

/* ============================ attachments ============================ */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fileToBase64Bytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsArrayBuffer(file);
  });
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      resolve(file || null);
    });
    input.click();
  });
}

async function attachFile(kind, file) {
  if (!file || !state.activePeer) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    toast(`Too large — the limit is ${humanSize(MAX_ATTACHMENT_BYTES)}`);
    return;
  }
  let bytes;
  try {
    bytes = await fileToBase64Bytes(file);
  } catch (err) {
    toast(err.message || 'Could not read the file');
    return;
  }
  await sendWithAttachment({
    kind, bytes,
    name: file.name || (kind === 'voice' ? 'voice-message' : 'file'),
    mime: file.type || 'application/octet-stream',
    duration: null,
    preview: kind === 'image' ? URL.createObjectURL(file) : null
  });
}

async function sendWithAttachment(att) {
  const key = state.activePeer;
  const chat = ensureChat(key);
  const replyTo = state.replyTo;
  const caption = els.composerInput.value.trim();
  els.composerInput.value = '';

  const optimistic = {
    id: 'tmp-' + Date.now(), text: caption, ts: Date.now(), mine: true,
    replyTo: replyTo ? replyTo.id : null,
    quote: replyTo ? { from: replyTo.from, text: replyTo.text, mine: replyTo.mine } : null,
    pending: true, reactions: [],
    kind: att.kind,
    attachment: { kind: att.kind, name: att.name, mime: att.mime, size: att.bytes.length, duration: att.duration },
    previewUrl: att.preview || null
  };
  chat.messages.push(optimistic);
  chat.last = att.kind === 'image' ? '🖼️ Photo' : (att.kind === 'voice' ? '🎤 Voice message' : `📄 ${att.name}`);
  chat.lastTs = optimistic.ts;
  clearReply();
  renderMessages();
  renderChatList();

  try {
    const res = isGroupKey(key)
      ? await api.sendGroup({
          groupId: groupIdOf(key), text: caption, members: groupMemberNames(groupIdOf(key)),
          replyTo: replyTo ? replyTo.id : undefined,
          attachment: { kind: att.kind, bytes: att.bytes, name: att.name, mime: att.mime, duration: att.duration }
        })
      : await api.send({
          to: peerUsername(key), text: caption, replyTo: replyTo ? replyTo.id : undefined,
          attachment: { kind: att.kind, bytes: att.bytes, name: att.name, mime: att.mime, duration: att.duration }
        });
    optimistic.id = res.id;
    optimistic.pending = false;
    optimistic.attachment = res.attachment || optimistic.attachment;
    renderMessages();
    renderChatList();
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    renderMessages();
    toast(err.message || 'Could not send the attachment');
  }
}

/** Fetch an attachment's bytes for display, whether it is a DM or a group message. */
async function fetchAttachment(m) {
  if (isGroupKey(state.activePeer)) return api.openGroupAttachment({ id: m.id });
  const peer = m.mine ? peerUsername(state.activePeer) : peerUsername(chatKey(m.from));
  return api.openAttachment({ id: m.id, peer });
}

/** Render an image attachment, decrypting it lazily the first time it is shown. */
function renderImageAttachment(m, wrap) {
  const img = document.createElement('img');
  img.className = 'att-image loading';
  img.alt = m.attachment.name || 'image';
  if (m.previewUrl) {
    img.src = m.previewUrl;
    img.classList.remove('loading');
  } else if (m.dataUrl) {
    img.src = m.dataUrl;
    img.classList.remove('loading');
  } else {
    img.addEventListener('click', async () => {
      if (img.dataset.loaded) return;
      try {
        const res = await fetchAttachment(m);
        m.dataUrl = res.dataUrl;
        img.src = res.dataUrl;
        img.classList.remove('loading');
        img.dataset.loaded = '1';
      } catch (err) {
        toast(err.message || 'Could not open the image');
      }
    });
  }
  wrap.appendChild(img);
}

function renderFileAttachment(m, wrap, kind) {
  const box = document.createElement('div');
  box.className = kind === 'voice' ? 'att-voice' : 'att-file';
  const ico = kind === 'voice' ? '🎤' : '📄';
  const sizeLabel = kind === 'voice' && m.attachment.duration
    ? `${m.attachment.duration}s`
    : humanSize(m.attachment.size);
  box.innerHTML = `
    <span class="att-ico">${ico}</span>
    <span class="att-meta">
      <span class="att-name">${escapeHtml(m.attachment.name || (kind === 'voice' ? 'Voice message' : 'File'))}</span>
      <span class="att-size">${escapeHtml(sizeLabel)}</span>
    </span>
    <button class="att-dl" type="button">Open</button>
  `;
  box.querySelector('.att-dl').addEventListener('click', async () => {
    try {
      const res = await fetchAttachment(m);
      const a = document.createElement('a');
      a.href = res.dataUrl;
      a.download = res.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast(err.message || 'Could not open the file');
    }
  });
  wrap.appendChild(box);
}

/* ============================== emoji ============================== */
const EMOJI_GROUPS = [
  { icon: '😀', label: 'Smileys', items: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤗','🤔','🤨','😐','😑','😶','😏','😒','🙄','😬','😴','😌','😔','😪','🤤','😷','🤒','🤕','🤢','🥶','🥵','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','💀','💩','🤡','👻','👽','🤖'] },
  { icon: '👍', label: 'Gestures', items: ['👍','👎','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','💪','🦾','✍️','💅','👏','🙌','👐','🤲','🤜','🤛','✊','👊'] },
  { icon: '❤️', label: 'Hearts', items: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💋','💌'] },
  { icon: '🔥', label: 'Symbols', items: ['🔥','✨','⭐','🌟','💫','⚡','💥','💯','✅','❌','❗','❓','⚠️','🎉','🎊','🎁','🏆','🥇','🎯','📌','📎','🔔','🔕','🔒','🔓','🕐','⏰','☀️','🌙','☁️','🌈','💧','❄️'] },
  { icon: '🍕', label: 'Food', items: ['🍕','🍔','🍟','🌭','🍿','🍩','🍪','🎂','🍰','🍫','🍬','🍭','🍎','🍌','🍇','🍓','🍉','🍊','🥑','🥕','🍞','🧀','🥚','🍗','🍖','🍜','🍚','🍣','🍤','☕','🍵','🧃','🥤','🍺','🍻','🥂'] },
  { icon: '⚽', label: 'Activity', items: ['⚽','🏀','🏈','⚾','🎾','🏐','🏓','🏸','🥊','🎯','🎮','🎲','🎸','🎹','🎺','🎻','🥁','🎤','🎧','🎬','📷','🚗','✈️','🚀','🚲','⛰️','🏝️','🌍','🗺️','🧭'] }
];

function buildEmojiPanel() {
  els.emojiTabs.innerHTML = '';
  els.emojiGrid.innerHTML = '';
  EMOJI_GROUPS.forEach((group, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-tab' + (i === 0 ? ' active' : '');
    tab.textContent = group.icon;
    tab.title = group.label;
    tab.addEventListener('click', () => {
      els.emojiTabs.querySelectorAll('.emoji-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderEmojiGrid(group);
    });
    els.emojiTabs.appendChild(tab);
  });
  renderEmojiGrid(EMOJI_GROUPS[0]);
}

function renderEmojiGrid(group) {
  els.emojiGrid.innerHTML = '';
  for (const emoji of group.items) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'emoji-cell';
    cell.textContent = emoji;
    cell.addEventListener('click', () => {
      const input = els.composerInput;
      const start = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(input.selectionEnd ?? start);
      input.selectionStart = input.selectionEnd = start + emoji.length;
      input.focus();
    });
    els.emojiGrid.appendChild(cell);
  }
}

els.btnEmoji.addEventListener('click', () => {
  els.emojiPanel.hidden = !els.emojiPanel.hidden;
  els.attachBackdrop.hidden = true;
});

/* ------------------------------ stickers ------------------------------ */
// Stickers are sent as small images: a 128px PNG rendered from an emoji, so the
// picture travels through the same encrypted attachment path as a photo. No new
// wire format is needed, and the relay still only ever sees ciphertext.

const STICKERS = [
  { name: 'wink', emoji: '😉', tint: '#FFD37A' },
  { name: 'heart', emoji: '❤️', tint: '#F2668A' },
  { name: 'laugh', emoji: '😂', tint: '#57E3B4' },
  { name: 'cool', emoji: '😎', tint: '#3BA8FF' },
  { name: 'cry', emoji: '😭', tint: '#8A6BFF' },
  { name: 'angry', emoji: '😡', tint: '#FF6B6B' },
  { name: 'party', emoji: '🥳', tint: '#B79BFF' },
  { name: 'fire', emoji: '🔥', tint: '#F0A93B' },
  { name: 'star', emoji: '⭐', tint: '#FFD37A' },
  { name: 'rocket', emoji: '🚀', tint: '#3BA8FF' },
  { name: 'ghost', emoji: '👻', tint: '#93A1B5' },
  { name: 'clap', emoji: '👏', tint: '#C6F07A' },
  { name: 'think', emoji: '🤔', tint: '#7BE8E8' },
  { name: 'sleep', emoji: '😴', tint: '#B79BFF' },
  { name: 'cat', emoji: '🐱', tint: '#FFB08A' },
  { name: 'cake', emoji: '🎂', tint: '#F2668A' }
];

/** Draw one sticker to a 128x128 PNG data URL. */
function renderStickerDataUrl(sticker) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, sticker.tint);
  grad.addColorStop(1, 'rgba(20, 25, 34, 0.85)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(6, 6, size - 12, size - 12, 26);
  } else {
    ctx.rect(6, 6, size - 12, size - 12);
  }
  ctx.fill();
  ctx.font = '64px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(sticker.emoji, size / 2, size / 2 + 4);
  return canvas.toDataURL('image/png');
}

function buildStickerPanel() {
  els.stickerGrid.innerHTML = '';
  for (const sticker of STICKERS) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'sticker-cell';
    cell.title = sticker.name;
    const img = document.createElement('img');
    img.src = renderStickerDataUrl(sticker);
    img.alt = sticker.name;
    cell.appendChild(img);
    cell.addEventListener('click', async () => {
      els.emojiPanel.hidden = true;
      const dataUrl = renderStickerDataUrl(sticker);
      const base64 = dataUrl.split(',')[1];
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await sendWithAttachment({
        kind: 'image', bytes,
        name: `${sticker.name}.png`, mime: 'image/png',
        duration: null, preview: dataUrl
      });
    });
    els.stickerGrid.appendChild(cell);
  }
}

function setPanelMode(mode) {
  els.panelSwitch.querySelectorAll('.panel-switch-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  els.emojiMode.hidden = mode !== 'emoji';
  els.stickerMode.hidden = mode !== 'stickers';
}

els.panelSwitch.addEventListener('click', (e) => {
  const tab = e.target.closest('.panel-switch-tab');
  if (tab) setPanelMode(tab.dataset.mode);
});
els.btnAttach.addEventListener('click', () => {
  els.attachBackdrop.hidden = !els.attachBackdrop.hidden;
  els.emojiPanel.hidden = true;
});
els.attachBackdrop.addEventListener('click', (e) => {
  if (e.target === els.attachBackdrop) els.attachBackdrop.hidden = true;
});
els.attachMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-attach]');
  if (!btn) return;
  const kind = btn.dataset.attach;
  els.attachBackdrop.hidden = true;
  const file = await pickFile(kind === 'image' ? 'image/*' : undefined);
  if (file) await attachFile(kind === 'image' ? 'image' : 'file', file);
});

/* ---------------------------- voice notes ---------------------------- */
els.btnVoice.addEventListener('click', async () => {
  if (state.recording) {
    state.recording.recorder.stop();
    return;
  }
  if (!state.activePeer) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Voice recording is not available on this device');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone permission was denied');
    return;
  }
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  const startedAt = Date.now();
  state.recording = { recorder, stream, startedAt };
  els.btnVoice.classList.add('recording');
  els.btnVoice.title = 'Stop recording';
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
  recorder.addEventListener('stop', async () => {
    stream.getTracks().forEach((t) => t.stop());
    els.btnVoice.classList.remove('recording');
    els.btnVoice.title = 'Voice message';
    state.recording = null;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (!blob.size) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await sendWithAttachment({
      kind: 'voice', bytes, name: `voice-${seconds}s.webm`,
      mime: 'audio/webm', duration: seconds, preview: null
    });
  });
  recorder.start();
  toast('Recording… tap the microphone again to send');
});

/* =========================== in-chat search =========================== */
function openChatSearch() {
  els.chatSearchBar.hidden = false;
  els.chatSearchInput.focus();
  els.chatSearchInput.select();
}

function closeChatSearch() {
  els.chatSearchBar.hidden = true;
  els.chatSearchInput.value = '';
  els.chatSearchCount.textContent = '';
  state.searchQuery = '';
  state.searchHits = [];
  state.searchIndex = -1;
  if (state.activePeer) renderMessages();
}

async function runChatSearch(query) {
  state.searchQuery = query;
  state.searchHits = [];
  state.searchIndex = -1;
  if (!query) { els.chatSearchCount.textContent = ''; renderMessages(); return; }
  if (!state.activePeer) return;
  const chat = activeChat();
  const needle = query.toLowerCase();
  // Search what is already loaded; pull more history so older matches appear.
  if (chat && !chat.loaded) {
    try {
      const items = await api.history({ with: peerUsername(state.activePeer), limit: 300 });
      chat.messages = resolveQuotes(items);
      chat.loaded = true;
    } catch { /* keep what we have */ }
  }
  const hits = [];
  for (const m of (chat ? chat.messages : [])) {
    if (m.deleted) continue;
    const text = (m.text || '').toLowerCase();
    const name = m.attachment && m.attachment.name ? m.attachment.name.toLowerCase() : '';
    if (text.includes(needle) || name.includes(needle)) hits.push(m.id);
  }
  state.searchHits = hits;
  state.searchIndex = hits.length ? hits.length - 1 : -1;
  els.chatSearchCount.textContent = hits.length ? `${hits.length} found` : 'none';
  renderMessages();
  if (hits.length) scrollToMessage(hits[state.searchIndex], { smooth: false });
}

let chatSearchTimer = null;
els.btnChatSearch.addEventListener('click', () => {
  if (els.chatSearchBar.hidden) openChatSearch(); else closeChatSearch();
});
els.btnChatSearchClose.addEventListener('click', closeChatSearch);
els.chatSearchInput.addEventListener('input', () => {
  clearTimeout(chatSearchTimer);
  const q = els.chatSearchInput.value.trim();
  chatSearchTimer = setTimeout(() => runChatSearch(q), 200);
});
els.chatSearchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !state.searchHits.length) return;
  e.preventDefault();
  state.searchIndex = (state.searchIndex - 1 + state.searchHits.length) % state.searchHits.length;
  scrollToMessage(state.searchHits[state.searchIndex]);
  renderMessages();
});

/* ============================ pinned banner ============================ */
function updatePinnedBar() {
  const chat = activeChat();
  const pinned = chat ? chat.messages.filter((m) => m.pinned && !m.deleted) : [];
  if (!pinned.length) { els.pinnedBar.hidden = true; return; }
  const top = pinned[pinned.length - 1];
  els.pinnedTitle.textContent = top.mine ? 'Pinned message · you' : `Pinned message · ${displayNameFor(peerUsername(chatKey(top.from || state.username)))}`;
  els.pinnedText.textContent = top.attachment && !top.text
    ? (top.attachment.name ? `📎 ${top.attachment.name}` : '📎 Attachment')
    : (top.text || 'Message');
  els.pinnedBar.hidden = false;
  els.pinnedBar.onclick = () => scrollToMessage(top.id);
}

els.btnPinnedUnpin.addEventListener('click', async (e) => {
  e.stopPropagation();
  const chat = activeChat();
  const pinned = chat ? chat.messages.filter((m) => m.pinned) : [];
  if (!pinned.length) return;
  const top = pinned[pinned.length - 1];
  try {
    await api.pinMessage({ id: top.id, pinned: false });
    top.pinned = false;
    updatePinnedBar();
    renderMessages();
    toast('Unpinned');
  } catch (err) {
    toast(err.message || 'Could not unpin');
  }
});

/* ============================ appearance ============================ */
const WALLPAPERS = ['none', 'dots', 'grid', 'sunset', 'mint'];

function applyTheme(theme) {
  state.settings.theme = theme;
  document.body.classList.toggle('theme-light', theme === 'light');
  els.setThemeSub.textContent = theme === 'light' ? 'Light' : 'Dark';
  els.btnThemeToggle.textContent = theme === 'light' ? 'Dark' : 'Light';
}

function applyWallpaper(wallpaper) {
  state.settings.wallpaper = wallpaper;
  for (const name of WALLPAPERS) {
    els.chatView.classList.toggle('wallpaper-' + name, name === wallpaper);
  }
  els.wallpaperPicker.querySelectorAll('.wallpaper-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.wallpaper === wallpaper);
  });
}

function buildWallpaperPicker() {
  els.wallpaperPicker.innerHTML = '';
  for (const name of WALLPAPERS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'wallpaper-swatch' + (name === state.settings.wallpaper ? ' active' : '');
    sw.dataset.wallpaper = name;
    sw.title = name;
    sw.innerHTML = `<span>${name}</span>`;
    sw.addEventListener('click', async () => {
      applyWallpaper(name);
      await persistSettings({ wallpaper: name });
    });
    els.wallpaperPicker.appendChild(sw);
  }
}

async function persistSettings(patch) {
  try {
    const saved = await api.saveSettings(patch);
    state.settings = { ...state.settings, ...saved };
  } catch { /* settings are cosmetic; keep the local value */ }
}

els.btnThemeToggle.addEventListener('click', async () => {
  const next = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await persistSettings({ theme: next });
});

/** Flip the theme from the drawer without opening Settings. */
async function toggleTheme() {
  const next = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await persistSettings({ theme: next });
  toast(next === 'light' ? 'Светлая тема' : 'Тёмная тема');
}

async function loadAppearance() {
  try {
    const s = await api.getSettings();
    if (s && typeof s === 'object') state.settings = { ...state.settings, ...s };
  } catch { /* defaults are fine */ }
  applyTheme(state.settings.theme === 'light' ? 'light' : 'dark');
  applyWallpaper(WALLPAPERS.includes(state.settings.wallpaper) ? state.settings.wallpaper : 'none');
  buildWallpaperPicker();
  document.documentElement.classList.toggle('reduce-motion', state.settings.reduceMotion === true);
}

/* ============================ forward / select ============================ */
function otherChatKeys() {
  return Array.from(state.chats.keys()).filter((k) => k !== state.activePeer);
}

function openForward(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const keys = otherChatKeys();
  els.forwardList.innerHTML = '';
  els.forwardEmpty.hidden = keys.length > 0;
  for (const key of sortedKeys(keys.slice())) {
    const peer = peerUsername(key);
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(avatarColorFor(peer))}">${escapeHtml(initial(displayNameFor(peer)))}</div>
      <div class="chat-item-body">
        <div class="chat-item-top"><span class="chat-item-name">${escapeHtml(key === SAVED ? 'Saved Messages' : displayNameFor(peer))}</span></div>
      </div>
    `;
    li.addEventListener('click', async () => {
      els.forwardBackdrop.hidden = true;
      await forwardTo(key, list);
    });
    els.forwardList.appendChild(li);
  }
  els.forwardBackdrop.hidden = false;
}

async function forwardTo(key, messages) {
  const target = peerUsername(key);
  let sent = 0;
  for (const m of messages) {
    try {
      if (m.kind && m.attachment) {
        // Re-encrypt the bytes for the new recipient rather than reusing the box.
        const res = await api.openAttachment({
          id: m.id, peer: m.mine ? peerUsername(state.activePeer) : peerUsername(chatKey(m.from))
        });
        const bytes = await dataUrlToBytes(res.dataUrl);
        await api.send({
          to: target, text: m.text || '',
          attachment: { kind: m.kind, bytes, name: m.attachment.name, mime: m.attachment.mime, duration: m.attachment.duration }
        });
      } else if (m.text) {
        await api.send({ to: target, text: m.text });
      }
      sent += 1;
    } catch (err) {
      toast(err.message || 'Could not forward');
      break;
    }
  }
  if (sent) toast(`Forwarded ${sent} message${sent > 1 ? 's' : ''}`);
  exitSelectMode();
}

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function enterSelectMode(firstMessage) {
  state.selecting = new Set(firstMessage ? [firstMessage.id] : []);
  els.selectBar.hidden = false;
  renderMessages();
}

function exitSelectMode() {
  state.selecting = null;
  els.selectBar.hidden = true;
  if (state.activePeer) renderMessages();
}

function toggleSelected(id) {
  if (!state.selecting) return;
  if (state.selecting.has(id)) state.selecting.delete(id); else state.selecting.add(id);
  els.selectCount.textContent = `${state.selecting.size} selected`;
  renderMessages();
}

function selectedMessages() {
  const chat = activeChat();
  if (!chat || !state.selecting) return [];
  return chat.messages.filter((m) => state.selecting.has(m.id));
}

els.btnSelectCancel.addEventListener('click', exitSelectMode);
els.btnSelectForward.addEventListener('click', () => {
  const chosen = selectedMessages();
  if (!chosen.length) return;
  openForward(chosen);
});
els.btnSelectDelete.addEventListener('click', async () => {
  const chosen = selectedMessages().filter((m) => m.mine);
  if (!chosen.length) { toast('You can only delete your own messages'); return; }
  const ok = await confirmDialog({
    title: `Delete ${chosen.length} message${chosen.length > 1 ? 's' : ''}?`,
    text: 'They will be removed for both you and the recipient.',
    confirmLabel: 'Delete'
  });
  if (!ok) return;
  for (const m of chosen) {
    try { await api.remove(m.id); applyDeleted(m.id); } catch { /* keep going */ }
  }
  exitSelectMode();
  toast('Deleted');
});

/* ------------------------------ shortcuts ------------------------------ */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.attachBackdrop.hidden) return void (els.attachBackdrop.hidden = true);
    if (!els.emojiPanel.hidden) return void (els.emojiPanel.hidden = true);
    if (!els.ctxBackdrop.hidden) return closeContextMenu();
    if (!els.confirmBackdrop.hidden) return settleConfirm(false);
    if (!els.forwardBackdrop.hidden) return void (els.forwardBackdrop.hidden = true);
    if (!els.profileBackdrop.hidden) return void (els.profileBackdrop.hidden = true);
    if (!els.chatmenuBackdrop.hidden) return void (els.chatmenuBackdrop.hidden = true);
    if (!els.settingsBackdrop.hidden) return void (els.settingsBackdrop.hidden = true);
    if (state.selecting) return exitSelectMode();
    if (!els.chatSearchBar.hidden) return closeChatSearch();
    if (state.editing) return clearEditing();
    if (state.replyTo) return clearReply();
  }
});

/* ============================== drawer ============================== */
function openDrawer() {
  els.drawer.hidden = false;
  els.drawerBackdrop.hidden = false;
  paintAvatar(els.drawerAvatar, state.username);
  els.drawerName.textContent = displayNameFor(state.username);
  els.drawerHandle.textContent = '@' + (state.username || '—');
  els.drawerAccountsCount.hidden = state.accounts.length <= 1;
  els.drawerAccountsCount.textContent = String(state.accounts.length);
  els.drawerVer.textContent = els.footVer ? els.footVer.textContent : 'v0.4.0';
}

function closeDrawer() {
  els.drawer.hidden = true;
  els.drawerBackdrop.hidden = true;
}

els.btnMenu.addEventListener('click', async () => {
  try { state.accounts = await api.listAccounts(); } catch { /* keep cached */ }
  openDrawer();
});
els.drawerBackdrop.addEventListener('click', closeDrawer);

els.drawer.addEventListener('click', (e) => {
  const item = e.target.closest('.drawer-item');
  if (!item) return;
  const action = item.dataset.drawer;
  closeDrawer();

  if (action === 'accounts') openAccounts();
  else if (action === 'my-profile') openMyProfile();
  else if (action === 'create') openCreateMenu();
  else if (action === 'contacts') openContacts();
  else if (action === 'saved') startChatWith(state.username);
  else if (action === 'settings') els.btnSettings.click();
  else if (action === 'new-chat') { els.search.value = ''; els.btnSearchClear.hidden = true; els.search.focus(); }
  else if (action === 'archived') {
    els.sectionArchived.hidden = false;
    els.archivedList.hidden = false;
    els.sectionArchived.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else if (action === 'theme') {
    toggleTheme();
  }
});

/* --------------------------- create menu --------------------------- */
async function openCreateMenu() {
  const choice = await confirmDialog({
    title: 'Создать',
    text: 'Новый аккаунт на этом устройстве или новая группа?',
    confirmLabel: 'Новый аккаунт',
    cancelLabel: 'Новая группа'
  });
  if (choice === true) { await api.logout().catch(() => {}); resetToAuth(); }
  else if (choice === false) openGroupModal();
}

/* ---------------------------- accounts ---------------------------- */
async function openAccounts() {
  try { state.accounts = await api.listAccounts(); } catch { /* keep cached */ }
  renderAccounts();
  els.accountsBackdrop.hidden = false;
}

function renderAccounts() {
  els.accountsList.innerHTML = '';
  for (const acc of state.accounts) {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.dataset.username = acc.username;
    row.innerHTML = `
      <span class="avatar tiny" data-color="${escapeHtml(avatarColorFor(acc.username))}">${escapeHtml(initial(acc.username))}</span>
      <span class="drawer-label">${escapeHtml(displayNameFor(acc.username))}</span>
      ${acc.active ? '<span class="drawer-badge">активный</span>' : ''}
      <button class="icon-btn" data-forget="${escapeHtml(acc.username)}" title="Убрать с устройства">✕</button>
    `;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-forget]')) return;
      if (acc.active) { els.accountsBackdrop.hidden = true; return; }
      await switchToAccount(acc.username);
    });
    els.accountsList.appendChild(row);
  }
}

els.accountsList.addEventListener('click', async (e) => {
  const forget = e.target.closest('[data-forget]');
  if (!forget) return;
  const username = forget.dataset.forget;
  const ok = await confirmDialog({
    title: 'Убрать аккаунт?',
    text: `@${username} будет удалён с этого устройства. Ключи пропадут — сообщения нельзя будет прочитать без пароля на другом устройстве.`,
    confirmLabel: 'Убрать'
  });
  if (!ok) return;
  try {
    const res = await api.forgetAccount(username);
    state.accounts = await api.listAccounts();
    if (res.switched) {
      els.accountsBackdrop.hidden = true;
      await restartSession();
    } else {
      renderAccounts();
    }
    toast('Аккаунт удалён с устройства');
  } catch (err) {
    toast(err.message || 'Не удалось удалить аккаунт');
  }
});

els.btnAccountsAdd.addEventListener('click', async () => {
  els.accountsBackdrop.hidden = true;
  await api.logout().catch(() => {});
  resetToAuth();
  toast('Войдите или создайте аккаунт');
});

els.btnAccountsClose.addEventListener('click', () => { els.accountsBackdrop.hidden = true; });
els.accountsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.accountsBackdrop) els.accountsBackdrop.hidden = true;
});

async function switchToAccount(username) {
  try {
    const res = await api.switchAccount(username);
    state.accounts = await api.listAccounts();
    els.accountsBackdrop.hidden = true;
    await restartSession();
    toast(`Аккаунт @${res.username}`);
  } catch (err) {
    toast(err.message || 'Не удалось переключить аккаунт');
  }
}

/** Re-read the active identity and route to the right screen after a switch. */
async function restartSession() {
  state.chats.clear();
  state.profiles.clear();
  state.presence.clear();
  state.groups.clear();
  state.activePeer = null;
  els.chatList.innerHTML = '';
  els.archivedList.innerHTML = '';
  els.messages.innerHTML = '';
  els.chatView.hidden = true;
  els.chatBlank.hidden = false;
  const s = await api.status();
  if (s.username && !s.unlocked) {
    els.unlockUser.textContent = `Unlock your vault, ${s.username}.`;
    showScreen('unlock');
  } else if (s.username && s.unlocked) {
    await enterMain(s.username);
  } else {
    resetToAuth();
  }
}

/* ---------------------------- contacts ---------------------------- */
async function openContacts() {
  await loadContacts();
  renderContacts();
  els.contactError.hidden = true;
  els.contactsBackdrop.hidden = false;
}

function renderContacts() {
  els.contactsList.innerHTML = '';
  els.contactsEmpty.hidden = state.contacts.length > 0;
  for (const username of state.contacts) {
    const row = document.createElement('div');
    row.className = 'menu-item contact-row';
    row.innerHTML = `
      <span class="avatar tiny" data-color="${escapeHtml(avatarColorFor(username))}">${escapeHtml(initial(displayNameFor(username)))}</span>
      <span class="contact-name">${escapeHtml(displayNameFor(username))}</span>
      <span class="contact-handle">@${escapeHtml(username)}</span>
      <button class="icon-btn" data-remove="${escapeHtml(username)}" title="Удалить">✕</button>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      els.contactsBackdrop.hidden = true;
      startChatWith(username);
    });
    els.contactsList.appendChild(row);
  }
}

els.contactsList.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  state.contacts = state.contacts.filter((u) => u !== remove.dataset.remove);
  renderContacts();
  await saveContacts();
});

els.btnContactAdd.addEventListener('click', async () => {
  const username = els.contactInput.value.trim().toLowerCase();
  els.contactError.hidden = true;
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    els.contactError.textContent = 'Ник: 3–32 символа a–z, 0–9, _';
    els.contactError.hidden = false;
    return;
  }
  if (username === state.username) {
    els.contactError.textContent = 'Это вы.';
    els.contactError.hidden = false;
    return;
  }
  if (state.contacts.includes(username)) {
    els.contactError.textContent = 'Уже в контактах.';
    els.contactError.hidden = false;
    return;
  }
  try {
    const key = await api.directory(username);
    if (key && key.profile) state.profiles.set(key.username, key.profile);
    state.contacts.push(username);
    state.contacts.sort();
    els.contactInput.value = '';
    renderContacts();
    await saveContacts();
    toast('Контакт добавлен');
  } catch (err) {
    els.contactError.textContent = err.message || 'Пользователь не найден';
    els.contactError.hidden = false;
  }
});

els.contactInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.btnContactAdd.click(); }
});

els.btnContactsClose.addEventListener('click', () => { els.contactsBackdrop.hidden = true; });
els.contactsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.contactsBackdrop) els.contactsBackdrop.hidden = true;
});

/* --------------------------- create group --------------------------- */
function openGroupModal() {
  els.groupName.value = '';
  els.groupMembers.value = state.contacts.join(', ');
  els.groupError.hidden = true;
  els.groupBackdrop.hidden = false;
  els.groupName.focus();
}

els.btnGroupClose.addEventListener('click', () => { els.groupBackdrop.hidden = true; });
els.groupBackdrop.addEventListener('click', (e) => {
  if (e.target === els.groupBackdrop) els.groupBackdrop.hidden = true;
});

els.btnGroupCreate.addEventListener('click', async () => {
  const name = els.groupName.value.trim();
  const members = els.groupMembers.value
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  els.groupError.hidden = true;
  if (!name) {
    els.groupError.textContent = 'Введите название группы';
    els.groupError.hidden = false;
    return;
  }
  try {
    const group = await api.createGroup({ name, members });
    state.groups.set(group.id, group);
    for (const m of group.members) {
      if (m.profile) state.profiles.set(m.username, m.profile);
    }
    els.groupBackdrop.hidden = true;
    ensureChat(groupKey(group.id));
    renderChatList();
    openChat(groupKey(group.id));
    toast('Группа создана');
  } catch (err) {
    els.groupError.textContent = err.message || 'Не удалось создать группу';
    els.groupError.hidden = false;
  }
});

/* --------------------------------- boot --------------------------------- */
(async function boot() {
  setMode('login');
  buildEmojiPanel();
  buildStickerPanel();
  loadAppearance();
  const s = await api.status();
  if (s.serverUrl) {
    els.serverUrl.value = s.serverUrl;
    els.setServer.value = s.serverUrl;
  }
  updateConnIndicators(s.online);
  if (s.username && !s.unlocked) {
    els.unlockUser.textContent = `Unlock your vault, ${s.username}.`;
    showScreen('unlock');
  } else if (s.username && s.unlocked) {
    enterMain(s.username);
  } else {
    showScreen('auth');
  }
})();
