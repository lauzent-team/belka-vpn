'use strict';

/**
 * Presence: who is online, and when a peer was last seen.
 *
 * A person wants to know if the other side is around before writing. The relay
 * already announced online/offline; it now also records and returns the moment
 * a peer went offline, so a chat header can say "был(а) в сети 5 минут назад"
 * instead of staying blank.
 *
 * Run with: node test/presence.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8794;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-presence-${Date.now()}.db`);
const PASSWORD = 'password-1234';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function device(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-presence-${label}-`));
  return { dir, client: new SleePhyClient({ userDataDir: dir, onEvent: () => {} }) };
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

  const alice = device('alice');
  const bob = device('bob');

  const aliceEvents = [];
  alice.client.onEvent = (e) => aliceEvents.push(e);

  await alice.client.connect(URL);
  await alice.client.register({ username: 'pres_alice', password: PASSWORD });
  await bob.client.connect(URL);
  await bob.client.register({ username: 'pres_bob', password: PASSWORD });

  // Both sides get a chat row so presence is broadcast to each other.
  await bob.client.sendMessage({ to: 'pres_alice', text: 'hi' });
  await wait(300);

  await step('a peer is reported online while connected', async () => {
    const info = await bob.client.getProfile('pres_alice');
    assert.strictEqual(info.online, true, 'alice is connected, so she is online');
    assert.strictEqual(info.lastSeen, null, 'no last-seen while online');
  });

  await step('the viewer is told when a peer comes online', async () => {
    aliceEvents.length = 0;
    // Bob disconnects and reconnects; alice should hear both transitions.
    bob.client.disconnect();
    await wait(400);
    await bob.client.connect(URL);
    await bob.client.unlock(PASSWORD).catch(() => {});
    await wait(400);
    const events = aliceEvents.filter((e) => e.type === 'presence' && e.username === 'pres_bob');
    assert.ok(events.some((e) => e.online === false), 'alice must see bob go offline');
    assert.ok(events.some((e) => e.online === true), 'alice must see bob come back online');
  });

  await step('going offline records a last-seen timestamp', async () => {
    aliceEvents.length = 0;
    bob.client.disconnect();
    await wait(500);
    const off = aliceEvents.find((e) => e.type === 'presence' && e.username === 'pres_bob' && !e.online);
    assert.ok(off, 'alice must receive the offline event');
    assert.ok(typeof off.lastSeen === 'number' && off.lastSeen > 0, 'the event must carry a last-seen time');
    const info = await alice.client.getProfile('pres_bob');
    assert.strictEqual(info.online, false);
    assert.strictEqual(info.lastSeen, off.lastSeen, 'profile.get must report the same last-seen');
  });

  await step('the chat list carries the peer last-seen for a fresh launch', async () => {
    const again = new SleePhyClient({ userDataDir: alice.dir, onEvent: () => {} });
    await again.connect(URL);
    await again.unlock(PASSWORD).catch(() => {});
    const chats = await again.listChats();
    const row = chats.find((c) => c.peer === 'pres_bob');
    assert.ok(row, 'bob should have a chat row');
    assert.ok(row.profile && row.profile.lastSeen, 'the chat row must carry bob last-seen');
    again.disconnect();
  });

  await step('the chat list counts the group members', async () => {
    await bob.client.connect(URL);
    await bob.client.unlock(PASSWORD).catch(() => {});
    const group = await alice.client.createGroup({ name: 'Presence group', members: ['pres_bob'] });
    assert.strictEqual(group.members.length, 2, 'the group view must list both members');
    const groups = await alice.client.listGroups();
    const row = groups.find((g) => g.id === group.id);
    assert.ok(row, 'the group must be in the list');
    assert.strictEqual(row.members.length, 2, 'the group list must report the member count');
  });

  await step('hiding last-seen removes it from the profile and the chat row', async () => {
    // Bob hides his last-seen; alice must no longer receive the timestamp.
    await bob.client.setPrivacy({ lastSeenHidden: true });
    bob.client.disconnect();
    await wait(400);
    const info = await alice.client.getProfile('pres_bob');
    assert.strictEqual(info.lastSeen, null, 'a hidden last-seen must not be sent to a peer');
    const chats = await alice.client.listChats();
    const row = chats.find((c) => c.peer === 'pres_bob');
    assert.ok(row, 'bob should still have a chat row');
    assert.ok(!row.profile.lastSeen, 'the chat row must not leak a hidden last-seen');
  });

  await step('hiding the profile hides name, bio, picture and streak but keeps the handle', async () => {
    await bob.client.connect(URL);
    await bob.client.unlock(PASSWORD).catch(() => {});
    await bob.client.saveProfile({ displayName: 'Bob Hidden', bio: 'secret bio' });
    await bob.client.setPrivacy({ profileHidden: true });
    const info = await alice.client.getProfile('pres_bob');
    assert.strictEqual(info.profile.displayName, 'pres_bob', 'the display name must fall back to the handle');
    assert.strictEqual(info.profile.bio, '', 'the bio must be hidden');
    assert.strictEqual(info.profile.streak, 0, 'the streak must be hidden');
    assert.strictEqual(info.profile.username, 'pres_bob', 'the handle must stay visible');
    // The owner still sees their own real profile.
    const own = await bob.client.getProfile('pres_bob');
    assert.strictEqual(own.profile.displayName, 'Bob Hidden', 'the owner sees their own profile');
  });

  await step('turning the switches back off restores the real profile', async () => {
    await bob.client.setPrivacy({ lastSeenHidden: false, profileHidden: false });
    const info = await alice.client.getProfile('pres_bob');
    assert.strictEqual(info.profile.displayName, 'Bob Hidden', 'the name must come back');
    assert.strictEqual(info.profile.bio, 'secret bio', 'the bio must come back');
  });

  server.kill('SIGTERM');
  await wait(200);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} presence checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
