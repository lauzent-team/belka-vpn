'use strict';

/**
 * Call helpers. Pure logic, no DOM and no relay: the renderer owns the WebRTC
 * objects and the UI, and asks this file the questions that are easy to get
 * subtly wrong (how long a call has run, which ringtone file to try, who is on
 * the call). Loaded in the renderer as window.SleePhyCalls and under plain node
 * for test/calls-logic.js.
 */

(function (root) {
  const AUDIO_EXT = ['mp3', 'ogg', 'wav', 'm4a'];

  /**
   * Public STUN servers, tried in order. They only help two peers discover each
   * other; they never see the media. A TURN relay (added later, per deployment)
   * is what carries the call when both sides sit behind a strict NAT.
   */
  const DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  /** mm:ss under an hour, then h:mm:ss — the way call timers read. */
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const two = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
  }

  function callKindLabel(video) {
    return video ? 'Видеозвонок' : 'Аудиозвонок';
  }

  /** The outgoing/incoming wording for the call banner. */
  function callStatusLabel(status, video) {
    const kind = callKindLabel(video);
    switch (status) {
      case 'outgoing': return `Исходящий ${kind.toLowerCase()}…`;
      case 'incoming': return `Входящий ${kind.toLowerCase()}`;
      case 'connecting': return 'Соединение…';
      case 'active': return null; // the timer replaces the label
      case 'ended': return 'Звонок завершён';
      default: return kind;
    }
  }

  /**
   * The ringtone file for a ring kind, from the manifest the user drops beside
   * the audio files (src/assets/ringtones/manifest.json):
   *
   *   { "ringtones": { "incoming": "incoming.mp3", "outgoing": "outgoing.mp3" } }
   *
   * With no manifest — or no entry for this kind — this returns null and the
   * renderer uses its synthesized chime, so a missing file is never an error
   * and never shows up as a failed request.
   */
  function ringtoneFile(kind, manifest) {
    const list = (manifest && manifest.ringtones) || null;
    if (!list) return null;
    const named = list[kind] || list.default;
    const name = typeof named === 'string' ? named.trim() : '';
    return name ? `assets/ringtones/${name}` : null;
  }

  /**
   * "Вы, Боб и ещё 2" — a participant line that stays short however many people
   * join. `self` is this device's own name and is listed first.
   */
  function describeParticipants(names, self) {
    const others = (names || []).filter((n) => n && n !== self);
    const total = others.length;
    if (total === 0) return self ? `${self}` : '';
    if (total === 1) return [self, others[0]].filter(Boolean).join(', ');
    // "Вы, Боб и ещё 2" — no comma before "и", which is how Russian lists read.
    const rest = total - 1;
    return [self, others[0]].filter(Boolean).join(', ') + ` и ещё ${rest}`;
  }

  /**
   * Whether a conversation can be called. Direct chats and groups can; the
   * saved-messages chat, bots and channels cannot. `key` is a chat key
   * ("group:12" for a group, a username otherwise).
   */
  function supportsCalls(key) {
    if (typeof key !== 'string' || !key) return false;
    if (key === 'saved') return false;
    if (key.startsWith('bot:')) return false;
    if (key.startsWith('channel:')) return false;
    return true;
  }

  function isGroupCallKey(key) {
    return typeof key === 'string' && key.startsWith('group:');
  }

  const api = {
    AUDIO_EXT, DEFAULT_ICE,
    formatDuration, callKindLabel, callStatusLabel,
    ringtoneFile, describeParticipants, supportsCalls, isGroupCallKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyCalls = api;
})(typeof window !== 'undefined' ? window : null);
