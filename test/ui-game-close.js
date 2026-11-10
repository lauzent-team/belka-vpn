'use strict';

/**
 * The live game board inside a personal chat can be got out of the way.
 *
 * The board is pinned under the transcript, so before this it covered the chat
 * with no way to remove it. Now it can be collapsed to a thin bar, expanded
 * again, or ended for good — and ending it clears the peer's board too, over an
 * ordinary encrypted control message the transcript never shows.
 *
 * Run with: xvfb-run -a node test/ui-game-close.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8813;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uigameclose-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uigameclose-${label}-`));
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

async function openChatWith(win, username) {
  await win.fill('#search', username);
  await win.press('#search', 'Enter');
  await win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
}

async function send(win, text) {
  await win.fill('#composer-input', text);
  await win.press('#composer-input', 'Enter');
}

async function startTtt(win) {
  await win.click('#btn-emoji');
  await win.click('.panel-switch-tab[data-mode="games"]');
  await win.waitForSelector('#game-grid .game-card', { timeout: 8000 });
  await win.click('#game-grid .game-card[data-game="tictactoe"]');
  await win.waitForSelector('.ttt-grid .ttt-cell', { timeout: 8000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 6);
  const alice = `gca_${suffix}`;
  const bob = `gcb_${suffix}`;
  const A = await launch('a');
  const B = await launch('b');
  await signIn(A.win, URL, { username: alice });
  await signIn(B.win, URL, { username: bob });
  await openChatWith(A.win, bob);
  await openChatWith(B.win, alice);

  await step('a game board can be collapsed to a thin bar', async () => {
    await startTtt(A.win);
    await B.win.waitForSelector('.ttt-grid', { timeout: 10000 });
    await A.win.click('.game-board-close');
    await A.win.waitForSelector('.game-min-bar', { timeout: 8000 });
    const boards = await A.win.$$eval('.game-board', (els) => els.length);
    assert.strictEqual(boards, 0, 'the full board should be gone when collapsed');
  });

  await step('a message sent while collapsed is not covered by the board', async () => {
    await send(A.win, 'привет, я свернул игру');
    await B.win.waitForFunction(
      () => [...document.querySelectorAll('#messages .msg')].some((e) => (e.textContent || '').includes('свернул')),
      null, { timeout: 8000 }
    );
    // The thin bar must sit at the very end, below the message, not over it.
    const last = await A.win.$eval('#messages', (el) => el.lastElementChild.className);
    assert.ok(/game-min|game-msg/.test(last), `last child was ${last}`);
  });

  await step('the bar expands the board again', async () => {
    await A.win.click('.game-min-bar .btn-secondary');
    await A.win.waitForSelector('.ttt-grid', { timeout: 8000 });
  });

  await step('ending the game removes the board for good', async () => {
    await A.win.click('.game-board-close');
    await A.win.waitForSelector('.game-min-bar', { timeout: 8000 });
    await A.win.click('.game-min-bar .btn-ghost');
    await A.win.waitForFunction(
      () => !document.querySelector('.game-msg'),
      null, { timeout: 8000 }
    );
  });

  await step('the peer\'s board disappears too, and the notice stays hidden', async () => {
    await B.win.waitForFunction(
      () => !document.querySelector('.game-msg'),
      null, { timeout: 10000 }
    );
    const leaked = await B.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => (e.textContent || '').includes('"end"')).length);
    assert.strictEqual(leaked, 0, 'the end notice must not appear as a bubble');
  });

  await step('the chat keeps working after the game is gone', async () => {
    await send(B.win, 'ок, до связи');
    await A.win.waitForFunction(
      () => [...document.querySelectorAll('#messages .msg')].some((e) => (e.textContent || '').includes('до связи')),
      null, { timeout: 8000 }
    );
  });

  await step('no console errors along the way', async () => {
    const bad = A.errors.concat(B.errors).filter((e) => !/DevTools|Autofill/i.test(e));
    assert.deepStrictEqual(bad, []);
  });

  A.app.close();
  B.app.close();
  server.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} game-close checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
