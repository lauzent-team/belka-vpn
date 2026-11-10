'use strict';

/**
 * Бурмалда FM — the station's playlist brain. Pure logic, no DOM and no audio:
 * it holds the track list, the play order and the "what plays next" rules, and
 * the renderer drives the <audio> element from its answers. Loaded in the
 * renderer as window.SleePhyFM and under plain node for test/fm-logic.js.
 *
 * The tracks themselves are data. Until real files are dropped into
 * src/assets/fm/ and listed in src/assets/fm/playlist.json, the station is
 * simply empty — the UI shows "тишина в эфире" rather than pretending to play.
 */

(function (root) {
  const AUDIO_EXT = ['mp3', 'ogg', 'wav', 'm4a', 'flac'];
  const MODES = ['off', 'all', 'one'];

  /**
   * Build the runtime playlist from a manifest. Each entry is either a bare
   * filename ("track.mp3") or an object ({ file, title, artist, cover }); both
   * shapes are accepted so the file the user writes can stay simple. `base` is
   * the folder the files live in — a URL in the app, a relative path in tests.
   */
  function buildPlaylist(manifest, base) {
    const root = String(base || 'assets/fm').replace(/\/+$/, '');
    const raw = (manifest && Array.isArray(manifest.tracks)) ? manifest.tracks : [];
    return raw.map((entry, i) => {
      const obj = typeof entry === 'string' ? { file: entry } : (entry || {});
      const file = String(obj.file || '').trim();
      if (!file) return null;
      const title = String(obj.title || '').trim() || titleFromFile(file);
      return {
        id: obj.id != null ? String(obj.id) : `t${i + 1}`,
        file: `${root}/${file}`,
        title,
        artist: String(obj.artist || '').trim() || 'Бурмалда FM',
        cover: obj.cover ? `${root}/${obj.cover}` : null,
        duration: Number.isFinite(obj.duration) ? obj.duration : null
      };
    }).filter(Boolean);
  }

  /** "01 — Ночной эфир.mp3" -> "Ночной эфир"; the file name is the fallback. */
  function titleFromFile(file) {
    const base = String(file).split('/').pop().replace(/\.[^.]+$/, '');
    const stripped = base.replace(/^\s*\d+\s*[-–—.)]\s*/, '').trim();
    return stripped || base;
  }

  /**
   * The next index given the current one and the repeat mode. Returns -1 when
   * playback should stop (repeat off, at the end). `shuffle` picks a different
   * track at random, never the current one unless it is the only track.
   */
  function nextIndex(count, current, mode, shuffle, rand) {
    if (count <= 0) return -1;
    if (mode === 'one') return current;
    const r = typeof rand === 'function' ? rand : Math.random;
    if (shuffle) {
      if (count === 1) return 0;
      let pick = current;
      while (pick === current) pick = Math.floor(r() * count);
      return pick;
    }
    const next = current + 1;
    if (next < count) return next;
    return mode === 'all' ? 0 : -1;
  }

  /** The previous index, wrapping only when the mode loops. */
  function prevIndex(count, current, mode, shuffle, rand) {
    if (count <= 0) return -1;
    if (shuffle) return nextIndex(count, current, mode, true, rand);
    const prev = current - 1;
    if (prev >= 0) return prev;
    return mode === 'all' ? count - 1 : 0;
  }

  /** Cycle the repeat mode off -> all -> one -> off. */
  function cycleMode(mode) {
    const i = MODES.indexOf(mode);
    return MODES[(i + 1) % MODES.length];
  }

  /** mm:ss for the seek bar; hours are folded in when a track is long. */
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  /** "12 треков" with the Russian plural forms. */
  function trackCountLabel(n) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const mod10 = count % 10;
    const mod100 = count % 100;
    let word = 'треков';
    if (mod10 === 1 && mod100 !== 11) word = 'трек';
    else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) word = 'трека';
    return `${count} ${word}`;
  }

  const api = {
    AUDIO_EXT, MODES,
    buildPlaylist, titleFromFile, nextIndex, prevIndex, cycleMode, formatTime, trackCountLabel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SleePhyFM = api;
})(typeof window !== 'undefined' ? window : null);
