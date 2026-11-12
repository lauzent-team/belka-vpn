const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');

const PORT = 8795;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-shot-${Date.now()}.db`);
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await new Promise((r) => setTimeout(r, 1200));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-shot-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1000, height: 700 });

  await win.screenshot({ path: path.join(OUT, '1-auth.png') });

  await win.fill('#auth-phone', '+79990001234');
  await win.fill('#server-url', URL);
  await win.click('#btn-auth');
  await win.waitForSelector('#form-code:not([hidden])', { timeout: 20000 });
  await win.screenshot({ path: path.join(OUT, '2-code.png') });
  await win.waitForFunction(() => (document.getElementById('auth-code').value || '').length === 6, { timeout: 10000 });
  await win.click('#btn-code');
  await win.waitForSelector('#screen-main.active', { timeout: 20000 });
  await win.screenshot({ path: path.join(OUT, '2-main-empty.png') });

  await win.fill('#search', 'bob');
  await win.press('#search', 'Enter');
  await win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await win.fill('#composer-input', 'привет! как дела?');
  await win.click('.send-btn');
  await win.fill('#composer-input', 'готовим новый мессенджер 🔐');
  await win.click('.send-btn');
  await new Promise((r) => setTimeout(r, 600));
  await win.screenshot({ path: path.join(OUT, '3-chat.png') });

  await win.click('#btn-my-profile');
  await win.waitForSelector('#profile-backdrop:not([hidden])');
  await new Promise((r) => setTimeout(r, 400));
  await win.screenshot({ path: path.join(OUT, '4-profile.png') });
  await win.click('#btn-profile-close');

  await win.click('#btn-settings');
  await win.waitForSelector('#settings-backdrop:not([hidden])');
  await new Promise((r) => setTimeout(r, 400));
  await win.screenshot({ path: path.join(OUT, '5-settings.png') });

  await win.click('#btn-settings-close');
  await win.click('#btn-peer-profile');
  await win.waitForSelector('#profile-backdrop:not([hidden])');
  await new Promise((r) => setTimeout(r, 400));
  await win.screenshot({ path: path.join(OUT, '6-chat-menu.png') });

  await app.close();
  server.kill('SIGTERM');
  console.log('screenshots written to', OUT);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
