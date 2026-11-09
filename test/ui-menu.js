'use strict';
// Verifies the menu bar is not drawn and the editing shortcuts still work.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signInWithPhone } = require('./_auth');

const PORT = 8796;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-menu-${Date.now()}.db`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-menu-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1040, height: 720 });

  const errors = [];
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));

  await step('the window menu bar is hidden', async () => {
    const state = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { autoHide: w.isMenuBarAutoHide(), visible: w.isMenuBarVisible() };
    });
    assert.strictEqual(state.visible, false, 'menu bar should not be visible');
  });

  await step('no menu labels are painted at the top of the window', async () => {
    const top = await win.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, 3);
      return el ? `${el.tagName}|${el.className || ''}` : 'none';
    });
    assert.ok(!/menubar/i.test(top), `top strip should not be a menu bar, got ${top}`);
  });

  await step('copy and paste still work through the hidden menu', async () => {
    const field = await win.$('#auth-phone');
    await field.fill('copy-paste-probe');
    await field.selectText();
    await win.keyboard.press('Control+C');
    await field.fill('');
    await field.click();
    await win.keyboard.press('Control+V');
    const value = await field.inputValue();
    assert.strictEqual(value, 'copy-paste-probe', 'paste should restore the copied text');
  });

  await step('an account can still be created after the menu change', async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    await signInWithPhone(win, URL, { username: `menu_${suffix}` });
    await wait(400);
  });

  await step('no uncaught errors in the renderer', async () => {
    assert.strictEqual(errors.length, 0, errors.join(' | '));
  });

  await app.close();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} menu checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error('fatal:', err); process.exit(1); });
