'use strict';

/**
 * Story checks against a real relay: publishing, per-viewer encryption, the
 * 24-hour window, the audience, seen marks and deletion. No mocks — real
 * crypto, real relay, real SQLite.
 *
 * Run with: node test/story-relay.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8794;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-story-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-story-${label}-`));
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
  const C = makeClient('c'); // never talks to A, so never in the audience
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;
  const carol = `carol_${suffix}`;

  for (const x of [A, B, C]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });
  await C.client.register({ username: carol, password: 'password-1234' });

  // Alice and Bob talk, so each is in the other's audience; Carol is not.
  await A.client.sendMessage({ to: bob, text: 'привет' });
  await waitFor(() => B.events.find((e) => e.type === 'message'));

  let storyId;
  await step('posting a story encrypts one copy per viewer', async () => {
    const audience = await A.client.storyAudience();
    assert.ok(audience.includes(bob), 'Bob should be in the audience');
    assert.ok(!audience.includes(carol), 'Carol should not be in the audience');
    assert.ok(!audience.includes(alice), 'the audience list excludes the author');

    const res = await A.client.postStory({ text: 'Мой первый сторис', audience });
    storyId = res.id;
    assert.ok(storyId, 'story id');
    assert.ok(res.expiresAt > Date.now(), 'expiry is in the future');
  });

  await step('the peer is told about the new story over the socket', async () => {
    const evt = await waitFor(() => B.events.find((e) => e.type === 'story.new' && e.id === storyId));
    assert.ok(evt, 'Bob should receive a story.new event');
    assert.equal(evt.author, alice);
  });

  await step('the peer can list and decrypt the story', async () => {
    const items = await B.client.listStories();
    const mine = items.find((s) => s.id === storyId);
    assert.ok(mine, 'story missing for Bob');
    assert.equal(mine.text, 'Мой первый сторис');
    assert.equal(mine.author, alice);
    assert.equal(mine.mine, false);
  });

  await step('the author sees their own story', async () => {
    const items = await A.client.listStories();
    const own = items.find((s) => s.id === storyId);
    assert.ok(own, 'author should see the story');
    assert.equal(own.mine, true);
    assert.equal(own.text, 'Мой первый сторис');
  });

  await step('a stranger cannot list or view the story', async () => {
    const items = await C.client.listStories();
    assert.ok(!items.some((s) => s.id === storyId), 'Carol must not see the story');
    let failed = false;
    try { await C.client.viewStory({ id: storyId }); }
    catch (err) { failed = /audience/i.test(err.message); }
    assert.ok(failed, 'Carol must not be able to view it');
  });

  await step('marking a story viewed updates the count', async () => {
    const res = await B.client.viewStory({ id: storyId });
    assert.equal(res.views, 1);
    const evt = await waitFor(() => A.events.find((e) => e.type === 'story.views' && e.id === storyId));
    assert.ok(evt, 'the author should learn the count');
    assert.equal(evt.count, 1);
  });

  await step('the author can see who viewed, and only the author can', async () => {
    const viewers = await A.client.storyViewers({ id: storyId });
    assert.ok(viewers.some((v) => v.username === bob), 'Bob should be listed as a viewer');
    let failed = false;
    try { await B.client.storyViewers({ id: storyId }); }
    catch (err) { failed = /your story/i.test(err.message); }
    assert.ok(failed, 'a non-author must not list viewers');
  });

  await step('a viewed story is marked seen for that viewer only', async () => {
    const forB = (await B.client.listStories()).find((s) => s.id === storyId);
    assert.ok(forB.seen, 'Bob has seen it');
    const forA = (await A.client.listStories()).find((s) => s.id === storyId);
    assert.ok(!forA.seen, 'the author has not "seen" their own story');
  });

  await step('the relay stores no plaintext story body', async () => {
    const raw = new DatabaseSync(DB);
    const row = raw.prepare('SELECT envelope FROM stories WHERE id = ?').get(storyId);
    assert.ok(row, 'row exists');
    assert.ok(!row.envelope.includes('сторис'), 'plaintext leaked into the relay store');
    const parsed = JSON.parse(row.envelope);
    assert.ok(parsed[alice], 'the author has their own envelope');
    assert.ok(parsed[bob], 'Bob has an envelope');
    raw.close();
  });

  await step('an expired story is hidden and swept', async () => {
    // Publish one with the shortest allowed life, then push its expiry into the
    // past directly so the sweep runs without a real wait.
    const audience = await A.client.storyAudience();
    const shortLived = await A.client.postStory({ text: 'исчезнет', audience, ttl: 60000 });
    const raw = new DatabaseSync(DB);
    raw.prepare('UPDATE stories SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, shortLived.id);
    raw.close();
    const items = await A.client.listStories();
    assert.ok(!items.some((s) => s.id === shortLived.id), 'expired story must not be listed');
    const raw2 = new DatabaseSync(DB);
    const row = raw2.prepare('SELECT id FROM stories WHERE id = ?').get(shortLived.id);
    raw2.close();
    assert.ok(!row, 'the sweep should have deleted the row');
  });

  await step('deleting a story removes it for everyone', async () => {
    await A.client.deleteStory({ id: storyId });
    const evt = await waitFor(() => B.events.find((e) => e.type === 'story.deleted' && e.id === storyId));
    assert.ok(evt, 'Bob should learn about the deletion');
    const items = await B.client.listStories();
    assert.ok(!items.some((s) => s.id === storyId), 'the story must be gone');
  });

  await step('a story photo round-trips for a viewer', async () => {
    const audience = await A.client.storyAudience();
    const bytes = new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6]);
    const res = await A.client.postStory({
      text: '', audience,
      attachment: { kind: 'image', bytes, name: 'story.png', mime: 'image/png' }
    });
    const evt = await waitFor(() => B.events.find((e) => e.type === 'story.new' && e.id === res.id));
    assert.equal(evt.kind, 'image');
    const item = (await B.client.listStories()).find((s) => s.id === res.id);
    assert.equal(item.kind, 'image');
    assert.ok(item.attachment && item.attachment.box, 'viewer has their own attachment blob');
    // The viewer can decrypt the bytes back to the original picture.
    const opened = await B.client.openStoryAttachment({ id: res.id });
    assert.ok(opened.dataUrl.startsWith('data:image/png;base64,'), 'a png data URL');
    const decoded = Buffer.from(opened.dataUrl.split(',')[1], 'base64');
    assert.deepStrictEqual([...decoded], [...bytes], 'the picture round-trips byte for byte');
    // A stranger is refused the picture.
    let refused = false;
    try { await C.client.openStoryAttachment({ id: res.id }); }
    catch { refused = true; }
    assert.ok(refused, 'Carol must not decrypt the picture');
  });

  for (const x of [A, B, C]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} story checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
