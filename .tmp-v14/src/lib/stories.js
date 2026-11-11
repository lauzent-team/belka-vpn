'use strict';

/**
 * SleePhy stories: 24-hour posts that a person shares with their contacts.
 *
 * Pure logic only — no DOM, no network, no crypto. A story body travels as an
 * ordinary end-to-end encrypted envelope (one copy per viewer, exactly like a
 * group message), so the relay stores ciphertext and a list of who may open it,
 * and never learns the caption, the picture or who watched what.
 *
 * Tests live in test/stories.js.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SleePhyStories = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const MAX_CAPTION = 300;
  const MAX_BG = 40;
  const HOUR_MS = 3600000;
  const DEFAULT_TTL_MS = 24 * HOUR_MS;
  const MIN_TTL_MS = HOUR_MS;
  const MAX_TTL_MS = 24 * HOUR_MS;
  const KINDS = ['text', 'image', 'voice'];

  const trim = (v) => String(v == null ? '' : v).trim();

  /**
   * Normalize a draft. Anything unusable is dropped rather than thrown, so a
   * caller can hand over whatever the composer held.
   */
  function make(draft) {
    const d = draft || {};
    const kind = KINDS.includes(d.kind) ? d.kind : 'text';
    const ttl = clampTtl(d.ttl);
    return {
      cap: trim(d.cap).slice(0, MAX_CAPTION),
      kind,
      bg: trim(d.bg).slice(0, MAX_BG) || 'mint',
      ttl
    };
  }

  /** A time-to-live inside the allowed window, in ms. */
  function clampTtl(ttl) {
    const n = Number(ttl);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
    return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(n)));
  }

  /** The encrypted body of a story: a tiny JSON document. */
  function encode(draft) {
    const s = make(draft);
    const out = { s: 1, cap: s.cap, kind: s.kind, bg: s.bg };
    if (s.kind === 'text') out.text = true;
    return JSON.stringify(out);
  }

  /** Decode a story body, or null when the text is not one. */
  function decode(text) {
    if (typeof text !== 'string' || text[0] !== '{') return null;
    let obj;
    try { obj = JSON.parse(text); } catch { return null; }
    if (!obj || obj.s !== 1) return null;
    return {
      cap: trim(obj.cap).slice(0, MAX_CAPTION),
      kind: KINDS.includes(obj.kind) ? obj.kind : 'text',
      bg: trim(obj.bg).slice(0, MAX_BG) || 'mint'
    };
  }

  /** When a story posted at `ts` stops being visible. */
  function expiresAt(ts, ttl) {
    return Number(ts) + clampTtl(ttl);
  }

  /** Whether a story has outlived its 24 hours. */
  function isExpired(story, now) {
    if (!story) return true;
    const end = story.expiresAt != null
      ? Number(story.expiresAt)
      : expiresAt(story.ts, story.ttl);
    return Number(now) >= end;
  }

  /** How long a story has left, floored at zero. */
  function remainingMs(story, now) {
    if (!story) return 0;
    const end = story.expiresAt != null
      ? Number(story.expiresAt)
      : expiresAt(story.ts, story.ttl);
    return Math.max(0, end - Number(now));
  }

  /** A short "5 ч" / "40 мин" label for the time left. */
  function remainingLabel(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n >= HOUR_MS) return `${Math.round(n / HOUR_MS)} ч`;
    if (n >= 60000) return `${Math.round(n / 60000)} мин`;
    return 'меньше минуты';
  }

  /** Drop the expired stories and sort the rest newest-first. */
  function filterActive(list, now) {
    return (Array.isArray(list) ? list : [])
      .filter((s) => s && !isExpired(s, now))
      .sort((a, b) => Number(b.ts) - Number(a.ts));
  }

  /**
   * Group the active stories by author, each author's stories oldest-first so
   * they play in the order they were posted.
   */
  function byAuthor(list, now) {
    const map = new Map();
    for (const s of filterActive(list, now)) {
      if (!map.has(s.author)) map.set(s.author, []);
      map.get(s.author).push(s);
    }
    for (const arr of map.values()) arr.sort((a, b) => Number(a.ts) - Number(b.ts));
    return map;
  }

  /**
   * The order authors appear in the bar: your own story first, then authors
   * with something unseen, then the rest, each group alphabetical by handle.
   */
  function orderAuthors(groups, opts) {
    const o = opts || {};
    const me = o.me || null;
    const unseen = o.unseen || (() => false);
    const names = Array.from(groups.keys());
    const rank = (name) => {
      if (name === me) return 0;
      const arr = groups.get(name) || [];
      return arr.some((s) => unseen(name, s)) ? 1 : 2;
    };
    return names.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a === me) return -1;
      if (b === me) return 1;
      return a.localeCompare(b);
    });
  }

  /** How many of an author's stories the viewer has not opened yet. */
  function unseenCount(stories, seenIds) {
    const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
    return (Array.isArray(stories) ? stories : []).filter((s) => !seen.has(s.id)).length;
  }

  /** The story to show after the current one, wrapping at the end. */
  function nextId(stories, currentId) {
    const list = Array.isArray(stories) ? stories : [];
    if (!list.length) return null;
    const i = list.findIndex((s) => s.id === currentId);
    if (i < 0) return list[0].id;
    return list[(i + 1) % list.length].id;
  }

  return {
    MAX_CAPTION, MAX_BG, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, KINDS,
    make, clampTtl, encode, decode, expiresAt, isExpired, remainingMs,
    remainingLabel, filterActive, byAuthor, orderAuthors, unseenCount, nextId
  };
});
