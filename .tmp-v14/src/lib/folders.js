'use strict';

/**
 * SleePhy chat folders ("папки"): named filters over the chat list, like the
 * Telegram folders that sit above the conversation list.
 *
 * A folder is a small plain object, so it can live in this account's settings
 * and travel to another device:
 *
 *   { id, name, kinds: { private, groups, channels, bots, saved },
 *     unreadOnly: false, include: [], exclude: [] }
 *
 * `kinds` decides which chat types show up, `include` force-adds a chat and
 * `exclude` force-removes one, and `unreadOnly` narrows the folder to chats
 * with something unread. Pure logic only — no DOM, no network. Tests live in
 * test/folders.js.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SleePhyFolders = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const KINDS = ['private', 'groups', 'channels', 'bots', 'saved'];
  const MAX_FOLDERS = 20;
  const MAX_NAME = 40;

  /** The always-present first tab. Not stored; rebuilt on every load. */
  function allFolder() {
    return { id: 'all', name: 'Все чаты', kinds: { private: true, groups: true, channels: true, bots: true, saved: true }, unreadOnly: false, include: [], exclude: [], system: true };
  }

  /** The chat type behind a chat key, given whether it names a bot. */
  function kindOf(key, isBot) {
    if (key === 'saved') return 'saved';
    if (isBot) return 'bots';
    if (typeof key === 'string' && key.startsWith('group:')) return 'groups';
    if (typeof key === 'string' && key.startsWith('channel:')) return 'channels';
    return 'private';
  }

  /** Coerce arbitrary stored data into a usable folder, or null if hopeless. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_NAME);
    if (!name) return null;
    const kinds = {};
    for (const k of KINDS) kinds[k] = !!(raw.kinds && raw.kinds[k]);
    if (!KINDS.some((k) => kinds[k])) kinds.private = true;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : 'f' + Math.random().toString(36).slice(2, 8),
      name,
      kinds,
      unreadOnly: !!raw.unreadOnly,
      exclusive: !!raw.exclusive,
      include: Array.isArray(raw.include) ? raw.include.filter((k) => typeof k === 'string').slice(0, 200) : [],
      exclude: Array.isArray(raw.exclude) ? raw.exclude.filter((k) => typeof k === 'string').slice(0, 200) : []
    };
  }

  /** Normalise a stored folder list, dropping anything unusable and de-duping ids. */
  function normalizeAll(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set(['all']);
    for (const item of list) {
      const folder = normalize(item);
      if (!folder || seen.has(folder.id)) continue;
      seen.add(folder.id);
      out.push(folder);
      if (out.length >= MAX_FOLDERS) break;
    }
    return out;
  }

  /**
   * Does a chat belong in a folder? `desc` is { key, kind, unread }.
   * An explicit exclude always wins; otherwise an explicit include adds the
   * chat even when its kind is not listed.
   */
  function matches(folder, desc) {
    if (!folder || !desc) return false;
    if (folder.exclude && folder.exclude.includes(desc.key)) return false;
    if (folder.include && folder.include.includes(desc.key)) return true;
    if (folder.unreadOnly && !(desc.unread > 0)) return false;
    return !!(folder.kinds && folder.kinds[desc.kind]);
  }

  /** The chats of one folder, in the order they were given. */
  function filter(folder, descs) {
    return (descs || []).filter((d) => matches(folder, d));
  }

  /**
   * Chats hidden from the main "all" list because an exclusive folder owns
   * them. Used so a chat moved into a folder does not also stay in "all".
   */
  function exclusiveKeys(folders, descs) {
    const hidden = new Set();
    for (const folder of folders || []) {
      if (!folder || !folder.exclusive) continue;
      for (const d of descs || []) if (matches(folder, d)) hidden.add(d.key);
    }
    return hidden;
  }

  /** Total unread inside a folder, for the tab badge. */
  function unreadIn(folder, descs) {
    return (descs || []).reduce((n, d) => (matches(folder, d) ? n + (d.unread || 0) : n), 0);
  }

  return {
    KINDS, MAX_FOLDERS, MAX_NAME,
    allFolder, kindOf, normalize, normalizeAll, matches, filter, unreadIn, exclusiveKeys
  };
});
