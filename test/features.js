'use strict';

/**
 * Server-level checks for the Telegram-style features: profiles, claiming a
 * username, saved messages, chat settings, replies, edits, deletes, reactions,
 * typing and presence. No mocks — a real relay, real crypto, real clients.
 *
 * Run with: node test/features.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8795;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-feat-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-feat-${label}-`));
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
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  await A.client.connect(URL);
  await B.client.connect(URL);

  await step('register two accounts', async () => {
    await A.client.register({ username: alice, password: 'password-1234' });
    await B.client.register({ username: bob, password: 'password-1234' });
    assert.strictEqual(A.client.status().username, alice);
    assert.strictEqual(B.client.status().username, bob);
  });

  await step('a username cannot be claimed twice', async () => {
    const C = makeClient('c');
    await C.client.connect(URL);
    let failed = false;
    try { await C.client.register({ username: alice, password: 'password-1234' }); }
    catch (err) { failed = /taken/i.test(err.message); }
    assert.ok(failed, 'the second registration should be refused');
    C.client.disconnect();
  });

  await step('profile defaults to the username', async () => {
    const { profile } = await A.client.getProfile(alice);
    assert.strictEqual(profile.displayName, alice);
    assert.strictEqual(profile.bio, '');
    assert.strictEqual(profile.avatarColor, 'mint');
  });

  await step('profile can be edited and is saved', async () => {
    const saved = await A.client.saveProfile({
      displayName: 'Alice A.', bio: 'Hello there', avatarColor: 'violet'
    });
    assert.strictEqual(saved.displayName, 'Alice A.');
    const { profile } = await A.client.getProfile(alice);
    assert.strictEqual(profile.displayName, 'Alice A.');
    assert.strictEqual(profile.bio, 'Hello there');
    assert.strictEqual(profile.avatarColor, 'violet');
  });

  await step('profile changes reach the other side', async () => {
    // Bob must have a chat with Alice first, then a change propagates.
    await B.client.sendMessage({ to: alice, text: 'hi' });
    await waitFor(() => B.events.some((e) => e.type === 'message'));
    await A.client.saveProfile({ displayName: 'Alice Updated' });
    const seen = await waitFor(() => A.events.find((e) => e.type === 'message'));
    assert.ok(seen, 'sanity: the message arrived');
    await B.client.sendMessage({ to: alice, text: 'again' });
    const changed = await waitFor(() =>
      B.events.find((e) => e.type === 'profile' && e.profile.displayName === 'Alice Updated'));
    assert.ok(changed, 'Bob should be told about the new display name');
  });

  await step('user search finds accounts', async () => {
    const items = await A.client.searchUsers(bob.slice(0, 6));
    assert.ok(items.some((u) => u.username === bob), 'the search should include Bob');
  });

  await step('username can be changed and the old one is freed', async () => {
    const renamed = `bob2_${suffix}`;
    const res = await B.client.changeUsername(renamed);
    assert.strictEqual(res.username, renamed);
    assert.strictEqual(res.previous, bob);
    // The old name is free again.
    const C = makeClient('c2');
    await C.client.connect(URL);
    await C.client.register({ username: bob, password: 'password-1234' });
    C.client.disconnect();
    // And the renamed account still works.
    const { profile } = await B.client.getProfile(renamed);
    assert.strictEqual(profile.username, renamed);
    B.username = renamed;
  });

  await step('saved messages: sending to yourself works', async () => {
    const name = B.client.status().username;
    await B.client.sendMessage({ to: name, text: 'note to self' });
    const got = await waitFor(() =>
      B.events.find((e) => e.type === 'message' && e.text === 'note to self'));
    assert.ok(got, 'the saved message should come back to us');
  });

  await step('replies carry the quoted message id', async () => {
    const first = await A.client.sendMessage({ to: B.client.status().username, text: 'original' });
    const reply = await A.client.sendMessage({
      to: B.client.status().username, text: 'reply text', replyTo: first.id
    });
    assert.strictEqual(reply.replyTo, first.id);
    const hist = await A.client.history({ with: B.client.status().username });
    const found = hist.find((m) => m.id === reply.id);
    assert.strictEqual(found.replyTo, first.id);
  });

  await step('a message can be edited', async () => {
    const sent = await A.client.sendMessage({ to: B.client.status().username, text: 'typo here' });
    const res = await A.client.editMessage({
      id: sent.id, to: B.client.status().username, text: 'fixed'
    });
    assert.ok(res.editedAt > 0);
    const hist = await A.client.history({ with: B.client.status().username });
    const found = hist.find((m) => m.id === sent.id);
    assert.strictEqual(found.text, 'fixed');
    assert.ok(found.editedAt, 'editedAt should be set');
  });

  await step('an edit reaches the other side', async () => {
    const sent = await A.client.sendMessage({ to: B.client.status().username, text: 'before' });
    await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === sent.id));
    await A.client.editMessage({ id: sent.id, to: B.client.status().username, text: 'after' });
    const got = await waitFor(() =>
      B.events.find((e) => e.type === 'edited' && e.id === sent.id && e.text === 'after'));
    assert.ok(got, 'Bob should receive the edited text');
  });

  await step('a message can be deleted and disappears from history', async () => {
    const sent = await A.client.sendMessage({ to: B.client.status().username, text: 'burn me' });
    await A.client.deleteMessage({ id: sent.id });
    const hist = await A.client.history({ with: B.client.status().username });
    const found = hist.find((m) => m.id === sent.id);
    assert.ok(found, 'the row stays as a tombstone');
    assert.strictEqual(found.deleted, true);
    assert.strictEqual(found.text, '');
  });

  await step('a delete reaches the other side', async () => {
    const sent = await A.client.sendMessage({ to: B.client.status().username, text: 'vanish' });
    await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === sent.id));
    await A.client.deleteMessage({ id: sent.id });
    const got = await waitFor(() => B.events.find((e) => e.type === 'deleted' && e.id === sent.id));
    assert.ok(got, 'Bob should be told the message was deleted');
  });

  await step('you cannot edit or delete someone else\'s message', async () => {
    const sent = await A.client.sendMessage({ to: B.client.status().username, text: 'mine only' });
    let editFailed = false;
    let deleteFailed = false;
    try { await B.client.editMessage({ id: sent.id, to: alice, text: 'hijack' }); }
    catch (err) { editFailed = /not your message/i.test(err.message); }
    try { await B.client.deleteMessage({ id: sent.id }); }
    catch (err) { deleteFailed = /not your message/i.test(err.message); }
    assert.ok(editFailed, 'Bob must not edit Alice\'s message');
    assert.ok(deleteFailed, 'Bob must not delete Alice\'s message');
  });

  await step('reactions are stored and shared', async () => {
    const sent = await A.client.sendMessage({ to: B.client.status().username, text: 'react to me' });
    await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === sent.id));
    const res = await B.client.react({ id: sent.id, emoji: '👍' });
    assert.ok(res.reactions.some((r) => r.emoji === '👍'));
    const got = await waitFor(() =>
      A.events.find((e) => e.type === 'reactions' && e.id === sent.id && e.reactions.length));
    assert.ok(got, 'Alice should see the reaction');
  });

  await step('typing indicators are delivered', async () => {
    await A.client.typing({ to: B.client.status().username, state: 'start' });
    const got = await waitFor(() => B.events.find((e) => e.type === 'typing' && e.state === 'start'));
    assert.ok(got, 'Bob should see Alice typing');
  });

  await step('presence is pushed to a chat partner when they come and go', async () => {
    // A conversation must already exist (it does by now), then Alice goes away
    // and comes back. Bob should hear about both transitions.
    B.events.length = 0;
    A.client.disconnect();
    const offline = await waitFor(() =>
      B.events.find((e) => e.type === 'presence' && e.username === alice && e.online === false));
    assert.ok(offline, 'Bob should be told Alice went offline');

    await A.client.connect(URL);
    const online = await waitFor(() =>
      B.events.find((e) => e.type === 'presence' && e.username === alice && e.online === true));
    assert.ok(online, 'Bob should be told Alice came back online');
  });

  await step('chat can be pinned, muted and archived', async () => {
    const peer = B.client.status().username;
    let res = await A.client.setChatSettings({ peer, pinned: true });
    assert.strictEqual(res.pinned, true);
    res = await A.client.setChatSettings({ peer, muted: true });
    assert.strictEqual(res.pinned, true, 'pinning is preserved');
    assert.strictEqual(res.muted, true);
    res = await A.client.setChatSettings({ peer, archived: true });
    assert.strictEqual(res.archived, true);
    res = await A.client.setChatSettings({ peer, pinned: false, archived: false });
    assert.strictEqual(res.pinned, false);
    assert.strictEqual(res.archived, false);
    assert.strictEqual(res.muted, true, 'mute is untouched');
  });

  await step('the chat list reports peers, flags and unread counts', async () => {
    const peer = B.client.status().username;
    await A.client.sendMessage({ to: peer, text: 'unread for bob' });
    await wait(200);
    const chats = await B.client.listChats();
    const row = chats.find((c) => c.peer === alice);
    assert.ok(row, 'Bob should have a chat with Alice');
    assert.ok(row.unread >= 1, `expected unread, got ${row.unread}`);
    assert.ok(row.last, 'the last message should be included');
  });

  await step('marking a chat read clears the unread count', async () => {
    await B.client.markRead(alice);
    const chats = await B.client.listChats();
    const row = chats.find((c) => c.peer === alice);
    assert.strictEqual(row.unread, 0);
  });

  await step('clearing a chat removes its messages', async () => {
    const peer = B.client.status().username;
    await A.client.clearChat(peer);
    const hist = await A.client.history({ with: peer });
    assert.strictEqual(hist.length, 0, 'history should be empty after clearing');
  });

  await step('deleting a chat removes it from the list', async () => {
    const peer = B.client.status().username;
    await A.client.deleteChat(peer);
    const chats = await A.client.listChats();
    assert.ok(!chats.some((c) => c.peer === peer), 'the chat should be gone');
  });

  A.client.disconnect();
  B.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} feature checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
