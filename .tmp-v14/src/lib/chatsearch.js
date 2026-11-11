'use strict';

/**
 * Message search inside one chat. Pure logic, no DOM: the renderer owns the
 * bar and the chips, this file decides which messages match.
 *
 * A message can carry text, an attachment, or a payload (poll, gift, game).
 * The payload checks live in other libraries, so the caller passes in a small
 * `extra` tag per message ('poll' | 'gift' | 'game' | null) instead of this
 * module reaching for them.
 *
 * Loaded both in the renderer (as window.SleePhyChatSearch) and under plain
 * node for test/chatsearch.js.
 */

(function (root) {
  /** Categories shown as chips. `media` and `link` are the broad ones. */
  const KINDS = ['any', 'media', 'photo', 'voice', 'file', 'link', 'poll', 'gift', 'game'];

  const MEDIA_KINDS = ['photo', 'voice', 'video', 'file'];

  const KIND_LABELS = {
    any: 'Все',
    media: 'Медиа',
    photo: 'Фото',
    voice: 'Голосовые',
    file: 'Файлы',
    link: 'Ссылки',
    poll: 'Опросы',
    gift: 'Подарки',
    game: 'Игры'
  };

  const DAY = 24 * 60 * 60 * 1000;

  /** A URL somewhere in the text, plain http(s) or a bare www. host. */
  function linkIn(text) {
    if (typeof text !== 'string' || !text) return false;
    return /(https?:\/\/|www\.)\S+/i.test(text);
  }

  /**
   * The single category a message belongs to for the chips. A poll/gift/game
   * wins over its carrier text; otherwise the attachment kind, then a link,
   * then plain text.
   */
  function classify(m, extra) {
    if (!m || m.deleted) return 'deleted';
    if (extra === 'poll' || extra === 'gift' || extra === 'game') return extra;
    if (m.kind === 'image') return 'photo';
    if (m.kind === 'voice') return 'voice';
    if (m.kind === 'video') return 'video';
    if (m.kind && m.attachment) return 'file';
    if (linkIn(m.text)) return 'link';
    return 'text';
  }

  /** Everything the free-text box looks at: the body and the file name. */
  function haystack(m) {
    const text = m && typeof m.text === 'string' ? m.text : '';
    const name = m && m.attachment && m.attachment.name ? m.attachment.name : '';
    return (text + '\n' + name).toLowerCase();
  }

  /** Cut-off timestamp for a date filter, or null when the range is open. */
  function dateCutoff(date, now) {
    if (!date || date === 'any') return null;
    const t = typeof now === 'number' ? now : Date.now();
    if (date === 'today') {
      const start = new Date(t);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    if (date === 'week') return t - 7 * DAY;
    if (date === 'month') return t - 30 * DAY;
    return null;
  }

  function normalize(filter) {
    const f = filter || {};
    return {
      query: typeof f.query === 'string' ? f.query.trim().toLowerCase() : '',
      from: f.from === 'me' || f.from === 'them' ? f.from : 'any',
      kind: KINDS.includes(f.kind) ? f.kind : 'any',
      date: f.date || 'any',
      now: f.now
    };
  }

  /** True when one message passes every part of the filter. */
  function matches(m, filter, extra) {
    if (!m || m.deleted) return false;
    const f = normalize(filter);

    if (f.from === 'me' && !m.mine) return false;
    if (f.from === 'them' && m.mine) return false;

    const cutoff = dateCutoff(f.date, f.now);
    if (cutoff !== null && (m.ts || 0) < cutoff) return false;

    if (f.query && !haystack(m).includes(f.query)) return false;

    if (f.kind !== 'any') {
      const kind = classify(m, extra);
      if (f.kind === 'media') {
        if (!MEDIA_KINDS.includes(kind)) return false;
      } else if (f.kind === 'link') {
        if (!linkIn(m.text)) return false;
      } else if (kind !== f.kind) {
        return false;
      }
    }
    return true;
  }

  /**
   * The messages that match, newest first. `extrasOf(m)` returns the payload
   * tag for a message, or undefined.
   */
  function search(messages, filter, extrasOf) {
    const tag = typeof extrasOf === 'function' ? extrasOf : () => null;
    const out = [];
    for (const m of messages || []) {
      if (matches(m, filter, tag(m))) out.push(m);
    }
    return out;
  }

  /** How many messages fall in each chip category, for the chip labels. */
  function counts(messages, extrasOf) {
    const out = {};
    for (const kind of KINDS) {
      // Derived from `matches` so a chip label can never disagree with the
      // list the chip produces.
      out[kind] = search(messages, { kind }, extrasOf).length;
    }
    return out;
  }

  const api = { KINDS, KIND_LABELS, MEDIA_KINDS, linkIn, classify, matches, search, counts, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyChatSearch = api;
})(typeof window !== 'undefined' ? window : null);
