'use strict';

/**
 * UI smoke test: launches the real Electron app under Xvfb, drives the real
 * interface with real clicks and typing, and checks that the two clients can
 * actually talk to each other. No mocks.
 *
 * Run with: xvfb-run -a node test/ui.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');

const PORT = 8793;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-ui-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-ui-${label}-`));
}

async function launch(label) {
  const dir = tmpDir(label);
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  win.on('pageerror', (err) => errors.push(String(err)));
  return { app, win, dir, errors };
}

async function register(win, username, password) {
  await win.click('.auth-tab[data-tab="register"]');
  await win.fill('#auth-username', username);
  await win.fill('#auth-password', password);
  await win.fill('#auth-confirm', password);
  await win.fill('#server-url', URL);
  await win.click('#btn-auth');
  await win.waitForSelector('#screen-main.active', { timeout: 20000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: 'alice' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const a = await launch('a');
  const b = await launch('b');

  await step('app window opens with the auth screen', async () => {
    assert.ok(await a.win.isVisible('#screen-auth'));
    const title = await a.win.title();
    assert.strictEqual(title, 'SleePhy');
  });

  await step('registering an account reaches the main screen', async () => {
    await register(a.win, 'alice', 'correct-horse-battery');
    assert.strictEqual(await a.win.textContent('#me-name'), 'alice');
    assert.ok(await a.win.isVisible('#screen-main'));
  });

  await step('second account registers', async () => {
    await register(b.win, 'bob', 'hunter2-hunter2');
    assert.strictEqual(await b.win.textContent('#me-name'), 'bob');
  });

  await step('starting a chat by username opens the conversation', async () => {
    await a.win.fill('#search', 'bob');
    await a.win.press('#search', 'Enter');
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    assert.strictEqual(await a.win.textContent('#peer-name'), 'bob');
  });

  await step('alice sends, bob receives the message', async () => {
    await a.win.fill('#composer-input', 'привет из теста 🔐');
    await a.win.click('.send-btn');
    await b.win.fill('#search', 'alice');
    await b.win.press('#search', 'Enter');
    await b.win.waitForSelector('.msg.in .bubble', { timeout: 10000 });
    const text = await b.win.textContent('.msg.in .bubble');
    assert.strictEqual(text, 'привет из теста 🔐');
  });

  await step('sent message appears as an outgoing bubble', async () => {
    const out = await a.win.textContent('.msg.out .bubble');
    assert.strictEqual(out, 'привет из теста 🔐');
  });

  await step('bob replies and alice sees it', async () => {
    await b.win.fill('#composer-input', 'получил, всё работает');
    await b.win.click('.send-btn');
    await a.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.in .bubble'))
        .some((el) => el.textContent === 'получил, всё работает'),
      { timeout: 10000 }
    );
  });

  await step('settings modal shows the public key', async () => {
    await a.win.click('#btn-settings');
    await a.win.waitForSelector('#settings-backdrop:not([hidden])');
    const key = await a.win.textContent('#set-pubkey');
    assert.ok(key && key.length > 20 && key !== '—', 'expected a public key');
  });

  // Everything from here on needs an administrator. SLEEPHY_ADMINS makes alice
  // the admin, so the relay grants her the flag at login.
  await step('the admin panel lists every account', async () => {
    await a.win.click('.settings-nav-item[data-pane="admin"]');
    await a.win.waitForSelector('.settings-pane[data-pane="admin"].active');
    await a.win.waitForSelector('#admin-users .admin-user', { timeout: 8000 });
    const rows = await a.win.$$eval('#admin-users .admin-user-sub', (els) => els.map((e) => e.textContent));
    assert.ok(rows.some((t) => t.includes('@alice')), 'alice should be listed');
    assert.ok(rows.some((t) => t.includes('@bob')), 'bob should be listed');
  });

  await step('an admin can verify an account and the checkmark shows', async () => {
    await a.win.click('#admin-users .admin-act[data-act="verify"][data-user="bob"]');
    await a.win.waitForFunction(
      () => !!document.querySelector('#admin-users .admin-user-name .admin-tag.verified'),
      { timeout: 8000 }
    );
    // Alice opens Bob's profile: the badge next to the name must be visible.
    await a.win.click('#btn-settings-close');
    await a.win.fill('#search', 'bob');
    await a.win.press('#search', 'Enter');
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await a.win.click('#btn-peer-profile');
    await a.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.waitForFunction(
      () => !document.getElementById('profile-badge').hidden,
      { timeout: 8000 }
    );
    await a.win.click('#btn-profile-close');
  });

  await step('an admin announcement reaches the other client', async () => {
    await a.win.click('#btn-settings');
    await a.win.waitForSelector('#settings-backdrop:not([hidden])');
    await a.win.click('.settings-nav-item[data-pane="admin"]');
    await a.win.waitForSelector('.settings-pane[data-pane="admin"].active');
    await a.win.fill('#admin-announce-input', 'Всем привет, это объявление');
    await a.win.click('#btn-admin-announce');
    await b.win.waitForFunction(
      () => (document.getElementById('toast') || {}).textContent === '📣 alice: Всем привет, это объявление',
      { timeout: 8000 }
    );
    await a.win.click('#btn-settings-close');
  });

  await step('a sticker is sent as an encrypted image', async () => {
    await a.win.click('#btn-emoji');
    await a.win.waitForSelector('#emoji-panel:not([hidden])');
    await a.win.click('.panel-switch-tab[data-mode="stickers"]');
    await a.win.waitForSelector('#sticker-mode:not([hidden])');
    const before = await a.win.$$eval('#messages .msg.has-attachment', (els) => els.length);
    await a.win.click('#sticker-grid .sticker-cell');
    await a.win.waitForFunction(
      (n) => document.querySelectorAll('#messages .msg.has-attachment').length > n,
      before,
      { timeout: 10000 }
    );
    await a.win.waitForSelector('#messages .msg.has-attachment .att-image', { timeout: 10000 });
  });

  await step('no uncaught errors in the renderer console', async () => {
    const errors = a.errors || [];
    assert.strictEqual(errors.length, 0, 'renderer errors: ' + errors.join(' | '));
  });

  await a.app.close();
  await b.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch {}

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
