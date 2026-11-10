'use strict';

/**
 * Drives the real Electron UI for the nickname feature: the owner's own editor
 * in the profile form, and the admin's hover popup on an @handle in the admin
 * panel. Real clicks on the real app — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-nicknames.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8799;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uinick-${Date.now()}.db`);
const ADMIN = 'pidoras';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uinick-${label}-`));
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

async function openProfile(win) {
  await win.click('#btn-my-profile');
  await win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
}

async function openAdminPane(win) {
  if (!(await win.isVisible('#settings-backdrop:not([hidden])'))) {
    await win.click('#btn-settings');
    await win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 8000 });
  }
  await win.click('.settings-nav-item[data-pane="admin"]');
  await win.waitForSelector('.settings-pane[data-pane="admin"].active', { timeout: 8000 });
  await win.waitForSelector('#admin-users .admin-user', { timeout: 8000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: ADMIN },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const owner = await launch('owner');
  const user = await launch('user');
  const suffix = Math.random().toString(36).slice(2, 6);
  const peer = `vasya_${suffix}`;

  await signIn(owner.win, URL, { username: ADMIN });
  await signIn(user.win, URL, { username: peer });

  await step('the owner sees the nickname editor in their profile form', async () => {
    await openProfile(owner.win);
    await owner.win.click('#btn-profile-edit');
    await owner.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });
    assert.ok(await owner.win.isVisible('#nicknames-field'), 'the owner must see the nickname field');
  });

  await step('an ordinary account does not see the nickname editor', async () => {
    await openProfile(user.win);
    await user.win.click('#btn-profile-edit');
    await user.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });
    assert.ok(!(await user.win.isVisible('#nicknames-field')), 'a non-owner must not see the field');
    await user.win.click('#btn-profile-close');
  });

  await step('the owner sets a nickname from the form and it shows on the profile', async () => {
    await owner.win.fill('#profile-nickname-input', 'Главный');
    await owner.win.click('#btn-nickname-add');
    await owner.win.fill('#profile-nickname-input', 'Boss');
    await owner.win.click('#btn-nickname-add');
    await owner.win.click('#profile-form button[type="submit"]');
    await owner.win.waitForFunction(
      () => document.querySelectorAll('#profile-nicknames .nickname-chip').length === 2,
      { timeout: 8000 }
    );
    const chips = await owner.win.$$eval('#profile-nicknames .nickname-chip span', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(chips, ['Главный', 'Boss']);
    await owner.win.click('#btn-profile-close');
  });

  await step('hovering an @handle in the admin panel opens the nickname popup', async () => {
    await openAdminPane(owner.win);
    const at = owner.win.locator(`#admin-users .admin-at[data-user="${peer}"]`);
    await at.hover();
    await owner.win.waitForSelector('.nick-pop', { timeout: 8000 });
    assert.ok(await owner.win.isVisible('.nick-pop'), 'the popup must appear');
  });

  await step('the admin adds a nickname from the popup', async () => {
    await owner.win.fill('.nick-pop-add input', 'Вася');
    await owner.win.click('.nick-pop-add button');
    await owner.win.waitForFunction(
      () => [...document.querySelectorAll('.nick-pop-item input')].some((i) => i.value === 'Вася'),
      null,
      { timeout: 8000 }
    );
  });

  await step('the peer profile shows the nickname the admin set', async () => {
    // The admin edited the peer's nicknames, so the peer sees the chip on their
    // own profile.
    await openProfile(user.win);
    await user.win.waitForSelector('#profile-nicknames .nickname-chip', { timeout: 8000 });
    const chips = await user.win.$$eval('#profile-nicknames .nickname-chip span', (els) => els.map((e) => e.textContent));
    assert.ok(chips.includes('Вася'), `expected the admin-set nickname, got ${JSON.stringify(chips)}`);
    await user.win.click('#btn-profile-close');
  });

  await step('the admin renames a nickname in the popup', async () => {
    await owner.win.hover(`#admin-users .admin-at[data-user="${peer}"]`);
    await owner.win.waitForSelector('.nick-pop', { timeout: 8000 });
    const input = owner.win.locator('.nick-pop-item input').first();
    await input.fill('Васёк');
    await input.press('Enter');
    await owner.win.waitForFunction(
      () => [...document.querySelectorAll('.nick-pop-item input')].some((i) => i.value === 'Васёк'),
      { timeout: 8000 }
    );
  });

  await step('the admin removes a nickname in the popup', async () => {
    await owner.win.hover(`#admin-users .admin-at[data-user="${peer}"]`);
    await owner.win.waitForSelector('.nick-pop', { timeout: 8000 });
    await owner.win.click('.nick-pop-item .admin-act.danger');
    await owner.win.waitForFunction(
      () => document.querySelectorAll('.nick-pop-item').length === 0,
      { timeout: 8000 }
    );
  });

  await step('no uncaught errors in either renderer', async () => {
    assert.deepStrictEqual(owner.errors, [], 'owner renderer errors');
    assert.deepStrictEqual(user.errors, [], 'user renderer errors');
  });

  await owner.app.close();
  await user.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} UI nickname checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
