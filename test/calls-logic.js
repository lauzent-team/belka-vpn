'use strict';

/**
 * The call helpers, exercised under plain node. These are the questions the
 * renderer asks when it paints a call: how long it has run, what the banner
 * says, who is on it. Getting the wording or the arithmetic wrong here is
 * exactly the kind of bug that only shows up mid-call, so it is pinned down.
 *
 * Run with: node test/calls-logic.js
 */

const assert = require('assert');
const calls = require('../src/lib/calls');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

step('a duration reads mm:ss under an hour', () => {
  assert.strictEqual(calls.formatDuration(0), '00:00');
  assert.strictEqual(calls.formatDuration(9_000), '00:09');
  assert.strictEqual(calls.formatDuration(65_000), '01:05');
  assert.strictEqual(calls.formatDuration(3_599_000), '59:59');
});

step('a duration reads h:mm:ss past an hour', () => {
  assert.strictEqual(calls.formatDuration(3_600_000), '1:00:00');
  assert.strictEqual(calls.formatDuration(3_725_000), '1:02:05');
});

step('a bad duration is clamped, not printed as NaN', () => {
  assert.strictEqual(calls.formatDuration(-5000), '00:00');
  assert.strictEqual(calls.formatDuration(undefined), '00:00');
  assert.strictEqual(calls.formatDuration('abc'), '00:00');
});

step('the banner names the kind of call', () => {
  assert.strictEqual(calls.callKindLabel(false), 'Аудиозвонок');
  assert.strictEqual(calls.callKindLabel(true), 'Видеозвонок');
});

step('the banner reflects the call state', () => {
  assert.ok(calls.callStatusLabel('outgoing', false).includes('Исходящий'));
  assert.ok(calls.callStatusLabel('incoming', true).includes('Входящий'));
  assert.strictEqual(calls.callStatusLabel('active', false), null, 'the timer replaces it');
  assert.ok(calls.callStatusLabel('connecting', false).includes('Соединение'));
});

step('a ringtone file comes from the manifest', () => {
  const manifest = { ringtones: { incoming: 'incoming.mp3', default: 'ring.mp3' } };
  assert.strictEqual(calls.ringtoneFile('incoming', manifest), 'assets/ringtones/incoming.mp3');
  assert.strictEqual(calls.ringtoneFile('outgoing', manifest), 'assets/ringtones/ring.mp3');
});

step('with no manifest there is no ringtone file, only the chime', () => {
  assert.strictEqual(calls.ringtoneFile('incoming', null), null);
  assert.strictEqual(calls.ringtoneFile('incoming', {}), null);
  assert.strictEqual(calls.ringtoneFile('incoming', { ringtones: { incoming: '  ' } }), null);
});

step('participants read "Вы, Боб" for two', () => {
  assert.strictEqual(calls.describeParticipants(['Боб'], 'Вы'), 'Вы, Боб');
});

step('participants read "Вы, Боб и ещё 2" for a crowd', () => {
  assert.strictEqual(calls.describeParticipants(['Боб', 'Кэрол', 'Дэйв'], 'Вы'), 'Вы, Боб и ещё 2');
});

step('the self name is never counted twice', () => {
  assert.strictEqual(calls.describeParticipants(['Вы', 'Боб'], 'Вы'), 'Вы, Боб');
});

step('a lone participant is just the self name', () => {
  assert.strictEqual(calls.describeParticipants([], 'Вы'), 'Вы');
  assert.strictEqual(calls.describeParticipants(['Вы'], 'Вы'), 'Вы');
});

step('direct chats and groups can be called', () => {
  assert.strictEqual(calls.supportsCalls('bob'), true);
  assert.strictEqual(calls.supportsCalls('group:7'), true);
});

step('saved messages, bots and channels cannot be called', () => {
  assert.strictEqual(calls.supportsCalls('saved'), false);
  assert.strictEqual(calls.supportsCalls('bot:minigames'), false);
  assert.strictEqual(calls.supportsCalls('channel:3'), false);
  assert.strictEqual(calls.supportsCalls(''), false);
  assert.strictEqual(calls.supportsCalls(null), false);
});

step('a group key is recognised as a group call', () => {
  assert.strictEqual(calls.isGroupCallKey('group:12'), true);
  assert.strictEqual(calls.isGroupCallKey('bob'), false);
});

step('there is always at least one STUN server', () => {
  assert.ok(Array.isArray(calls.DEFAULT_ICE) && calls.DEFAULT_ICE.length >= 1);
  assert.ok(calls.DEFAULT_ICE.every((s) => /^stun:/.test(s.urls)));
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} call-logic checks passed`);
process.exit(passed === results.length ? 0 : 1);
