'use strict';

/**
 * Global search checks against a real relay: `search.global` hands back the
 * newest slice of every conversation, decrypted on the device, tagged with the
 * chat it came from — direct chats, groups and channels alike. No mocks: real
 * crypto, real relay, real SQLite.
 *
 * Run with: node test/globalsearch-relay.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');
const G = require('../src/lib/globalsearch');

const PORT = 8821;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-gsearch-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-gsearch-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const A = makeClient('a');
  const B = makeClient('b');
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  for (const x of [A, B]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });

  await A.client.sendMessage({ to: bob, text: 'привет из личного чата' });
  await B.client.sendMessage({ to: alice, text: 'и тебе привет' });

  // A group with both, and a channel Alice owns with Bob subscribed.
  const group = await A.client.createGroup({ name: 'Работа', members: [bob] });
  const groupId = group.id || group.groupId;
  await A.client.sendGroupMessage({ groupId, text: 'совещание в пять', members: [alice, bob] });

  const channel = await A.client.createChannel({ name: 'Новости' });
  const channelId = channel.id || channel.channelId;
  await B.client.joinChannel({ channelId });
  await A.client.sendChannelPost({ channelId, text: 'важное объявление', members: [alice, bob] });

  let snapshot;
  await step('search.global returns the newest slice of every conversation', async () => {
    snapshot = await A.client.searchGlobal({ limit: 200 });
    assert.ok(Array.isArray(snapshot), 'a flat list');
    assert.ok(snapshot.find((m) => m.chatKey === bob && m.text === 'привет из личного чата'), 'direct hit');
    assert.ok(snapshot.find((m) => m.chatKey === `group:${groupId}` && m.text === 'совещание в пять'), 'group hit');
    assert.ok(snapshot.find((m) => m.chatKey === `channel:${channelId}` && m.text === 'важное объявление'), 'channel hit');
  });

  await step('the client decrypts every hit, so no ciphertext is left', async () => {
    assert.ok(snapshot.every((m) => typeof m.text === 'string'), 'text is a string');
    assert.ok(!snapshot.some((m) => m.text.includes('⚠')), 'nothing failed to decrypt');
  });

  await step('a query finds the matching message across chats', async () => {
    const hits = G.searchAcross(
      [{ key: bob, title: 'Bob', messages: snapshot.filter((m) => m.chatKey === bob) }],
      { query: 'личного' }, { extrasOf: () => null }
    );
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].message.text, 'привет из личного чата');
  });

  await step('a query with no match returns nothing', async () => {
    const hits = G.searchAcross(
      [{ key: bob, title: 'Bob', messages: snapshot.filter((m) => m.chatKey === bob) }],
      { query: 'нет-такого-слова-нигде' }, { extrasOf: () => null }
    );
    assert.strictEqual(hits.length, 0);
  });

  await step('the sender reads their own sent message back from the slice', async () => {
    const mine = snapshot.find((m) => m.chatKey === bob && m.text === 'привет из личного чата');
    assert.ok(mine.mine, 'it is marked as mine for the sender');
  });

  await step('a scheduled (held) message never appears in the slice', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'секрет-позже', sendAt: Date.now() + 60 * 60 * 1000 });
    const again = await A.client.searchGlobal({ limit: 200 });
    assert.ok(!again.find((m) => m.id === res.id), 'a held message is not searchable yet');
    await A.client.cancelScheduled({ id: res.id });
  });

  await step('a deleted message drops out of the slice', async () => {
    const res = await A.client.sendMessage({ to: bob, text: 'удали-из-поиска' });
    const before = await A.client.searchGlobal({ limit: 200 });
    assert.ok(before.find((m) => m.id === res.id), 'it was there');
    await A.client.deleteMessage({ id: res.id });
    const after = await A.client.searchGlobal({ limit: 200 });
    assert.ok(!after.find((m) => m.id === res.id), 'and it is gone');
  });

  await step('a busy chat does not crowd out a quiet one (per-chat slice)', async () => {
    // Carol messages Alice 40 times, then Alice messages Bob once. With a small
    // limit, the quiet Bob chat must still be represented.
    const carol = makeClient('c2');
    await carol.client.connect(URL);
    const carolName = `carol2_${suffix}`;
    await carol.client.register({ username: carolName, password: 'password-1234' });
    for (let i = 0; i < 40; i += 1) await carol.client.sendMessage({ to: alice, text: `шум ${i}` });
    await A.client.sendMessage({ to: bob, text: 'тихое-сообщение-боба' });

    const slice = await A.client.searchGlobal({ limit: 3 });
    assert.ok(slice.find((m) => m.chatKey === carolName), 'the busy chat is present');
    assert.ok(slice.find((m) => m.chatKey === bob && m.text === 'тихое-сообщение-боба'), 'the quiet chat survives the limit');
    carol.client.disconnect();
  });

  await step('another account never sees a conversation it is not part of', async () => {
    const carol = makeClient('c');
    await carol.client.connect(URL);
    await carol.client.register({ username: `carol_${suffix}`, password: 'password-1234' });
    const theirs = await carol.client.searchGlobal({ limit: 200 });
    assert.strictEqual(theirs.length, 0, 'a stranger has nothing to search');
    carol.client.disconnect();
  });

  await step('the relay refuses an unauthenticated search', async () => {
    const dave = makeClient('d');
    await dave.client.connect(URL);
    await assert.rejects(
      () => dave.client.searchGlobal({ limit: 10 }),
      /Not authenticated|Vault is locked/,
      'a locked vault cannot search'
    );
    dave.client.disconnect();
  });

  for (const x of [A, B]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} global-search relay checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
