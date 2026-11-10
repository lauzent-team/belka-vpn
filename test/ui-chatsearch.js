'use strict';

/**
 * In-chat search with filters, driven through the real Electron UI: open the
 * search bar, type, open the filter chips, pick a category, and check that the
 * highlight and the count follow.
 *
 * Run with: xvfb-run -a node test/ui-chatsearch.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8817;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-chatsearch-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-chatsearch-${label}-`));
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
/** Type a message into the open chat and wait for it to render. */
async function say(win, text) {
  await win.fill('#composer-input', text);
  await win.press('#composer-input', 'Enter');
  await win.waitForFunction(
    (t) => Array.from(document.querySelectorAll('#messages .msg .bubble')).some((b) => b.textContent.includes(t)),
    text, { timeout: 8000 }
  );
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const u = await launch('u');
  const v = await launch('v');
  const s = Math.random().toString(36).slice(2, 6);
  const peer = `searchpeer_${s}`;
  const me = `searcher_${s}`;
  await signIn(u.win, URL, { username: me });
  await signIn(v.win, URL, { username: peer });

  await u.win.fill('#search', peer);
  await u.win.press('#search', 'Enter');
  await u.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });

  await say(u.win, 'привет мир');
  await say(u.win, 'второе сообщение');
  await say(u.win, 'ссылка https://example.com тут');

  await step('the search bar opens and takes focus', async () => {
    await u.win.click('#btn-chat-search');
    await u.win.waitForSelector('#chat-search-bar:not([hidden])', { timeout: 8000 });
    const focused = await u.win.evaluate(() => document.activeElement && document.activeElement.id);
    assert.strictEqual(focused, 'chat-search-input');
  });

  await step('a word finds the message that contains it', async () => {
    await u.win.fill('#chat-search-input', 'второе');
    await u.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.search-hit').length === 1, null, { timeout: 8000 }
    );
    const count = await u.win.textContent('#chat-search-count');
    assert.ok(/1\s*найдено/.test(count), `count was ${count}`);
  });

  await step('a word that is not there reports nothing', async () => {
    await u.win.fill('#chat-search-input', 'зелёный жираф');
    await u.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.search-hit').length === 0, null, { timeout: 8000 }
    );
    const count = await u.win.textContent('#chat-search-count');
    assert.ok(/ничего/.test(count), `count was ${count}`);
  });

  await step('the filter button reveals the chip rows', async () => {
    await u.win.click('#btn-chat-search-filter');
    await u.win.waitForSelector('#chat-search-filters:not([hidden])', { timeout: 8000 });
    const kinds = await u.win.$$eval('#csf-kinds .csf-chip', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(kinds.includes('Фото'), `kinds were ${kinds}`);
    assert.ok(kinds.includes('Ссылки'), `kinds were ${kinds}`);
  });

  await step('an empty box plus the "Ссылки" chip finds the link message', async () => {
    await u.win.fill('#chat-search-input', '');
    await u.win.click('#csf-kinds .csf-chip[data-value="link"]');
    await u.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.search-hit').length === 1, null, { timeout: 8000 }
    );
    const text = await u.win.textContent('#messages .msg.search-hit .bubble');
    assert.ok(text.includes('example.com'), `hit was ${text}`);
  });

  await step('sending a photo makes the "Фото" chip find it', async () => {
    await u.win.click('#btn-chat-search-close');
    // Send a real 1x1 PNG through the attach flow.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const tmp = path.join(os.tmpdir(), `sleephy-shot-${Date.now()}.png`);
    fs.writeFileSync(tmp, png);
    await u.win.click('#btn-attach');
    const [chooser] = await Promise.all([
      u.win.waitForEvent('filechooser', { timeout: 8000 }),
      u.win.click('[data-attach="image"]')
    ]);
    await chooser.setFiles(tmp);
    await u.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.has-attachment').length >= 1, null, { timeout: 10000 }
    );
    fs.rmSync(tmp, { force: true });

    await u.win.click('#btn-chat-search');
    await u.win.click('#btn-chat-search-filter');
    await u.win.click('#csf-kinds .csf-chip[data-value="photo"]');
    await u.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.search-hit').length === 1, null, { timeout: 8000 }
    );
    const marked = await u.win.$eval('#btn-chat-search-filter', (e) => e.classList.contains('has-filter'));
    assert.ok(marked, 'filter button should show a dot');
  });

  await step('the "Я" sender chip narrows to my own messages', async () => {
    await u.win.click('#csf-kinds .csf-chip[data-value="any"]');
    await u.win.click('#csf-from .csf-chip[data-value="me"]');
    await u.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.search-hit').length > 0, null, { timeout: 8000 }
    );
    const allMine = await u.win.$$eval('#messages .msg.search-hit', (els) => els.every((e) => e.classList.contains('out')));
    assert.ok(allMine, 'every hit should be my own message');
  });

  await step('closing the search clears the highlight and the filters', async () => {
    await u.win.click('#btn-chat-search-close');
    await u.win.waitForSelector('#chat-search-bar[hidden]', { state: 'hidden', timeout: 8000 });
    const hits = await u.win.$$eval('#messages .msg.search-hit', (els) => els.length);
    assert.strictEqual(hits, 0, 'no message should stay highlighted');
    const dot = await u.win.$eval('#btn-chat-search-filter', (e) => e.classList.contains('has-filter'));
    assert.ok(!dot, 'the filter dot should be gone');
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
  console.log(`\n${results.length - failed}/${results.length} chat-search UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
