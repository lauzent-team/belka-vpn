'use strict';

/**
 * Checks the connection UX:
 *   1. the server field shows the configured address
 *   2. with an unreachable server, registering fails with a clear message
 *   3. with a reachable server, registering succeeds
 *
 * Run with: xvfb-run -a node test/connection.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8796;
const GOOD = `ws://127.0.0.1:${PORT}`;
const BAD = 'ws://127.0.0.1:9'; // nothing listens here
const DB = path.join(os.tmpdir(), `sleephy-conn-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-conn-${label}-`));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  return { app, win, dir };
}

async function submit(win, server) {
  await win.fill('#server-url', server);
  await win.fill('#auth-username', 'probe_user');
  await win.fill('#auth-password', 'probe-password-1');
  await win.click('#btn-auth');
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await new Promise((r) => setTimeout(r, 1200));

  const a = await launch('a');

  await step('server field shows a real address', async () => {
    const value = await a.win.inputValue('#server-url');
    assert.ok(value && value.length > 5, `expected an address, got "${value}"`);
  });

  await step('unreachable server gives a clear error', async () => {
    await submit(a.win, BAD);
    await a.win.waitForSelector('#auth-error:not([hidden])', { timeout: 20000 });
    const text = await a.win.textContent('#auth-error');
    assert.ok(/server/i.test(text), `error should mention the server, got: "${text}"`);
    assert.ok(await a.win.isVisible('#screen-auth'), 'should stay on the auth screen');
  });

  await step('reachable server lets the account be created', async () => {
    await signIn(a.win, GOOD, { username: 'connuser' });
    assert.strictEqual(await a.win.textContent('#me-name'), 'connuser');
  });

  await step('connection indicator turns on', async () => {
    const cls = await a.win.getAttribute('#auth-conn', 'class');
    assert.ok(cls.includes('on'), `expected the indicator on, got "${cls}"`);
  });

  // A rejected sign-in must read as a sentence, in the user's language — not as
  // Electron's "Error invoking remote method ..." wrapper, and not in English.
  await step('a wrong password shows a translated reason, not an IPC wrapper', async () => {
    const b = await launch('b');
    await b.win.fill('#server-url', GOOD);
    await b.win.fill('#auth-username', 'probe_user');
    await b.win.fill('#auth-password', 'definitely-wrong-1');
    await b.win.click('#btn-auth');
    await b.win.waitForSelector('#auth-error:not([hidden])', { timeout: 20000 });
    const text = (await b.win.textContent('#auth-error')).trim();
    assert.ok(!/invoking remote method/i.test(text), `raw IPC text leaked: "${text}"`);
    assert.ok(!/Error/i.test(text), `error wrapper leaked: "${text}"`);
    assert.strictEqual(text, 'Неверное имя пользователя или пароль', `expected the Russian message, got "${text}"`);
    await b.app.close();
  });

  // The phone button is present but parked until an SMS provider is funded.
  await step('the phone button is disabled and shows the "Скоро" hint', async () => {
    assert.ok(await a.win.isDisabled('#btn-phone-signin'), 'phone button should be disabled');
    assert.strictEqual((await a.win.textContent('#phone-soon')).trim(), 'Скоро');
  });

  await a.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch {}

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} connection checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
