'use strict';

/**
 * Account lifecycle tests against a real relay: signing out and back in,
 * switching, and dropping an account from the device.
 *
 * Regression cover for a sign-out that deleted the identity file but left the
 * registry entry behind. The account then showed up as usable, could not be
 * unlocked ("No key material"), and its username stayed reserved on the relay,
 * so it could not be re-registered either — a dead end.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8795;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-accounts-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function device(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-acc-${label}-`));
  const client = new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
  return { client, dir };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const probe = () => {
      const ws = new WebSocket(URL);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => {
        if (Date.now() - t0 > 8000) return reject(new Error('server did not start'));
        setTimeout(probe, 150);
      });
    };
    probe();
  });

  const a = device('a');
  const PASSWORD = 'password-1234';

  await step('registering stores an unlockable key record', async () => {
    await a.client.connect(URL);
    await a.client.register({ username: 'ann', password: PASSWORD });
    assert.strictEqual(a.client.username, 'ann');
    assert.ok(a.client.keyRecordFor('ann'), 'a sealed record should exist');
  });

  await step('signing out clears the live identity but keeps the key record', async () => {
    a.client.signOut();
    assert.strictEqual(a.client.username, null, 'the session is gone');
    assert.strictEqual(a.client.status().hasStoredIdentity, false, 'no live identity file');
    assert.ok(a.client.keyRecordFor('ann'), 'the sealed key must survive sign-out');
    const listed = a.client.listAccounts();
    assert.deepStrictEqual(listed.map((x) => x.username), ['ann'], 'the account is still usable');
  });

  await step('the same account logs back in after signing out', async () => {
    await a.client.connect(URL);
    await a.client.login({ username: 'ann', password: PASSWORD });
    assert.strictEqual(a.client.username, 'ann');
    assert.ok(a.client.status().unlocked, 'the vault should be unlocked');
  });

  await step('a wrong password is rejected without losing the key record', async () => {
    a.client.signOut();
    await a.client.connect(URL);
    let threw = false;
    try { await a.client.login({ username: 'ann', password: 'not-the-password' }); }
    catch { threw = true; }
    assert.ok(threw, 'a wrong password must fail');
    assert.ok(a.client.keyRecordFor('ann'), 'and must not destroy the stored key');
  });

  await step('the account still logs in with the right password', async () => {
    await a.client.connect(URL);
    await a.client.login({ username: 'ann', password: PASSWORD });
    assert.strictEqual(a.client.username, 'ann');
  });

  // A wiped profile, or a fresh install of a name that already exists on the
  // relay, has the password but not the key: the key only ever lived on the
  // first device. Sign-in must fail cleanly and leave no session behind, or the
  // UI reads a signed-in user with no vault and sticks on an unlock screen.
  await step('a device without the key cannot sign in and keeps no session', async () => {
    const fresh = device('fresh');
    await fresh.client.connect(URL);
    let message = '';
    try { await fresh.client.login({ username: 'ann', password: PASSWORD }); }
    catch (err) { message = err.message || ''; }
    assert.ok(/no key on this device/i.test(message), `expected a key-loss message, got "${message}"`);
    assert.strictEqual(fresh.client.username, null, 'no user may be adopted');
    assert.strictEqual(fresh.client.status().unlocked, false, 'the vault must stay locked');
    assert.strictEqual(fresh.client.status().hasStoredIdentity, false, 'nothing may be written');
  });

  await step('that device can still create its own account', async () => {
    const fresh = device('fresh2');
    await fresh.client.connect(URL);
    await fresh.client.register({ username: 'erin', password: PASSWORD });
    assert.strictEqual(fresh.client.username, 'erin');
    assert.ok(fresh.client.status().unlocked, 'the new vault should be open');
  });

  const b = device('b');

  await step('a second account registers on the same device', async () => {
    await b.client.connect(URL);
    await b.client.register({ username: 'carol', password: PASSWORD });
    b.client.signOut();
    await b.client.connect(URL);
    await b.client.register({ username: 'dave', password: PASSWORD });
    assert.deepStrictEqual(
      b.client.listAccounts().map((x) => x.username).sort(),
      ['carol', 'dave'],
      'both accounts should be listed'
    );
  });

  await step('switching accounts lands on the other account', async () => {
    const res = await b.client.switchAccount('carol');
    assert.strictEqual(res.username, 'carol');
    assert.strictEqual(res.hasKeys, true, 'the target account has key material');
    await b.client.unlock(PASSWORD);
    assert.strictEqual(b.client.username, 'carol');
  });

  await step('forgetting an account removes it from the device', async () => {
    await b.client.forgetAccount('carol');
    assert.deepStrictEqual(
      b.client.listAccounts().map((x) => x.username),
      ['dave'],
      'the forgotten account is gone, the other remains'
    );
  });

  // Forgetting is local: the relay still holds the account, so its username
  // stays reserved. Re-registering it must fail until the account is deleted
  // server-side, which keeps the two notions from silently diverging.
  await step('a forgotten account stays reserved on the relay', async () => {
    await b.client.connect(URL);
    let message = '';
    try { await b.client.register({ username: 'carol', password: 'brand-new-pass-9' }); }
    catch (err) { message = err.message || ''; }
    assert.ok(/taken/i.test(message), `expected the username to stay taken, got "${message}"`);
  });

  await step('forgetting every account empties the device', async () => {
    b.client.forgetAllAccounts();
    assert.deepStrictEqual(b.client.listAccounts(), [], 'no accounts should remain');
    assert.strictEqual(b.client.status().hasStoredIdentity, false);
  });

  a.client.disconnect();
  b.client.disconnect();
  server.kill('SIGTERM');
  await wait(200);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} account checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
