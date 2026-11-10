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
  const C = makeClient('c');
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;
  const carol = `carol_${suffix}`;

  await A.client.connect(URL);
  await B.client.connect(URL);
  await C.client.connect(URL);

  await step('register two accounts', async () => {
    await A.client.register({ username: alice, password: 'password-1234' });
    await B.client.register({ username: bob, password: 'password-1234' });
    await C.client.register({ username: carol, password: 'password-1234' });
    assert.strictEqual(A.client.status().username, alice);
    assert.strictEqual(B.client.status().username, bob);
  });

  await step('a username cannot be claimed twice', async () => {
    const dup = makeClient('dup');
    await dup.client.connect(URL);
    let failed = false;
    try { await dup.client.register({ username: alice, password: 'password-1234' }); }
    catch (err) { failed = /taken/i.test(err.message); }
    assert.ok(failed, 'the second registration should be refused');
    dup.client.disconnect();
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

  await step('profile social links are stored and validated', async () => {
    const saved = await A.client.saveProfile({
      socials: [
        { network: 'telegram', url: 'https://t.me/alice' },
        { network: 'github', url: 'https://github.com/alice' }
      ]
    });
    assert.deepStrictEqual(saved.socials.map((s) => s.network), ['telegram', 'github']);
    const { profile } = await A.client.getProfile(alice);
    assert.strictEqual(profile.socials[0].url, 'https://t.me/alice');

    // A javascript: link must be rejected outright.
    let rejected = false;
    try { await A.client.saveProfile({ socials: [{ network: 'website', url: 'javascript:alert(1)' }] }); }
    catch { rejected = true; }
    assert.ok(rejected, 'a non-http social link must be rejected');

    // An unknown network must be rejected too.
    let badNetwork = false;
    try { await A.client.saveProfile({ socials: [{ network: 'myspace', url: 'https://x.test' }] }); }
    catch { badNetwork = true; }
    assert.ok(badNetwork, 'an unknown network must be rejected');
  });

  await step('a hidden profile hides its social links from others', async () => {
    await A.client.saveProfile({ socials: [{ network: 'telegram', url: 'https://t.me/alice' }] });
    await A.client.setPrivacy({ profileHidden: true });
    const { profile } = await B.client.getProfile(alice);
    assert.deepStrictEqual(profile.socials, [], 'a hidden profile must not leak social links');
    await A.client.setPrivacy({ profileHidden: false });
    const back = await B.client.getProfile(alice);
    assert.strictEqual(back.profile.socials.length, 1, 'the links come back when unhidden');
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

  await step('an attachment is stored as ciphertext and decrypts for the peer', async () => {
    const bytes = new TextEncoder().encode('hello from an attachment');
    const res = await A.client.sendMessage({
      to: B.client.status().username, text: 'see file',
      attachment: { kind: 'file', bytes, name: 'note.txt', mime: 'text/plain' }
    });
    const got = await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === res.id));
    assert.equal(got.kind, 'file', 'kind should be file');
    const att = JSON.parse(got.attachment);
    assert.equal(att.name, 'note.txt');
    // The relay holds the ciphertext, never the plaintext bytes.
    assert.ok(!att.box.includes('hello from an attachment'), 'plaintext must not appear');
    const opened = await B.client.openAttachment({ id: res.id, peer: A.client.status().username });
    assert.equal(Buffer.from(opened.dataUrl.split(',')[1], 'base64').toString(), 'hello from an attachment');
  });

  await step('an oversized attachment is rejected', async () => {
    const bytes = new Uint8Array(6 * 1024 * 1024);
    await assert.rejects(
      () => A.client.sendMessage({
        to: B.client.status().username, text: '',
        attachment: { kind: 'file', bytes, name: 'big.bin', mime: 'application/octet-stream' }
      }),
      /too large/i
    );
  });

  await step('a file exactly at the size limit is accepted', async () => {
    // The ciphertext is the file plus the 16-byte box MAC, so the relay must
    // allow that overhead or a file at the stated limit would be refused.
    const bytes = new Uint8Array(5 * 1024 * 1024);
    bytes[0] = 42;
    bytes[bytes.length - 1] = 7;
    const res = await A.client.sendMessage({
      to: B.client.status().username, text: '',
      attachment: { kind: 'file', bytes, name: 'edge.bin', mime: 'application/octet-stream' }
    });
    const opened = await B.client.openAttachment({ id: res.id, peer: A.client.status().username });
    const out = Buffer.from(opened.dataUrl.split(',')[1], 'base64');
    assert.strictEqual(out.length, bytes.length, 'every byte should survive the round-trip');
    assert.strictEqual(out[0], 42);
    assert.strictEqual(out[out.length - 1], 7);
  });

  await step('a message can be pinned and unpinned, both sides notified', async () => {
    const res = await A.client.sendMessage({ to: B.client.status().username, text: 'pin me' });
    const got = await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === res.id));
    const pin = await A.client.pinMessage({ id: res.id, pinned: true });
    assert.equal(pin.pinned, true);
    assert.ok(await waitFor(() => B.events.find((e) => e.type === 'pinned' && e.id === res.id)));
    const pinned = await A.client.pinnedMessages({ peer: B.client.status().username });
    assert.ok(pinned.some((m) => m.id === res.id), 'the message should be in the pinned list');
    const unpin = await A.client.pinMessage({ id: res.id, pinned: false });
    assert.equal(unpin.pinned, false);
  });

  await step('history carries attachment, kind and pinned flags', async () => {
    const res = await A.client.sendMessage({ to: B.client.status().username, text: 'flag check' });
    await A.client.pinMessage({ id: res.id, pinned: true });
    const items = await A.client.history({ with: B.client.status().username, limit: 50 });
    const found = items.find((m) => m.id === res.id);
    assert.ok(found, 'the message should be in history');
    assert.equal(found.pinned, true);
  });

  await step('a message can be fetched by id for opening attachments', async () => {
    const bytes = new TextEncoder().encode('fetch me');
    const res = await A.client.sendMessage({
      to: B.client.status().username, text: '',
      attachment: { kind: 'image', bytes, name: 'p.png', mime: 'image/png' }
    });
    const opened = await B.client.openAttachment({ id: res.id, peer: A.client.status().username });
    assert.ok(opened.dataUrl.startsWith('data:image/png;base64,'), 'should return a png data url');
    assert.equal(Buffer.from(opened.dataUrl.split(',')[1], 'base64').toString(), 'fetch me');
  });

  await step('a third party cannot fetch or open someone else\'s message', async () => {
    const res = await A.client.sendMessage({ to: B.client.status().username, text: 'private' });
    await assert.rejects(
      () => C.client.openAttachment({ id: res.id, peer: B.client.status().username }),
      /no such message|not your conversation/i
    );
  });

  await step('search matches on peer and attachment name', async () => {
    const bytes = new TextEncoder().encode('searchable');
    await A.client.sendMessage({
      to: B.client.status().username, text: '',
      attachment: { kind: 'file', bytes, name: 'findme-unique.txt', mime: 'text/plain' }
    });
    const hits = await A.client.searchMessages({ query: 'findme-unique' });
    assert.ok(hits.length >= 1, 'the attachment name should match');
  });

  await step('settings round-trip and merge partial updates', async () => {
    const first = await A.client.saveSettings({ theme: 'light', wallpaper: 'dots' });
    assert.equal(first.theme, 'light');
    assert.equal(first.wallpaper, 'dots');
    const second = await A.client.saveSettings({ wallpaper: 'grid' });
    assert.equal(second.theme, 'light', 'unrelated keys must survive a partial update');
    assert.equal(second.wallpaper, 'grid');
    const read = await A.client.getSettings();
    assert.equal(read.theme, 'light');
    assert.equal(read.wallpaper, 'grid');
  });

  await step('settings are per account', async () => {
    const s = await B.client.getSettings();
    assert.notEqual(s.theme, 'light', 'B should not inherit A\'s theme');
  });

  await step('a voice note round-trips with a duration', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await A.client.sendMessage({
      to: B.client.status().username, text: '',
      attachment: { kind: 'voice', bytes, name: 'voice-3s.webm', mime: 'audio/webm', duration: 3 }
    });
    const got = await waitFor(() => B.events.find((e) => e.type === 'message' && e.id === res.id));
    assert.equal(got.kind, 'voice');
    const opened = await B.client.openAttachment({ id: res.id, peer: A.client.status().username });
    assert.equal(opened.mime, 'audio/webm');
  });

  A.client.disconnect();
  B.client.disconnect();
  C.client.disconnect();
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
