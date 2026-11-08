'use strict';

/**
 * SleePhy UI. Talks to the main process through window.sleephy only.
 * No key material or plaintext crypto happens here.
 */

const api = window.sleephy;

/* --------------------------- element helpers --------------------------- */
const $ = (id) => document.getElementById(id);

const els = {
  screens: {
    auth: $('screen-auth'),
    unlock: $('screen-unlock'),
    main: $('screen-main')
  },
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

  meName: $('me-name'),
  meAvatar: $('me-avatar'),
  meState: $('me-state'),
  search: $('search'),
  chatList: $('chat-list'),
  chatEmpty: $('chat-empty'),
  btnSettings: $('btn-settings'),

  chatBlank: $('chat-blank'),
  chatView: $('chat-view'),
  peerName: $('peer-name'),
  peerAvatar: $('peer-avatar'),
  peerSub: $('peer-sub'),
  messages: $('messages'),
  composer: $('composer'),
  composerInput: $('composer-input'),

  settingsBackdrop: $('settings-backdrop'),
  btnSettingsClose: $('btn-settings-close'),
  setUsername: $('set-username'),
  setConn: $('set-conn'),
  setConnDot: $('set-conn-dot'),
  setServer: $('set-server'),
  btnApplyServer: $('btn-apply-server'),
  setPubkey: $('set-pubkey'),
  btnLogout: $('btn-logout'),

  toast: $('toast')
};

/* ------------------------------- state ------------------------------- */
const state = {
  mode: 'login', // login | register
  username: null,
  online: false,
  unlocked: false,
  activePeer: null,
  chats: new Map(), // username -> { last, unread, messages: [] }
  seen: new Set()
};

/* ------------------------------ utilities ------------------------------ */
function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) {
    el.classList.toggle('active', key === name);
  }
}

function showError(el, message) {
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = message;
  el.hidden = false;
  // retrigger the shake animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, 2600);
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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
  state.username = null;
  state.unlocked = false;
  state.chats.clear();
  state.seen.clear();
  renderChatList();
  showScreen('auth');
});

/* -------------------------------- main UI -------------------------------- */
function enterMain(username) {
  state.username = username;
  els.meName.textContent = username;
  els.meAvatar.textContent = initial(username);
  els.setUsername.textContent = username;
  showScreen('main');
  refreshStatus();
}

function ensureChat(peer) {
  if (!state.chats.has(peer)) {
    state.chats.set(peer, { last: '', unread: 0, messages: [] });
  }
  return state.chats.get(peer);
}

function renderChatList() {
  const peers = Array.from(state.chats.keys())
    .sort((a, b) => {
      const la = state.chats.get(a).messages.at(-1)?.ts || 0;
      const lb = state.chats.get(b).messages.at(-1)?.ts || 0;
      return lb - la;
    });

  els.chatList.innerHTML = '';
  els.chatEmpty.hidden = peers.length > 0;

  peers.forEach((peer) => {
    const chat = state.chats.get(peer);
    const li = document.createElement('li');
    li.className = 'chat-item' + (peer === state.activePeer ? ' active' : '');
    li.dataset.peer = peer;
    li.innerHTML = `
      <div class="avatar small">${escapeHtml(initial(peer))}</div>
      <div class="chat-item-body">
        <div class="chat-item-name">${escapeHtml(peer)}</div>
        <div class="chat-item-last">${escapeHtml(chat.last || 'No messages yet')}</div>
      </div>
      ${chat.unread ? `<span class="chat-item-badge">${chat.unread}</span>` : ''}
    `;
    li.addEventListener('click', () => openChat(peer));
    els.chatList.appendChild(li);
  });
}

