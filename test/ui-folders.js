'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8813;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-foldercheck-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
async function launch(label, reuseDir) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-foldercheck-${label}-`));
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win, dir, errors };
}
async function openChatWith(win, username) {
  await win.fill('#search', username);
  await win.press('#search', 'Enter');
  await win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
}
/** Create a folder through the drawer and the folder modal. */
async function createFolder(win, name, kinds) {
  await win.click('#btn-menu');
  await win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
  await win.click('[data-drawer="folders"]');
  await win.waitForSelector('#folder-backdrop:not([hidden])', { timeout: 8000 });
  await win.click('#btn-folder-new');
  await win.waitForSelector('#folder-editor:not([hidden])', { timeout: 8000 });
  await win.fill('#folder-name', name);
  for (const kind of kinds) {
    const box = await win.$(`#folder-kinds input[data-kind="${kind}"]`);
    if (!(await box.isChecked())) await box.check();
  }
  // Untick the default "private" when it is not wanted.
  if (!kinds.includes('private')) {
    const box = await win.$('#folder-kinds input[data-kind="private"]');
    if (await box.isChecked()) await box.uncheck();
  }
  await win.click('#btn-folder-save');
  await win.waitForSelector('#folder-editor', { state: 'hidden', timeout: 8000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: 'pidoras' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const u = await launch('u');
  const v = await launch('v');
  const s = Math.random().toString(36).slice(2, 6);
  const peer = `folderpeer_${s}`;
  const me = `foldertester_${s}`;
  await signIn(u.win, URL, { username: me });
  await signIn(v.win, URL, { username: peer });
  await openChatWith(u.win, peer);

  await step('there is only the "all" tab until a folder is made', async () => {
    const n = await u.win.$$eval('.folder-tab', (els) => els.length);
    assert.strictEqual(n, 1, `expected one tab, got ${n}`);
    const label = await u.win.textContent('.folder-tab .folder-tab-name');
    assert.strictEqual(label.trim(), 'Все чаты');
  });

  await step('a folder with no name is refused with an error', async () => {
    await u.win.click('#btn-menu');
    await u.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await u.win.click('[data-drawer="folders"]');
    await u.win.waitForSelector('#folder-backdrop:not([hidden])', { timeout: 8000 });
    await u.win.click('#btn-folder-new');
    await u.win.fill('#folder-name', '   ');
    await u.win.click('#btn-folder-save');
    await u.win.waitForSelector('#folder-error:not([hidden])', { timeout: 8000 });
    const text = await u.win.textContent('#folder-error');
    assert.ok(/название/i.test(text), `error was ${text}`);
    await u.win.click('#btn-folder-close');
  });

  await step('a "Личные" folder appears as a second tab', async () => {
    await createFolder(u.win, 'Личные', ['private']);
    await u.win.click('#btn-folder-close');
    await u.win.waitForFunction(
      () => document.querySelectorAll('.folder-tab').length === 2, null, { timeout: 8000 }
    );
    const names = await u.win.$$eval('.folder-tab .folder-tab-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(names, ['Все чаты', 'Личные']);
  });

  await step('the folder shows the private chat and hides groups', async () => {
    // Open the "Личные" tab.
    await u.win.click('.folder-tab[data-folder]:nth-child(2)');
    await u.win.waitForFunction(
      () => document.querySelector('.folder-tab.active .folder-tab-name').textContent.trim() === 'Личные',
      null, { timeout: 8000 }
    );
    const rows = await u.win.$$eval('#chat-list .chat-item', (els) => els.map((e) => e.dataset.peer));
    assert.ok(rows.includes(peer), `private chat should be listed, got ${rows}`);
    const groups = await u.win.$$eval('#chat-list .chat-item[data-peer^="group:"]', (els) => els.length);
    assert.strictEqual(groups, 0, 'a groups chat must not appear in a private-only folder');
  });

  await step('switching back to "Все чаты" shows everything again', async () => {
    await u.win.click('.folder-tab[data-folder="all"]');
    await u.win.waitForFunction(
      () => document.querySelector('.folder-tab.active .folder-tab-name').textContent.trim() === 'Все чаты',
      null, { timeout: 8000 }
    );
    const rows = await u.win.$$eval('#chat-list .chat-item', (els) => els.map((e) => e.dataset.peer));
    assert.ok(rows.includes(peer));
  });

  await step('the folders survive an app restart', async () => {
    await new Promise((r) => setTimeout(r, 700));
    await u.app.close();
    const again = await launch('u2', u.dir);
    await again.win.waitForFunction(
      () => document.querySelector('#screen-main.active') || document.querySelector('#screen-unlock.active'),
      null, { timeout: 20000 }
    );
    if (await again.win.$('#screen-unlock.active')) {
      await again.win.fill('#unlock-password', 'sleephy-test-1234');
      await again.win.press('#unlock-password', 'Enter');
      await again.win.waitForSelector('#screen-main.active', { timeout: 20000 });
    }
    await again.win.waitForFunction(
      () => document.querySelectorAll('.folder-tab').length === 2, null, { timeout: 10000 }
    );
    const names = await again.win.$$eval('.folder-tab .folder-tab-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(names, ['Все чаты', 'Личные']);
    await again.app.close();
  });

  await step('no uncaught errors in either renderer', async () => {
    assert.deepStrictEqual(u.errors, [], 'tester renderer errors');
    assert.deepStrictEqual(v.errors, [], 'peer renderer errors');
  });

  await v.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} folder UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
