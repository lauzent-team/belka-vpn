'use strict';

/**
 * Unit checks for shared/streak.js — the rules behind every "огонёк".
 *
 * Run with: node test/streak.js
 */

const assert = require('assert');
const S = require('../src/lib/streak');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

// A fixed "now" so the day maths never depends on when the test runs.
const NOW = Date.parse('2026-03-10T12:00:00Z');
const today = '2026-03-10';
const yesterday = '2026-03-09';

console.log('streak');

step('dayKey is the UTC calendar day', () => {
  assert.strictEqual(S.dayKey(Date.parse('2026-03-10T23:59:59Z')), today);
  assert.strictEqual(S.dayKey(Date.parse('2026-03-11T00:00:00Z')), '2026-03-11');
});

step('a missing row reads as no streak', () => {
  assert.deepStrictEqual(S.view(null, NOW), { count: 0, active: false });
});

step('today already counted reads active', () => {
  assert.deepStrictEqual(S.view({ day: today, count: 4 }, NOW), { count: 4, active: true });
});

step('yesterday keeps the count but is not active', () => {
  assert.deepStrictEqual(S.view({ day: yesterday, count: 4 }, NOW), { count: 4, active: false });
});

step('a streak that missed a day reads zero', () => {
  assert.deepStrictEqual(S.view({ day: '2026-03-08', count: 9 }, NOW), { count: 0, active: false });
});

step('sending twice the same day keeps the count', () => {
  assert.deepStrictEqual(S.bump({ day: today, count: 3 }, NOW), { day: today, count: 3 });
});

step('sending the day after extends the streak', () => {
  assert.deepStrictEqual(S.bump({ day: yesterday, count: 3 }, NOW), { day: today, count: 4 });
});

step('sending after a gap restarts at one', () => {
  assert.deepStrictEqual(S.bump({ day: '2026-03-01', count: 30 }, NOW), { day: today, count: 1 });
});

step('a first ever message starts at one', () => {
  assert.deepStrictEqual(S.bump(null, NOW), { day: today, count: 1 });
});

step('a mutual streak needs both days and today', () => {
  assert.strictEqual(S.isMutual({ day: today, count: 2 }, NOW), true);
  assert.strictEqual(S.isMutual({ day: today, count: 1 }, NOW), false);
  assert.strictEqual(S.isMutual({ day: yesterday, count: 5 }, NOW), false);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} streak checks passed`);
process.exit(failed === 0 ? 0 : 1);
