'use strict';
/**
 * The rate limiter is pure logic, so it is tested without a socket or a clock:
 * `now` is a counter the test advances by hand.
 */
const assert = require('assert');
const { createLimiter, createRegistry } = require('../src/lib/ratelimit');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { console.error('  FAIL', name, '->', e.message); process.exitCode = 1; }
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

console.log('rate limiter');

check('allows up to the limit, then refuses', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 3, now: clock.now });
  assert.strictEqual(lim.take('a').ok, true);
  assert.strictEqual(lim.take('a').ok, true);
  assert.strictEqual(lim.take('a').ok, true);
  const refused = lim.take('a');
  assert.strictEqual(refused.ok, false);
  assert.ok(refused.retryAfterMs > 0, 'a refusal says when to try again');
});

check('remaining counts down', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 3, now: clock.now });
  assert.strictEqual(lim.take('a').remaining, 2);
  assert.strictEqual(lim.take('a').remaining, 1);
  assert.strictEqual(lim.take('a').remaining, 0);
});

check('separate keys do not share a budget', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 1, now: clock.now });
  assert.strictEqual(lim.take('a').ok, true);
  assert.strictEqual(lim.take('b').ok, true, 'a fresh key has its own window');
  assert.strictEqual(lim.take('a').ok, false);
});

check('an event ages out of the window', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 2, now: clock.now });
  lim.take('a'); lim.take('a');
  assert.strictEqual(lim.take('a').ok, false);
  clock.advance(1001);
  assert.strictEqual(lim.take('a').ok, true, 'the window slid past the first two');
});

check('a refusal does not extend the penalty', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 1, now: clock.now });
  lim.take('a');
  for (let i = 0; i < 50; i++) lim.take('a'); // hammering must not push the reset out
  clock.advance(1001);
  assert.strictEqual(lim.take('a').ok, true, 'recovers one window after the allowed hit');
});

check('the sliding window closes the boundary double-burst', () => {
  // A fixed window would allow max at t=999 and max again at t=1001. Sliding
  // must refuse the second burst because the first is still inside the window.
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 5, now: clock.now });
  for (let i = 0; i < 5; i++) assert.strictEqual(lim.take('a').ok, true);
  clock.advance(999);
  assert.strictEqual(lim.take('a').ok, false, 'still inside the first window');
  clock.advance(2); // t = 1001, the first hit has aged out
  assert.strictEqual(lim.take('a').ok, true);
});

check('peek does not spend the budget', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 1, now: clock.now });
  assert.strictEqual(lim.peek('a').ok, true);
  assert.strictEqual(lim.peek('a').ok, true, 'peek is free');
  assert.strictEqual(lim.take('a').ok, true, 'the one allowed hit is still there');
});

check('the key map is bounded and evicts the least recently used', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 2, maxKeys: 3, now: clock.now });
  lim.take('a'); lim.take('b'); lim.take('c');
  lim.take('a'); // 'a' is now the most recent (and at its limit of 2)
  lim.take('d'); // forces an eviction
  assert.strictEqual(lim.size(), 3, 'never grows past maxKeys');
  assert.strictEqual(lim.peek('b').remaining, 2, 'the evicted key starts clean');
  assert.strictEqual(lim.peek('a').remaining, 0, 'the recently used key kept its hits');
});

check('sweep forgets only keys that aged out', () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, max: 5, now: clock.now });
  lim.take('old');
  clock.advance(500);
  lim.take('fresh');
  clock.advance(600); // 'old' is now outside the window, 'fresh' is not
  lim.sweep();
  assert.strictEqual(lim.size(), 1, 'only the live key survives');
  assert.strictEqual(lim.peek('fresh').remaining, 4);
});

check('a registry exposes named buckets independently', () => {
  const clock = fakeClock();
  const reg = createRegistry({
    login: { windowMs: 1000, max: 2 },
    send: { windowMs: 1000, max: 1 }
  }, { now: clock.now });
  assert.strictEqual(reg.take('login', 'a').ok, true);
  assert.strictEqual(reg.take('login', 'a').ok, true);
  assert.strictEqual(reg.take('login', 'a').ok, false);
  assert.strictEqual(reg.take('send', 'a').ok, true, 'send has its own budget');
  assert.deepStrictEqual(reg.names().sort(), ['login', 'send']);
});

check('an unknown bucket name is a programming error, not a silent allow', () => {
  const reg = createRegistry({ login: { windowMs: 1000, max: 1 } });
  assert.throws(() => reg.take('nope', 'a'), /unknown rate limit/);
});

check('rejects nonsense configuration', () => {
  assert.throws(() => createLimiter({ windowMs: 0, max: 1 }), /windowMs/);
  assert.throws(() => createLimiter({ windowMs: 1000, max: 0 }), /max/);
});

console.log(`\n${passed} rate limiter checks passed`);
