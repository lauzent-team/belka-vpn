'use strict';

/**
 * The app lives in the system tray, and its alerts are raised by the main
 * process rather than by the page. Both matter for the same reason: with the
 * window closed the app must keep running and keep notifying, and the toast
 * must be attributed to SleePhy, not to the bare Electron runtime.
 *
 * Run with: xvfb-run -a node test/ui-tray.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');

const PORT = 8811;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-tray-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-tray-${label}-`));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY, SLEEPHY_SERVER: URL }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#auth-username', { state: 'attached', timeout: 8000 });
  return { app, win, dir };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await wait(1200);

  const a = await launch('a');

  await step('the window opens on the sign-in screen', async () => {
    await a.win.waitForSelector('#auth-username', { state: 'attached', timeout: 8000 });
  });

  await step('the notification bridge reaches the main process', async () => {
    const ok = await a.win.evaluate(() => window.sleephy.notify({ title: 'SleePhy', body: 'проверка' }));
    assert.strictEqual(ok, true, 'the main process must accept the alert');
  });

  await step('the app reports itself as SleePhy, not as Electron', async () => {
    const name = await a.app.evaluate(({ app }) => app.getName());
    assert.strictEqual(name, 'SleePhy');
  });

  await step('closing the window hides it and keeps the app running', async () => {
    await a.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    await wait(600);
    const state = await a.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { windows: BrowserWindow.getAllWindows().length, visible: w ? w.isVisible() : null };
    });
    // The window survives hidden rather than being destroyed, which is what the
    // tray needs to restore from.
    assert.strictEqual(state.windows, 1, 'the window must not be destroyed');
    assert.strictEqual(state.visible, false, 'the window must be hidden');
  });

  await step('the app is still alive with no visible window', async () => {
    // A quit here would mean the tray never came up, since the close handler
    // only hides when there is a tray to restore from.
    const alive = a.app.process() && !a.app.process().killed;
    assert.ok(alive, 'the process must still be running');
    const name = await a.app.evaluate(({ app }) => app.getName());
    assert.strictEqual(name, 'SleePhy');
  });

  await a.app.close();
  server.kill();
  fs.rmSync(a.dir, { recursive: true, force: true });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} tray checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
