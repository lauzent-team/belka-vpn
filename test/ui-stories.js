'use strict';

/**
 * The stories bar, composer and viewer, driven through the real Electron app.
 * Alice publishes a story; Bob's bar grows a ring, and opening it shows the
 * text and marks it seen. The relay never sees the caption in the clear.
 *
 * Run with: xvfb-run -a node test/ui-stories.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { DatabaseSync } = require('node:sqlite');
const { signIn } = require('./_auth');

const PORT = 8900 + Math.floor(Math.random() * 100);
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uistories-${Date.now()}.db`);

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

  const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uistories-a-'));
  const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uistories-b-'));

  const A = await launch(aliceDir);
  const B = await launch(bobDir);
  await signIn(A.win, URL, { username: alice });
  await signIn(B.win, URL, { username: bob });

  await step('the stories bar shows the add button from the start', async () => {
    await A.win.waitForSelector('#stories-bar:not([hidden])', { timeout: 8000 });
    await A.win.waitForSelector('#btn-story-add', { timeout: 8000 });
    const rings = await A.win.evaluate(() => document.querySelectorAll('#story-ring-list .story-ring').length);
    assert.strictEqual(rings, 0, 'there should be no author rings yet');
  });

  // Alice and Bob exchange one message so each joins the other's story audience.
  await step('Alice opens a chat with Bob', async () => {
    await A.win.fill('#search', bob);
    await A.win.press('#search', 'Enter');
    await A.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await A.win.fill('#composer-input', 'привет');
    await A.win.press('#composer-input', 'Enter');
    await A.win.waitForFunction(
      () => document.querySelectorAll('.msg:not(.msg-system)').length > 0,
      { timeout: 8000 }
    );
  });

  await step('Bob receives the message, joining the audience', async () => {
    await B.win.waitForFunction(
      () => (document.getElementById('chat-list').textContent || '').includes('alice') ||
            document.querySelectorAll('.chat-item').length > 0,
      { timeout: 8000 }
    );
  });

  await step('Alice opens the story composer and sees her audience', async () => {
    await A.win.click('#btn-story-add');
    await A.win.waitForSelector('#story-backdrop:not([hidden])', { timeout: 8000 });
    await A.win.waitForFunction(
      () => (document.getElementById('story-audience-note').textContent || '').includes('контакт'),
      { timeout: 8000 }
    );
  });

  await step('publishing a text story shows the bar and opens the viewer', async () => {
    await A.win.fill('#story-caption', 'Мой первый сторис');
    await A.win.click('#btn-story-publish');
    await A.win.waitForSelector('#story-viewer:not([hidden])', { timeout: 8000 });
    const text = (await A.win.textContent('#story-viewer-text')).trim();
    assert.strictEqual(text, 'Мой первый сторис');
    await A.win.click('#btn-story-viewer-close');
    await A.win.waitForSelector('#stories-bar:not([hidden])', { timeout: 8000 });
  });

  await step('the author button marks that Alice has a story', async () => {
    const has = await A.win.evaluate(() =>
      document.getElementById('btn-story-add').classList.contains('has-stories'));
    assert.ok(has, 'the add button should show Alice has a live story');
    const rings = await A.win.evaluate(() =>
      document.querySelectorAll('#story-ring-list .story-ring').length);
    assert.strictEqual(rings, 0, 'Bob has no story, so there should be no author ring');
  });

  await step('Bob sees the story ring and can open it', async () => {
    await B.win.waitForSelector('#stories-bar:not([hidden])', { timeout: 10000 });
    await B.win.waitForSelector('#story-ring-list .story-ring.unseen', { timeout: 10000 });
    await B.win.click('#story-ring-list .story-ring.unseen .story-ring-btn');
    await B.win.waitForSelector('#story-viewer:not([hidden])', { timeout: 8000 });
    const text = (await B.win.textContent('#story-viewer-text')).trim();
    assert.strictEqual(text, 'Мой первый сторис');
  });

  await step('the ring goes from unseen to seen once opened', async () => {
    await B.win.click('#btn-story-viewer-close');
    await B.win.waitForSelector('#story-ring-list .story-ring.seen', { timeout: 8000 });
    const unseen = await B.win.evaluate(() => document.querySelectorAll('#story-ring-list .story-ring.unseen').length);
    assert.strictEqual(unseen, 0, 'no ring should remain unseen');
  });

  await step('the author sees a view count on their own story', async () => {
    // Bob's open marks Alice's story seen; the count arrives over the socket.
    // Reopen Alice's own story to read the footer.
    await A.win.click('#btn-story-add');
    await A.win.waitForSelector('#story-viewer:not([hidden])', { timeout: 8000 });
    await A.win.waitForFunction(
      () => {
        const el = document.getElementById('story-viewer-views');
        return el && /просмотр/.test(el.textContent || '');
      },
      { timeout: 12000 }
    );
    await A.win.click('#btn-story-viewer-close');
  });

  await step('the relay stores no plaintext caption', async () => {
    const raw = new DatabaseSync(DB);
    const rows = raw.prepare('SELECT envelope FROM stories').all();
    raw.close();
    assert.ok(rows.length >= 1, 'there should be a story row');
    for (const r of rows) {
      assert.ok(!r.envelope.includes('сторис'), 'plaintext leaked into the relay store');
    }
  });

  await step('no console errors along the way', async () => {
    const bad = A.errors.concat(B.errors).filter((e) => !/DevTools|Autofill/i.test(e));
    assert.deepStrictEqual(bad, []);
  });

  A.app.close();
  B.app.close();
  server.kill();
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} story UI checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
