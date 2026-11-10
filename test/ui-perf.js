'use strict';

/**
 * Sending must stay smooth: a burst of incoming messages is painted in a few
 * frames, not one full rebuild per message.
 *
 * The renderer rebuilds the whole message list whenever it changes (day
 * separators and edit markers shift), so the cost is bounded by coalescing
 * repaints into an animation frame. This drives the real app, sends a burst of
 * messages, and counts how many times the list was cleared and rebuilt.
 *
 * Run with: xvfb-run -a node test/ui-perf.js
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
const DB = path.join(os.tmpdir(), `sleephy-uperf-${Date.now()}.db`);
const BURST = 40;

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
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: '' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const sender = `burst_${suffix}`;
  const viewer = `watch_${suffix}`;

  const sDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uperf-s-'));
  const vDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uperf-v-'));

  const sd = await launch(sDir);
  const vw = await launch(vDir);
  await signIn(sd.win, URL, { username: sender });
  await signIn(vw.win, URL, { username: viewer });

  await step('the viewer opens the conversation', async () => {
    await sd.win.evaluate(async (to) => { await window.sleephy.send({ to, text: 'привет' }); }, viewer);
    await vw.win.waitForSelector(`#chat-list .chat-item[data-peer="${sender}"]`, { timeout: 15000 });
    await vw.win.click(`#chat-list .chat-item[data-peer="${sender}"]`);
    await vw.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await wait(200);
  });

  let stats = null;
  await step('a burst of messages is painted in a few frames', async () => {
    // Count how often the list is cleared and rebuilt: `innerHTML = ''` on a
    // populated list shows up as one record removing many nodes at once.
    await vw.win.evaluate(() => {
      const box = document.getElementById('messages');
      window.__perf = { rebuilds: 0, added: 0 };
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.removedNodes.length > 1) window.__perf.rebuilds += 1;
          window.__perf.added += r.addedNodes.length;
        }
      });
      obs.observe(box, { childList: true });
      window.__perfObs = obs;
    });

    const t0 = Date.now();
    await sd.win.evaluate(async ({ to, n }) => {
      const jobs = [];
      for (let i = 0; i < n; i++) jobs.push(window.sleephy.send({ to, text: `сообщение ${i}` }));
      await Promise.all(jobs);
    }, { to: viewer, n: BURST });

    // Wait until every message is on screen.
    await vw.win.waitForFunction(
      (n) => document.querySelectorAll('#messages .msg').length >= n,
      BURST, { timeout: 20000 }
    );
    const elapsed = Date.now() - t0;
    stats = await vw.win.evaluate(() => {
      window.__perfObs.disconnect();
      return { ...window.__perf, msgs: document.querySelectorAll('#messages .msg').length };
    });
    stats.elapsed = elapsed;
    console.log(`    burst: ${BURST} messages, ${stats.rebuilds} list rebuilds, ${elapsed} ms`);
  });

  await step('every message arrived', async () => {
    assert.ok(stats && stats.msgs >= BURST, `expected ${BURST} messages, saw ${stats && stats.msgs}`);
  });

  await step('the burst did not rebuild the list once per message', async () => {
    assert.ok(stats.rebuilds < BURST / 2,
      `${BURST} messages caused ${stats.rebuilds} rebuilds; coalescing is not working`);
  });

  await step('the burst finished promptly', async () => {
    assert.ok(stats.elapsed < 8000, `the burst took ${stats.elapsed} ms`);
  });

  await step('sending a message stays instant for the sender', async () => {
    // The optimistic bubble must appear in the same frame as the keypress.
    const t = await vw.win.evaluate(async () => {
      const input = document.getElementById('composer-input');
      input.value = 'быстрое сообщение';
      const t0 = performance.now();
      document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true }));
      // Wait one frame for the optimistic paint.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const pending = !!document.querySelector('#messages .msg.pending');
      return { pending, ms: performance.now() - t0 };
    });
    assert.ok(t.pending, 'the optimistic bubble must be painted right away');
    assert.ok(t.ms < 500, `the optimistic paint took ${t.ms} ms`);
  });

  await step('no uncaught errors in the renderer', async () => {
    assert.deepStrictEqual(vw.errors, [], `renderer errors: ${vw.errors.join(' | ')}`);
  });

  await sd.app.close();
  await vw.app.close();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} perf UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
