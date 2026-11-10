'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8809;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uicheck-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uicheck-${label}-`));
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

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: 'pidoras' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));
  const u = await launch('u');
  const s = Math.random().toString(36).slice(2, 6);
  await signIn(u.win, URL, { username: `tester_${s}` });

  await step('bots drawer opens and lists bots', async () => {
    await u.win.click('#btn-menu');
    await u.win.click('.drawer-item[data-drawer="bots"]');
    await u.win.waitForSelector('#bots-backdrop:not([hidden])', { timeout: 8000 });
    const n = await u.win.$$eval('#bots-list .menu-item', (e) => e.length);
    assert.ok(n >= 2, `expected bots, got ${n}`);
    await u.win.click('#btn-bots-close');
  });

  await step('opening the minigames bot starts a local chat', async () => {
    await u.win.click('#btn-menu');
    await u.win.click('.drawer-item[data-drawer="bots"]');
    await u.win.waitForSelector('#bots-list .menu-item', { timeout: 8000 });
    await u.win.click('#bots-list .menu-item[data-bot="minigames"]');
    await u.win.waitForSelector('#messages .msg', { timeout: 8000 });
    const name = await u.win.textContent('#peer-name');
    assert.ok(/Мини-игры/.test(name), `peer name was ${name}`);
  });

  await step('games panel lists four games and starts tic-tac-toe vs bot', async () => {
    await u.win.click('#btn-emoji');
    await u.win.click('.panel-switch-tab[data-mode="games"]');
    await u.win.waitForSelector('#game-grid .game-card', { timeout: 8000 });
    const n = await u.win.$$eval('#game-grid .game-card', (e) => e.length);
    assert.strictEqual(n, 4, `expected 4 games, got ${n}`);
    await u.win.click('#game-grid .game-card[data-game="tictactoe"]');
    await u.win.waitForSelector('.ttt-grid .ttt-cell', { timeout: 8000 });
  });

  await step('playing a cell updates the board and the bot answers', async () => {
    await u.win.click('.ttt-cell[data-cell="4"]');
    await u.win.waitForFunction(
      () => [...document.querySelectorAll('.ttt-cell')].filter((c) => c.textContent.trim()).length >= 2,
      null, { timeout: 8000 }
    );
  });

  await step('no uncaught errors in the renderer', async () => {
    assert.deepStrictEqual(u.errors, [], 'renderer errors');
  });

  /* -------- two real people: game invite and a gift over the relay -------- */
  const v = await launch('v');
  const peer = `peer_${s}`;
  await signIn(v.win, URL, { username: peer });

  await step('a game invite reaches the peer and draws the same board', async () => {
    await openChatWith(u.win, peer);
    await openChatWith(v.win, `tester_${s}`);
    await u.win.click('#btn-emoji');
    await u.win.click('.panel-switch-tab[data-mode="games"]');
    await u.win.waitForSelector('#game-grid .game-card', { timeout: 8000 });
    await u.win.click('#game-grid .game-card[data-game="tictactoe"]');
    await u.win.waitForSelector('.ttt-grid .ttt-cell', { timeout: 8000 });
    // The peer receives the invite and adopts the game.
    await v.win.waitForSelector('.ttt-grid .ttt-cell', { timeout: 10000 });
    // The invite itself is not shown as a text bubble.
    const leaks = await v.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => (e.textContent || '').includes('"g":')).length);
    assert.strictEqual(leaks, 0, 'the game payload must not appear as a text bubble');
  });

  await step('a move made on one device shows on the other', async () => {
    await u.win.click('.ttt-cell[data-cell="0"]');
    await v.win.waitForFunction(
      () => { const c = document.querySelector('.ttt-cell[data-cell="0"]'); return c && c.textContent.trim() === '✕'; },
      null, { timeout: 10000 }
    );
    // Now the peer moves and the first device adopts it.
    await v.win.click('.ttt-cell[data-cell="4"]');
    await u.win.waitForFunction(
      () => { const c = document.querySelector('.ttt-cell[data-cell="4"]'); return c && c.textContent.trim() === '◯'; },
      null, { timeout: 10000 }
    );
  });

  await step('a gift can be picked and arrives as a gift bubble', async () => {
    await openChatWith(u.win, peer);
    await u.win.click('#btn-attach');
    await u.win.waitForSelector('#attach-menu', { timeout: 8000 });
    await u.win.click('[data-attach="gift"]');
    await u.win.waitForSelector('#gifts-backdrop:not([hidden])', { timeout: 8000 });
    const n = await u.win.$$eval('#gifts-grid .gift-card', (e) => e.length);
    assert.ok(n >= 5, `expected a gift catalogue, got ${n}`);
    await u.win.click('#gifts-grid .gift-card[data-gift="rose"]');
    await u.win.waitForSelector('#messages .gift-bubble', { timeout: 8000 });
    await v.win.waitForSelector('#messages .gift-bubble', { timeout: 10000 });
    const text = await v.win.textContent('#messages .gift-bubble');
    assert.ok(text.includes('Роза'), `gift bubble was ${text}`);
  });

  await step('no uncaught errors in either renderer', async () => {
    assert.deepStrictEqual(u.errors, [], 'tester renderer errors');
    assert.deepStrictEqual(v.errors, [], 'peer renderer errors');
  });

  await u.app.close();
  await v.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
