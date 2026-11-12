'use strict';

/**
 * Nickname tests against a real relay.
 *
 * Nicknames are the extra display names shown under a profile name. The rule
 * under test is asymmetric: the owner account may hold an unbounded list and
 * set it from its own profile form, while every other account is capped and
 * edited only by an administrator. The relay enforces all of it; this suite
 * drives a real relay with a real client and asserts:
 *   1. an ordinary account cannot set its own nicknames
 *   2. an administrator can add, rename and remove anyone's nicknames
 *   3. a non-admin cannot edit anyone's nicknames
 *   4. an ordinary account is capped; the owner account is not
 *   5. the owner sets its own list from the profile form
 *   6. nicknames reach the public profile and the admin user list
 *   7. a hidden profile hides its nicknames from other viewers
 *   8. a nickname is held by at most one account: another is refused it, the
 *      holder keeps it, and releasing it frees it for someone else
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8798;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-nicknames-${Date.now()}.db`);
const OWNER = 'pidoras';

const results = [];
function pass(name) { results.push(['PASS', name]); console.log('  PASS', name); }
function fail(name, err) { results.push(['FAIL', name]); console.log('  FAIL', name, '->', err && err.message); }
async function step(name, fn) {
  try { await fn(); pass(name); }
  catch (err) { fail(name, err); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-nick-${label}-`));
  return new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: OWNER },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tryConnect = () => {
      const ws = new WebSocket(URL);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => {
        if (Date.now() - t0 > 8000) return reject(new Error('server did not start'));
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });

  const owner = makeClient('owner');
  const user = makeClient('user');
  const other = makeClient('other');

  await step('the owner and an ordinary account register', async () => {
    await owner.connect(URL);
    await owner.register({ username: OWNER, password: 'owner-password-1' });
    await user.connect(URL);
    await user.register({ username: 'vasya', password: 'user-password-1' });
    await other.connect(URL);
    await other.register({ username: 'petya', password: 'other-password-1' });
  });

  await step('an ordinary account cannot set its own nicknames', async () => {
    await user.saveProfile({ nicknames: ['a', 'b', 'c', 'd'] });
    const p = (await user.getProfile('vasya')).profile;
    assert.deepStrictEqual(p.nicknames, [], 'a non-owner must not set nicknames from the profile form');
  });

  await step('the owner account is told it may set its own nicknames', async () => {
    const p = (await owner.getProfile(OWNER)).profile;
    assert.strictEqual(p.owner, true, 'the owner profile must carry the owner flag');
    const u = (await user.getProfile('vasya')).profile;
    assert.notStrictEqual(u.owner, true, 'another account must not be told it is the owner');
  });

  await step('an administrator can add a nickname to anyone', async () => {
    await owner.adminAction({ action: 'nicknameAdd', username: 'vasya', nickname: 'Вася' });
    await owner.adminAction({ action: 'nicknameAdd', username: 'vasya', nickname: 'Друг' });
    const p = (await user.getProfile('vasya')).profile;
    assert.deepStrictEqual(p.nicknames, ['Вася', 'Друг']);
  });

  await step('an administrator can rename a nickname by index', async () => {
    await owner.adminAction({ action: 'nicknameSet', username: 'vasya', nickname: 'Васёк', index: 0 });
    const p = (await user.getProfile('vasya')).profile;
    assert.deepStrictEqual(p.nicknames, ['Васёк', 'Друг']);
  });

  await step('an administrator can remove a nickname by index', async () => {
    await owner.adminAction({ action: 'nicknameRemove', username: 'vasya', index: 1 });
    const p = (await user.getProfile('vasya')).profile;
    assert.deepStrictEqual(p.nicknames, ['Васёк']);
  });

  await step('an out-of-range index is refused', async () => {
    let message = '';
    try { await owner.adminAction({ action: 'nicknameRemove', username: 'vasya', index: 5 }); }
    catch (err) { message = err.message; }
    assert.ok(/no such/i.test(message), `expected a range refusal, got "${message}"`);
  });

  await step('a duplicate nickname is not stored twice', async () => {
    await owner.adminAction({ action: 'nicknameAdd', username: 'vasya', nickname: 'Васёк' });
    const p = (await user.getProfile('vasya')).profile;
    assert.deepStrictEqual(p.nicknames, ['Васёк']);
  });

  await step('an ordinary account is capped at three nicknames', async () => {
    await owner.adminAction({ action: 'nicknameAdd', username: 'vasya', nickname: 'x2' });
    await owner.adminAction({ action: 'nicknameAdd', username: 'vasya', nickname: 'x3' });
    await owner.adminAction({ action: 'nicknameAdd', username: 'vasya', nickname: 'x4' });
    const p = (await user.getProfile('vasya')).profile;
    assert.strictEqual(p.nicknames.length, 3, 'the cap must hold even when an admin adds them');
  });

  await step('the owner account can hold an unbounded list', async () => {
    for (let i = 0; i < 12; i++) {
      await owner.adminAction({ action: 'nicknameAdd', username: OWNER, nickname: `nick${i}` });
    }
    const p = (await owner.getProfile(OWNER)).profile;
    assert.strictEqual(p.nicknames.length, 12, 'the owner must not be capped');
  });

  await step('the owner sets its own nickname list from the profile form', async () => {
    await owner.saveProfile({ nicknames: ['Главный', 'Boss'] });
    const p = (await owner.getProfile(OWNER)).profile;
    assert.deepStrictEqual(p.nicknames, ['Главный', 'Boss']);
  });

  await step('a nickname held by one account cannot be taken by another', async () => {
    let message = '';
    try { await owner.adminAction({ action: 'nicknameAdd', username: 'petya', nickname: 'Главный' }); }
    catch (err) { message = err.message; }
    assert.ok(/занят/i.test(message), `expected a "taken" refusal, got "${message}"`);
    const p = (await owner.getProfile('petya')).profile;
    assert.deepStrictEqual(p.nicknames, [], 'the taken name must not be added');
  });

  await step('the check reports a held name as taken and an unused one as free', async () => {
    const taken = await user.checkNickname('Главный');
    assert.strictEqual(taken.available, false, 'a name held by the owner is not free');
    const free = await user.checkNickname('СвежийНик');
    assert.strictEqual(free.available, true, 'an unused name is free');
  });

  await step('the holder still sees its own nickname as its own', async () => {
    const mine = await owner.checkNickname('Главный');
    assert.strictEqual(mine.available, true, 'the holder keeps its own name');
    assert.strictEqual(mine.heldBySelf, true, 'and is told it holds it');
  });

  await step('releasing a nickname frees it for another account', async () => {
    // The owner drops "Boss", then an ordinary account can take it.
    await owner.saveProfile({ nicknames: ['Главный'] });
    const freed = await user.checkNickname('Boss');
    assert.strictEqual(freed.available, true, 'the released name is free again');
    await owner.adminAction({ action: 'nicknameAdd', username: 'petya', nickname: 'Boss' });
    const p = (await owner.getProfile('petya')).profile;
    assert.deepStrictEqual(p.nicknames, ['Boss'], 'the released name was claimed');
  });

  await step('a non-admin cannot edit anyone\'s nicknames', async () => {
    let message = '';
    try { await user.adminAction({ action: 'nicknameAdd', username: OWNER, nickname: 'hax' }); }
    catch (err) { message = err.message; }
    assert.ok(/admin/i.test(message), `expected an admin refusal, got "${message}"`);
  });

  await step('nicknames appear in the admin user list', async () => {
    const list = await owner.adminUsers();
    const row = list.find((i) => i.username === 'vasya');
    assert.ok(row, 'the account must be listed');
    assert.deepStrictEqual(row.nicknames, ['Васёк', 'x2', 'x3']);
  });

  await step('a nickname that is too long is refused', async () => {
    let message = '';
    try {
      await owner.adminAction({ action: 'nicknameAdd', username: 'petya', nickname: 'x'.repeat(33) });
    } catch (err) { message = err.message; }
    assert.ok(/long/i.test(message), `expected a length refusal, got "${message}"`);
  });

  await step('a hidden profile hides its nicknames from other viewers', async () => {
    await user.setPrivacy({ profileHidden: true });
    const seen = (await owner.getProfile('vasya')).profile;
    assert.deepStrictEqual(seen.nicknames, [], 'a hidden profile must not leak nicknames');
    const self = (await user.getProfile('vasya')).profile;
    assert.ok(self.nicknames.length > 0, 'the account still sees its own nicknames');
  });

  await step('the profile says whether the viewer may edit nicknames', async () => {
    const asAdmin = (await owner.getProfile('vasya')).profile;
    assert.strictEqual(asAdmin.canEditNicknames, true, 'an admin must be told they may edit');
    const asPeer = (await other.getProfile('vasya')).profile;
    assert.strictEqual(asPeer.canEditNicknames, false, 'a peer must not be told they may edit');
  });

  owner.disconnect();
  user.disconnect();
  other.disconnect();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter(([s]) => s === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} nickname checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
