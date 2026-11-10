'use strict';

/**
 * Key verification checks against a real relay: the safety number is derived on
 * the device from the two public keys, so both ends compute the same value and
 * the relay never learns it. No mocks — real crypto, real relay.
 *
 * Run with: node test/safety.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');
const cryptoLib = require('../src/lib/crypto');

const PORT = 8795;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-safety-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-safety-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const A = makeClient('a');
  const B = makeClient('b');
  const C = makeClient('c');
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;
  const carol = `carol_${suffix}`;

  for (const x of [A, B, C]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });
  await C.client.register({ username: carol, password: 'password-1234' });

  await step('both sides derive the same safety number', async () => {
    const a = await A.client.safetyNumberWith(bob);
    const b = await B.client.safetyNumberWith(alice);
    assert.ok(a, 'a number is produced');
    assert.equal(a, b, 'the two ends must agree, or the check is useless');
  });

  await step('the number is stable across calls', async () => {
    const first = await A.client.safetyNumberWith(bob);
    const again = await A.client.safetyNumberWith(bob);
    assert.equal(first, again);
  });

  await step('a different peer gives a different number', async () => {
    const withBob = await A.client.safetyNumberWith(bob);
    const withCarol = await A.client.safetyNumberWith(carol);
    assert.notEqual(withBob, withCarol, 'a shared number must be per pair');
  });

  await step('the number is twelve five-digit groups', async () => {
    const num = await A.client.safetyNumberWith(bob);
    const groups = num.split(' ');
    assert.equal(groups.length, 12);
    for (const g of groups) assert.match(g, /^\d{5}$/);
  });

  await step('the order of the keys does not change the number', async () => {
    const pubA = A.client.publicKey;
    const pubB = B.client.publicKey;
    const forward = await cryptoLib.safetyNumber(pubA, pubB);
    const backward = await cryptoLib.safetyNumber(pubB, pubA);
    assert.equal(forward, backward, 'sorting the keys makes the result symmetric');
  });

  await step('a different key pair yields a different number', async () => {
    // A fresh identity stands in for a relay that substituted a key: the code
    // Alice sees for that key must not match the real Bob's code.
    const fake = await cryptoLib.generateIdentity();
    const real = await cryptoLib.safetyNumber(A.client.publicKey, B.client.publicKey);
    const swapped = await cryptoLib.safetyNumber(A.client.publicKey, fake.publicKey);
    assert.notEqual(real, swapped, 'a substituted key must be visible in the code');
  });

  await step('the number never reaches the relay as plaintext', async () => {
    const num = await A.client.safetyNumberWith(bob);
    // The relay holds no message with this value: it is computed locally.
    await A.client.sendMessage({ to: bob, text: 'hi' });
    const { DatabaseSync } = require('node:sqlite');
    await wait(200);
    const db = new DatabaseSync(DB);
    const rows = db.prepare('SELECT box, nonce FROM messages').all();
    const blob = rows.map((r) => `${r.box}${r.nonce}`).join('');
    assert.ok(!blob.includes(num.replace(/ /g, '')), 'the code is not stored');
    assert.ok(!blob.includes(num), 'the code is not stored');
    db.close();
  });

  await step('a signed-out client cannot read a safety number', async () => {
    const lone = makeClient('lone');
    await lone.client.connect(URL);
    let threw = false;
    try { await lone.client.safetyNumberWith(bob); } catch { threw = true; }
    assert.ok(threw, 'without a public key there is nothing to compare');
    lone.client.disconnect();
  });

  for (const x of [A, B, C]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} safety checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
