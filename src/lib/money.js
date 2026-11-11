'use strict';

/**
 * Money arithmetic for Rockets and Premium. Pure logic, no DOM and no network:
 * the relay, the renderer and the test suite all share it, so a price is
 * computed the same way on both sides. Loaded in the renderer as
 * window.SleePhyMoney and under plain node for test/premium-logic.js.
 *
 * Everything is in kopecks, as an integer. Rubles only appear at the edge, when
 * a price is shown or a provider expects a decimal string — floating point
 * never touches a balance.
 */

(function (root) {
  const KOPECKS = 100;
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  /** Kopecks to a plain ruble number for display: 19900 -> 199, 8900 -> 89. */
  function rubles(kopecks) {
    return Math.round(Number(kopecks) || 0) / KOPECKS;
  }

  /** Kopecks to the decimal string a payment provider expects: 19900 -> "199.00". */
  function amountString(kopecks) {
    return (Math.round(Number(kopecks) || 0) / KOPECKS).toFixed(2);
  }

  /** A provider's decimal amount back to integer kopecks, or null if unusable. */
  function toKopecks(amount) {
    const n = Number(String(amount).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * KOPECKS);
  }

  /** What a bundle of Rockets costs, in kopecks, at a per-rocket unit price. */
  function bundlePrice(unitKopecks, rockets) {
    const n = Math.trunc(Number(rockets));
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * Math.trunc(Number(unitKopecks));
  }

  /** Every bundle with its price, ready for the shelf. */
  function priceBundles(unitKopecks, bundles) {
    return (bundles || []).map((rockets) => ({
      rockets,
      priceKopecks: bundlePrice(unitKopecks, rockets),
      priceRub: rubles(bundlePrice(unitKopecks, rockets))
    }));
  }

  /** Only a bundle from the list may be bought; anything else is refused. */
  function isKnownBundle(bundles, rockets) {
    return (bundles || []).includes(Math.trunc(Number(rockets)));
  }

  /**
   * The new expiry when a month is added. The clock starts from the later of
   * "now" and the current expiry, so buying while still subscribed extends the
   * subscription instead of discarding what is left.
   */
  function extendPremium(currentUntil, now, months = 1, monthMs = MONTH_MS) {
    const base = Math.max(Number(currentUntil) || 0, Number(now) || 0);
    return base + Math.trunc(months) * monthMs;
  }

  /** Whether a subscription is still running. */
  function premiumActive(currentUntil, now) {
    return (Number(currentUntil) || 0) > (Number(now) || 0);
  }

  /** Whole days left, rounded up, or 0 when there is none. */
  function daysLeft(currentUntil, now) {
    const left = (Number(currentUntil) || 0) - (Number(now) || 0);
    return left > 0 ? Math.ceil(left / (24 * 60 * 60 * 1000)) : 0;
  }

  /** Russian plural for Rockets: 1 ракета, 2 ракеты, 5 ракет. */
  function rocketWord(count) {
    const n = Math.abs(Math.trunc(Number(count) || 0));
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'ракета';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ракеты';
    return 'ракет';
  }

  const api = {
    KOPECKS, MONTH_MS,
    rubles, amountString, toKopecks,
    bundlePrice, priceBundles, isKnownBundle,
    extendPremium, premiumActive, daysLeft, rocketWord
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyMoney = api;
})(typeof window !== 'undefined' ? window : null);
