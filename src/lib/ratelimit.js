'use strict';

/**
 * Rate limiting for the relay.
 *
 * The relay had none, which the README listed as the reason it could not face
 * the public internet: nothing stopped a loop of password guesses, a flood of
 * messages, or a script draining the SMS balance. This module is the missing
 * piece. It is pure logic — no sockets, no database — so the relay and the
 * tests share one implementation and it can be exercised without a network.
 *
 * The model is a sliding window per key: at most `max` events may fall inside
 * any `windowMs` stretch. A sliding window is chosen over a fixed one because a
 * fixed window lets an attacker send `max` at the end of one window and `max`
 * at the start of the next, doubling the burst at the boundary.
 *
 * Keys are attacker-influenced (a username, a phone number, an IP), so the
 * store is bounded two ways: a key holds at most `max` timestamps, and the map
 * holds at most `maxKeys` keys, evicting the least recently used. Without the
 * second bound, a loop that guesses random usernames would grow the map without
 * limit and turn the defence into the attack.
 */

(function (root) {
  const DEFAULT_MAX_KEYS = 20000;

  /**
   * A store of sliding windows, one per key.
   *
   * `now` is injectable so tests can advance the clock instead of sleeping.
   */
  function createLimiter({ windowMs, max, maxKeys = DEFAULT_MAX_KEYS, now = Date.now } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');
    if (!Number.isFinite(max) || max <= 0) throw new Error('max must be positive');

    // Insertion order doubles as recency order: a Map iterates oldest-first, so
    // the first key is the least recently used. Every hit re-inserts the key to
    // move it to the end.
    const hits = new Map();

    /** Drop timestamps that have fallen out of the window, in place. */
    function trim(arr, cutoff) {
      let i = 0;
      while (i < arr.length && arr[i] <= cutoff) i++;
      if (i) arr.splice(0, i);
      return arr;
    }

    function evictIfNeeded() {
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        hits.delete(oldest);
      }
    }

    /**
     * Record one event for `key`. Returns `{ ok: true, remaining }` when it is
     * allowed, or `{ ok: false, retryAfterMs }` when the window is full. A
     * refused event is not recorded, so a client that backs off recovers as
     * soon as the oldest event ages out rather than extending its own penalty.
     */
    function take(key) {
      const t = now();
      const cutoff = t - windowMs;
      let arr = hits.get(key);
      if (!arr) {
        arr = [];
        hits.set(key, arr);
      } else {
        // Re-insert to mark this key as most recently used.
        hits.delete(key);
        hits.set(key, arr);
        trim(arr, cutoff);
      }

      if (arr.length >= max) {
        return { ok: false, retryAfterMs: Math.max(1, arr[0] + windowMs - t) };
      }
      arr.push(t);
      evictIfNeeded();
      return { ok: true, remaining: max - arr.length };
    }

    /** Whether `key` would be allowed right now, without recording an event. */
    function peek(key) {
      const arr = hits.get(key);
      if (!arr) return { ok: true, remaining: max };
      const cutoff = now() - windowMs;
      const live = trim(arr.slice(), cutoff);
      if (live.length >= max) {
        return { ok: false, retryAfterMs: Math.max(1, live[0] + windowMs - now()) };
      }
      return { ok: true, remaining: max - live.length };
    }

    /** Forget every key whose newest event has aged out. */
    function sweep() {
      const cutoff = now() - windowMs;
      for (const [key, arr] of hits) {
        if (!arr.length || arr[arr.length - 1] <= cutoff) hits.delete(key);
      }
    }

    function reset() {
      hits.clear();
    }

    return { take, peek, sweep, reset, size: () => hits.size, windowMs, max };
  }

  /**
   * A named set of limiters. The relay asks for one by name, so a new protected
   * action is a line in the table rather than a new object to thread around.
   *
   * `now` is passed through to every limiter so a test can control time.
   */
  function createRegistry(policies, { now = Date.now, maxKeys } = {}) {
    const limiters = new Map();
    for (const [name, policy] of Object.entries(policies)) {
      limiters.set(name, createLimiter({ ...policy, now, ...(maxKeys ? { maxKeys } : {}) }));
    }

    function get(name) {
      const limiter = limiters.get(name);
      if (!limiter) throw new Error(`unknown rate limit: ${name}`);
      return limiter;
    }

    return {
      /** Take one event from the named bucket. */
      take(name, key) {
        return get(name).take(String(key));
      },
      peek(name, key) {
        return get(name).peek(String(key));
      },
      sweep() {
        for (const limiter of limiters.values()) limiter.sweep();
      },
      reset() {
        for (const limiter of limiters.values()) limiter.reset();
      },
      names: () => [...limiters.keys()]
    };
  }

  const api = { createLimiter, createRegistry, DEFAULT_MAX_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SleePhyRateLimit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
