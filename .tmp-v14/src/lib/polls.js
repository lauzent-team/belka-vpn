'use strict';

/**
 * SleePhy polls: the data shape for a poll and its votes, plus the pure logic
 * for building, validating and tallying one.
 *
 * Pure logic only — no DOM, no network, no crypto. A poll travels as an
 * ordinary end-to-end encrypted message and a vote as another, so the relay
 * sees only ciphertext and never learns the question, the options, or who
 * voted for what. Tests live in test/polls.js.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SleePhyPolls = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const MAX_QUESTION = 200;
  const MAX_OPTION = 100;
  const MAX_OPTIONS = 10;
  const MIN_OPTIONS = 2;

  const trim = (value) => String(value == null ? '' : value).trim();

  /**
   * Build a poll from raw composer input. Trims, drops blank options, caps the
   * lengths and clamps the flags, so a caller can hand over whatever the form
   * held without pre-validating.
   */
  function make(question, options, settings) {
    const s = settings || {};
    return {
      q: trim(question).slice(0, MAX_QUESTION),
      o: (Array.isArray(options) ? options : [])
        .map((o) => trim(o).slice(0, MAX_OPTION))
        .filter(Boolean)
        .slice(0, MAX_OPTIONS),
      m: !!s.multiple,
      anon: s.anon !== false,
      closed: false
    };
  }

  /** A poll is sendable when it has a question and at least two options. */
  function validate(poll) {
    if (!poll) return { ok: false, error: 'Пустой опрос' };
    if (!trim(poll.q)) return { ok: false, error: 'Введите вопрос' };
    const n = Array.isArray(poll.o) ? poll.o.length : 0;
    if (n < MIN_OPTIONS) return { ok: false, error: `Нужно минимум ${MIN_OPTIONS} варианта` };
    if (n > MAX_OPTIONS) return { ok: false, error: `Не больше ${MAX_OPTIONS} вариантов` };
    return { ok: true, error: null };
  }

  /** The (encrypted) text of a poll message. */
  function encode(poll) {
    return JSON.stringify({ poll });
  }

  /** The poll carried by a message, or null for ordinary text. */
  function decode(text) {
    if (!text || text[0] !== '{') return null;
    let obj;
    try { obj = JSON.parse(text); } catch { return null; }
    const p = obj && obj.poll;
    if (!p || typeof p.q !== 'string' || !Array.isArray(p.o)) return null;
    return {
      q: p.q,
      o: p.o.map((o) => String(o)),
      m: !!p.m,
      anon: p.anon !== false,
      closed: !!p.closed
    };
  }

  /** The (encrypted) text of a vote message: which options the sender picked. */
  function encodeVote(pollId, indices) {
    return JSON.stringify({ pv: pollId, i: indices });
  }

  /** The vote carried by a message, or null. `i` is always a sorted, unique list. */
  function decodeVote(text) {
    if (!text || text[0] !== '{') return null;
    let obj;
    try { obj = JSON.parse(text); } catch { return null; }
    if (!obj || !Number.isInteger(obj.pv) || !Array.isArray(obj.i)) return null;
    const i = [...new Set(obj.i.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
    return { pv: obj.pv, i };
  }

  /**
   * The next selection after tapping option `index`. A single-choice poll keeps
   * at most one selection and clears it when the same option is tapped again;
   * a multiple-choice poll adds or removes the option.
   */
  function toggle(poll, current, index) {
    const sel = Array.isArray(current) ? current.slice() : [];
    const at = sel.indexOf(index);
    if (poll && poll.m) {
      if (at >= 0) sel.splice(at, 1); else sel.push(index);
    } else {
      sel.length = 0;
      if (at < 0) sel.push(index);
    }
    return sel.sort((a, b) => a - b);
  }

  /**
   * Tally a poll. `votes` maps a voter name to the option indices they picked.
   * Returns one row per option (count and share), plus the voter count and the
   * winning row (or null on a tie / no votes).
   */
  function tally(poll, votes) {
    const options = (poll && poll.o) || [];
    const counts = options.map(() => 0);
    const map = votes || {};
    let voters = 0;
    for (const name of Object.keys(map)) {
      const picked = Array.isArray(map[name]) ? map[name] : [];
      let counted = false;
      for (const i of picked) {
        if (i >= 0 && i < counts.length) { counts[i] += 1; counted = true; }
      }
      if (counted) voters += 1;
    }
    const rows = options.map((text, i) => ({
      text,
      count: counts[i],
      share: voters ? counts[i] / voters : 0
    }));
    let best = -1;
    let tie = false;
    rows.forEach((r, i) => {
      if (r.count > best) { best = r.count; tie = false; }
      else if (r.count === best && r.count > 0) tie = true;
    });
    const winner = best > 0 && !tie ? rows.findIndex((r) => r.count === best) : null;
    return { rows, voters, winner };
  }

  return {
    MAX_QUESTION, MAX_OPTION, MAX_OPTIONS, MIN_OPTIONS,
    make, validate, encode, decode, encodeVote, decodeVote, toggle, tally
  };
});