function appendMessage({ text, ts, mine }) {
  const el = document.createElement('div');
  el.className = 'msg ' + (mine ? 'out' : 'in');
  el.innerHTML = `
    <div class="bubble">${escapeHtml(text)}</div>
    <div class="meta">${timeLabel(ts)}</div>
  `;
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function openChat(peer) {
  state.activePeer = peer;
  const chat = ensureChat(peer);
  chat.unread = 0;

  els.chatBlank.hidden = true;
  els.chatView.hidden = false;
  els.peerName.textContent = peer;
  els.peerAvatar.textContent = initial(peer);
  els.peerSub.textContent = 'end-to-end encrypted';
  els.messages.innerHTML = '';
  renderChatList();

  if (chat.messages.length === 0) {
    try {
      const items = await api.history({ with: peer, limit: 200 });
      chat.messages = items;
      items.forEach((m) => appendMessage({ text: m.text, ts: m.ts, mine: m.mine }));
      const last = items.at(-1);
      chat.last = last ? last.text : '';
      renderChatList();
    } catch (err) {
      appendMessage({ text: '⚠ ' + (err.message || 'Could not load history'), ts: Date.now(), mine: false });
    }
  } else {
    chat.messages.forEach((m) => appendMessage({ text: m.text, ts: m.ts, mine: m.mine }));
  }
  els.composerInput.focus();
}

function startChatWith(username) {
  ensureChat(username);
  renderChatList();
  openChat(username);
}

els.search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const value = els.search.value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(value)) return toast('Enter a valid username');
  if (value === state.username) return toast('That is you');
  els.search.value = '';
  startChatWith(value);
});

els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text || !state.activePeer) return;
  els.composerInput.value = '';
  const chat = ensureChat(state.activePeer);
  const optimistic = { text, ts: Date.now(), mine: true };
  chat.messages.push(optimistic);
  chat.last = text;
  appendMessage(optimistic);
  renderChatList();
  try {
    await api.send({ to: state.activePeer, text });
  } catch (err) {
    appendMessage({ text: '⚠ ' + (err.message || 'Message not sent'), ts: Date.now(), mine: false });
  }
});

/* ------------------------------- settings ------------------------------- */
els.btnSettings.addEventListener('click', () => {
  els.settingsBackdrop.hidden = false;
  els.setServer.value = els.serverUrl.value;
  api.status().then((s) => {
    els.setPubkey.textContent = s.publicKey || '—';
    updateConnIndicators(s.online);
  });
});
els.btnSettingsClose.addEventListener('click', () => { els.settingsBackdrop.hidden = true; });
els.settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.settingsBackdrop) els.settingsBackdrop.hidden = true;
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
  state.username = null;
  state.unlocked = false;
  state.activePeer = null;
  state.chats.clear();
  state.seen.clear();
  els.chatList.innerHTML = '';
  els.chatBlank.hidden = false;
  els.chatView.hidden = true;
  renderChatList();
  showScreen('auth');
  toast('Signed out, local keys erased');
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
  if (state.username) {
    els.meName.textContent = state.username;
    els.meAvatar.textContent = initial(state.username);
    els.setUsername.textContent = state.username;
  }
  els.setPubkey.textContent = s.publicKey || '—';
  updateConnIndicators(s.online);
}

/* -------------------------------- events -------------------------------- */
api.onEvent((evt) => {
  switch (evt.type) {
    case 'connection':
      updateConnIndicators(evt.state === 'online');
      break;
    case 'session':
      if (evt.state === 'unlocked') {
        state.unlocked = true;
        enterMain(evt.username);
        refreshStatus();
      } else if (evt.state === 'locked') {
        state.username = evt.username;
        els.unlockUser.textContent = `Unlock your vault, ${evt.username}.`;
        showScreen('unlock');
      } else if (evt.state === 'signed-out') {
        showScreen('auth');
      }
      break;
    case 'message': {
      const chat = ensureChat(evt.from);
      chat.messages.push({ text: evt.text, ts: evt.ts, mine: false });
      chat.last = evt.text;
      if (state.activePeer === evt.from) {
        appendMessage({ text: evt.text, ts: evt.ts, mine: false });
      } else {
        chat.unread += 1;
      }
      renderChatList();
      break;
    }
    case 'queued':
      toast(`New encrypted message from ${evt.from}`);
      break;
    case 'key':
      break;
    default:
      break;
  }
});

/* --------------------------------- boot --------------------------------- */
(async function boot() {
  setMode('login');
  const s = await api.status();
  // Show the address the app will actually use, not a hardcoded one.
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
