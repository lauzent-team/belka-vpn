'use strict';

/**
 * Unit checks for src/lib/chatsearch.js — the filter rules behind in-chat
 * search. No DOM, no relay: plain objects in, ids out.
 *
 * Run with: node test/chatsearch.js
 */

const assert = require('assert');
const S = require('../src/lib/chatsearch');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const NOW = new Date('2026-11-04T12:00:00').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const messages = [
  { id: 1, text: 'Привет, как дела?', ts: NOW - 2 * HOUR, mine: false },
  { id: 2, text: 'Отправлю фото', ts: NOW - 3 * DAY, mine: true },
  { id: 3, text: '', kind: 'image', attachment: { name: 'кот.png' }, ts: NOW - 20 * DAY, mine: false },
  { id: 4, text: '', kind: 'voice', attachment: { name: 'voice-5s.webm' }, ts: NOW - 40 * DAY, mine: true },
  { id: 5, text: 'смотри https://example.com/page', ts: NOW - 2 * DAY, mine: false },
  { id: 6, text: 'документ во вложении', kind: 'file', attachment: { name: 'отчёт.pdf' }, ts: NOW - 10 * DAY, mine: true },
  { id: 7, text: 'вопрос дня', ts: NOW - 5 * HOUR, mine: false },
  { id: 8, text: 'удалённое', ts: NOW - HOUR, mine: true, deleted: true }
];
const extras = { 7: 'poll' };

function extrasOf(m) { return extras[m.id] || null; }
function ids(list) { return list.map((m) => m.id); }

console.log('chat search');

step('a text query finds the message that contains it', () => {
  assert.deepStrictEqual(ids(S.search(messages, { query: 'дела' }, extrasOf)), [1]);
});

step('the query is case-insensitive', () => {
  assert.deepStrictEqual(ids(S.search(messages, { query: 'ПРИВЕТ' }, extrasOf)), [1]);
});

step('the query also looks at the attachment file name', () => {
  assert.deepStrictEqual(ids(S.search(messages, { query: 'отчёт' }, extrasOf)), [6]);
});

step('deleted messages never match, even with an empty filter', () => {
  assert.ok(!ids(S.search(messages, {}, extrasOf)).includes(8));
});

step('the from filter splits mine and theirs', () => {
  assert.deepStrictEqual(ids(S.search(messages, { from: 'me' }, extrasOf)).sort(), [2, 4, 6]);
  assert.deepStrictEqual(ids(S.search(messages, { from: 'them' }, extrasOf)).sort(), [1, 3, 5, 7]);
});

step('the media chip keeps photos, voice, video and files but not text', () => {
  const got = ids(S.search(messages, { kind: 'media' }, extrasOf)).sort();
  assert.deepStrictEqual(got, [3, 4, 6]);
});

step('the photo chip keeps only images', () => {
  assert.deepStrictEqual(ids(S.search(messages, { kind: 'photo' }, extrasOf)), [3]);
});

step('the voice chip keeps only voice notes', () => {
  assert.deepStrictEqual(ids(S.search(messages, { kind: 'voice' }, extrasOf)), [4]);
});

step('the file chip keeps documents and not images', () => {
  assert.deepStrictEqual(ids(S.search(messages, { kind: 'file' }, extrasOf)), [6]);
});

step('the link chip finds a URL in the text', () => {
  assert.deepStrictEqual(ids(S.search(messages, { kind: 'link' }, extrasOf)), [5]);
});

step('a bare www. host counts as a link too', () => {
  assert.ok(S.linkIn('зайди на www.example.org'));
  assert.ok(!S.linkIn('обычный текст'));
});

step('the poll chip matches a message tagged as a poll', () => {
  assert.deepStrictEqual(ids(S.search(messages, { kind: 'poll' }, extrasOf)), [7]);
});

step('the date filter keeps only recent messages', () => {
  assert.deepStrictEqual(ids(S.search(messages, { date: 'today', now: NOW }, extrasOf)).sort(), [1, 7]);
  assert.deepStrictEqual(ids(S.search(messages, { date: 'week', now: NOW }, extrasOf)).sort(), [1, 2, 5, 7]);
});

step('filters combine: a query plus a sender plus a kind', () => {
  const got = ids(S.search(messages, { query: 'фото', from: 'me', kind: 'any' }, extrasOf));
  assert.deepStrictEqual(got, [2]);
});

step('an empty filter returns every live message', () => {
  assert.strictEqual(S.search(messages, {}, extrasOf).length, 7);
});

step('counts reports the size of each chip', () => {
  const c = S.counts(messages, extrasOf);
  assert.strictEqual(c.any, 7);
  assert.strictEqual(c.media, 3);
  assert.strictEqual(c.photo, 1);
  assert.strictEqual(c.voice, 1);
  assert.strictEqual(c.file, 1);
  assert.strictEqual(c.link, 1);
  assert.strictEqual(c.poll, 1);
});

step('an unknown kind falls back to any', () => {
  assert.strictEqual(S.normalize({ kind: 'nonsense' }).kind, 'any');
});

step('an unknown from falls back to any', () => {
  assert.strictEqual(S.normalize({ from: 'nobody' }).from, 'any');
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} chat-search checks passed`);
process.exit(failed === 0 ? 0 : 1);
