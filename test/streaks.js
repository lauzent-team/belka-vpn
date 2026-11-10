'use strict';

/**
 * The "огонёк" streak: days in a row the account has sent something.
 *
 * The relay counts the days and stores only the last day and the running count.
 * These checks drive that with real clients and a real relay, then backdate the
 * stored day directly so a "next day" can be simulated without waiting one.
 *
 * Run with: node test/streaks.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8804;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-streak-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-streak-${label}-`));
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

/** Rewrite the stored streak day/count to stand in for another calendar day. */
function backdate(username, dayOffset, count) {
  const day = new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10);
  const db = new DatabaseSync(DB);
  try {
    db.prepare('UPDATE streaks SET day = ?, count = ? WHERE username = ?').run(day, count, username);
  } finally {
    db.close();
  }
  return day;
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
  // Give Bob a chat with Alice so profile changes reach him.
  await B.client.sendMessage({ to: alice, text: 'hi' });
  await waitFor(() => A.events.some((e) => e.type === 'message'));

  await step('a fresh account has no streak', async () => {
    const s = await A.client.getStreak();
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.active, false);
  });

  await step('sending today starts a streak of one', async () => {
    await A.client.sendMessage({ to: bob, text: 'first' });
    const s = await A.client.getStreak();
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.active, true);
  });

  await step('a peer sees the streak on the profile', async () => {
    const { profile } = await B.client.getProfile(alice);
    assert.strictEqual(profile.streak, 1);
    assert.strictEqual(profile.streakActive, true);
  });

  await step('the peer is told the moment the streak moves', async () => {
    const event = await waitFor(() =>
      B.events.find((e) => e.type === 'profile' && e.username === alice && e.profile.streak === 1));
    assert.ok(event, 'Bob should receive a profile update carrying the streak');
  });

  await step('sending again the same day does not add a day', async () => {
    await A.client.sendMessage({ to: bob, text: 'second' });
    const s = await A.client.getStreak();
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.active, true);
  });

  await step('a day later, sending extends the streak', async () => {
    backdate(alice, -1, 4); // yesterday, four days running
    let s = await A.client.getStreak();
    assert.strictEqual(s.count, 4, 'the streak should still read 4 before sending');
    assert.strictEqual(s.active, false, 'today is not counted yet');
    await A.client.sendMessage({ to: bob, text: 'third' });
    s = await A.client.getStreak();
    assert.strictEqual(s.count, 5);
    assert.strictEqual(s.active, true);
  });

  await step('a missed day resets the streak to zero', async () => {
    backdate(alice, -2, 9); // two days ago: the chain is broken
    const s = await A.client.getStreak();
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.active, false);
  });

  await step('sending after a break restarts at one', async () => {
    await A.client.sendMessage({ to: bob, text: 'back' });
    const s = await A.client.getStreak();
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.active, true);
  });

  await step('renaming the account keeps the streak', async () => {
    const renamed = `alice2_${suffix}`;
    backdate(alice, -1, 3);
    await A.client.sendMessage({ to: bob, text: 'still here' });
    const before = await A.client.getStreak();
    assert.strictEqual(before.count, 4);
    await A.client.changeUsername(renamed);
    const after = await A.client.getStreak();
    assert.strictEqual(after.count, 4, 'the streak must follow the account');
  });

  A.client.disconnect();
  B.client.disconnect();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} streak checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
