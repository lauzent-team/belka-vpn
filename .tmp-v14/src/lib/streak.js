'use strict';

/**
 * Shared streak rules for the "огонёк" — the flame for days in a row.
 *
 * There are two kinds of streak, and both use these rules:
 *
 *   - the account streak, days in a row the account sent anything;
 *   - the dialog streak, days in a row *this pair of people* wrote to each
 *     other, which is what the flame inside a chat means.
 *
 * The rules are pure so the relay (node) and the renderer (browser) agree
 * exactly, and so they can be tested without either.
 *
 * A day is a UTC calendar day. `count` is how many consecutive days ending on
 * `day` were active. A streak that missed a whole day reads as 0, so it visibly
 * breaks the way it should.
 */

(function (root) {
  const DAY_MS = 86400000;

  /** The UTC calendar day of a timestamp, as "YYYY-MM-DD". */
  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  /**
   * What a stored `{ day, count }` row looks like from today's point of view:
   * `{ count, active }`. `active` means today is already counted. A row from
   * before yesterday has lapsed to zero.
   */
  function view(row, now) {
    const ts = now === undefined ? Date.now() : now;
    if (!row || !row.count) return { count: 0, active: false };
    const today = dayKey(ts);
    if (row.day === today) return { count: row.count, active: true };
    if (row.day === dayKey(ts - DAY_MS)) return { count: row.count, active: false };
    return { count: 0, active: false };
  }

  /**
   * The row after an activity on `ts`: same day keeps the count, the day after
   * the last active day extends it, anything older restarts at one.
   */
  function bump(row, ts) {
    const day = dayKey(ts);
    if (row && row.day === day) return { day, count: row.count };
    const yesterday = dayKey(ts - DAY_MS);
    const count = row && row.day === yesterday ? row.count + 1 : 1;
    return { day, count };
  }

  /** True when the pair has written on consecutive days, including today. */
  function isMutual(row, now) {
    const v = view(row, now);
    return v.count > 1 && v.active;
  }

  const api = { DAY_MS, dayKey, view, bump, isMutual };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyStreak = api;
})(typeof window !== 'undefined' ? window : null);
