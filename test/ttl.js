'use strict';

/**
 * Self-destructing message checks against a real relay: the shared conversation
 * timer, the countdown carried on each message, the sweep that wipes ciphertext
 * once it runs out, and the plaintext-free store. No mocks — real crypto, real
 * relay, real SQLite.
 *
 * Run with: node test/ttl.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8796;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-ttl-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-ttl-${label}-`));
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
  await A.client.sendMessage({ to: bob, text: 'привет' });
  await waitFor(() => B.events.find((e) => e.type === 'message'));

  await step('setting the timer writes it for both sides and tells the peer', async () => {
    const res = await A.client.setChatTtl({ peer: bob, ttl: 60000 });
    assert.equal(res.ttl, 60000);
    const evt = await waitFor(() => B.events.find((e) => e.type === 'chat.ttl'));
    assert.ok(evt, 'Bob should be told about the timer');
    assert.equal(evt.ttl, 60000);
    assert.equal(evt.peer, alice, 'the event points back at the sender');
    // Both sides read the same timer back from history.
    const hist = await B.client.history({ with: alice, limit: 10 });
    assert.equal(hist.ttl, 60000);
  });

  let ttlMsgId;
  await step('a message sent with a timer carries its expiry to both sides', async () => {
    const before = Date.now();
    const res = await A.client.sendMessage({ to: bob, text: 'сгори', ttl: 60000 });
    ttlMsgId = res.id;
    assert.ok(res.expiresAt >= before + 55000 && res.expiresAt <= before + 65000, 'sender gets an expiry about a minute out');
    const evt = await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === ttlMsgId));
    assert.ok(evt, 'Bob should receive the message');
    assert.ok(evt.expiresAt > Date.now(), 'the peer is told when it will vanish');
    const row = await B.client.history({ with: alice, limit: 10 });
    const m = row.find((x) => x.id === ttlMsgId);
    assert.ok(m && m.expiresAt, 'history carries the expiry');
  });

  await step('a message without a timer never expires', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'останусь' });
    assert.ok(!res.expiresAt, 'no expiry when no timer is set');
    const row = await B.client.history({ with: alice, limit: 10 });
    const m = row.find((x) => x.id === res.id);
    assert.ok(m && !m.expiresAt, 'history leaves it open');
  });

  await step('the relay stores only ciphertext, not the text', async () => {
    const raw = new DatabaseSync(DB);
    const row = raw.prepare('SELECT box, expires_at FROM messages WHERE id = ?').get(ttlMsgId);
    assert.ok(row, 'row exists');
    assert.ok(!row.box.includes('сгори'), 'plaintext leaked into the relay store');
    assert.ok(row.expires_at, 'the expiry is stored on the row');
    raw.close();
  });

  await step('an expired message is swept and both sides are told', async () => {
    // Push the expiry into the past so the sweep runs without a real wait.
    const raw = new DatabaseSync(DB);
    raw.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, ttlMsgId);
    raw.close();

    const evtB = await waitFor(() => B.events.find((e) => e.type === 'expired' && e.id === ttlMsgId), 12000);
    const evtA = await waitFor(() => A.events.find((e) => e.type === 'expired' && e.id === ttlMsgId), 12000);
    assert.ok(evtB, 'the recipient is told it expired');
    assert.ok(evtA, 'the sender is told it expired');

    const raw2 = new DatabaseSync(DB);
    const row = raw2.prepare('SELECT box, nonce, attachment, expires_at, deleted FROM messages WHERE id = ?').get(ttlMsgId);
    assert.equal(row.box, '', 'the ciphertext is wiped');
    assert.equal(row.nonce, '', 'the nonce is wiped');
    assert.equal(row.attachment, null, 'any attachment is wiped');
    assert.equal(row.expires_at, null, 'the timer is cleared');
    assert.equal(row.deleted, 1, 'the row is left as a deleted marker');
    raw2.close();
  });

  await step('a history read shows the swept message as deleted', async () => {
    const row = await B.client.history({ with: alice, limit: 10 });
    const m = row.find((x) => x.id === ttlMsgId);
    assert.ok(m && m.deleted, 'the message reads as deleted');
    assert.equal(m.text, '', 'nothing is decrypted from a wiped message');
  });

  await step('turning the timer off leaves future messages permanent', async () => {
    const res = await A.client.setChatTtl({ peer: bob, ttl: 0 });
    assert.equal(res.ttl, 0);
    await waitFor(() => B.events.find((e) => e.type === 'chat.ttl' && e.ttl === 0));
    const sent = await A.client.sendMessage({ to: bob, text: 'снова постоянное' });
    assert.ok(!sent.expiresAt, 'a message sent after the timer is off never expires');
  });

  await step('the relay clamps an absurd timer instead of trusting it', async () => {
    const res = await A.client.setChatTtl({ peer: bob, ttl: 1 });
    assert.equal(res.ttl, 1000, 'a sub-second timer is lifted to the floor');
    const res2 = await A.client.setChatTtl({ peer: bob, ttl: 999 * 24 * 3600 * 1000 });
    assert.equal(res2.ttl, 7 * 24 * 3600 * 1000, 'an over-long timer is capped');
    await A.client.setChatTtl({ peer: bob, ttl: 0 });
  });

  for (const x of [A, B]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} ttl checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
