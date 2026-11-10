'use strict';

/**
 * Drives the real Electron UI for self-destructing messages: opening the timer
 * picker from the chat menu, choosing a value, seeing the header chip, and
 * watching the countdown appear on a fresh bubble. Real clicks on the real app
 * against a real relay — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-ttl.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8797;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uittl-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uittl-${label}-`));
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

  // Alice opens a chat with Bob and sends one ordinary message.
  await a.win.fill('#search', bob);
  await a.win.press('#search', 'Enter');
  await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await a.win.fill('#composer-input', 'привет');
  await a.win.press('#composer-input', 'Enter');
  // Bob opens the same conversation and sees the message land.
  await b.win.fill('#search', alice);
  await b.win.press('#search', 'Enter');
  await b.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await b.win.waitForSelector('#messages .msg', { timeout: 10000 });

  await step('the header chip is hidden until a timer is set', async () => {
    assert.ok(await a.win.isHidden('#peer-ttl'), 'no timer chip by default');
  });

  await step('the chat menu offers an auto-delete entry', async () => {
    await a.win.click('#btn-chat-menu');
    await a.win.waitForSelector('#chatmenu-backdrop:not([hidden])', { timeout: 8000 });
    assert.ok(await a.win.isVisible('#menu-ttl'), 'auto-delete entry should be visible in a DM');
  });

  await step('choosing a timer opens the picker and sets it', async () => {
    await a.win.click('#menu-ttl');
    await a.win.waitForSelector('#ttl-backdrop:not([hidden])', { timeout: 8000 });
    const count = await a.win.locator('#ttl-options .menu-item').count();
    assert.ok(count > 1, 'the picker should offer several values');
    // The 1-minute choice is the sixth row (Off, 1s, 5s, 10s, 30s, 1m).
    await a.win.click('#ttl-options .menu-item:nth-child(6)');
    await a.win.waitForSelector('#ttl-backdrop', { state: 'hidden', timeout: 8000 });
  });

  await step('the header chip shows the chosen timer', async () => {
    await a.win.waitForSelector('#peer-ttl:not([hidden])', { timeout: 8000 });
    const label = (await a.win.textContent('#peer-ttl-label')).trim();
    assert.ok(/мин|min/i.test(label), 'the chip should read a minute, got: ' + label);
  });

  await step('the peer is told the timer was set', async () => {
    await b.win.waitForSelector('#peer-ttl:not([hidden])', { timeout: 8000 });
  });

  await step('a message sent now shows a countdown', async () => {
    await a.win.fill('#composer-input', 'сгорит');
    await a.win.press('#composer-input', 'Enter');
    await a.win.waitForSelector('#messages .msg .ttl-mark', { timeout: 8000 });
    const remaining = (await a.win.textContent('#messages .msg .ttl-mark .ttl-remain')).trim();
    assert.ok(remaining.length > 0, 'the countdown should have a value, got: ' + JSON.stringify(remaining));
    // Bob sees the countdown on his copy too.
    await b.win.waitForSelector('#messages .msg .ttl-mark', { timeout: 8000 });
  });

  await step('turning auto-delete off hides the chip again', async () => {
    await a.win.click('#btn-chat-menu');
    await a.win.waitForSelector('#chatmenu-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#menu-ttl');
    await a.win.waitForSelector('#ttl-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#ttl-options .menu-item:nth-child(1)');
    await a.win.waitForSelector('#ttl-backdrop', { state: 'hidden', timeout: 8000 });
    await a.win.waitForSelector('#peer-ttl', { state: 'hidden', timeout: 8000 });
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
  console.log(`\n${results.length - failed}/${results.length} UI ttl checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
