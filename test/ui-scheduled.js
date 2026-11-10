'use strict';

/**
 * Drives the real Electron UI for scheduled messages: opening the "send later"
 * picker from the attachment menu, choosing a time, seeing the drawer badge and
 * the scheduled list, and sending a held message early. Real clicks on the real
 * app against a real relay — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-scheduled.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8819;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uisch-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uisch-${label}-`));
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

  // Alice opens a chat with Bob.
  await a.win.fill('#search', bob);
  await a.win.press('#search', 'Enter');
  await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });

  await step('the attachment menu offers "send later"', async () => {
    await a.win.click('#btn-attach');
    await a.win.waitForSelector('#attach-backdrop:not([hidden])', { timeout: 8000 });
    assert.ok(await a.win.isVisible('[data-attach="schedule"]'), 'schedule entry should be visible');
  });

  await step('scheduling with an empty composer is refused', async () => {
    await a.win.click('[data-attach="schedule"]');
    await a.win.waitForSelector('#attach-backdrop', { state: 'hidden', timeout: 8000 });
    assert.ok(await a.win.isHidden('#schedule-backdrop'), 'no picker without a message');
  });

  await step('writing a message then scheduling opens the picker', async () => {
    await a.win.fill('#composer-input', 'отложенное письмо');
    await a.win.click('#btn-attach');
    await a.win.waitForSelector('#attach-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('[data-attach="schedule"]');
    await a.win.waitForSelector('#schedule-backdrop:not([hidden])', { timeout: 8000 });
    const count = await a.win.locator('#schedule-options .menu-item').count();
    assert.ok(count > 1, 'the picker should offer several times');
  });

  await step('choosing a time adds the message to the scheduled list', async () => {
    await a.win.click('#schedule-options .menu-item:nth-child(1)');
    await a.win.waitForSelector('#schedule-backdrop', { state: 'hidden', timeout: 8000 });
    // The drawer badge reflects the one held message (the drawer itself may be
    // closed, so check the badge's own hidden flag, not its visibility).
    await a.win.waitForFunction(() => {
      const el = document.getElementById('drawer-scheduled-count');
      return el && !el.hidden;
    }, { timeout: 8000 });
    assert.equal((await a.win.textContent('#drawer-scheduled-count')).trim(), '1');
  });

  await step('the scheduled list shows the message and its time', async () => {
    await a.win.click('#btn-menu');
    await a.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await a.win.click('[data-drawer="scheduled"]');
    await a.win.waitForSelector('#sched-backdrop:not([hidden])', { timeout: 8000 });
    const text = (await a.win.textContent('#sched-list .sched-text')).trim();
    assert.equal(text, 'отложенное письмо');
    const when = (await a.win.textContent('#sched-list .sched-when')).trim();
    assert.ok(when.length > 0, 'the list shows a send time');
  });

  await step('the held message is not delivered to the peer yet', async () => {
    await b.win.fill('#search', alice);
    await b.win.press('#search', 'Enter');
    await b.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 600));
    const seen = await b.win.locator('#messages .msg', { hasText: 'отложенное письмо' }).count();
    assert.equal(seen, 0, 'the peer should not see a scheduled message');
  });

  await step('"send now" delivers the message and clears the list', async () => {
    await a.win.click('#sched-list [data-sched="now"]');
    await a.win.waitForSelector('#sched-empty:not([hidden])', { timeout: 8000 });
    await b.win.waitForSelector('#messages .msg', { timeout: 8000 });
    const seen = await b.win.locator('#messages .msg', { hasText: 'отложенное письмо' }).count();
    assert.equal(seen, 1, 'the peer should receive the released message');
    assert.ok(await a.win.isHidden('#drawer-scheduled-count'), 'the badge clears when the list empties');
  });

  await step('cancelling removes a held message without sending it', async () => {
    await a.win.click('#btn-sched-close');
    await a.win.waitForSelector('#sched-backdrop', { state: 'hidden', timeout: 8000 });
    await a.win.fill('#composer-input', 'отменить меня');
    await a.win.click('#btn-attach');
    await a.win.waitForSelector('#attach-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('[data-attach="schedule"]');
    await a.win.waitForSelector('#schedule-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#schedule-options .menu-item:nth-child(1)');
    await a.win.waitForSelector('#schedule-backdrop', { state: 'hidden', timeout: 8000 });
    await a.win.click('#btn-menu');
    await a.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await a.win.click('[data-drawer="scheduled"]');
    await a.win.waitForSelector('#sched-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#sched-list [data-sched="cancel"]');
    await a.win.waitForSelector('#sched-empty:not([hidden])', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 500));
    const seen = await b.win.locator('#messages .msg', { hasText: 'отменить меня' }).count();
    assert.equal(seen, 0, 'a cancelled message is never delivered');
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
  console.log(`\n${results.length - failed}/${results.length} UI scheduled checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
