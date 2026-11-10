'use strict';

/**
 * Tests for the poll logic in src/lib/polls.js. Pure logic, no server and no
 * browser: this runs with plain `node test/polls.js`.
 */

const assert = require('assert');
const polls = require('../src/lib/polls');

const results = [];
function pass(name) { results.push(true); console.log('  PASS', name); }
function step(name, fn) {
  try { fn(); pass(name); } catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

step('make trims, drops blank options and clamps flags', () => {
  const p = polls.make('  Обед?  ', ['  Пицца ', '', '  Суши  ', null], { multiple: true, anon: false });
  assert.strictEqual(p.q, 'Обед?');
  assert.deepStrictEqual(p.o, ['Пицца', 'Суши']);
  assert.strictEqual(p.m, true);
  assert.strictEqual(p.anon, false);
  assert.strictEqual(p.closed, false);
});

step('make caps the number of options and the lengths', () => {
  const p = polls.make('Q', Array.from({ length: 20 }, (_, i) => 'opt' + i), {});
  assert.strictEqual(p.o.length, polls.MAX_OPTIONS);
  const long = polls.make('x'.repeat(500), ['a', 'b'], {});
  assert.strictEqual(long.q.length, polls.MAX_QUESTION);
});

step('validate rejects a poll with fewer than two options', () => {
  assert.strictEqual(polls.validate(polls.make('Q', ['only one'], {})).ok, false);
  assert.strictEqual(polls.validate(polls.make('Q', ['a', 'b'], {})).ok, true);
  assert.strictEqual(polls.validate(polls.make('', ['a', 'b'], {})).ok, false);
});

step('a poll round-trips through encode/decode', () => {
  const p = polls.make('Куда?', ['Море', 'Горы'], { multiple: true });
  const back = polls.decode(polls.encode(p));
  assert.deepStrictEqual(back, p);
});

step('decode ignores ordinary text and malformed JSON', () => {
  assert.strictEqual(polls.decode('hello'), null);
  assert.strictEqual(polls.decode('{"gift":"rose"}'), null);
  assert.strictEqual(polls.decode('{not json'), null);
  assert.strictEqual(polls.decode('{"poll":{"q":"Q"}}'), null);
});

step('a vote round-trips, deduplicating and sorting indices', () => {
  const v = polls.decodeVote(polls.encodeVote(7, [3, 1, 3, -2, 2]));
  assert.deepStrictEqual(v, { pv: 7, i: [1, 2, 3] });
  assert.strictEqual(polls.decodeVote('plain'), null);
  assert.strictEqual(polls.decodeVote('{"pv":"x","i":[]}'), null);
});

step('toggle enforces single choice and clears a repeated tap', () => {
  const single = polls.make('Q', ['a', 'b', 'c'], {});
  assert.deepStrictEqual(polls.toggle(single, [], 1), [1]);
  assert.deepStrictEqual(polls.toggle(single, [1], 2), [2]);
  assert.deepStrictEqual(polls.toggle(single, [2], 2), []);
});

step('toggle adds and removes options for a multiple-choice poll', () => {
  const multi = polls.make('Q', ['a', 'b', 'c'], { multiple: true });
  assert.deepStrictEqual(polls.toggle(multi, [], 2), [2]);
  assert.deepStrictEqual(polls.toggle(multi, [2], 0), [0, 2]);
  assert.deepStrictEqual(polls.toggle(multi, [0, 2], 0), [2]);
});

step('tally counts voters, shares and the winner', () => {
  const p = polls.make('Q', ['a', 'b', 'c'], {});
  const t = polls.tally(p, { anna: [0], bob: [0], cid: [1] });
  assert.strictEqual(t.voters, 3);
  assert.deepStrictEqual(t.rows.map((r) => r.count), [2, 1, 0]);
  assert.strictEqual(t.rows[0].share, 2 / 3);
  assert.strictEqual(t.winner, 0);
});

step('tally reports no winner on a tie or with no votes', () => {
  const p = polls.make('Q', ['a', 'b'], {});
  assert.strictEqual(polls.tally(p, { anna: [0], bob: [1] }).winner, null);
  assert.strictEqual(polls.tally(p, {}).winner, null);
  assert.strictEqual(polls.tally(p, {}).voters, 0);
});

step('tally ignores out-of-range and empty selections', () => {
  const p = polls.make('Q', ['a', 'b'], {});
  const t = polls.tally(p, { anna: [9], bob: [] });
  assert.strictEqual(t.voters, 0);
  assert.deepStrictEqual(t.rows.map((r) => r.count), [0, 0]);
});

step('a multiple-choice vote counts a voter once across options', () => {
  const p = polls.make('Q', ['a', 'b'], { multiple: true });
  const t = polls.tally(p, { anna: [0, 1] });
  assert.strictEqual(t.voters, 1);
  assert.deepStrictEqual(t.rows.map((r) => r.count), [1, 1]);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} poll checks passed`);
process.exit(failed === 0 ? 0 : 1);
