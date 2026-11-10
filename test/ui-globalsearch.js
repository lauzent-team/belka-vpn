'use strict';

/**
 * Drives the real Electron UI for global search: typing a word into the top
 * search box surfaces a cross-chat "Сообщения" section, clicking a hit opens
 * the chat it came from, and a word that matches nothing hides the section.
 * Real clicks on the real app against a real relay — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-globalsearch.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8822;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uigs-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uigs-${label}-`));
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

  // Alice sends Bob a message with a word that appears nowhere else.
  await a.win.fill('#search', bob);
  await a.win.press('#search', 'Enter');
  await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await a.win.fill('#composer-input', 'уникальноеслово для поиска');
  await a.win.press('#composer-input', 'Enter');
  await a.win.waitForSelector('#messages .msg', { timeout: 8000 });

  await step('a query surfaces a cross-chat "Сообщения" section', async () => {
    await a.win.fill('#search', 'уникальноеслово');
    await a.win.waitForSelector('#search-messages-wrap:not([hidden])', { timeout: 10000 });
    const count = await a.win.locator('#search-messages .search-msg').count();
    assert.ok(count >= 1, 'at least one message hit');
  });

  await step('the hit shows the chat it came from and a snippet', async () => {
    const row = a.win.locator('#search-messages .search-msg').first();
    const name = (await row.locator('.chat-item-name').textContent()).trim();
    assert.ok(name.length > 0, 'the row names the conversation');
    const snippet = (await row.locator('.chat-item-last').textContent()).trim();
    assert.ok(snippet.includes('уникальноеслово'), 'the snippet carries the matched text');
  });

  await step('clicking a hit opens that chat', async () => {
    await a.win.click('#search-messages .search-msg');
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    const peer = (await a.win.textContent('#peer-name')).trim();
    assert.strictEqual(peer, bob, 'it opened the chat the hit belonged to');
    assert.ok(await a.win.isHidden('#search-panel'), 'the search panel closed');
  });

  await step('a query that matches nothing hides the messages section', async () => {
    await a.win.fill('#search', 'ничего-нет-здесь-вообще');
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(await a.win.isHidden('#search-messages-wrap'), 'no message hits');
  });

  await step('clearing the box hides the search panel again', async () => {
    await a.win.click('#btn-search-clear');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(await a.win.isHidden('#search-panel'), 'the panel is gone');
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
  console.log(`\n${results.length - failed}/${results.length} UI global-search checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
