'use strict';

/**
 * Drives the real Electron UI for key verification: opening a peer profile,
 * reading the safety number, seeing both ends agree, marking it verified and
 * finding the mark again after reopening the profile. Real clicks on the real
 * app against a real relay — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-safety.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8794;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uisafety-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uisafety-${label}-`));
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win, dir, errors };
}

/** Open the peer profile from the chat header and wait for the safety number. */
async function openPeerProfile(win) {
  await win.click('#btn-peer-profile');
  await win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
  await win.waitForSelector('#profile-safety:not([hidden])', { timeout: 8000 });
  await win.waitForFunction(() => {
    const el = document.getElementById('profile-safety-number');
    return el && el.textContent && el.textContent.trim() !== '…';
  }, null, { timeout: 8000 });
  return (await win.textContent('#profile-safety-number')).trim();
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const a = await launch('a');
  const b = await launch('b');
  const suffix = Math.random().toString(36).slice(2, 6);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  await signIn(a.win, URL, { username: alice });
  await signIn(b.win, URL, { username: bob });

  // Alice opens a chat with Bob so both have a peer to verify.
  await a.win.fill('#search', bob);
  await a.win.press('#search', 'Enter');
  await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await a.win.fill('#composer-input', 'привет');
  await a.win.press('#composer-input', 'Enter');
  await b.win.fill('#search', alice);
  await b.win.press('#search', 'Enter');
  await b.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await b.win.waitForSelector('#messages .msg', { timeout: 10000 });

  let aliceCode = '';
  await step('a peer profile shows the safety number', async () => {
    aliceCode = await openPeerProfile(a.win);
    assert.match(aliceCode, /^(\d{5} ){11}\d{5}$/, 'twelve five-digit groups, got: ' + aliceCode);
  });

  await step('the other end shows the same number', async () => {
    const bobCode = await openPeerProfile(b.win);
    assert.strictEqual(bobCode, aliceCode, 'both ends must agree');
  });

  await step('marking it verified shows the tick and hides the button', async () => {
    await a.win.click('#btn-safety-mark');
    await a.win.waitForSelector('#profile-safety-verified:not([hidden])', { timeout: 8000 });
    assert.ok(await a.win.isHidden('#btn-safety-mark'), 'the button is replaced by the tick');
  });

  await step('the tick is still there after reopening the profile', async () => {
    await a.win.click('#btn-profile-close');
    await a.win.waitForSelector('#profile-backdrop', { state: 'hidden', timeout: 8000 });
    await openPeerProfile(a.win);
    await a.win.waitForSelector('#profile-safety-verified:not([hidden])', { timeout: 8000 });
  });

  await step('a self profile hides the safety block', async () => {
    await a.win.click('#btn-profile-close');
    await a.win.waitForSelector('#profile-backdrop', { state: 'hidden', timeout: 8000 });
    await a.win.click('#btn-my-profile');
    await a.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    assert.ok(await a.win.isHidden('#profile-safety'), 'you do not verify yourself');
  });

  await step('no uncaught errors in either renderer', async () => {
    const errors = [...a.errors, ...b.errors];
    assert.strictEqual(errors.length, 0, 'renderer errors: ' + errors.join(' | '));
  });

  await a.app.close();
  await b.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch {}

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} UI safety checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
