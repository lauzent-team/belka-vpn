'use strict';

/**
 * Unit checks for src/lib/globalsearch.js — searching across every chat at
 * once. No DOM, no relay: plain conversations in, hits out.
 *
 * Run with: node test/globalsearch.js
 */

const assert = require('assert');
const G = require('../src/lib/globalsearch');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const NOW = new Date('2026-11-04T12:00:00').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const conversations = [
  {
    key: 'anna',
    title: 'Анна',
    messages: [
      { id: 1, text: 'привет, как дела?', ts: NOW - 2 * HOUR, mine: false },
      { id: 2, text: 'скинула фото', kind: 'image', attachment: { name: 'кот.png' }, ts: NOW - 3 * DAY, mine: true }
    ]
  },
  {
    key: 'boris',
    title: 'Борис',
    messages: [
      { id: 3, text: 'привет, готов созвон?', ts: NOW - HOUR, mine: false },
      { id: 4, text: 'смотри https://example.com', ts: NOW - 10 * DAY, mine: true },
      { id: 5, text: 'старое сообщение', ts: NOW - 60 * DAY, mine: false }
    ]
  },
  {
    key: 'group:7',
    title: 'Работа',
    messages: [
      { id: 6, text: 'вопрос дня', ts: NOW - 5 * HOUR, mine: false },
      { id: 7, text: 'удалённое', ts: NOW - HOUR, mine: true, deleted: true }
    ]
  }
];
const extras = { 6: 'poll' };
function extrasOf(m) { return extras[m.id] || null; }

function ids(hits) { return hits.map((h) => h.message.id); }

console.log('global search');

step('a query finds hits across every conversation', () => {
  const hits = G.searchAcross(conversations, { query: 'привет' }, { extrasOf });
  assert.deepStrictEqual(ids(hits).sort(), [1, 3]);
});

step('hits carry the chat they came from', () => {
  const hits = G.searchAcross(conversations, { query: 'привет' }, { extrasOf });
  const keys = hits.map((h) => h.chatKey).sort();
  assert.deepStrictEqual(keys, ['anna', 'boris']);
  assert.strictEqual(hits.find((h) => h.chatKey === 'anna').title, 'Анна');
});

step('hits are ordered newest first across chats', () => {
  const hits = G.searchAcross(conversations, { query: 'привет' }, { extrasOf });
  assert.deepStrictEqual(ids(hits), [3, 1]);
});

step('deleted messages never match', () => {
  const hits = G.searchAcross(conversations, { kind: 'any' }, { extrasOf });
  assert.ok(!ids(hits).includes(7));
});

step('the query looks inside attachment names too', () => {
  const hits = G.searchAcross(conversations, { query: 'кот' }, { extrasOf });
  assert.deepStrictEqual(ids(hits), [2]);
});

step('the kind filter works globally, e.g. every link', () => {
  const hits = G.searchAcross(conversations, { kind: 'link' }, { extrasOf });
  assert.deepStrictEqual(ids(hits), [4]);
});

step('the payload tag travels in, so a poll is findable', () => {
  const hits = G.searchAcross(conversations, { kind: 'poll' }, { extrasOf });
  assert.deepStrictEqual(ids(hits), [6]);
});

step('the from filter splits mine and theirs globally', () => {
  const mine = G.searchAcross(conversations, { from: 'me' }, { extrasOf });
  assert.deepStrictEqual(ids(mine).sort(), [2, 4]);
});

step('the date filter drops old hits', () => {
  const recent = G.searchAcross(conversations, { date: 'today', now: NOW }, { extrasOf });
  assert.ok(!ids(recent).includes(5));
});

step('an empty filter returns every live message', () => {
  const hits = G.searchAcross(conversations, { kind: 'any' }, { extrasOf });
  assert.strictEqual(hits.length, 6);
});

step('isEmptyFilter is true only when nothing is asked', () => {
  assert.ok(G.isEmptyFilter({}));
  assert.ok(!G.isEmptyFilter({ query: 'x' }));
  assert.ok(!G.isEmptyFilter({ kind: 'photo' }));
});

step('a missing or malformed conversation is skipped, not thrown on', () => {
  const messy = [null, { key: 'ok', title: 'OK', messages: [{ id: 9, text: 'найди меня', ts: NOW, mine: false }] }, { title: 'no key', messages: [] }, { key: 'bad' }];
  const hits = G.searchAcross(messy, { query: 'найди' }, { extrasOf });
  assert.deepStrictEqual(ids(hits), [9]);
});

step('the limit caps the result count', () => {
  const hits = G.searchAcross(conversations, { kind: 'any' }, { extrasOf, limit: 2 });
  assert.strictEqual(hits.length, 2);
});

step('a nonsense limit falls back to the default', () => {
  assert.strictEqual(G.clampLimit(0), G.DEFAULT_LIMIT);
  assert.strictEqual(G.clampLimit(-5), G.DEFAULT_LIMIT);
  assert.strictEqual(G.clampLimit('x'), G.DEFAULT_LIMIT);
  assert.strictEqual(G.clampLimit(9999), G.MAX_LIMIT);
});

step('groupByChat regroups flat hits by conversation, newest first within', () => {
  const hits = G.searchAcross(conversations, { kind: 'any' }, { extrasOf });
  const groups = G.groupByChat(hits);
  assert.deepStrictEqual(groups.map((g) => g.key), ['boris', 'anna', 'group:7']);
  assert.deepStrictEqual(groups[0].items.map((m) => m.id), [3, 4, 5]);
  assert.strictEqual(groups[1].title, 'Анна');
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} global-search checks passed`);
process.exit(failed === 0 ? 0 : 1);
