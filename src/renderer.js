const SERVERS = [
  { flag: '🇳🇱', name: 'Netherlands, Amsterdam', ip: '185.24.9.11', ping: 24 },
  { flag: '🇩🇪', name: 'Germany, Frankfurt', ip: '185.24.9.42', ping: 31 },
  { flag: '🇫🇷', name: 'France, Paris', ip: '185.24.9.77', ping: 38 },
  { flag: '🇬🇧', name: 'United Kingdom, London', ip: '185.24.9.90', ping: 45 },
  { flag: '🇺🇸', name: 'United States, New York', ip: '185.24.9.130', ping: 92 }
];

const PROTOCOLS = ['WireGuard', 'OpenVPN', 'VLESS'];

// Works in Electron (window.belka) and falls back to localStorage in a plain browser.
const bridge = window.belka || {
  minimize() {}, close() {},
  getConfig: async () => ({ engine: 'wireguard', text: localStorage.getItem('belka.config') || '' }),
  setConfig: async (cfg) => { localStorage.setItem('belka.config', cfg.text); return { ok: true }; },
  connect: async () => ({ ok: true }),
  disconnect: async () => ({ ok: true }),
  onEvent() {}
};

const app = document.getElementById('app');
const $ = (id) => document.getElementById(id);

const el = {
  statusTitle: $('statusTitle'),
  statusSub: $('statusSub'),
  powerBtn: $('powerBtn'),
  cta: $('cta'),
  timerLabel: $('timerLabel'),
  timerValue: $('timerValue'),
  curFlag: $('curFlag'),
  curName: $('curName'),
  curIp: $('curIp'),
  curPing: $('curPing'),
  serverDropBtn: $('serverDropBtn'),
  serverList: $('serverList'),
  quickGrid: $('quickGrid'),
  protoBtn: $('protoBtn'),
  protoList: $('protoList'),
  encText: $('encText'),
  killToggle: $('killToggle'),
  configModal: $('configModal'),
  configInput: $('configInput')
};

let state = 'disconnected'; // disconnected | connecting | connected
let currentServer = SERVERS[0];
let currentProto = 'WireGuard';
let sessionStart = null;
let lastSessionSeconds = 0;
let timerHandle = null;
let connectTimeout = null;
let hasConfig = false;

/* ---------------- Timer ---------------- */
function fmt(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function startTimer() {
  sessionStart = Date.now();
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    el.timerValue.textContent = fmt(Math.floor((Date.now() - sessionStart) / 1000));
  }, 1000);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
  if (sessionStart) {
    lastSessionSeconds = Math.floor((Date.now() - sessionStart) / 1000);
    sessionStart = null;
  }
}

/* ---------------- State machine ---------------- */
function setState(next) {
  state = next;
  app.dataset.state = next;

  if (next === 'connected') {
    el.statusTitle.textContent = "You're protected";
    el.statusSub.textContent = 'Your traffic is encrypted and private';
    el.cta.textContent = 'Click to disconnect';
    el.timerLabel.textContent = 'CONNECTED FOR';
    el.encText.textContent = 'Traffic encrypted';
    startTimer();
  } else if (next === 'connecting') {
    el.statusTitle.textContent = 'Connecting...';
    el.statusSub.textContent = `Establishing tunnel via ${currentProto}`;
    el.cta.textContent = 'Please wait';
  } else {
    el.statusTitle.textContent = 'VPN is off';
    el.statusSub.textContent = 'Your traffic is not protected';
    el.cta.textContent = 'Click to connect';
    el.timerLabel.textContent = 'LAST SESSION';
    el.timerValue.textContent = fmt(lastSessionSeconds);
    el.encText.textContent = 'Not encrypted';
  }
}

async function toggleConnection() {
  if (state === 'connecting') return;

  if (state === 'connected') {
    stopTimer();
    await bridge.disconnect();
    setState('disconnected');
    return;
  }

  if (!hasConfig) { openModal(); return; }

  setState('connecting');
  const res = await bridge.connect({ engine: currentProto.toLowerCase() });

  clearTimeout(connectTimeout);
  connectTimeout = setTimeout(() => {
    if (res && res.ok) {
      setState('connected');
    } else {
      setState('disconnected');
      el.statusSub.textContent = (res && res.error) || 'Connection failed';
    }
  }, 1200);
}

