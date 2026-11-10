'use strict';

/**
 * The dialog "огонёк": days in a row two people have written to each other.
 *
 * Unlike the account streak, this belongs to the pair, so both sides must see
 * the same number. On the day it first appears the relay also leaves one
 * centered "series started" note in both transcripts, and that note must never
 * count as an unread message or become the chat preview.
 *
 * Run with: node test/dialog-streaks.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8810;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-dialog-streak-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-dialog-${label}-`));
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

/** Rewrite the stored pair day/count to stand in for another calendar day. */
function backdate(x, y, dayOffset, count) {
  const [a, b] = x < y ? [x, y] : [y, x];
  const day = new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10);
  const db = new DatabaseSync(DB);
  try {
    db.prepare('UPDATE dialog_streaks SET day = ?, count = ? WHERE a = ? AND b = ?')
      .run(day, count, a, b);
  } finally {
    db.close();
  }
  return day;
}

/** How many centered series notes a transcript holds. */
function seriesNotes(items) {
  return items.filter((m) => m.kind === 'system:series');
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

  await A.client.connect(URL);
  await B.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });

  await step('a fresh pair has no dialog flame', async () => {
    const s = await A.client.dialogStreak(bob);
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.active, false);
  });

  await step('the first message starts the pair flame at one', async () => {
    const sent = await A.client.sendMessage({ to: bob, text: 'привет' });
    assert.ok(sent.id, 'the message should be stored');
    const s = await A.client.dialogStreak(bob);
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.active, true);
  });

  await step('the sender is told the flame moved right away', async () => {
    const evt = await waitFor(() => A.events.find((e) => e.type === 'dialog.streak'));
    assert.ok(evt, 'the send reply should carry the dialog streak');
    assert.strictEqual(evt.peer, bob);
    assert.strictEqual(evt.count, 1);
    assert.strictEqual(evt.active, true);
  });

  await step('both sides see one centered series note', async () => {
    await waitFor(() => B.events.some((e) => e.type === 'message'));
    const fromA = await A.client.history({ with: bob, limit: 50 });
    const fromB = await B.client.history({ with: alice, limit: 50 });
    assert.strictEqual(seriesNotes(fromA).length, 1, 'Alice sees one note');
    assert.strictEqual(seriesNotes(fromB).length, 1, 'Bob sees one note');
    assert.strictEqual(fromA.streak.count, 1, 'history carries the pair flame');
    assert.strictEqual(fromB.streak.count, 1, 'both sides read the same flame');
  });

  await step('the note does not count as an unread message', async () => {
    const rows = await B.client.listChats();
    const row = rows.find((r) => r.peer === alice);
    assert.ok(row, 'Bob has a chat with Alice');
    assert.strictEqual(row.unread, 1, 'only the real message is unread');
    assert.strictEqual(row.last.from, alice, 'the preview is the real message');
  });

  await step('a reply the same day keeps the flame at one', async () => {
    await B.client.sendMessage({ to: alice, text: 'и тебе' });
    await waitFor(() => A.events.filter((e) => e.type === 'message').length >= 2);
    const s = await A.client.dialogStreak(bob);
    assert.strictEqual(s.count, 1);
    const notes = seriesNotes(await A.client.history({ with: bob, limit: 50 }));
    assert.strictEqual(notes.length, 1, 'no second note the same day');
  });

  await step('writing the next day extends the flame to two', async () => {
    backdate(alice, bob, -1, 1);
    await A.client.sendMessage({ to: bob, text: 'доброе утро' });
    const s = await A.client.dialogStreak(bob);
    assert.strictEqual(s.count, 2);
    assert.strictEqual(s.active, true);
    const notes = seriesNotes(await A.client.history({ with: bob, limit: 50 }));
    assert.strictEqual(notes.length, 1, 'an extension is not a new series');
  });

  await step('a missed day restarts the flame at one', async () => {
    backdate(alice, bob, -2, 5);
    await A.client.sendMessage({ to: bob, text: 'снова тут' });
    const s = await A.client.dialogStreak(bob);
    assert.strictEqual(s.count, 1, 'the flame restarts');
    const notes = seriesNotes(await A.client.history({ with: bob, limit: 50 }));
    assert.strictEqual(notes.length, 2, 'a restarted series leaves a new note');
  });

  await step('the chat list carries the pair flame on both sides', async () => {
    const rowsA = await A.client.listChats();
    const rowsB = await B.client.listChats();
    const rowA = rowsA.find((r) => r.peer === bob);
    const rowB = rowsB.find((r) => r.peer === alice);
    assert.ok(rowA.streak && rowA.streak.count === 1, 'Alice row carries the flame');
    assert.ok(rowB.streak && rowB.streak.count === 1, 'Bob row carries the flame');
  });

  await step('a saved-messages post has no pair flame', async () => {
    // Saved Messages is a chat with yourself: it has no pair, so it must not
    // touch the flame Alice shares with Bob.
    await A.client.sendMessage({ to: alice, text: 'заметка себе' });
    const s = await A.client.dialogStreak(bob);
    assert.strictEqual(s.count, 1, 'the pair flame is untouched by a self-post');
  });

  await step('the pair row is stored once, in sorted order', async () => {
    const [a, b] = alice < bob ? [alice, bob] : [bob, alice];
    const db = new DatabaseSync(DB);
    try {
      const rows = db.prepare('SELECT * FROM dialog_streaks WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
        .all(a, b, b, a);
      assert.strictEqual(rows.length, 1, 'one row serves both people');
      assert.strictEqual(rows[0].a, a, 'the pair is stored with a < b');
      assert.strictEqual(rows[0].b, b);
    } finally {
      db.close();
    }
  });

  A.client.disconnect();
  B.client.disconnect();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} dialog-streak checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
