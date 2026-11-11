'use strict';

/**
 * Money arithmetic. The prices in the app are integers in kopecks, so the
 * rounding is the one thing worth pinning down: 0.89 ₽ must never drift into
 * 0.88 or 0.90 after a multiply, and a subscription bought early must extend
 * rather than replace.
 *
 * Run with: node test/premium-logic.js
 */

const assert = require('assert');
const MONEY = require('../src/lib/money');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

step('rubles converts kopecks without float drift', () => {
  assert.strictEqual(MONEY.rubles(19900), 199);
  assert.strictEqual(MONEY.rubles(89), 0.89);
  assert.strictEqual(MONEY.rubles(4450), 44.5);
  assert.strictEqual(MONEY.rubles(0), 0);
});

step('amountString is the two-decimal form a provider expects', () => {
  assert.strictEqual(MONEY.amountString(19900), '199.00');
  assert.strictEqual(MONEY.amountString(89), '0.89');
  assert.strictEqual(MONEY.amountString(4450), '44.50');
});

step('toKopecks parses a provider amount, comma or dot', () => {
  assert.strictEqual(MONEY.toKopecks('0.89'), 89);
  assert.strictEqual(MONEY.toKopecks('199.00'), 19900);
  assert.strictEqual(MONEY.toKopecks('44,50'), 4450);
  assert.strictEqual(MONEY.toKopecks('nonsense'), null);
  assert.strictEqual(MONEY.toKopecks('-1'), null);
});

step('bundlePrice is whole kopecks for every bundle', () => {
  // 0.89 ₽ a rocket, in kopecks, exactly as the price list states.
  for (const rockets of [50, 100, 250, 500, 1000, 2500]) {
    const price = MONEY.bundlePrice(89, rockets);
    assert.strictEqual(price, rockets * 89, `${rockets} rockets`);
    assert.strictEqual(Number.isInteger(price), true);
  }
  assert.strictEqual(MONEY.bundlePrice(89, 0), null);
  assert.strictEqual(MONEY.bundlePrice(89, -5), null);
});

step('priceBundles pairs each bundle with its ruble price', () => {
  const priced = MONEY.priceBundles(89, [50, 100]);
  assert.deepStrictEqual(priced, [
    { rockets: 50, priceKopecks: 4450, priceRub: 44.5 },
    { rockets: 100, priceKopecks: 8900, priceRub: 89 }
  ]);
});

step('isKnownBundle refuses anything not on the list', () => {
  const bundles = [50, 100, 250];
  assert.strictEqual(MONEY.isKnownBundle(bundles, 50), true);
  assert.strictEqual(MONEY.isKnownBundle(bundles, 250), true);
  // A client asking for 1 000 000 cheap rockets is exactly the attack here.
  assert.strictEqual(MONEY.isKnownBundle(bundles, 1000000), false);
  assert.strictEqual(MONEY.isKnownBundle(bundles, 0), false);
  assert.strictEqual(MONEY.isKnownBundle(bundles, -50), false);
});

step('extendPremium adds a month from now when none is running', () => {
  const now = 1_000_000;
  assert.strictEqual(MONEY.extendPremium(0, now, 1, MONEY.MONTH_MS), now + MONEY.MONTH_MS);
  assert.strictEqual(MONEY.extendPremium(null, now, 1, MONEY.MONTH_MS), now + MONEY.MONTH_MS);
});

step('extendPremium extends a running subscription instead of replacing it', () => {
  const now = 1_000_000;
  const running = now + 5 * MONEY.MONTH_MS;
  // Buying again while subscribed must add a month to the end, not reset it.
  assert.strictEqual(MONEY.extendPremium(running, now, 1, MONEY.MONTH_MS), running + MONEY.MONTH_MS);
});

step('extendPremium restarts from now when the old one has lapsed', () => {
  const now = 1_000_000;
  const lapsed = now - 10 * MONEY.MONTH_MS;
  assert.strictEqual(MONEY.extendPremium(lapsed, now, 1, MONEY.MONTH_MS), now + MONEY.MONTH_MS);
});

step('premiumActive and daysLeft track the clock', () => {
  const now = 1_000_000;
  assert.strictEqual(MONEY.premiumActive(now + 1000, now), true);
  assert.strictEqual(MONEY.premiumActive(now - 1000, now), false);
  assert.strictEqual(MONEY.premiumActive(0, now), false);
  assert.strictEqual(MONEY.daysLeft(now + 2 * 24 * 60 * 60 * 1000, now), 2);
  assert.strictEqual(MONEY.daysLeft(now - 1, now), 0);
});

step('rocketWord agrees with the number', () => {
  assert.strictEqual(MONEY.rocketWord(1), 'ракета');
  assert.strictEqual(MONEY.rocketWord(2), 'ракеты');
  assert.strictEqual(MONEY.rocketWord(4), 'ракеты');
  assert.strictEqual(MONEY.rocketWord(5), 'ракет');
  assert.strictEqual(MONEY.rocketWord(11), 'ракет');
  assert.strictEqual(MONEY.rocketWord(21), 'ракета');
  assert.strictEqual(MONEY.rocketWord(100), 'ракет');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
