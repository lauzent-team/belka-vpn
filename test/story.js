'use strict';

/**
 * Unit tests for the stories library (src/lib/stories.js). Pure logic only —
 * no window, no relay. Run with: node test/story.js
 */

const assert = require('assert');
const S = require('../src/lib/stories.js');

const results = [];
function step(name, fn) {
  try { fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

step('make fills defaults for an empty draft', () => {
  const s = S.make();
  assert.strictEqual(s.kind, 'text');
  assert.strictEqual(s.bg, 'mint');
  assert.strictEqual(s.cap, '');
  assert.strictEqual(s.ttl, S.DEFAULT_TTL_MS);
});

step('make trims and caps the caption', () => {
  const s = S.make({ cap: '  ' + 'x'.repeat(400) + '  ' });
  assert.strictEqual(s.cap.length, S.MAX_CAPTION);
});

step('make rejects an unknown kind', () => {
  assert.strictEqual(S.make({ kind: 'video' }).kind, 'text');
});

step('clampTtl keeps a value inside the window', () => {
  assert.strictEqual(S.clampTtl(2 * 3600000), 2 * 3600000);
  assert.strictEqual(S.clampTtl(1), S.MIN_TTL_MS);
  assert.strictEqual(S.clampTtl(999 * 3600000), S.MAX_TTL_MS);
  assert.strictEqual(S.clampTtl('nope'), S.DEFAULT_TTL_MS);
});

step('encode then decode round-trips a text story', () => {
  const body = S.encode({ cap: 'Привет', kind: 'text', bg: 'sunset' });
  const back = S.decode(body);
  assert.strictEqual(back.cap, 'Привет');
  assert.strictEqual(back.kind, 'text');
  assert.strictEqual(back.bg, 'sunset');
});

step('decode ignores ordinary text and bad JSON', () => {
  assert.strictEqual(S.decode('hello'), null);
  assert.strictEqual(S.decode('{'), null);
  assert.strictEqual(S.decode('{"s":2}'), null);
  assert.strictEqual(S.decode(null), null);
});

step('expiresAt adds the time-to-live', () => {
  assert.strictEqual(S.expiresAt(1000, 3600000), 1000 + 3600000);
});

step('isExpired flips exactly at the deadline', () => {
  const story = { ts: NOW, ttl: 3600000 };
  assert.strictEqual(S.isExpired(story, NOW + 3599999), false);
  assert.strictEqual(S.isExpired(story, NOW + 3600000), true);
  assert.strictEqual(S.isExpired(null, NOW), true);
});

step('remainingMs floors at zero and remainingLabel is short', () => {
  const story = { ts: NOW, ttl: 2 * 3600000 };
  assert.strictEqual(S.remainingMs(story, NOW + 3600000), 3600000);
  assert.strictEqual(S.remainingMs(story, NOW + 999 * 3600000), 0);
  assert.strictEqual(S.remainingLabel(2 * 3600000), '2 ч');
  assert.strictEqual(S.remainingLabel(40 * 60000), '40 мин');
  assert.strictEqual(S.remainingLabel(1000), 'меньше минуты');
});

step('filterActive drops expired stories and sorts newest-first', () => {
  const list = [
    { id: 1, ts: NOW - 10, ttl: 3600000 },
    { id: 2, ts: NOW - 5 * 3600000, ttl: 3600000 },
    { id: 3, ts: NOW - 1, ttl: 3600000 }
  ];
  const out = S.filterActive(list, NOW);
  assert.deepStrictEqual(out.map((s) => s.id), [3, 1]);
});

step('byAuthor groups per author, oldest-first inside a group', () => {
  const list = [
    { id: 1, author: 'a', ts: NOW - 30, ttl: 3600000 },
    { id: 2, author: 'a', ts: NOW - 10, ttl: 3600000 },
    { id: 3, author: 'b', ts: NOW - 20, ttl: 3600000 }
  ];
  const groups = S.byAuthor(list, NOW);
  assert.deepStrictEqual(groups.get('a').map((s) => s.id), [1, 2]);
  assert.deepStrictEqual(groups.get('b').map((s) => s.id), [3]);
});

step('orderAuthors puts me first, then unseen, then the rest', () => {
  const list = [
    { id: 1, author: 'zed', ts: NOW - 30, ttl: 3600000 },
    { id: 2, author: 'ann', ts: NOW - 10, ttl: 3600000 },
    { id: 3, author: 'bob', ts: NOW - 20, ttl: 3600000 }
  ];
  const groups = S.byAuthor(list, NOW);
  const order = S.orderAuthors(groups, {
    me: 'zed',
    unseen: (name, s) => s.id === 2
  });
  assert.deepStrictEqual(order, ['zed', 'ann', 'bob']);
});

step('unseenCount counts stories not in the seen set', () => {
  const stories = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.strictEqual(S.unseenCount(stories, new Set([1, 3])), 1);
  assert.strictEqual(S.unseenCount(stories, []), 3);
});

step('nextId walks forward and wraps', () => {
  const stories = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.strictEqual(S.nextId(stories, 'a'), 'b');
  assert.strictEqual(S.nextId(stories, 'c'), 'a');
  assert.strictEqual(S.nextId(stories, 'zzz'), 'a');
  assert.strictEqual(S.nextId([], 'a'), null);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} story checks passed`);
process.exit(passed === results.length ? 0 : 1);
