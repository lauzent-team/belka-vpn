'use strict';

/**
 * Group-chat checks: creation, membership, fan-out encryption, history,
 * edits, deletes and attachments. Real relay, real crypto, no mocks.
 *
 * Run with: node test/groups.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8794;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-grp-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-grp-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await wait(80);
  }
  return null;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const A = makeClient('a');
  const B = makeClient('b');
  const C = makeClient('c');
  const D = makeClient('d'); // never invited
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;
  const carol = `carol_${suffix}`;
  const dave = `dave_${suffix}`;

  for (const x of [A, B, C, D]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });
  await C.client.register({ username: carol, password: 'password-1234' });
  await D.client.register({ username: dave, password: 'password-1234' });

  let group;
  await step('create a group with two members', async () => {
    group = await A.client.createGroup({ name: 'Друзья', members: [bob, carol] });
    assert.ok(group.id, 'group has an id');
    assert.equal(group.name, 'Друзья');
    assert.equal(group.owner, alice);
    const names = group.members.map((m) => m.username).sort();
    assert.deepEqual(names, [alice, bob, carol].sort());
  });

  await step('every member sees the group in their list', async () => {
    for (const x of [A, B, C]) {
      const groups = await x.client.listGroups();
      assert.ok(groups.some((g) => g.id === group.id), 'group missing for a member');
    }
    const daveGroups = await D.client.listGroups();
    assert.equal(daveGroups.length, 0, 'non-member must not see the group');
  });

  await step('a non-member is told about the group over the socket', async () => {
    const evt = await waitFor(() => B.events.find((e) => e.type === 'group.updated'));
    assert.ok(evt, 'B should receive a group.updated event');
    assert.equal(evt.group.id, group.id);
  });

  let firstId;
  await step('a message fans out to every member', async () => {
    const members = [alice, bob, carol];
    const sent = await A.client.sendGroupMessage({ groupId: group.id, text: 'Привет, группа!', members });
    firstId = sent.id;
    assert.ok(firstId, 'sent id');

    const gotB = await waitFor(() => B.events.find((e) => e.type === 'group.message' && e.id === firstId));
    const gotC = await waitFor(() => C.events.find((e) => e.type === 'group.message' && e.id === firstId));
    assert.equal(gotB.text, 'Привет, группа!');
    assert.equal(gotC.text, 'Привет, группа!');
    assert.equal(gotB.from, alice);
  });

  await step('the sender does not receive their own message twice', async () => {
    await wait(400);
    const echo = A.events.filter((e) => e.type === 'group.message' && e.id === firstId);
    assert.equal(echo.length, 0, 'sender should not get a socket echo');
  });

  await step('history decrypts for each member', async () => {
    const hB = await B.client.groupHistory({ groupId: group.id });
    assert.equal(hB.length, 1);
    assert.equal(hB[0].text, 'Привет, группа!');
    assert.equal(hB[0].mine, false);
    const hA = await A.client.groupHistory({ groupId: group.id });
    assert.equal(hA[0].mine, true);
  });

  await step('a non-member cannot read the history', async () => {
    let failed = false;
    try { await D.client.groupHistory({ groupId: group.id }); }
    catch (err) { failed = /member/i.test(err.message); }
    assert.ok(failed, 'non-member read should fail');
  });

  await step('a non-member cannot send to the group', async () => {
    let failed = false;
    try {
      await D.client.sendGroupMessage({ groupId: group.id, text: 'sneak', members: [alice, bob, carol] });
    } catch (err) { failed = /member/i.test(err.message); }
    assert.ok(failed, 'non-member send should fail');
  });

  await step('the group envelope on the relay holds no plaintext', async () => {
    // Read the raw row straight from the relay database.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    const row = raw.prepare('SELECT envelope FROM group_messages WHERE id = ?').get(firstId);
    assert.ok(row, 'row exists');
    assert.ok(!row.envelope.includes('Привет'), 'plaintext leaked into the relay store');
    const parsed = JSON.parse(row.envelope);
    assert.deepEqual(Object.keys(parsed).sort(), [alice, bob, carol].sort());
    raw.close();
  });

  await step('a new member joins and receives later messages', async () => {
    const updated = await A.client.addGroupMember({ groupId: group.id, username: dave });
    assert.equal(updated.members.length, 4);
    const members = [alice, bob, carol, dave];
    const sent = await A.client.sendGroupMessage({ groupId: group.id, text: 'Добро пожаловать', members });
    const gotD = await waitFor(() => D.events.find((e) => e.type === 'group.message' && e.id === sent.id));
    assert.equal(gotD.text, 'Добро пожаловать');
  });

  await step('editing a group message updates every member', async () => {
    const members = [alice, bob, carol, dave];
    const res = await A.client.editGroupMessage({ id: firstId, groupId: group.id, text: 'Исправлено', members });
    assert.equal(res.text, 'Исправлено');
    const evt = await waitFor(() => B.events.find((e) => e.type === 'group.edited' && e.id === firstId));
    assert.equal(evt.text, 'Исправлено');
  });

  await step('deleting a group message reaches the others', async () => {
    await A.client.deleteGroupMessage({ id: firstId });
    const evt = await waitFor(() => C.events.find((e) => e.type === 'group.deleted' && e.id === firstId));
    assert.ok(evt, 'C should learn about the deletion');
    const h = await B.client.groupHistory({ groupId: group.id });
    assert.ok(!h.some((m) => m.id === firstId), 'deleted message must not appear in history');
  });

  await step('a group photo round-trips for each member', async () => {
    const members = [alice, bob, carol, dave];
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const sent = await A.client.sendGroupMessage({
      groupId: group.id, text: '', members,
      attachment: { kind: 'image', bytes, name: 'pic.png', mime: 'image/png' }
    });
    const gotB = await waitFor(() => B.events.find((e) => e.type === 'group.message' && e.id === sent.id));
    assert.equal(gotB.kind, 'image');
    const opened = await B.client.openGroupAttachment({ id: sent.id });
    assert.equal(opened.mime, 'image/png');
    assert.ok(opened.dataUrl.startsWith('data:image/png;base64,'));
  });

  await step('leaving the group removes the member', async () => {
    await C.client.leaveGroup({ groupId: group.id });
    const groups = await C.client.listGroups();
    assert.ok(!groups.some((g) => g.id === group.id), 'group should be gone for C');
    const evt = await waitFor(() => B.events.find((e) => e.type === 'group.updated' && e.left === carol));
    assert.ok(evt, 'others should see the member leave');
  });

  for (const x of [A, B, C, D]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} group checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
