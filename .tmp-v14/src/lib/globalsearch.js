'use strict';

/**
 * Search across every conversation at once. Pure logic, no DOM, no relay: the
 * caller hands in the already-decrypted transcripts and this file decides what
 * matches and in what order.
 *
 * The per-message filter is the one in-chat search already uses
 * (`src/lib/chatsearch.js`), so a query means the same thing whether it is
 * typed in the chat bar or in the top box. This module only adds the "which
 * chat did it come from" layer and the flat, newest-first ordering.
 *
 * Loaded both in the renderer (as window.SleePhyGlobalSearch) and under plain
 * node for test/globalsearch.js.
 */

(function (root) {
  const chatsearch = (typeof module !== 'undefined' && module.exports)
    ? require('./chatsearch')
    : (root && root.SleePhyChatSearch);

  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;

  /**
   * Flatten conversations into a newest-first list of hits.
   *
   * `conversations` is `[{ key, title, messages }]`; a conversation with no
   * messages or a missing key is skipped rather than throwing, so a half-loaded
   * chat cannot break the whole search.
   *
   * `extrasOf(message)` returns the payload tag ('poll' | 'gift' | 'game') for
   * a message, exactly as in-chat search expects.
   */
  function searchAcross(conversations, filter, opts) {
    const options = opts || {};
    const limit = clampLimit(options.limit);
    const extrasOf = typeof options.extrasOf === 'function' ? options.extrasOf : () => null;
    const hits = [];
    for (const convo of conversations || []) {
      if (!convo || typeof convo.key !== 'string' || !Array.isArray(convo.messages)) continue;
      for (const message of convo.messages) {
        if (!chatsearch.matches(message, filter, extrasOf(message))) continue;
        hits.push({ chatKey: convo.key, title: convo.title || convo.key, message });
      }
    }
    hits.sort((a, b) => (b.message.ts || 0) - (a.message.ts || 0));
    return hits.slice(0, limit);
  }

  /** Regroup flat hits by chat, keeping the newest-first order within each. */
  function groupByChat(hits) {
    const order = [];
    const byKey = new Map();
    for (const hit of hits || []) {
      let group = byKey.get(hit.chatKey);
      if (!group) {
        group = { key: hit.chatKey, title: hit.title, items: [] };
        byKey.set(hit.chatKey, group);
        order.push(group);
      }
      group.items.push(hit.message);
    }
    return order;
  }

  /** True when the filter asks for nothing, so the caller can skip the work. */
  function isEmptyFilter(filter) {
    const f = chatsearch.normalize(filter);
    return !f.query && f.from === 'any' && f.kind === 'any' && f.date === 'any';
  }

  function clampLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.floor(n), MAX_LIMIT);
  }

  const api = { DEFAULT_LIMIT, MAX_LIMIT, searchAcross, groupByChat, isEmptyFilter, clampLimit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyGlobalSearch = api;
})(typeof window !== 'undefined' ? window : null);
