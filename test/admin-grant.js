'use strict';

/**
 * An administrator handing out Rockets and Premium from the panel.
 *
 * The point is that a granted balance is the same thing as a paid one: it goes
 * through the same relay code, shows up in the admin user list, and a
 * non-admin cannot reach any of it. The relay is the authority, so these checks
 * are about who may do what and what the numbers become.
 *
 * Run with: node test/admin-grant.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8831;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-grant-${Date.now()}.db`);
const ADMIN = 'grantadmin';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-grant-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_ADMINS: ADMIN,
      SLEEPHY_OWNER: ADMIN,
      SLEEPHY_PAY_PROVIDER: 'mock',
      SLEEPHY_WELCOME_ROCKETS: '0'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const user = `guser_${suffix}`;

  const admin = makeClient('admin');
  const target = makeClient('target');
  for (const x of [admin, target]) await x.client.connect(URL);
  await admin.client.register({ username: ADMIN, password: 'password-1234' });
  await target.client.register({ username: user, password: 'password-1234' });

  await step('a fresh account has no Rockets and no Premium', async () => {
    const w = await target.client.wallet();
    assert.strictEqual(w.balance, 0, 'no Rockets yet');
    assert.strictEqual(w.premium.active, false, 'no subscription');
  });

  await step('an administrator can grant Rockets', async () => {
    const from = target.events.length;
    await admin.client.adminAction({ action: 'grantRockets', username: user, amount: 250 });
    const w = await target.client.wallet();
    assert.strictEqual(w.balance, 250, 'the balance went up by exactly 250');
    // The grant is pushed to the account, not left for a manual refresh.
    await wait(150);
    assert.ok(
      target.events.slice(from).some((e) => e.type === 'wallet' && e.balance === 250),
      'the account is told about its new balance'
    );
  });

  await step('an administrator can grant Premium in months', async () => {
    await admin.client.adminAction({ action: 'grantPremium', username: user, months: 3 });
    const w = await target.client.wallet();
    assert.strictEqual(w.premium.active, true, 'Premium is active');
    const left = w.premium.until - Date.now();
    assert.ok(left > 88 * 24 * 60 * 60 * 1000, 'about three months ahead');
    assert.strictEqual(w.balance, 250, 'Rockets are untouched by Premium');
  });

  await step('granting Premium again extends instead of resetting', async () => {
    const before = (await target.client.wallet()).premium.until;
    await admin.client.adminAction({ action: 'grantPremium', username: user, months: 1 });
    const after = (await target.client.wallet()).premium.until;
    const added = after - before;
    assert.ok(added > 29 * 24 * 60 * 60 * 1000, 'a month was added on top');
  });

  await step('a negative grant takes away', async () => {
    await admin.client.adminAction({ action: 'grantRockets', username: user, amount: -50 });
    assert.strictEqual((await target.client.wallet()).balance, 200, '200 left');
  });

  await step('granting nothing at all is refused', async () => {
    await assert.rejects(
      () => admin.client.adminAction({ action: 'grantRockets', username: user, amount: 0 }),
      /ракет|Premium/,
      'a zero grant is not a grant'
    );
    assert.strictEqual((await target.client.wallet()).balance, 200, 'nothing changed');
  });

  await step('a non-admin cannot grant anything', async () => {
    await assert.rejects(
      () => target.client.adminAction({ action: 'grantRockets', username: user, amount: 1000 }),
      /admin|Not allowed|not allowed/i,
      'the panel is closed to ordinary accounts'
    );
    assert.strictEqual((await target.client.wallet()).balance, 200, 'and nothing was credited');
  });

  await step('the grant shows up in the admin user list', async () => {
    const rows = await admin.client.adminUsers();
    const row = rows.find((r) => r.username === user);
    assert.ok(row, 'the account is listed');
    assert.strictEqual(row.rockets, 200, 'the panel sees the balance');
    assert.strictEqual(row.premium, true, 'and the subscription');
  });

  await step('a purchase and a grant end up indistinguishable', async () => {
    // Buy a known bundle; the resulting balance must look like any other.
    await target.client.payCreate({ kind: 'rockets', rockets: 100 });
    const w = await target.client.wallet();
    assert.strictEqual(w.balance, 300, '200 granted + 100 bought');
  });

  server.kill();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
