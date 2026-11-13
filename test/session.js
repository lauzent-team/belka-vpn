'use strict';

/**
 * Session persistence and profile-picture tests against a real relay.
 *
 * Regression cover for two field reports:
 *   1. "On re-entry I am logged out and must type the password again." The
 *      relay used to keep session tokens in memory, so a restart invalidated
 *      every device, and a resume that failed on a network hiccup erased the
 *      whole identity file — including the sealed private key.
 *   2. Users asked for profile pictures, not just an avatar colour.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8797;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-session-${Date.now()}.db`);
const PASSWORD = 'password-1234';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function device(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-sess-${label}-`));
  const client = new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
  return { client, dir };
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

async function waitForServer() {
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
}

// A 1x1 PNG, small enough to pass every size cap.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  let server = startServer();
  await waitForServer();

  const a = device('a');

  await step('registering issues a token the device stores', async () => {
    await a.client.connect(URL);
    await a.client.register({ username: 'ann', password: PASSWORD });
    assert.ok(a.client.token, 'a session token should be issued');
    assert.ok(a.client.readIdentity().token, 'the token should be persisted');
  });

  await step('a relay restart does not sign the device out', async () => {
    server.kill('SIGTERM');
    await wait(300);
    server = startServer();
    await waitForServer();
    // Fresh client object on the same device directory: this is what launching
    // the app again does.
    const again = new SleePhyClient({ userDataDir: a.dir, onEvent: () => {} });
    await again.connect(URL);
    assert.strictEqual(again.username, 'ann', 'the session should resume after a restart');
    assert.ok(again.token, 'the token should still be valid');
    again.disconnect();
  });

  await step('a network failure does not erase the sealed key', async () => {
    // Point the device at a dead port so resume cannot reach the relay.
    const offline = new SleePhyClient({ userDataDir: a.dir, onEvent: () => {} });
    await offline.connect('ws://127.0.0.1:1').catch(() => {});
    await offline.autoResume().catch(() => {});
    assert.ok(offline.readIdentity(), 'the identity file must survive a network failure');
    assert.ok(offline.readIdentity().sealed, 'the sealed key must survive');
    assert.ok(offline.readIdentity().token, 'the token must survive');
  });

  await step('a device can still unlock with its password after all that', async () => {
    const client = new SleePhyClient({ userDataDir: a.dir, onEvent: () => {} });
    await client.connect(URL);
    await client.unlock(PASSWORD);
    assert.ok(client.status().unlocked, 'the vault should open with the stored password');
    client.disconnect();
  });

  await step('the chosen relay address is remembered across launches', async () => {
    // The reported symptom: a device created against a non-default relay came
    // back pointing at the bundled default, where its session was unknown.
    const fresh = new SleePhyClient({ userDataDir: a.dir, onEvent: () => {} });
    assert.strictEqual(fresh.serverUrl, URL, 'the saved address should be used at construction');
  });

  await step('signing out revokes the token, so a copied profile cannot be replayed', async () => {
    const d = device('signout');
    await d.client.connect(URL);
    await d.client.register({ username: 'sam', password: PASSWORD });
    const leaked = d.client.readIdentity().token;

    // The token works from another device while it is valid...
    const thief = new SleePhyClient({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-thief-')), onEvent: () => {} });
    await thief.connect(URL);
    const before = await thief.request({ t: 'resume', token: leaked, deviceId: 'thief' });
    assert.strictEqual(before.username, 'sam', 'the token should replay before the sign-out');

    // ...and stops working the moment the owner signs out.
    await d.client.logout();
    let refused = false;
    try { await thief.request({ t: 'resume', token: leaked, deviceId: 'thief-2' }); }
    catch (err) { refused = /expired|session/i.test(err.message); }
    assert.ok(refused, 'a revoked token must be refused');
    thief.disconnect();
  });

  await step('signing out on one device leaves another device signed in', async () => {
    const first = device('dev-one');
    await first.client.connect(URL);
    await first.client.register({ username: 'dual', password: PASSWORD });
    const firstToken = first.client.readIdentity().token;

    // A second device is the account moved across by copying its key files, the
    // only way to hold the same account twice. It signs in and gets its own token.
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-dev-two-'));
    fs.copyFileSync(path.join(first.dir, 'sleephy-identity.json'), path.join(secondDir, 'sleephy-identity.json'));
    fs.copyFileSync(path.join(first.dir, 'sleephy-accounts.json'), path.join(secondDir, 'sleephy-accounts.json'));
    const second = new SleePhyClient({ userDataDir: secondDir, onEvent: () => {} });
    await second.connect(URL);
    await second.login({ username: 'dual', password: PASSWORD });
    const secondToken = second.readIdentity().token;
    assert.notStrictEqual(firstToken, secondToken, 'each device should hold its own token');

    await first.client.logout();
    // The other device is untouched: only the signing-out device's token dies.
    const still = await second.request({ t: 'resume', token: secondToken, deviceId: 'probe' });
    assert.strictEqual(still.username, 'dual', 'the other device must stay signed in');
    first.client.disconnect();
    second.disconnect();
  });

  await step('changing the password revokes every other session but keeps this one', async () => {
    const owner = device('owner');
    await owner.client.connect(URL);
    await owner.client.register({ username: 'pwown', password: PASSWORD });

    // The account is on a second device, with its own token — as if it leaked.
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-other-'));
    fs.copyFileSync(path.join(owner.dir, 'sleephy-identity.json'), path.join(otherDir, 'sleephy-identity.json'));
    fs.copyFileSync(path.join(owner.dir, 'sleephy-accounts.json'), path.join(otherDir, 'sleephy-accounts.json'));
    const other = new SleePhyClient({ userDataDir: otherDir, onEvent: () => {} });
    await other.connect(URL);
    await other.login({ username: 'pwown', password: PASSWORD });
    const otherToken = other.readIdentity().token;

    const mine = owner.client.readIdentity().token;
    await owner.client.setPassword(PASSWORD + '-new');

    // The other device's token is dead...
    let refused = false;
    try { await other.request({ t: 'resume', token: otherToken, deviceId: 'other' }); }
    catch (err) { refused = /expired|session/i.test(err.message); }
    assert.ok(refused, 'another device should be signed out by a password change');

    // ...but the device that changed the password stays signed in.
    const still = await owner.client.request({ t: 'resume', token: mine, deviceId: 'mine' });
    assert.strictEqual(still.username, 'pwown', 'the acting device must stay signed in');
    owner.client.disconnect();
    other.disconnect();
  });

  await step('an admin forceLogout revokes the token too, not just the socket', async () => {
    const { spawn: spawnRelay } = require('child_process');
    // A relay whose admin is a known name, so this device can force a sign-out.
    const adminPort = PORT + 1;
    const adminUrl = `ws://127.0.0.1:${adminPort}`;
    const adminDb = path.join(os.tmpdir(), `sleephy-signout-admin-${Date.now()}.db`);
    const relay = spawnRelay(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, SLEEPHY_PORT: String(adminPort), SLEEPHY_DB: adminDb, SLEEPHY_ADMINS: 'boss' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    relay.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    try {
      const deadline = Date.now() + 8000;
      for (;;) {
        const ok = await new Promise((resolve) => {
          const ws = new WebSocket(adminUrl);
          ws.on('open', () => { ws.close(); resolve(true); });
          ws.on('error', () => resolve(false));
        });
        if (ok) break;
        if (Date.now() > deadline) throw new Error('admin relay did not start');
        await wait(150);
      }

      const boss = device('boss');
      await boss.client.connect(adminUrl);
      await boss.client.register({ username: 'boss', password: PASSWORD });

      const victim = device('victim');
      await victim.client.connect(adminUrl);
      await victim.client.register({ username: 'target', password: PASSWORD });
      const victimToken = victim.client.readIdentity().token;

      await boss.client.adminAction({ action: 'forceLogout', username: 'target' });

      // The socket is kicked, but the real check is the token: it must be dead.
      const ghost = new SleePhyClient({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-ghost-')), onEvent: () => {} });
      await ghost.connect(adminUrl);
      let refused = false;
      try { await ghost.request({ t: 'resume', token: victimToken, deviceId: 'ghost' }); }
      catch (err) { refused = /expired|session/i.test(err.message); }
      assert.ok(refused, 'a force-logged-out token must be refused, not just its socket closed');
      ghost.disconnect();
      boss.client.disconnect();
      victim.client.disconnect();
    } finally {
      relay.kill('SIGTERM');
      await wait(200);
      for (const f of [adminDb, `${adminDb}-wal`, `${adminDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
    }
  });

  await step('an avatar image round-trips through the relay', async () => {
    const b = device('b');
    await b.client.connect(URL);
    await b.client.register({ username: 'bob', password: PASSWORD });
    const saved = await b.client.saveProfile({ avatarImage: PNG });
    assert.strictEqual(saved.avatarImage, PNG, 'the picture should come back on the profile');

    // A different device reads it through a directory lookup.
    const c = device('c');
    await c.client.connect(URL);
    await c.client.register({ username: 'cat', password: PASSWORD });
    const { profile } = await c.client.getProfile('bob');
    assert.strictEqual(profile.avatarImage, PNG, 'another account should see the picture');

    await step('a display-name edit keeps the picture', async () => {
      const after = await b.client.saveProfile({ displayName: 'Bobby' });
      assert.strictEqual(after.avatarImage, PNG, 'the picture must not be cleared by a name edit');
      assert.strictEqual(after.displayName, 'Bobby');
    });

    await step('the picture can be cleared explicitly', async () => {
      const after = await b.client.saveProfile({ avatarImage: null });
      assert.strictEqual(after.avatarImage, null, 'null should clear the picture');
      assert.strictEqual(after.displayName, 'Bobby', 'the name must be untouched');
    });

    b.client.disconnect();
    c.client.disconnect();
  });

  await step('an oversized picture is rejected', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(70 * 1024);
    let threw = false;
    try { await a.client.saveProfile({ avatarImage: big }); }
    catch { threw = true; }
    assert.ok(threw, 'a picture over the cap should be refused');
  });

  await step('a non-image avatar is rejected', async () => {
    let threw = false;
    try { await a.client.saveProfile({ avatarImage: 'data:text/plain;base64,aGk=' }); }
    catch { threw = true; }
    assert.ok(threw, 'only raster images should be accepted');
  });

  a.client.disconnect();
  server.kill('SIGTERM');
  await wait(200);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} session checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
