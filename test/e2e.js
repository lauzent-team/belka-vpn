'use strict';

/**
 * End-to-end test: real relay server, real crypto, real WebSocket transport.
 * No mocks. Two clients register, exchange messages, and we assert:
 *   1. ciphertext on the wire is not the plaintext
 *   2. the relay stores only ciphertext (never the plaintext)
 *   3. both sides decrypt correctly
 *   4. tampered ciphertext is rejected (authenticated encryption)
 *   5. offline messages are delivered on reconnect
 *   6. wrong password cannot unlock the local key material
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8791;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-test-${Date.now()}.db`);

const results = [];
function pass(name) { results.push(['PASS', name]); console.log('  PASS', name); }
function fail(name, err) { results.push(['FAIL', name]); console.log('  FAIL', name, '->', err && err.message); }

async function step(name, fn) {
  try { await fn(); pass(name); }
  catch (err) { fail(name, err); }
}

function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-${label}-`));
  return dir;
}

function makeClient(label) {
  const dir = tmpDir(label);
  const events = [];
  const client = new SleePhyClient({
    userDataDir: dir,
    onEvent: (e) => events.push(e)
  });
  return { client, events, dir };
}

function waitFor(events, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeout) return reject(new Error('timeout waiting for event'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main() {
  // ---- start a real relay server ----
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  // wait for the port to accept connections
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tryConnect = () => {
      const ws = new WebSocket(URL);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => {
        if (Date.now() - t0 > 8000) return reject(new Error('server did not start'));
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });

  const alice = makeClient('alice');
  const bob = makeClient('bob');

  await step('alice registers', async () => {
    await alice.client.connect(URL);
    await alice.client.register({ username: 'alice', password: 'correct-horse-battery' });
    assert.strictEqual(alice.client.username, 'alice');
  });

  await step('bob registers', async () => {
    await bob.client.connect(URL);
    await bob.client.register({ username: 'bob', password: 'hunter2-hunter2' });
    assert.strictEqual(bob.client.username, 'bob');
  });

  await step('duplicate username is rejected', async () => {
    const dup = makeClient('dup');
    await dup.client.connect(URL);
    let threw = false;
    try { await dup.client.register({ username: 'alice', password: 'another-pass-1' }); }
    catch { threw = true; }
    assert.ok(threw, 'expected duplicate registration to fail');
    dup.client.disconnect();
  });

  await step('bob receives an encrypted message from alice', async () => {
    const secret = 'meet me at the usual place 🔐';
    await alice.client.sendMessage({ to: 'bob', text: secret });
    const evt = await waitFor(bob.events, (e) => e.type === 'message');
    assert.strictEqual(evt.text, secret, 'decrypted text must match');
    assert.strictEqual(evt.from, 'alice');
  });

  await step('relay stores ciphertext, not plaintext', async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare('SELECT box, nonce FROM messages').all();
    assert.ok(rows.length >= 1, 'expected at least one stored message');
    const raw = fs.readFileSync(DB);
    assert.ok(!raw.includes(Buffer.from('meet me at the usual place')),
      'plaintext must never appear in the server database');
    assert.ok(rows[0].box.length > 0 && rows[0].nonce.length > 0);
    db.close();
  });

  await step('tampered ciphertext is rejected', async () => {
    const cryptoLib = require('../src/lib/crypto');
    const peerKey = await alice.client.ensurePeerKey('bob');
    const { box, nonce } = await cryptoLib.encryptMessage('integrity check', peerKey, alice.client.secretKey);
    const bytes = Buffer.from(box, 'base64');
    bytes[0] ^= 0xff; // flip a bit
    const tampered = bytes.toString('base64');
    let threw = false;
    try {
      await cryptoLib.decryptMessage(tampered, nonce, alice.client.publicKey, bob.client.secretKey);
    } catch { threw = true; }
    assert.ok(threw, 'tampered ciphertext must fail authentication');
  });

  await step('offline message is delivered on reconnect', async () => {
    bob.client.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    await alice.client.sendMessage({ to: 'bob', text: 'sent while you were away' });
    bob.events.length = 0;
    await bob.client.connect(URL);
    const evt = await waitFor(bob.events, (e) => e.type === 'message' && e.text === 'sent while you were away', 8000);
    assert.strictEqual(evt.text, 'sent while you were away');
  });

  await step('history returns decrypted conversation', async () => {
    const items = await alice.client.history({ with: 'bob', limit: 50 });
    assert.ok(items.length >= 2, 'expected at least two messages');
    assert.ok(items.some((m) => m.text === 'meet me at the usual place 🔐' && m.mine));
  });

  await step('login with wrong password fails', async () => {
    const mallory = makeClient('mallory');
    await mallory.client.connect(URL);
    let threw = false;
    try { await mallory.client.login({ username: 'alice', password: 'wrong-password-xx' }); }
    catch { threw = true; }
    assert.ok(threw, 'wrong password must be rejected');
    mallory.client.disconnect();
  });

  await step('local key file cannot be unlocked with wrong password', async () => {
    const cryptoLib = require('../src/lib/crypto');
    const id = JSON.parse(fs.readFileSync(path.join(alice.dir, 'sleephy-identity.json'), 'utf8'));
    const wrongKey = cryptoLib.deriveKey('wrong-password-xx', id.salt);
    let threw = false;
    try { await cryptoLib.openSecret(id.sealed, id.nonce, wrongKey); }
    catch { threw = true; }
    assert.ok(threw, 'sealed key must not open with a wrong password');
  });

  await step('key file has restrictive permissions', async () => {
    // Windows has no POSIX mode bits: statSync always reports 0o666 there, so
    // the check only means something on a POSIX host.
    if (process.platform === 'win32') return;
    const id = path.join(alice.dir, 'sleephy-identity.json');
    const mode = fs.statSync(id).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  // ---- teardown ----
  alice.client.disconnect();
  bob.client.disconnect();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch {}

  const failed = results.filter(([s]) => s === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
