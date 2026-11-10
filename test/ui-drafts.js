'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8812;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-draftcheck-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
async function launch(label, reuseDir) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-draftcheck-${label}-`));
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

async function openChatWith(win, username) {
  await win.fill('#search', username);
  await win.press('#search', 'Enter');
  await win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
}

/** The preview text of the chat row for one peer. */
async function rowPreview(win, key) {
  return win.$eval(`.chat-item[data-peer="${key}"] .chat-item-last`, (el) => el.textContent.trim());
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: 'pidoras' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const u = await launch('u');
  const v = await launch('v');
  const s = Math.random().toString(36).slice(2, 6);
  const peer = `draftpeer_${s}`;
  const me = `drafttester_${s}`;
  await signIn(u.win, URL, { username: me });
  await signIn(v.win, URL, { username: peer });
  await openChatWith(u.win, peer);
  await openChatWith(v.win, me);

  await step('typing in the composer shows a draft in the chat list', async () => {
    await u.win.fill('#composer-input', 'привет, это черновик');
    await u.win.waitForFunction(
      (key) => {
        const el = document.querySelector(`.chat-item[data-peer="${key}"] .chat-item-last`);
        return el && /Черновик:/.test(el.textContent);
      }, peer, { timeout: 8000 }
    );
    const text = await rowPreview(u.win, peer);
    assert.ok(text.includes('Черновик:'), `row was ${text}`);
    assert.ok(text.includes('привет'), `row was ${text}`);
  });

  await step('the draft is restored when the chat is reopened', async () => {
    // Switch to another chat, then back.
    await openChatWith(u.win, me);
    await u.win.waitForFunction(
      () => document.querySelector('#composer-input').value === '',
      null, { timeout: 8000 }
    );
    await openChatWith(u.win, peer);
    await u.win.waitForFunction(
      () => document.querySelector('#composer-input').value === 'привет, это черновик',
      null, { timeout: 8000 }
    );
  });

  await step('sending clears the draft and the last message takes over', async () => {
    await u.win.press('#composer-input', 'Enter');
    await u.win.waitForFunction(
      (key) => {
        const el = document.querySelector(`.chat-item[data-peer="${key}"] .chat-item-last`);
        return el && !/Черновик:/.test(el.textContent);
      }, peer, { timeout: 8000 }
    );
    const text = await rowPreview(u.win, peer);
    assert.ok(text.includes('привет, это черновик'), `row was ${text}`);
    const value = await u.win.inputValue('#composer-input');
    assert.strictEqual(value, '', 'composer should be empty after send');
  });

  await step('the draft survives a full app restart', async () => {
    await u.win.fill('#composer-input', 'незаконченная мысль');
    // Let the coalesced settings write land.
    await new Promise((r) => setTimeout(r, 900));
    await u.app.close();
    const again = await launch('u2', u.dir);
    // A restart may land straight on the chats (the session is remembered) or
    // on the unlock screen, depending on the auto-lock setting.
    await again.win.waitForFunction(
      () => document.querySelector('#screen-main.active') || document.querySelector('#screen-unlock.active'),
      null, { timeout: 20000 }
    );
    const locked = await again.win.$('#screen-unlock.active');
    if (locked) {
      await again.win.fill('#unlock-password', 'sleephy-test-1234');
      await again.win.press('#unlock-password', 'Enter');
      await again.win.waitForSelector('#screen-main.active', { timeout: 20000 });
    }
    await openChatWith(again.win, peer);
    await again.win.waitForFunction(
      () => document.querySelector('#composer-input').value === 'незаконченная мысль',
      null, { timeout: 10000 }
    );
    await again.app.close();
  });

  await step('no uncaught errors in the tester renderer', async () => {
    assert.deepStrictEqual(v.errors, [], 'peer renderer errors');
  });

  await v.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} draft UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
