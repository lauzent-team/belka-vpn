'use strict';

/**
 * Channel checks: creation, one-to-many fan-out, subscription, history,
 * edits/deletes, attachments, verified badges and admin moderation. Real relay,
 * real crypto, no mocks.
 *
 * Run with: node test/channels.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8800 + Math.floor(Math.random() * 100);
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-ch-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-ch-${label}-`));
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
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: '' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const A = makeClient('a'); // owner
  const B = makeClient('b'); // subscriber
  const C = makeClient('c'); // other subscriber
  const D = makeClient('d'); // never subscribed
  const suffix = Math.random().toString(36).slice(2, 7);
  const owner = `owner_${suffix}`;
  const fan = `fan_${suffix}`;
  const fan2 = `fan2_${suffix}`;
  const outsider = `out_${suffix}`;

  for (const x of [A, B, C, D]) await x.client.connect(URL);
  await A.client.register({ username: owner, password: 'password-1234' });
  await B.client.register({ username: fan, password: 'password-1234' });
  await C.client.register({ username: fan2, password: 'password-1234' });
  await D.client.register({ username: outsider, password: 'password-1234' });

  let channel;
  await step('create a channel', async () => {
    channel = await A.client.createChannel({ name: 'Новости', description: 'О чём канал' });
    assert.ok(channel.id, 'channel has an id');
    assert.equal(channel.name, 'Новости');
    assert.equal(channel.owner, owner);
    assert.equal(channel.isOwner, true);
    assert.equal(channel.subscribed, true);
    assert.equal(channel.subs, 1);
  });

  await step('the owner sees the channel in their list', async () => {
    const list = await A.client.listChannels();
    assert.ok(list.some((c) => c.id === channel.id));
  });

  await step('a stranger sees it in discovery but is not subscribed', async () => {
    const items = await B.client.discoverChannels();
    const found = items.find((c) => c.id === channel.id);
    assert.ok(found, 'channel should be discoverable');
    assert.equal(found.subscribed, false);
    assert.equal(found.subscribers, undefined, 'subscriber list is owner-only');
  });

  await step('subscribing adds the channel to the subscriber list', async () => {
    const joined = await B.client.joinChannel({ channelId: channel.id });
    assert.equal(joined.subscribed, true);
    const list = await B.client.listChannels();
    assert.ok(list.some((c) => c.id === channel.id));
  });

  await step('the owner view carries every subscriber name', async () => {
    const view = await A.client.channelInfo({ channelId: channel.id });
    assert.ok(Array.isArray(view.subscribers), 'owner sees subscriber list');
    assert.ok(view.subscribers.includes(owner));
    assert.ok(view.subscribers.includes(fan));
  });

  await step('a non-owner cannot post', async () => {
    let failed = false;
    try {
      await B.client.sendChannelPost({ channelId: channel.id, text: 'hi', members: [fan] });
    } catch { failed = true; }
    assert.ok(failed, 'only the owner may post');
  });

  let post;
  await step('a post fans out to every subscriber', async () => {
    // Only current subscribers get an envelope, exactly like the client does.
    const members = [owner, fan];
    post = await A.client.sendChannelPost({ channelId: channel.id, text: 'Первое сообщение', members });
    assert.ok(post.id, 'post has an id');
    const gotB = await waitFor(() => B.events.find((e) => e.type === 'channel.message' && e.id === post.id));
    assert.ok(gotB, 'subscriber should receive the post');
    assert.equal(gotB.text, 'Первое сообщение');
  });

  await step('a non-subscriber receives nothing', async () => {
    await wait(400);
    assert.ok(!D.events.some((e) => e.type === 'channel.message' && e.id === post.id));
  });

  await step('history decrypts for a subscriber', async () => {
    const items = await B.client.channelHistory({ channelId: channel.id, limit: 50 });
    const found = items.find((m) => m.id === post.id);
    assert.ok(found, 'post is in history');
    assert.equal(found.text, 'Первое сообщение');
    assert.equal(found.mine, false);
  });

  await step('a non-subscriber cannot read the history', async () => {
    let failed = false;
    try { await D.client.channelHistory({ channelId: channel.id, limit: 10 }); } catch { failed = true; }
    assert.ok(failed, 'history is subscriber-only');
  });

  await step('the relay stores only ciphertext', async () => {
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare('SELECT envelope FROM channel_messages WHERE id = ?').get(post.id);
    assert.ok(!/Первое/.test(row.envelope), 'plaintext must not reach the relay');
    db.close();
  });

  await step('a later subscriber only sees posts made while subscribed', async () => {
    await C.client.joinChannel({ channelId: channel.id });
    await wait(300);
    assert.ok(!C.events.some((e) => e.type === 'channel.message' && e.id === post.id),
      'C joined after the post and gets no backfill');
    // The owner must learn about the new subscriber, or their next post
    // would encrypt no envelope for C.
    const update = await waitFor(() =>
      A.events.find((e) => e.type === 'channel.updated' && e.channel && e.channel.id === channel.id
        && (e.channel.subscribers || []).includes(fan2)));
    assert.ok(update, 'the owner should be told a new subscriber joined');
  });

  await step('a new post reaches everyone subscribed now', async () => {
    const members = [owner, fan, fan2];
    const second = await A.client.sendChannelPost({ channelId: channel.id, text: 'Второе', members });
    const gotC = await waitFor(() => C.events.find((e) => e.type === 'channel.message' && e.id === second.id));
    assert.ok(gotC, 'the newly subscribed member receives it');
  });

  await step('editing a post updates every subscriber', async () => {
    const members = [owner, fan, fan2];
    const res = await A.client.editChannelMessage({ id: post.id, channelId: channel.id, text: 'Правка', members });
    assert.ok(res.editedAt);
    const gotB = await waitFor(() => B.events.find((e) => e.type === 'channel.edited' && e.id === post.id));
    assert.ok(gotB);
    assert.equal(gotB.text, 'Правка');
  });

  await step('deleting a post reaches the others', async () => {
    await A.client.deleteChannelMessage({ id: post.id });
    const gotB = await waitFor(() => B.events.find((e) => e.type === 'channel.deletedMessage' && e.id === post.id));
    assert.ok(gotB);
  });

  await step('a photo post round-trips for a subscriber', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const members = [owner, fan, fan2];
    const sent = await A.client.sendChannelPost({
      channelId: channel.id, text: 'Фото', members,
      attachment: { kind: 'image', bytes, name: 'pic.png', mime: 'image/png' }
    });
    const gotB = await waitFor(() => B.events.find((e) => e.type === 'channel.message' && e.id === sent.id));
    assert.equal(gotB.kind, 'image');
    const opened = await B.client.openChannelAttachment({ id: sent.id });
    assert.equal(opened.mime, 'image/png');
    assert.ok(opened.dataUrl.startsWith('data:image/png;base64,'));
  });

  await step('the owner can edit the channel name', async () => {
    const updated = await A.client.editChannel({ channelId: channel.id, name: 'Новости 2' });
    assert.equal(updated.name, 'Новости 2');
    const gotB = await waitFor(() => B.events.find((e) => e.type === 'channel.updated'
      && e.channel && e.channel.id === channel.id && e.channel.name === 'Новости 2'));
    assert.ok(gotB, 'subscribers hear about the rename');
    assert.equal(gotB.channel.name, 'Новости 2');
  });

  await step('a subscriber can leave the channel', async () => {
    await C.client.leaveChannel({ channelId: channel.id });
    const list = await C.client.listChannels();
    assert.ok(!list.some((c) => c.id === channel.id), 'channel should be gone for C');
  });

  await step('the owner cannot leave their own channel', async () => {
    let failed = false;
    try { await A.client.leaveChannel({ channelId: channel.id }); } catch { failed = true; }
    assert.ok(failed);
  });

  await step('a non-admin cannot verify a channel', async () => {
    const nobody = makeClient('nobody');
    await nobody.client.connect(URL);
    await nobody.client.register({ username: `nobody_${suffix}`, password: 'password-1234' });
    let failed = false;
    try { await nobody.client.adminAction({ action: 'channelVerify', channelId: channel.id }); }
    catch { failed = true; }
    assert.ok(failed, 'a non-admin cannot verify a channel');
    nobody.client.disconnect();
  });

  await step('an admin can verify a channel and subscribers are told', async () => {
    // Promote via the admin relay path is impossible without an admin, so drive
    // the mutation the way the panel does: a second relay booted with SLEEPHY_ADMINS.
    const PORT2 = PORT + 1;
    const URL2 = `ws://127.0.0.1:${PORT2}`;
    const DB2 = path.join(os.tmpdir(), `sleephy-ch-adm-${Date.now()}.db`);
    const server2 = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, SLEEPHY_PORT: String(PORT2), SLEEPHY_DB: DB2, SLEEPHY_ADMINS: `boss_${suffix}` },
      stdio: ['ignore', 'ignore', 'inherit']
    });
    await wait(1200);
    const boss = makeClient('boss');
    const member = makeClient('mem');
    await boss.client.connect(URL2);
    await member.client.connect(URL2);
    const bossName = `boss_${suffix}`;
    const memName = `mem_${suffix}`;
    await boss.client.register({ username: bossName, password: 'password-1234' });
    await member.client.register({ username: memName, password: 'password-1234' });
    const ch2 = await boss.client.createChannel({ name: 'Проверяемый' });
    await member.client.joinChannel({ channelId: ch2.id });
    await boss.client.adminAction({ action: 'channelVerify', channelId: ch2.id });
    const evt = await waitFor(() => member.events.find((e) =>
      e.type === 'channel.updated' && e.channel && e.channel.id === ch2.id && e.channel.verified));
    assert.ok(evt, 'subscriber is told the channel is now verified');
    assert.equal(evt.channel.verified, true);
    boss.client.disconnect();
    member.client.disconnect();
    server2.kill('SIGTERM');
    await wait(300);
    for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  });

  await step('an admin can delete a channel for everyone', async () => {
    const PORT2 = PORT + 2;
    const URL2 = `ws://127.0.0.1:${PORT2}`;
    const DB2 = path.join(os.tmpdir(), `sleephy-ch-del-${Date.now()}.db`);
    const server2 = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, SLEEPHY_PORT: String(PORT2), SLEEPHY_DB: DB2, SLEEPHY_ADMINS: `boss2_${suffix}` },
      stdio: ['ignore', 'ignore', 'inherit']
    });
    await wait(1200);
    const boss = makeClient('boss2');
    const member = makeClient('mem2');
    await boss.client.connect(URL2);
    await member.client.connect(URL2);
    const bossName = `boss2_${suffix}`;
    const memName = `mem2_${suffix}`;
    await boss.client.register({ username: bossName, password: 'password-1234' });
    await member.client.register({ username: memName, password: 'password-1234' });
    const ch = await boss.client.createChannel({ name: 'Удаляемый' });
    await member.client.joinChannel({ channelId: ch.id });
    await boss.client.adminAction({ action: 'channelDelete', channelId: ch.id });
    const evt = await waitFor(() => member.events.find((e) => e.type === 'channel.deleted' && e.channelId === ch.id));
    assert.ok(evt, 'subscriber is told the channel was deleted');
    const list = await member.client.listChannels();
    assert.ok(!list.some((c) => c.id === ch.id));
    boss.client.disconnect();
    member.client.disconnect();
    server2.kill('SIGTERM');
    await wait(300);
    for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  });

  for (const x of [A, B, C, D]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} channel checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
