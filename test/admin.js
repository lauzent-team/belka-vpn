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

  // A badge picture replaces the plain checkmark. A 1x1 PNG is enough to prove
  // the round trip; the client is what crops and sizes a real picture.
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  await step('the admin can give an account a badge picture', async () => {
    await admin.client.adminAction({ action: 'badge', username: 'victim_user', image: PNG_1PX });
    const profile = await user.client.getProfile('victim_user');
    assert.strictEqual(profile.profile.badgeImage, PNG_1PX, 'the picture should reach the public profile');
    assert.strictEqual(profile.profile.verified, true, 'a picture also marks the account verified');
  });

  await step('a badge picture is refused when it is not an image', async () => {
    let message = '';
    try {
      await admin.client.adminAction({ action: 'badge', username: 'victim_user', image: 'data:text/html;base64,PHNjcmlwdD4=' });
    } catch (err) { message = err.message; }
    assert.ok(/PNG|JPEG|GIF|WebP/i.test(message), `expected an image-type reason, got "${message}"`);
  });

  await step('a badge picture is refused when it is too large', async () => {
    let message = '';
    const huge = 'data:image/png;base64,' + 'A'.repeat(200 * 1024);
    try {
      await admin.client.adminAction({ action: 'badge', username: 'victim_user', image: huge });
    } catch (err) { message = err.message; }
    assert.ok(/large/i.test(message), `expected a size reason, got "${message}"`);
  });

  await step('a non-admin cannot set a badge picture', async () => {
    let threw = false;
    try {
      await user.client.adminAction({ action: 'badge', username: 'regular_user', image: PNG_1PX });
    } catch { threw = true; }
    assert.ok(threw, 'a non-admin must be refused');
  });

  await step('clearing a badge picture restores the plain checkmark', async () => {
    await admin.client.adminAction({ action: 'badge', username: 'victim_user', image: null });
    const profile = await user.client.getProfile('victim_user');
    assert.strictEqual(profile.profile.badgeImage, null, 'the picture should be cleared');
    assert.strictEqual(profile.profile.verified, true, 'the account stays verified');
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

  let protectedAdmin = null;
  await step('the configured admin account cannot be deleted', async () => {
    // A second name from SLEEPHY_ADMINS, so the actor is not the target.
    const other = makeClient('protected');
    await other.client.connect(URL);
    await other.client.register({ username: 'protected_admin', password: 'protected-pass-1' });
    protectedAdmin = other;

    let message = '';
    try { await admin.client.adminAction({ action: 'delete', username: 'protected_admin' }); }
    catch (err) { message = err.message; }
    assert.ok(/protected/i.test(message), `expected a protected-account refusal, got "${message}"`);
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

  // The configured admin keeps the panel even after the stored flag is toggled
  // off: ADMINS grants admin by name, so isAdmin() stays true. Regression test
  // for the shield button making the panel vanish.
  await step('the configured admin stays an admin after the flag is toggled off', async () => {
    await admin.client.adminAction({ action: 'grantAdmin', username: ADMIN });
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare('SELECT is_admin FROM users WHERE username = ?').get(ADMIN);
    db.close();
    assert.strictEqual(row.is_admin, 0, 'the stored flag should now be 0');
    const overview = await admin.client.adminOverview();
    assert.ok(overview.stats.users >= 3, 'and the account must still reach the panel');
  });

  await step('the profile tells the client it is an admin by configuration', async () => {
    const profile = protectedAdmin.client.status().profile;
    assert.strictEqual(profile.adminByConfig, true, 'the client must be told the account is configured as admin');
  });

  await step('signing in restores the admin flag for a configured admin', async () => {
    // Toggle the stored flag off, then sign in again: login re-applies it for
    // any account named in SLEEPHY_ADMINS.
    await admin.client.adminAction({ action: 'grantAdmin', username: 'protected_admin' });
    let db = new DatabaseSync(DB, { readOnly: true });
    assert.strictEqual(db.prepare('SELECT is_admin FROM users WHERE username = ?').get('protected_admin').is_admin, 0);
    db.close();
    protectedAdmin.client.disconnect();
    await protectedAdmin.client.connect(URL);
    await protectedAdmin.client.login({ username: 'protected_admin', password: 'protected-pass-1' });
    db = new DatabaseSync(DB, { readOnly: true });
    assert.strictEqual(db.prepare('SELECT is_admin FROM users WHERE username = ?').get('protected_admin').is_admin, 1);
    db.close();
    protectedAdmin.client.disconnect();
  });

  /* ---------------------- the expanded admin panel ---------------------- */

  await step('the overview reports the fuller set of counters', async () => {
    const { stats } = await admin.client.adminOverview();
    for (const key of ['users', 'online', 'messages', 'groups', 'channels',
      'banned', 'verified', 'admins', 'announcements', 'sessions', 'flames']) {
      assert.ok(typeof stats[key] === 'number', `stats.${key} should be a number`);
    }
    assert.strictEqual(stats.announcements, 1, 'the earlier announcement is counted');
    assert.ok(stats.verified >= 1, 'victim_user is still verified');
  });

  await step('the user list carries the richer per-account detail', async () => {
    const items = await admin.client.adminUsers();
    const victim = items.find((i) => i.username === 'victim_user');
    for (const key of ['received', 'groups', 'subs', 'lastSeen', 'hasPassword',
      'hasPhone', 'profileHidden', 'lastSeenHidden', 'adminByConfig']) {
      assert.ok(key in victim, `user row should expose ${key}`);
    }
    assert.strictEqual(victim.verified, true, 'verified flag still present');
  });

  await step('an announcement is written to the action log', async () => {
    const { log } = await admin.client.adminOverview();
    const entry = log.find((r) => r.action === 'announce');
    assert.ok(entry, 'the announcement should appear in the log');
    assert.strictEqual(entry.actor, ADMIN, 'and name the admin who sent it');
  });

  await step('forcing a sign-out drops the device without blocking the account', async () => {
    const u = makeClient('logoutme');
    await u.client.connect(URL);
    await u.client.register({ username: 'logout_target', password: 'logout-pass-1' });
    await admin.client.adminAction({ action: 'forceLogout', username: 'logout_target' });
    const evt = await waitFor(u.events, (e) => e.type === 'kicked', 5000);
    assert.ok(/signed out/i.test(evt.reason), `expected a sign-out reason, got ${evt.reason}`);
    // Not blocked: the same account can sign straight back in.
    const back = makeClientFrom(u.dir, 'logoutback');
    await back.client.connect(URL);
    await back.client.login({ username: 'logout_target', password: 'logout-pass-1' });
    assert.strictEqual(back.client.username, 'logout_target');
    back.client.disconnect();
  });

  await step('resetting a profile wipes its fields but keeps the account', async () => {
    // Give the account a profile through its own device, then reset it.
    const u = makeClient('profreset');
    await u.client.connect(URL);
    await u.client.register({ username: 'profile_target', password: 'profile-pass-1' });
    await u.client.saveProfile({ displayName: 'Big Name', bio: 'hello', avatarColor: 'rose' });
    let profile = await admin.client.adminUsers();
    assert.strictEqual(profile.find((x) => x.username === 'profile_target').displayName, 'Big Name');

    await admin.client.adminAction({ action: 'resetProfile', username: 'profile_target' });
    const after = await admin.client.adminUsers();
    const row = after.find((x) => x.username === 'profile_target');
    assert.strictEqual(row.displayName, 'profile_target', 'the name falls back to the handle');
    assert.strictEqual(row.bio, '', 'the bio is cleared');
    assert.ok(row, 'the account is not deleted');
    u.client.disconnect();
  });

  await step('clearing messages erases the relay copies for both sides', async () => {
    const a = makeClient('clear_a');
    const b = makeClient('clear_b');
    await a.client.connect(URL);
    await b.client.connect(URL);
    await a.client.register({ username: 'clear_a', password: 'clear-a-pass-1' });
    await b.client.register({ username: 'clear_b', password: 'clear-b-pass-1' });
    await a.client.sendMessage({ to: 'clear_b', text: 'secret one' });
    await a.client.sendMessage({ to: 'clear_b', text: 'secret two' });

    let db = new DatabaseSync(DB, { readOnly: true });
    let count = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE sender = ? OR recipient = ?'
    ).get('clear_a', 'clear_a');
    db.close();
    assert.ok(count.c >= 2, 'the messages are stored before clearing');

    await admin.client.adminAction({ action: 'clearMessages', username: 'clear_a' });
    db = new DatabaseSync(DB, { readOnly: true });
    count = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE sender = ? OR recipient = ?'
    ).get('clear_a', 'clear_a');
    const stillThere = db.prepare('SELECT COUNT(*) AS c FROM users WHERE username = ?').get('clear_a');
    db.close();
    assert.strictEqual(count.c, 0, 'the relay copies are gone');
    assert.strictEqual(stillThere.c, 1, 'but the account survives');
    a.client.disconnect();
    b.client.disconnect();
  });

  await step('clearing all channel checkmarks clears them', async () => {
    const owner = makeClient('chanowner');
    await owner.client.connect(URL);
    await owner.client.register({ username: 'chan_owner', password: 'chan-pass-1' });
    await owner.client.createChannel({ name: 'Test Channel', description: 'x' });
    const channels = await admin.client.adminChannels();
    const ch = channels.find((c) => c.owner === 'chan_owner');
    assert.ok(ch, 'the channel exists');
    await admin.client.adminAction({ action: 'channelVerify', channelId: ch.id });
    let list = await admin.client.adminChannels();
    assert.strictEqual(list.find((c) => c.id === ch.id).verified, true);

    await admin.client.adminAction({ action: 'channelUnverifyAll' });
    list = await admin.client.adminChannels();
    assert.ok(list.every((c) => !c.verified), 'no channel should stay verified');
    owner.client.disconnect();
  });

  await step('the device list groups accounts by installation', async () => {
    const owner = makeClient('devowner');
    owner.client.ensureDeviceId = () => 'test-device-xyz';
    await owner.client.connect(URL);
    await owner.client.register({ username: 'dev_owner_a', password: 'dev-pass-1' });
    const second = makeClient('devsecond');
    second.client.ensureDeviceId = () => 'test-device-xyz';
    await second.client.connect(URL);
    await second.client.register({ username: 'dev_owner_b', password: 'dev-pass-1' });

    const { items } = await admin.client.adminDevices();
    const row = items.find((d) => d.id === 'test-device-xyz');
    assert.ok(row, 'the shared device is listed');
    assert.strictEqual(row.accounts, 2, 'both accounts are counted');
    assert.ok(row.usernames.includes('dev_owner_a') && row.usernames.includes('dev_owner_b'),
      'both usernames are shown');

    owner.client.disconnect();
    second.client.disconnect();
  });

  await step('freeing a device frees its account slots', async () => {
    const { items } = await admin.client.adminDevices();
    const row = items.find((d) => d.id === 'test-device-xyz');
    assert.ok(row, 'the device is still there');
    await admin.client.adminAction({ action: 'deviceClear', deviceId: 'test-device-xyz' });
    const after = await admin.client.adminDevices();
    assert.ok(!after.items.find((d) => d.id === 'test-device-xyz'),
      'the cleared device is gone from the list');
  });

  await step('a non-admin is refused the device list and action', async () => {
    let threw = false;
    try { await user.client.adminDevices(); } catch { threw = true; }
    assert.ok(threw, 'a non-admin must be refused the device list');
    threw = false;
    try { await user.client.adminAction({ action: 'deviceClear', deviceId: 'whatever' }); }
    catch { threw = true; }
    assert.ok(threw, 'a non-admin must be refused deviceClear');
  });

  await step('a non-admin is refused the new actions too', async () => {
    for (const action of ['forceLogout', 'resetProfile', 'clearMessages', 'channelUnverifyAll']) {
      let threw = false;
      try { await user.client.adminAction({ action, username: 'victim_user' }); }
      catch { threw = true; }
      assert.ok(threw, `a non-admin must be refused ${action}`);
    }
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
