'use strict';

/**
 * Admin and verification tests against a real relay.
 *
 * The relay names its first administrator in code (SLEEPHY_ADMINS, default
 * "pidoras"), so this suite points that at the test's own admin. It covers:
 *   1. the first admin is recognised without any database flag
 *   2. a non-admin is refused every admin operation
 *   3. granting a checkmark makes it visible in the public profile
 *   4. blocking disconnects the account and locks it out of login
 *   5. deleting erases the account and its messages
 *   6. an announcement reaches every connected client
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8794;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-admin-${Date.now()}.db`);
const ADMIN = 'pidoras';

const results = [];
function pass(name) { results.push(['PASS', name]); console.log('  PASS', name); }
function fail(name, err) { results.push(['FAIL', name]); console.log('  FAIL', name, '->', err && err.message); }
async function step(name, fn) {
  try { await fn(); pass(name); }
  catch (err) { fail(name, err); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-${label}-`));
  return makeClientFrom(dir, label);
}

/** Reuse an existing device directory so the stored private key is available. */
function makeClientFrom(dir, label) {
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir, label };
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
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_ADMINS: `${ADMIN},protected_admin`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

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

  const admin = makeClient('admin');
  const user = makeClient('user');
  const victim = makeClient('victim');

  await step('the configured account registers as an administrator', async () => {
    await admin.client.connect(URL);
    await admin.client.register({ username: ADMIN, password: 'admin-password-1' });
    const overview = await admin.client.adminOverview();
    assert.strictEqual(overview.stats.users, 1, 'one account so far');
  });

  await step('the admin flag is set in the database at registration', async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare('SELECT is_admin, verified FROM users WHERE username = ?').get(ADMIN);
    db.close();
    assert.strictEqual(row.is_admin, 1, 'is_admin should be 1 for the configured admin');
  });

  await step('a plain account is not an administrator', async () => {
    await user.client.connect(URL);
    await user.client.register({ username: 'regular_user', password: 'regular-pass-1' });
    let threw = false;
    try { await user.client.adminOverview(); } catch { threw = true; }
    assert.ok(threw, 'a non-admin must be refused the admin overview');
  });

  await step('a non-admin cannot grant themselves a checkmark', async () => {
    let threw = false;
    try {
      await user.client.adminAction({ action: 'verify', username: 'regular_user' });
    } catch { threw = true; }
    assert.ok(threw, 'a non-admin must be refused admin actions');
  });

  await step('the admin sees the account list with flags', async () => {
    const items = await admin.client.adminUsers();
    const names = items.map((i) => i.username).sort();
    assert.deepStrictEqual(names, [ADMIN, 'regular_user'].sort());
    const adminRow = items.find((i) => i.username === ADMIN);
    assert.strictEqual(adminRow.admin, true, 'admin row should be flagged');
  });

  await step('granting a checkmark reaches the public profile', async () => {
    await victim.client.connect(URL);
    await victim.client.register({ username: 'victim_user', password: 'victim-pass-1' });
    await admin.client.adminAction({ action: 'verify', username: 'victim_user' });

    const profile = await user.client.getProfile('victim_user');
    assert.strictEqual(profile.profile.verified, true, 'verified should be true');
  });

  await step('an announcement reaches every connected client', async () => {
    await admin.client.adminAction({ action: 'announce', text: 'Server maintenance at 20:00' });
    const evt = await waitFor(user.events, (e) => e.type === 'announcement');
    assert.strictEqual(evt.text, 'Server maintenance at 20:00');
    assert.strictEqual(evt.from, ADMIN);
  });

  await step('blocking an account disconnects it', async () => {
    await admin.client.adminAction({ action: 'ban', username: 'victim_user' });
    const evt = await waitFor(victim.events, (e) => e.type === 'kicked', 5000);
    assert.ok(/blocked/i.test(evt.reason), `expected a block reason, got ${evt.reason}`);
  });

  await step('a blocked account cannot log back in', async () => {
    const retry = makeClient('retry');
    await retry.client.connect(URL);
    let message = '';
    try { await retry.client.login({ username: 'victim_user', password: 'victim-pass-1' }); }
    catch (err) { message = err.message; }
    assert.ok(/blocked/i.test(message), `expected a block error, got "${message}"`);
    retry.client.disconnect();
  });

  await step('unblocking lets the account back in', async () => {
    await admin.client.adminAction({ action: 'ban', username: 'victim_user' });
    // Same device directory: the private key never leaves the device, so a
    // fresh directory genuinely cannot sign in.
    const back = makeClientFrom(victim.dir, 'back');
    await back.client.connect(URL);
    await back.client.login({ username: 'victim_user', password: 'victim-pass-1' });
    assert.strictEqual(back.client.username, 'victim_user');
    victim.client = back.client;
    back.client.disconnect();
  });

  await step('the admin cannot block their own account', async () => {
    let message = '';
    try { await admin.client.adminAction({ action: 'ban', username: ADMIN }); }
    catch (err) { message = err.message; }
    assert.ok(/own account/i.test(message), `expected a self-block refusal, got "${message}"`);
  });

  await step('deleting an account erases it and its messages', async () => {
    await user.client.sendMessage({ to: 'regular_user', text: 'note to self' });
    await admin.client.adminAction({ action: 'delete', username: 'regular_user' });
    const items = await admin.client.adminUsers();
    assert.ok(!items.some((i) => i.username === 'regular_user'), 'account should be gone');

    const db = new DatabaseSync(DB, { readOnly: true });
    const left = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE sender = ? OR recipient = ?'
    ).get('regular_user', 'regular_user');
    db.close();
    assert.strictEqual(left.c, 0, 'its messages should be gone too');
  });

  await step('the configured admin account cannot be deleted', async () => {
    // A second name from SLEEPHY_ADMINS, so the actor is not the target.
    const other = makeClient('protected');
    await other.client.connect(URL);
    await other.client.register({ username: 'protected_admin', password: 'protected-pass-1' });

    let message = '';
    try { await admin.client.adminAction({ action: 'delete', username: 'protected_admin' }); }
    catch (err) { message = err.message; }
    assert.ok(/protected/i.test(message), `expected a protected-account refusal, got "${message}"`);
    other.client.disconnect();
  });

  await step('a second admin can be granted and then acts', async () => {
    const promoted = makeClient('promoted');
    await promoted.client.connect(URL);
    await promoted.client.register({ username: 'promoted_user', password: 'promoted-pass-1' });

    await admin.client.adminAction({ action: 'grantAdmin', username: 'promoted_user' });
    const overview = await promoted.client.adminOverview();
    assert.ok(overview.stats.users >= 3, 'the new admin can read the overview');
    promoted.client.disconnect();
  });

  admin.client.disconnect();
  user.client.disconnect();
  victim.client.disconnect();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter(([s]) => s === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} admin checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
