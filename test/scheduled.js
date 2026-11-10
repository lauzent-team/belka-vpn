'use strict';

/**
 * Scheduled ("send later") message checks against a real relay: a message held
 * for a future time is invisible to history until then, can be listed, cancelled
 * and sent early by its sender, and is released automatically by the sweeper.
 * No mocks — real crypto, real relay, real SQLite.
 *
 * Run with: node test/scheduled.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8818;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-sched-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-sched-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await wait(80);
  }
  return null;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const A = makeClient('a');
  const B = makeClient('b');
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  for (const x of [A, B]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });

  const future = Date.now() + 60 * 60 * 1000;

  await step('a scheduled message is acknowledged but not delivered yet', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'напишу позже', sendAt: future });
    assert.ok(res.scheduled, 'the sender is told it was scheduled');
    assert.ok(res.sendAt > Date.now(), 'it carries a future send time');
    assert.equal(res.text, 'напишу позже');
    // Bob must not see it at all before its time.
    await wait(400);
    assert.ok(!B.events.find((e) => e.type === 'message' && e.id === res.id), 'the recipient gets nothing yet');
  });

  await step('the held message is absent from the recipient history', async () => {
    const row = await B.client.history({ with: alice, limit: 20 });
    assert.ok(!row.find((x) => x.text === 'напишу позже'), 'nothing leaks into history early');
  });

  let heldId;
  await step('the sender can list their scheduled message, decrypted', async () => {
    const items = await A.client.listScheduled();
    assert.equal(items.length, 1, 'exactly one scheduled message');
    heldId = items[0].id;
    assert.equal(items[0].text, 'напишу позже', 'the sender reads the text back');
    assert.equal(items[0].to, bob);
    assert.ok(items[0].sendAt >= future - 1000, 'the send time is preserved');
  });

  await step('the relay stores only ciphertext while it waits', async () => {
    const raw = new DatabaseSync(DB);
    const row = raw.prepare('SELECT box, send_at FROM messages WHERE id = ?').get(heldId);
    assert.ok(row, 'row exists');
    assert.ok(!row.box.includes('напишу позже'), 'plaintext leaked into the relay store');
    assert.ok(row.send_at, 'the send time is stored on the row');
    raw.close();
  });

  await step('cancelling removes it from the list and never delivers it', async () => {
    const id = await A.client.cancelScheduled({ id: heldId });
    assert.equal(id, heldId);
    const items = await A.client.listScheduled();
    assert.equal(items.length, 0, 'the list is empty again');
    await wait(400);
    assert.ok(!B.events.find((e) => e.type === 'message' && e.id === heldId), 'the peer still gets nothing');
    const row = await B.client.history({ with: alice, limit: 20 });
    assert.ok(!row.find((x) => x.id === heldId), 'and it never enters history');
  });

  await step('a scheduled message can be rescheduled to a new time', async () => {
    const later = Date.now() + 2 * 60 * 60 * 1000;
    const res = await A.client.sendMessage({ to: bob, text: 'перенеси меня', sendAt: future });
    await A.client.rescheduleScheduled({ id: res.id, sendAt: later });
    const items = await A.client.listScheduled();
    const item = items.find((x) => x.id === res.id);
    assert.ok(item, 'still scheduled');
    assert.ok(item.sendAt >= later - 1000, 'the new time was written');
  });

  let nowId;
  await step('"send now" releases the message to both sides at once', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'отправь сейчас', sendAt: future });
    nowId = res.id;
    await A.client.sendScheduledNow({ id: nowId });
    const evt = await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === nowId));
    assert.ok(evt, 'the recipient receives it immediately');
    assert.equal(evt.text, 'отправь сейчас');
    const items = await A.client.listScheduled();
    assert.ok(!items.find((x) => x.id === nowId), 'it left the scheduled list');
    const row = await B.client.history({ with: alice, limit: 20 });
    assert.ok(row.find((x) => x.id === nowId), 'it is now part of the history');
  });

  let dueId;
  await step('the sweeper releases a message whose time has arrived', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'созрело', sendAt: future });
    dueId = res.id;
    // Push the send time into the past so the sweep runs without a real wait.
    const raw = new DatabaseSync(DB);
    raw.prepare('UPDATE messages SET send_at = ? WHERE id = ?').run(Date.now() - 1000, dueId);
    raw.close();

    const evt = await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === dueId), 12000);
    assert.ok(evt, 'the recipient receives it when its time comes');
    assert.equal(evt.text, 'созрело');
    const released = await waitFor(() => A.events.find((e) => e.type === 'scheduled.released' && e.id === dueId), 12000);
    assert.ok(released, 'the sender is told it went out');

    const raw2 = new DatabaseSync(DB);
    const row = raw2.prepare('SELECT send_at FROM messages WHERE id = ?').get(dueId);
    assert.equal(row.send_at, null, 'the send time is cleared on release');
    raw2.close();
  });

  await step('the relay clamps a send time in the past to a future one', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'слишком рано', sendAt: Date.now() - 10 * 60 * 1000 });
    assert.ok(res.scheduled, 'it is still treated as scheduled');
    assert.ok(res.sendAt > Date.now(), 'the relay lifted it into the future');
    await A.client.cancelScheduled({ id: res.id });
  });

  await step('deleting a scheduled message also clears its send time', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'удали меня', sendAt: future });
    await A.client.deleteMessage({ id: res.id });
    const items = await A.client.listScheduled();
    assert.ok(!items.find((x) => x.id === res.id), 'it is gone from the scheduled list');
  });

  for (const x of [A, B]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} scheduled checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
