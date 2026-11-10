'use strict';

/**
 * Call signaling over a real relay. The relay is a switchboard: it forwards
 * the WebRTC handshake (offer/answer/ICE) between participants and never sees
 * the media. These checks pin down who gets rung, who may signal on a call,
 * and how a call ends — direct, group, decline, hangup and a dropped socket.
 *
 * Run with: node test/calls.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8824;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-calls-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-call-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The call id shared between the first three steps.
let pendingCall = null;

/** Index a client's event log at right now; wait only for events after it. */
const mark = (client) => client.events.length;

/**
 * Wait for an event of `type` that arrived after `from`, optionally matching a
 * predicate. The marker is taken before the action that should cause the event,
 * so a stale event from an earlier step can never satisfy the wait.
 */
async function waitFrom(client, from, type, predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (let i = from; i < client.events.length; i++) {
      const e = client.events[i];
      if (e.type === type && (!predicate || predicate(e))) return e;
    }
    await wait(20);
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;
  const carol = `carol_${suffix}`;

  const A = makeClient('a');
  const B = makeClient('b');
  const C = makeClient('c');
  for (const x of [A, B, C]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });
  await C.client.register({ username: carol, password: 'password-1234' });

  await step('a direct call rings exactly the callee', async () => {
    const b = mark(B);
    const { callId } = await A.client.callInvite({ to: bob, video: false });
    assert.ok(callId, 'a call id came back');
    const ring = await waitFrom(B, b, 'call.incoming');
    assert.strictEqual(ring.from, alice, 'bob sees alice calling');
    assert.strictEqual(ring.callId, callId, 'same call id');
    assert.strictEqual(ring.video, false, 'audio call');
    assert.ok(!C.events.some((e) => e.type === 'call.incoming'), 'carol was not rung');
    // Keep the call alive for the next two steps.
    pendingCall = callId;
  });

  await step('the answer reaches the caller', async () => {
    const b = mark(B);
    const a = mark(A);
    const ring = await waitFrom(B, 0, 'call.incoming', (e) => e.callId === pendingCall);
    assert.ok(ring, 'bob has the ring');
    await B.client.callAnswer({ callId: pendingCall });
    const answered = await waitFrom(A, a, 'call.answered');
    assert.strictEqual(answered.from, bob, 'bob answered');
    assert.strictEqual(answered.callId, pendingCall, 'same call');
  });

  await step('an offer and an ICE candidate both pass through', async () => {
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
    const b = mark(B);
    await A.client.callSignal({ callId: pendingCall, sdp });
    const gotSdp = await waitFrom(B, b, 'call.signal');
    assert.strictEqual(gotSdp.from, alice, 'from alice');
    assert.strictEqual(gotSdp.sdp, sdp, 'the SDP arrived intact');

    const candidate = { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0' };
    const a = mark(A);
    await B.client.callSignal({ callId: pendingCall, candidate });
    const gotCand = await waitFrom(A, a, 'call.signal');
    assert.deepStrictEqual(gotCand.candidate, candidate, 'the candidate arrived intact');
    await A.client.callHangup({ callId: pendingCall });
    pendingCall = null;
  });

  await step('a signal addressed to one peer does not reach the others', async () => {
    const { callId } = await A.client.callInvite({ to: bob, video: false });
    await B.client.callAnswer({ callId });
    const before = C.events.filter((e) => e.type === 'call.signal').length;
    await A.client.callSignal({ callId, to: bob, sdp: 'addressed' });
    await wait(150);
    assert.strictEqual(C.events.filter((e) => e.type === 'call.signal').length, before, 'carol saw nothing');
    await A.client.callHangup({ callId });
  });

  // The client's call methods are best-effort by design, so the refusals are
  // checked against the raw request — that is exactly what the relay answers.
  const rawSignal = (c, callId) => c.request({ t: 'call.signal', callId, sdp: 'v=0' });

  await step('a stranger cannot signal on someone else\'s call', async () => {
    const { callId } = await A.client.callInvite({ to: bob, video: false });
    await assert.rejects(() => rawSignal(C.client, callId), /No such call/, 'carol is refused');
    await A.client.callHangup({ callId });
  });

  await step('a decline tears the call down for both sides', async () => {
    const b = mark(B); const a = mark(A);
    const { callId } = await A.client.callInvite({ to: bob, video: false });
    const ring = await waitFrom(B, b, 'call.incoming');
    assert.strictEqual(ring.callId, callId, 'bob was rung');
    await B.client.callDecline({ callId });
    const declined = await waitFrom(A, a, 'call.declined');
    assert.strictEqual(declined.from, bob, 'bob declined');
    // The call is gone: a second signal on it is now refused.
    await assert.rejects(() => rawSignal(A.client, callId), /No such call/);
  });

  await step('a hangup ends the call for the other side', async () => {
    const b = mark(B);
    const { callId } = await A.client.callInvite({ to: bob, video: false });
    await waitFrom(B, b, 'call.incoming');
    await B.client.callAnswer({ callId });
    await A.client.callHangup({ callId });
    const ended = await waitFrom(B, b, 'call.ended');
    assert.strictEqual(ended.callId, callId, 'bob learned the call ended');
  });

  await step('a dropped socket removes the caller from the call', async () => {
    const b = mark(B);
    const { callId } = await A.client.callInvite({ to: bob, video: false });
    await waitFrom(B, b, 'call.incoming');
    A.client.disconnect();
    const ended = await waitFrom(B, b, 'call.ended');
    assert.strictEqual(ended.callId, callId, 'bob learned the call ended');
    // Reconnect so the later steps have a live alice.
    await A.client.connect(URL);
    await wait(200);
  });

  await step('a group call rings every other member', async () => {
    const group = await A.client.createGroup({ name: 'Звонок', members: [bob, carol] });
    const groupId = group.id || group.groupId;
    const b = mark(B); const c = mark(C); const a = mark(A);
    const { callId } = await A.client.callInvite({ groupId, video: true });
    const bobRing = await waitFrom(B, b, 'call.incoming');
    const carolRing = await waitFrom(C, c, 'call.incoming');
    assert.strictEqual(bobRing.groupId, groupId, 'bob rang in the group');
    assert.strictEqual(carolRing.groupId, groupId, 'carol rang in the group');
    assert.strictEqual(carolRing.video, true, 'video call');
    assert.strictEqual(bobRing.callId, callId, 'same call id');

    // One member leaves; the others keep the call alive.
    await B.client.callHangup({ callId });
    const left = await waitFrom(A, a, 'call.left');
    assert.strictEqual(left.from, bob, 'alice saw bob leave');
    await A.client.callSignal({ callId, sdp: 'still-here' });
    const still = await waitFrom(C, c, 'call.signal');
    assert.strictEqual(still.from, alice, 'the call carried on without bob');
  });

  await step('an outsider cannot join a group call by id', async () => {
    const group = await A.client.createGroup({ name: 'Закрытая', members: [bob] });
    const groupId = group.id || group.groupId;
    const { callId } = await A.client.callInvite({ groupId, video: false });
    await assert.rejects(() => rawSignal(C.client, callId), /No such call/);
    await assert.rejects(
      () => C.client.request({ t: 'call.answer', callId }), /No such call/
    );
    await A.client.callHangup({ callId });
  });

  await step('an unknown call id is refused, not crashed on', async () => {
    await assert.rejects(() => rawSignal(A.client, 'nope'), /No such call/);
    await assert.rejects(() => A.client.request({ t: 'call.answer', callId: 'nope' }), /No such call/);
  });

  await step('a call to an unknown user is refused', async () => {
    await assert.rejects(() => A.client.callInvite({ to: 'ghost_nobody', video: false }), /No such user/);
  });

  await step('a call to yourself is refused', async () => {
    await assert.rejects(() => A.client.callInvite({ to: alice, video: false }), /Cannot call yourself/);
  });

  await step('the invite response lists who was rung', async () => {
    const group = await A.client.createGroup({ name: 'Ростер', members: [bob, carol] });
    const groupId = group.id || group.groupId;
    const res = await A.client.callInvite({ groupId, video: false });
    assert.deepStrictEqual([...res.participants].sort(), [bob, carol].sort(), 'both members are listed');
    await A.client.callHangup({ callId: res.callId });
    await wait(150);
  });

  await step('the answer response lists the others on the call', async () => {
    const group = await A.client.createGroup({ name: 'Ростер2', members: [bob, carol] });
    const groupId = group.id || group.groupId;
    const { callId } = await A.client.callInvite({ groupId, video: false });
    const bMark = mark(B);
    await waitFrom(B, bMark, 'call.incoming');
    const res = await B.client.callAnswer({ callId });
    assert.ok(res.participants.includes(alice), 'bob is told alice is already there');
    assert.ok(res.participants.includes(carol), 'and so is carol');
    await A.client.callHangup({ callId });
    await wait(150);
  });

  await step('a group call ends for the last person when the rest leave', async () => {
    const group = await A.client.createGroup({ name: 'Один', members: [bob, carol] });
    const groupId = group.id || group.groupId;
    const { callId } = await A.client.callInvite({ groupId, video: false });
    const a = mark(A); const c = mark(C);
    await waitFrom(B, mark(B), 'call.incoming');
    await waitFrom(C, c, 'call.incoming');
    // Carol leaves first: the call carries on for alice and bob.
    await C.client.callHangup({ callId });
    const left = await waitFrom(A, a, 'call.left');
    assert.strictEqual(left.from, carol, 'alice saw carol leave');
    assert.ok(!A.events.slice(a).some((e) => e.type === 'call.ended'), 'the call did not end yet');
    // Alice leaves: only bob is left, so the call is over for him too.
    const bMark = mark(B);
    await A.client.callHangup({ callId });
    const ended = await waitFrom(B, bMark, 'call.ended');
    assert.strictEqual(ended.callId, callId, 'bob was told the call ended');
    void c;
  });

  for (const x of [A, B, C]) x.client.disconnect();
  server.kill('SIGTERM');
  await wait(300);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} call checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