/* ---------------- Dropdowns ---------------- */
function applyServer(s) {
  currentServer = s;
  el.curFlag.textContent = s.flag;
  el.curName.textContent = s.name;
  el.curIp.textContent = s.ip;
  el.curPing.textContent = `${s.ping} ms`;
}

function renderServerList() {
  el.serverList.innerHTML = '';
  SERVERS.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'drop-item';
    row.innerHTML = `<span>${s.flag}</span><span>${s.name}</span><span class="p">${s.ping} ms</span>`;
    row.addEventListener('click', () => { applyServer(s); closeDropdowns(); });
    el.serverList.appendChild(row);
  });
}

function renderQuickGrid() {
  el.quickGrid.innerHTML = '';
  [SERVERS[1], SERVERS[2]].forEach((s) => {
    const card = document.createElement('div');
    card.className = 'quick-card';
    card.innerHTML = `<span>${s.flag}</span><div><div class="qc-name">${s.name.split(', ')[1]}</div><div class="qc-ping">${s.ping} ms</div></div>`;
    card.addEventListener('click', () => applyServer(s));
    el.quickGrid.appendChild(card);
  });
}

function renderProtoList() {
  el.protoList.innerHTML = '';
  PROTOCOLS.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'drop-item';
    row.textContent = p;
    row.addEventListener('click', () => { currentProto = p; el.protoBtn.textContent = `${p} ⌵`; closeDropdowns(); });
    el.protoList.appendChild(row);
  });
}

function closeDropdowns() {
  el.serverList.classList.remove('open');
  el.protoList.classList.remove('open');
  el.serverDropBtn.classList.remove('open');
}

/* ---------------- Modal ---------------- */
function openModal() {
  el.configModal.hidden = false;
  requestAnimationFrame(() => el.configModal.classList.add('show'));
  el.configInput.focus();
}
function closeModal() {
  el.configModal.classList.remove('show');
  setTimeout(() => { el.configModal.hidden = true; }, 250);
}

/* ---------------- Wire up ---------------- */
el.powerBtn.addEventListener('click', toggleConnection);

el.serverDropBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = el.serverList.classList.contains('open');
  closeDropdowns();
  if (!open) { el.serverList.classList.add('open'); el.serverDropBtn.classList.add('open'); }
});

el.protoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = el.protoList.classList.contains('open');
  closeDropdowns();
  if (!open) el.protoList.classList.add('open');
});

el.killToggle.addEventListener('click', () => {
  const on = el.killToggle.getAttribute('aria-checked') === 'true';
  el.killToggle.setAttribute('aria-checked', String(!on));
});

$('settingsBtn').addEventListener('click', openModal);
$('configCancel').addEventListener('click', closeModal);
$('configSave').addEventListener('click', async () => {
  const text = el.configInput.value.trim();
  await bridge.setConfig({ engine: currentProto.toLowerCase(), text });
  hasConfig = !!text;
  closeModal();
});
$('minBtn').addEventListener('click', () => bridge.minimize());
$('closeBtn').addEventListener('click', () => bridge.close());
$('allLocations').addEventListener('click', (e) => {
  e.preventDefault();
  const open = el.serverList.classList.contains('open');
  closeDropdowns();
  if (!open) { el.serverList.classList.add('open'); el.serverDropBtn.classList.add('open'); }
});

document.addEventListener('click', closeDropdowns);
el.configModal.addEventListener('click', (e) => { if (e.target === el.configModal) closeModal(); });

bridge.onEvent((data) => {
  if (data && data.type === 'error') {
    setState('disconnected');
    el.statusSub.textContent = data.error;
  }
});

/* ---------------- Init ---------------- */
async function init() {
  renderServerList();
  renderQuickGrid();
  renderProtoList();
  setState('disconnected');

  const cfg = await bridge.getConfig();
  hasConfig = !!(cfg && cfg.text && cfg.text.trim());
  if (cfg && cfg.text) el.configInput.value = cfg.text;
  if (!hasConfig) setTimeout(openModal, 400);
}
init();
