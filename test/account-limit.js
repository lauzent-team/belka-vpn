'use strict';

/**
 * One device may hold three accounts; a device whose account has Premium may
 * hold five. The rule is enforced by the relay from a device id the client
 * generates, so these checks drive a real relay with real clients.
 *
 * Run with: node test/account-limit.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8836;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-acct-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-acct-${label}-`));
  return new SleePhyClient({ userDataDir: dir });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      // The register bucket is per address, and this test makes many accounts
      // from one address on purpose; the device cap is what is under test.
      SLEEPHY_RATE_REGISTER: '100'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  // A shared device id, as if all these accounts were made on one machine.
  const deviceId = 'device-' + suffix;

  /** A client that reports the shared device id, so the relay sees one device. */
  function sharedDeviceClient(label) {
    const c = makeClient(label);
    c.ensureDeviceId = () => deviceId;
    return c;
  }

  await step('three accounts are allowed on one device', async () => {
    for (let i = 1; i <= 3; i++) {
      const c = sharedDeviceClient('a' + i);
      await c.connect(URL);
      await c.register({ username: `acct_${suffix}_${i}`, password: 'password-1234' });
      c.disconnect();
    }
  });

  await step('the fourth is refused, and told why', async () => {
    const c = sharedDeviceClient('a4');
    await c.connect(URL);
    let refused = null;
    try { await c.register({ username: `acct_${suffix}_4`, password: 'password-1234' }); }
    catch (e) { refused = e; }
    assert.ok(refused, 'the fourth account must be refused');
    assert.ok(/Premium/.test(refused.message), `the message should mention Premium, got: ${refused.message}`);
    c.disconnect();
  });

  await step('a different device still gets its own three', async () => {
    const c = makeClient('other');
    await c.connect(URL);
    await c.register({ username: `acct_other_${suffix}`, password: 'password-1234' });
    c.disconnect();
  });

  await step('a client that sends no device id is not blocked', async () => {
    // An older client must keep working; only the address limit applies to it.
    const c = makeClient('old');
    c.ensureDeviceId = () => '';
    await c.connect(URL);
    await c.register({ username: `acct_old_${suffix}`, password: 'password-1234' });
    c.disconnect();
  });

  await step('Premium raises the cap to five', async () => {
    // Grant Premium to the first account of the shared device, directly on the
    // relay (the payment path is covered elsewhere). Then two more registrations
    // must succeed.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    db.prepare('UPDATE users SET premium_until = ? WHERE username = ?')
      .run(Date.now() + 30 * 24 * 60 * 60 * 1000, `acct_${suffix}_1`);
    db.close();

    for (let i = 4; i <= 5; i++) {
      const c = sharedDeviceClient('p' + i);
      await c.connect(URL);
      await c.register({ username: `acct_${suffix}_${i}`, password: 'password-1234' });
      c.disconnect();
    }
  });

  await step('the sixth is refused even with Premium', async () => {
    const c = sharedDeviceClient('p6');
    await c.connect(URL);
    let refused = null;
    try { await c.register({ username: `acct_${suffix}_6`, password: 'password-1234' }); }
    catch (e) { refused = e; }
    assert.ok(refused, 'the sixth account must be refused');
    assert.ok(/5/.test(refused.message), `the message should name the cap, got: ${refused.message}`);
    c.disconnect();
  });

  server.kill('SIGTERM');
  await wait(300);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
