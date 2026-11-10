'use strict';

/**
 * Unit checks for src/lib/pins.js — pinned-message ordering and navigation.
 *
 * Run with: node test/pins.js
 */

const assert = require('assert');
const P = require('../src/lib/pins');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const messages = [
  { id: 1, pinned: true, ts: 100 },
  { id: 2, pinned: false, ts: 200 },
  { id: 3, pinned: true, ts: 300 },
  { id: 4, pinned: true, ts: 50 },
  { id: 5, pinned: true, ts: 250, deleted: true },
  { id: 6, pinned: true }
];

console.log('pins');

step('only pinned, live messages are listed', () => {
  assert.deepStrictEqual(P.list(messages).map((m) => m.id), [3, 1, 4, 6]);
});

step('the list is newest first', () => {
  const ids = P.list(messages).map((m) => m.id);
  assert.deepStrictEqual(ids.slice(0, 3), [3, 1, 4]);
});

step('a message with no timestamp sorts last, not first', () => {
  assert.strictEqual(P.list(messages).at(-1).id, 6);
});

step('a deleted message is never a pin', () => {
  assert.ok(!P.list(messages).some((m) => m.id === 5));
});

step('cycle steps forward and wraps around the end', () => {
  assert.strictEqual(P.cycle(0, 3, 1), 1);
  assert.strictEqual(P.cycle(2, 3, 1), 0);
});

step('cycle steps back and wraps around the start', () => {
  assert.strictEqual(P.cycle(0, 3, -1), 2);
  assert.strictEqual(P.cycle(1, 3, -1), 0);
});

step('cycle from -1 forward lands on the first', () => {
  assert.strictEqual(P.cycle(-1, 3, 1), 0);
});

step('cycle with nothing to show is -1', () => {
  assert.strictEqual(P.cycle(0, 0, 1), -1);
  assert.strictEqual(P.cycle(3, 0, -1), -1);
});

step('the counter reads "i из n"', () => {
  assert.strictEqual(P.label(0, 5), '1 из 5');
  assert.strictEqual(P.label(4, 5), '5 из 5');
});

step('the counter clamps an out-of-range index', () => {
  assert.strictEqual(P.label(9, 5), '5 из 5');
  assert.strictEqual(P.label(-3, 5), '1 из 5');
});

step('an empty pin set has an empty counter', () => {
  assert.strictEqual(P.label(0, 0), '');
});

step('arrows only appear with more than one pin', () => {
  assert.strictEqual(P.hasMultiple(1), false);
  assert.strictEqual(P.hasMultiple(2), true);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} pin checks passed`);
process.exit(failed === 0 ? 0 : 1);
