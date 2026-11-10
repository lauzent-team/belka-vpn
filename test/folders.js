'use strict';

/**
 * Tests for the chat-folder logic in src/lib/folders.js. Pure logic, no server
 * and no browser: this runs with plain `node test/folders.js`.
 */

const assert = require('assert');
const folders = require('../src/lib/folders');

const results = [];
function pass(name) { results.push(true); console.log('  PASS', name); }
function step(name, fn) {
  try { fn(); pass(name); } catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const desc = (key, kind, unread) => ({ key, kind, unread: unread || 0 });

step('kindOf classifies each chat key', () => {
  assert.strictEqual(folders.kindOf('alice'), 'private');
  assert.strictEqual(folders.kindOf('saved'), 'saved');
  assert.strictEqual(folders.kindOf('minigames', true), 'bots');
  assert.strictEqual(folders.kindOf('group:3'), 'groups');
  assert.strictEqual(folders.kindOf('channel:9'), 'channels');
});

step('the all folder matches every kind', () => {
  const all = folders.allFolder();
  for (const kind of folders.KINDS) {
    assert.ok(folders.matches(all, desc('x', kind)), `${kind} should match`);
  }
  assert.strictEqual(all.system, true);
});

step('normalize keeps a well-formed folder and fills defaults', () => {
  const f = folders.normalize({ id: 'f1', name: '  Работа  ', kinds: { groups: true } });
  assert.strictEqual(f.id, 'f1');
  assert.strictEqual(f.name, 'Работа');
  assert.strictEqual(f.kinds.groups, true);
  assert.strictEqual(f.kinds.private, false);
  assert.deepStrictEqual(f.include, []);
});

step('normalize rejects a nameless folder and falls back to a kind', () => {
  assert.strictEqual(folders.normalize({ name: '   ' }), null);
  assert.strictEqual(folders.normalize(null), null);
  const f = folders.normalize({ name: 'Пусто', kinds: {} });
  assert.strictEqual(f.kinds.private, true, 'a folder with no kind should default to private');
});

step('normalizeAll drops junk and de-duplicates ids', () => {
  const list = folders.normalizeAll([
    { id: 'a', name: 'A', kinds: { private: true } },
    { id: 'a', name: 'dupe', kinds: { private: true } },
    { name: '' },
    { id: 'all', name: 'shadow', kinds: { private: true } },
    { id: 'b', name: 'B', kinds: { groups: true } }
  ]);
  assert.deepStrictEqual(list.map((f) => f.id), ['a', 'b']);
});

step('a folder matches only the chat kinds it lists', () => {
  const work = folders.normalize({ id: 'w', name: 'Работа', kinds: { groups: true, channels: true } });
  assert.ok(folders.matches(work, desc('group:1', 'groups')));
  assert.ok(folders.matches(work, desc('channel:1', 'channels')));
  assert.ok(!folders.matches(work, desc('alice', 'private')));
});

step('unreadOnly narrows a folder to chats with something unread', () => {
  const f = folders.normalize({ id: 'u', name: 'Непрочитанные', kinds: { private: true }, unreadOnly: true });
  assert.ok(folders.matches(f, desc('alice', 'private', 2)));
  assert.ok(!folders.matches(f, desc('bob', 'private', 0)));
});

step('an explicit include overrides the kind filter', () => {
  const f = folders.normalize({ id: 'i', name: 'Избранное', kinds: { private: true }, include: ['group:7'] });
  assert.ok(folders.matches(f, desc('group:7', 'groups')), 'include should force-add');
});

step('an explicit exclude overrides everything', () => {
  const f = folders.normalize({ id: 'e', name: 'Без спама', kinds: { private: true }, include: ['alice'], exclude: ['alice'] });
  assert.ok(!folders.matches(f, desc('alice', 'private', 5)), 'exclude should win over include');
});

step('filter keeps the given order', () => {
  const f = folders.normalize({ id: 'p', name: 'Люди', kinds: { private: true } });
  const descs = [desc('alice', 'private'), desc('group:1', 'groups'), desc('bob', 'private')];
  assert.deepStrictEqual(folders.filter(f, descs).map((d) => d.key), ['alice', 'bob']);
});

step('unreadIn sums only the chats inside the folder', () => {
  const f = folders.normalize({ id: 'g', name: 'Группы', kinds: { groups: true } });
  const descs = [desc('group:1', 'groups', 3), desc('alice', 'private', 9), desc('group:2', 'groups', 1)];
  assert.strictEqual(folders.unreadIn(f, descs), 4);
});

step('normalizeAll caps the number of folders', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 'f' + i, name: 'F' + i, kinds: { private: true } }));
  assert.strictEqual(folders.normalizeAll(many).length, folders.MAX_FOLDERS);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} folder checks passed`);
process.exit(failed === 0 ? 0 : 1);
