'use strict';

/**
 * The "огонёк" must be visible: a flame in the chat header and a line on a
 * peer's profile. This drives the real app, sends a message, and reads the DOM.
 *
 * Run with: xvfb-run -a node test/ui-streak.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8800 + Math.floor(Math.random() * 100);
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uistreak-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(dir) {
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win, errors };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uistreak-a-'));
  const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uistreak-b-'));

  const A = await launch(aliceDir);
  const B = await launch(bobDir);
  await signIn(A.win, URL, { username: alice });
  await signIn(B.win, URL, { username: bob });

  await step('a new account shows no flame yet', async () => {
    assert.ok(await A.win.isHidden('#peer-streak'), 'the flame should start hidden');
  });

  await step('sending a message lights the dialog flame with a count of one', async () => {
    // Open the conversation through search, the way a person starts a chat.
    await A.win.fill('#search', bob);
    await A.win.press('#search', 'Enter');
    await A.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await A.win.fill('#composer-input', 'привет');
    await A.win.press('#composer-input', 'Enter');
    await A.win.waitForSelector('#peer-streak:not([hidden])', { timeout: 8000 });
    const count = (await A.win.textContent('#peer-streak-count')).trim();
    assert.strictEqual(count, '1');
    const lit = await A.win.evaluate(() => document.getElementById('peer-streak').classList.contains('on'));
    assert.ok(lit, 'the flame should be lit once today counts');
  });

  await step('the series started with a centered note', async () => {
    await A.win.waitForSelector('.msg-system .series-note', { timeout: 8000 });
  });

  await step('the peer sees the streak on the profile', async () => {
    await B.win.waitForFunction(() => {
      const rows = document.getElementById('chat-list').textContent || '';
      return rows.length > 0;
    }, { timeout: 8000 });
    await B.win.evaluate(async (who) => { await window.sleephy.profile(who); }, alice);
    // Open Alice's profile through the chat header.
    await B.win.evaluate((who) => {
      const items = [...document.querySelectorAll('.chat-item')];
      const row = items.find((el) => el.dataset.peer === who);
      if (row) row.click();
    }, alice);
    await B.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await B.win.click('#btn-peer-profile');
    await B.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    await B.win.waitForSelector('#profile-streak:not([hidden])', { timeout: 8000 });
    const text = (await B.win.textContent('#profile-streak-text')).trim();
    assert.ok(/1\s/.test(text), `the profile should read a one-day streak, got "${text}"`);
  });

  await step('the chat header shows the peer flame', async () => {
    await B.win.click('#btn-profile-close');
    await wait(300);
    await B.win.waitForSelector('#peer-streak:not([hidden])', { timeout: 8000 });
    const count = (await B.win.textContent('#peer-streak-count')).trim();
    assert.strictEqual(count, '1', 'the header flame should read one day for the pair');
  });

  await step('the chat list row carries the flame too', async () => {
    const chip = await B.win.evaluate((who) => {
      const row = [...document.querySelectorAll('.chat-item')].find((el) => el.dataset.peer === who);
      return row ? (row.querySelector('.chat-item-time .streak-chip') || {}).textContent || null : null;
    }, alice);
    assert.ok(chip && chip.includes('1'), `the row should carry the flame, got "${chip}"`);
  });

  await step('no console errors along the way', async () => {
    const bad = A.errors.concat(B.errors).filter((e) => !/DevTools|Autofill/i.test(e));
    assert.deepStrictEqual(bad, []);
  });

  A.app.close();
  B.app.close();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} streak UI checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
