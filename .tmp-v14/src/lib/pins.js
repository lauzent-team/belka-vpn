'use strict';

/**
 * Pinned-message ordering and navigation. Pure logic, no DOM: the renderer
 * owns the banner and the list panel, this file decides what order the pins
 * come in and which one the arrows move to.
 *
 * Loaded both in the renderer (as window.SleePhyPins) and under plain node for
 * test/pins.js.
 */

(function (root) {
  /**
   * The pinned messages of a chat, newest first. A deleted message is never a
   * pin even if the flag survived, and a message with no timestamp sorts last
   * rather than jumping to the top.
   */
  function list(messages) {
    return (messages || [])
      .filter((m) => m && m.pinned && !m.deleted)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  /** Step through `count` items, wrapping at both ends. -1 when there are none. */
  function cycle(index, count, dir) {
    if (count <= 0) return -1;
    const step = dir < 0 ? -1 : 1;
    return ((index + step) % count + count) % count;
  }

  /** "2 из 5" for the banner counter, empty when there is nothing pinned. */
  function label(index, count) {
    if (count <= 0) return '';
    const i = Math.min(Math.max(index, 0), count - 1);
    return `${i + 1} из ${count}`;
  }

  /** True when the banner should show its up/down arrows at all. */
  function hasMultiple(count) {
    return count > 1;
  }

  const api = { list, cycle, label, hasMultiple };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyPins = api;
})(typeof window !== 'undefined' ? window : null);
