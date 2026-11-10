'use strict';

/**
 * The expanded admin panel, driven through the real UI.
 *
 * The relay names its first administrator in code, so this suite points
 * SLEEPHY_ADMINS at the account it signs in as. It checks the panel's tabs,
 * filter chips, richer stats, the overflow menu of less common actions and the
 * action log — all over the real relay, with no mocks.
 *
 * Run with: xvfb-run -a node test/ui-admin.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8814;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uiadmin-${Date.now()}.db`);
const ADMIN = 'panel_admin';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uiadmin-${label}-`));
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win, errors };
}

async function openAdmin(win) {
  await win.click('#btn-settings');
  await win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 8000 });
  await win.click('.settings-nav-item[data-pane="admin"]');
  await win.waitForSelector('.settings-pane[data-pane="admin"].active', { timeout: 8000 });
  await win.waitForSelector('#admin-users .admin-user', { timeout: 10000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_ADMINS: ADMIN
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 6);
  const admin = await launch('admin');
  const other = await launch('other');
  await signIn(admin.win, URL, { username: ADMIN });
  await signIn(other.win, URL, { username: `panelu_${suffix}` });

  await step('the admin panel opens with the four tabs', async () => {
    await openAdmin(admin.win);
    const tabs = await admin.win.$$eval('.admin-tab', (els) => els.map((e) => e.dataset.tab));
    assert.deepStrictEqual(tabs, ['users', 'channels', 'log', 'broadcast']);
  });

  await step('the stats strip shows the expanded counters', async () => {
    const labels = await admin.win.$$eval('#admin-stats .admin-stat-label', (els) => els.map((e) => e.textContent));
    for (const want of ['Пользователей', 'Онлайн', 'Сообщений', 'Каналов', 'Проверено', 'Заблокировано', 'Огоньков']) {
      assert.ok(labels.includes(want), `stats should include ${want}, got ${labels.join(', ')}`);
    }
  });

  await step('a user row shows the richer detail line', async () => {
    const meta = await admin.win.$eval('#admin-users .admin-user .admin-user-meta', (e) => e.textContent);
    assert.ok(/отпр\./.test(meta) && /получ\./.test(meta), `meta line looked wrong: ${meta}`);
  });

  await step('the filter chips narrow the list', async () => {
    await admin.win.click('.admin-filter[data-filter="admins"]');
    await wait(150);
    const names = await admin.win.$$eval('#admin-users .admin-user .admin-user-sub .admin-at', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(names.map((n) => n.replace('@', '')), [ADMIN], 'only the admin should remain');
    await admin.win.click('.admin-filter[data-filter="all"]');
    await wait(150);
    const all = await admin.win.$$eval('#admin-users .admin-user', (els) => els.length);
    assert.ok(all >= 2, 'the full list returns');
  });

  await step('a tab switch shows the log pane', async () => {
    await admin.win.click('.admin-tab[data-tab="log"]');
    await admin.win.waitForSelector('.admin-tabpane[data-tab="log"].active', { timeout: 8000 });
  });

  await step('the broadcast tab sends an announcement and logs it', async () => {
    await admin.win.click('.admin-tab[data-tab="broadcast"]');
    await admin.win.fill('#admin-announce-input', 'Всем привет');
    await admin.win.click('#btn-admin-announce');
    await admin.win.waitForFunction(
      () => [...document.querySelectorAll('#admin-announcements .admin-log-line')]
        .some((e) => (e.textContent || '').includes('Всем привет')),
      null, { timeout: 8000 }
    );
    await admin.win.click('.admin-tab[data-tab="log"]');
    await admin.win.waitForFunction(
      () => [...document.querySelectorAll('#admin-log .admin-log-line')]
        .some((e) => (e.textContent || '').includes('Объявление')),
      null, { timeout: 8000 }
    );
  });

  await step('the overflow menu offers the less common actions', async () => {
    await admin.win.click('.admin-tab[data-tab="users"]');
    await admin.win.waitForSelector('#admin-users .admin-user [data-act="more"]', { timeout: 8000 });
    // Open the menu on a row that is not the acting admin.
    const btn = await admin.win.$(`#admin-users .admin-user [data-act="more"]`);
    await btn.click();
    await admin.win.waitForSelector('.admin-more-pop', { timeout: 8000 });
    const items = await admin.win.$$eval('.admin-more-pop .admin-more-item', (els) => els.map((e) => e.textContent));
    assert.ok(items.some((t) => /переписку/i.test(t)), 'the menu should offer clearing the chat');
    assert.ok(items.some((t) => /удалить аккаунт/i.test(t)), 'the menu should offer deleting the account');
    await admin.win.keyboard.press('Escape');
    await admin.win.mouse.click(5, 5);
    await wait(150);
  });

  await step('the panel works for a non-admin too, by hiding the section', async () => {
    // The non-admin never sees the admin nav item.
    await other.win.click('#btn-settings');
    await other.win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 8000 });
    const hidden = await other.win.$eval('#settings-nav-admin', (e) => e.hidden);
    assert.strictEqual(hidden, true, 'the admin section must be hidden for a non-admin');
  });

  await step('no console errors along the way', async () => {
    const bad = admin.errors.concat(other.errors).filter((e) => !/DevTools|Autofill/i.test(e));
    assert.deepStrictEqual(bad, []);
  });

  admin.app.close();
  other.app.close();
  server.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} admin panel checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
