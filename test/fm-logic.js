'use strict';

/**
 * Бурмалда FM's playlist rules, under plain node: how a manifest becomes a
 * playlist, what plays next under each repeat mode, and how the labels read.
 *
 * Run with: node test/fm-logic.js
 */

const assert = require('assert');
const fm = require('../src/lib/fm');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

step('a manifest of plain filenames becomes a playlist', () => {
  const list = fm.buildPlaylist({ tracks: ['a.mp3', 'b.mp3'] });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].file, 'assets/fm/a.mp3');
  assert.strictEqual(list[0].title, 'a');
});

step('a manifest of objects keeps the given titles and artists', () => {
  const list = fm.buildPlaylist({ tracks: [{ file: 'x.mp3', title: 'Эфир', artist: 'Диджей' }] });
  assert.strictEqual(list[0].title, 'Эфир');
  assert.strictEqual(list[0].artist, 'Диджей');
  assert.strictEqual(list[0].file, 'assets/fm/x.mp3');
});

step('a numbered filename is stripped to a clean title', () => {
  assert.strictEqual(fm.titleFromFile('01 - Ночной эфир.mp3'), 'Ночной эфир');
  assert.strictEqual(fm.titleFromFile('07. Утро.flac'), 'Утро');
  assert.strictEqual(fm.titleFromFile('track.mp3'), 'track');
});

step('a missing manifest yields an empty station, not a crash', () => {
  assert.deepStrictEqual(fm.buildPlaylist(null), []);
  assert.deepStrictEqual(fm.buildPlaylist({}), []);
  assert.deepStrictEqual(fm.buildPlaylist({ tracks: 'nope' }), []);
});

step('an entry with no file is dropped', () => {
  const list = fm.buildPlaylist({ tracks: [{ title: 'нет файла' }, 'ok.mp3'] });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].file, 'assets/fm/ok.mp3');
});

step('a cover is resolved against the station folder', () => {
  const list = fm.buildPlaylist({ tracks: [{ file: 'a.mp3', cover: 'a.jpg' }] });
  assert.strictEqual(list[0].cover, 'assets/fm/a.jpg');
});

step('next advances through the list', () => {
  assert.strictEqual(fm.nextIndex(5, 0, 'off', false), 1);
  assert.strictEqual(fm.nextIndex(5, 3, 'off', false), 4);
});

step('next stops at the end when repeat is off', () => {
  assert.strictEqual(fm.nextIndex(5, 4, 'off', false), -1);
});

step('next wraps when repeat-all is on', () => {
  assert.strictEqual(fm.nextIndex(5, 4, 'all', false), 0);
});

step('next repeats the same track when repeat-one is on', () => {
  assert.strictEqual(fm.nextIndex(5, 2, 'one', false), 2);
});

step('next in shuffle never repeats the current track', () => {
  const pick = fm.nextIndex(5, 2, 'all', true, () => 0.0);
  assert.notStrictEqual(pick, 2, 'a different track is chosen');
  assert.ok(pick >= 0 && pick < 5, 'and it is a real index');
});

step('shuffle with one track stays on it', () => {
  assert.strictEqual(fm.nextIndex(1, 0, 'all', true), 0);
});

step('prev steps back, or wraps with repeat-all', () => {
  assert.strictEqual(fm.prevIndex(5, 3, 'off', false), 2);
  assert.strictEqual(fm.prevIndex(5, 0, 'all', false), 4);
  assert.strictEqual(fm.prevIndex(5, 0, 'off', false), 0);
});

step('an empty playlist has no next and no previous', () => {
  assert.strictEqual(fm.nextIndex(0, -1, 'all', false), -1);
  assert.strictEqual(fm.prevIndex(0, -1, 'all', false), -1);
});

step('the repeat mode cycles off -> all -> one -> off', () => {
  assert.strictEqual(fm.cycleMode('off'), 'all');
  assert.strictEqual(fm.cycleMode('all'), 'one');
  assert.strictEqual(fm.cycleMode('one'), 'off');
});

step('time reads m:ss', () => {
  assert.strictEqual(fm.formatTime(0), '0:00');
  assert.strictEqual(fm.formatTime(75), '1:15');
  assert.strictEqual(fm.formatTime(600), '10:00');
});

step('the track count uses the right Russian plural', () => {
  assert.strictEqual(fm.trackCountLabel(0), '0 треков');
  assert.strictEqual(fm.trackCountLabel(1), '1 трек');
  assert.strictEqual(fm.trackCountLabel(3), '3 трека');
  assert.strictEqual(fm.trackCountLabel(5), '5 треков');
  assert.strictEqual(fm.trackCountLabel(11), '11 треков');
  assert.strictEqual(fm.trackCountLabel(21), '21 трек');
  assert.strictEqual(fm.trackCountLabel(22), '22 трека');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} FM-logic checks passed`);
process.exit(passed === results.length ? 0 : 1);
