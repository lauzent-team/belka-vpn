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

  server.kill('SIGTERM');
  await wait(200);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} presence checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
