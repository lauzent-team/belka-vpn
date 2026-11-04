const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

let mainWindow = null;
let tunnelProcess = null;

const TUNNEL_NAME = 'belka0';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 780,
    minWidth: 380,
    minHeight: 640,
    frame: false,
    resizable: true,
    backgroundColor: '#12161A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopTunnel();
  if (process.platform !== 'darwin') app.quit();
});

/* ---------- Credential storage (user-scoped, 0600) ---------- */
function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return { engine: 'wireguard', text: '' };
  }
}

function writeConfig(cfg) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
}

/* ---------- Engine binary resolution ---------- */
function binPath(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', exe),
    path.join(__dirname, 'bin', exe)
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/* ---------- Tunnel control ---------- */
function stopTunnel() {
  if (!tunnelProcess) return;
  try {
    if (process.platform === 'win32') {
      const wg = binPath('wireguard') || 'wireguard.exe';
      spawnSync(wg, ['/uninstalltunnelservice', TUNNEL_NAME], { windowsHide: true });
    } else {
      tunnelProcess.kill();
    }
  } catch { /* ignore */ }
  tunnelProcess = null;
}

function startWireGuard(configText) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belka-'));
  const confPath = path.join(tmpDir, `${TUNNEL_NAME}.conf`);
  fs.writeFileSync(confPath, configText, { mode: 0o600 });

  if (process.platform === 'win32') {
    // Official WireGuard for Windows installs a tunnel service (needs admin).
    const wg = binPath('wireguard') || 'wireguard.exe';
    tunnelProcess = spawn(wg, ['/installtunnelservice', confPath], { windowsHide: true, stdio: 'ignore' });
  } else {
    const wgGo = binPath('wireguard-go') || 'wireguard-go';
    tunnelProcess = spawn(wgGo, [TUNNEL_NAME], { stdio: 'ignore' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    tunnelProcess.on('error', (err) => done({ ok: false, error: err.message }));
    tunnelProcess.on('exit', (code) => {
      if (code !== 0) done({ ok: false, error: `Engine exited with code ${code}` });
    });
    setTimeout(() => done({ ok: true }), 1500);
  });
}

/* ---------- IPC ---------- */
ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('window:close', () => mainWindow && mainWindow.close());

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_e, cfg) => {
  writeConfig({ engine: cfg.engine || 'wireguard', text: cfg.text || '' });
  return { ok: true };
});

ipcMain.handle('vpn:connect', async (_e, { engine }) => {
  stopTunnel();

  const cfg = readConfig();
  if (!cfg.text || !cfg.text.trim()) {
    return { ok: false, error: 'No configuration saved. Add your key first.' };
  }

  const eng = (engine || cfg.engine || 'wireguard').toLowerCase();

  if (eng === 'wireguard') {
    return startWireGuard(cfg.text);
  }

  return {
    ok: false,
    error: `The "${eng}" engine needs its core binary bundled (xray-core). WireGuard works now.`
  };
});

ipcMain.handle('vpn:disconnect', async () => {
  stopTunnel();
  return { ok: true };
});
