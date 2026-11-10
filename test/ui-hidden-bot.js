'use strict';

/**
 * Hidden bots summoned by a mention in an ordinary chat.
 *
 * `@minigames` is not a peer you open: you type it in a personal chat and the
 * bot answers there. The mention itself is handled on the device and never
 * sent, so the peer sees only the invitation that follows, and the relay never
 * learns a bot was used.
 *
 * Run with: xvfb-run -a node test/ui-hidden-bot.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8811;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uihiddenbot-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uihiddenbot-${label}-`));
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

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 6);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  const A = await launch('a');
  const B = await launch('b');
  await signIn(A.win, URL, { username: alice });
  await signIn(B.win, URL, { username: bob });
  await openChatWith(A.win, bob);
  await openChatWith(B.win, alice);

  await step('a bare @minigames opens the game picker and is never sent', async () => {
    await send(A.win, '@minigames');
    await A.win.waitForSelector('#emoji-panel:not([hidden])', { timeout: 8000 });
    await A.win.waitForSelector('.games-mode:not([hidden])', { timeout: 8000 });
    // The mention must not become a message bubble.
    const leaked = await A.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => (e.textContent || '').includes('@minigames')).length);
    assert.strictEqual(leaked, 0, 'the mention must not be sent as a message');
  });

  await step('the bot leaves a quiet centered note in the chat', async () => {
    await A.win.waitForSelector('.msg-system .bot-note', { timeout: 8000 });
    const text = await A.win.textContent('.msg-system .bot-note');
    assert.ok(/игру/i.test(text), `the note should offer a game, got "${text}"`);
  });

  await step('the peer sees nothing of the mention or the note', async () => {
    await wait(800);
    const seen = await B.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => /@minigames|Приглашаю/.test(e.textContent || '')).length);
    assert.strictEqual(seen, 0, 'the bot must stay on the device that summoned it');
  });

  await step('@minigames with a game name invites the peer straight away', async () => {
    await send(A.win, '@minigames шахматы');
    // The invitation is an ordinary encrypted game message: the peer adopts it.
    await B.win.waitForSelector('.chess-grid', { timeout: 10000 });
    await A.win.waitForSelector('.chess-grid', { timeout: 8000 });
    const leaked = await B.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => (e.textContent || '').includes('"g":')).length);
    assert.strictEqual(leaked, 0, 'the game payload must not appear as a text bubble');
  });

  await step('the note is replaced, not repeated, on a second mention', async () => {
    await send(A.win, '@minigames шашки');
    await wait(500);
    const notes = await A.win.$$eval('.msg-system .bot-note', (els) => els.length);
    assert.strictEqual(notes, 1, 'only one bot note per chat');
  });

  await step('a mention inside a sentence is sent as normal text', async () => {
    await send(A.win, `спасибо @minigames`);
    await B.win.waitForFunction(
      () => [...document.querySelectorAll('#messages .msg')].some((e) => (e.textContent || '').includes('спасибо')),
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
  console.log(`\n${passed}/${results.length} hidden-bot checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
