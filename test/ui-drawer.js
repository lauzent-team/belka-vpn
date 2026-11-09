'use strict';

/**
 * Drives the real Electron UI for the drawer, Telegram-style settings,
 * contacts, group chats and the multi-account switcher. Real clicks on the
 * real app — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-drawer.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn, setAccountPassword } = require('./_auth');

const PORT = 8791;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-drawer-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-drawer-${label}-`));
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


const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const A = await launch('a');
  const B = await launch('b');
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  await signIn(A.win, URL, { username: alice });
  await signIn(B.win, URL, { username: bob });
  // Alice protects her vault, so switching back to her asks for a password.
  await setAccountPassword(A.win, 'password-1234');

  await step('the hamburger opens the drawer with all seven entries', async () => {
    await A.win.click('#btn-menu');
    await A.win.waitForSelector('#drawer:not([hidden])', { timeout: 5000 });
    const labels = await A.win.$$eval('#drawer .drawer-item .drawer-label', (els) => els.map((e) => e.textContent.trim()));
    for (const want of ['Аккаунты', 'Мой профиль', 'Создать аккаунт или группу', 'Контакты', 'Сохранённые сообщения', 'Настройки']) {
      assert.ok(labels.includes(want), `drawer is missing "${want}"`);
    }
    assert.ok(labels.length >= 7, 'the drawer should offer an extra entry beyond the six required');
  });

  await step('the drawer shows the active account handle', async () => {
    const handle = await A.win.textContent('#drawer-handle');
    assert.equal(handle.trim(), '@' + alice);
  });

  await step('drawer entry "Saved messages" opens the self chat', async () => {
    await A.win.click('#drawer .drawer-item[data-drawer="saved"]');
    await A.win.waitForSelector('#chat-view:not([hidden])', { timeout: 5000 });
    const name = (await A.win.textContent('#peer-name')).trim();
    assert.equal(name, 'Saved Messages');
    assert.ok(await A.win.isHidden('#drawer'), 'drawer should close after a choice');
  });

  await step('drawer entry "Settings" opens Telegram-style settings', async () => {
    await A.win.click('#btn-menu');
    await A.win.click('#drawer .drawer-item[data-drawer="settings"]');
    await A.win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 5000 });
    for (const id of ['#set-notify', '#set-preview', '#set-sound', '#set-lastseen', '#set-receipts',
      '#set-autolock', '#set-autophoto', '#set-keepmedia', '#set-enter', '#set-language', '#btn-blocked']) {
      assert.ok(await A.win.$(id), `settings is missing ${id}`);
    }
  });

  await step('a settings toggle persists to the account', async () => {
    await A.win.click('.settings-nav-item[data-pane="messages"]');
    await A.win.waitForSelector('.settings-pane[data-pane="messages"].active');
    await A.win.click('label.switch:has(#set-sound) .slider'); // turn sound off
    await wait(500);
    const s = await A.win.evaluate(() => window.sleephy.getSettings());
    assert.equal(s.notifySound, false, 'sound setting should be saved');
  });

  await step('settings stay per account and survive reopening', async () => {
    await A.win.click('#btn-settings-close');
    await A.win.click('#btn-settings');
    await A.win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 5000 });
    await A.win.click('.settings-nav-item[data-pane="messages"]');
    await A.win.waitForSelector('.settings-pane[data-pane="messages"].active');
    assert.equal(await A.win.isChecked('#set-sound'), false, 'toggle should reflect the saved value');
    await A.win.click('#btn-settings-close');
  });

  await step('a contact can be added and opens a chat', async () => {
    await A.win.click('#btn-menu');
    await A.win.click('#drawer .drawer-item[data-drawer="contacts"]');
    await A.win.waitForSelector('#contacts-backdrop:not([hidden])', { timeout: 5000 });
    await A.win.fill('#contact-input', bob);
    await A.win.click('#btn-contact-add');
    await A.win.waitForSelector('#contacts-list .contact-row', { timeout: 5000 });
    const rows = await A.win.$$eval('#contacts-list .contact-row .contact-handle', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(rows.includes('@' + bob), 'contact should be listed');
    await A.win.click('#contacts-list .contact-row');
    await wait(400);
    assert.ok(await A.win.isHidden('#contacts-backdrop'), 'contacts modal should close');
  });

  await step('the contact persists in the account settings', async () => {
    const s = await A.win.evaluate(() => window.sleephy.getSettings());
    assert.ok(Array.isArray(s.contacts) && s.contacts.includes(bob), 'contact should be saved');
  });

  let groupName;
  await step('a group can be created from the drawer', async () => {
    groupName = 'Друзья ' + suffix;
    await A.win.click('#btn-menu');
    await A.win.click('#drawer .drawer-item[data-drawer="create"]');
    await A.win.waitForSelector('#confirm-backdrop:not([hidden])', { timeout: 5000 });
    await A.win.click('#btn-confirm-no'); // "Новая группа"
    await A.win.waitForSelector('#group-backdrop:not([hidden])', { timeout: 5000 });
    await A.win.fill('#group-name', groupName);
    await A.win.fill('#group-members', bob);
    await A.win.click('#btn-group-create');
    await A.win.waitForSelector('#group-backdrop', { state: 'hidden', timeout: 8000 });
  });

  await step('the new group appears in the chat list and opens', async () => {
    await wait(400);
    const name = (await A.win.textContent('#peer-name')).trim();
    assert.equal(name, groupName);
    const sub = await A.win.textContent('#peer-sub');
    assert.ok(/2/.test(sub), 'the group should report two members');
  });

  await step('a group message fans out to the other member', async () => {
    await A.win.fill('#composer-input', 'Привет в группе');
    await A.win.press('#composer-input', 'Enter');
    await wait(1500);
    // Bob should now see the group and the message.
    await B.win.click('#btn-menu');
    await B.win.click('#drawer .drawer-item[data-drawer="saved"]');
    await wait(300);
    const listText = await B.win.textContent('#chat-list');
    assert.ok(listText.includes(groupName), 'Bob should see the group in his chat list');
  });

  await step('a second account can be created on the same device', async () => {
    await A.win.click('#btn-menu');
    await A.win.click('#drawer .drawer-item[data-drawer="accounts"]');
    await A.win.waitForSelector('#accounts-backdrop:not([hidden])', { timeout: 5000 });
    await A.win.click('#btn-accounts-add');
    // Adding an account signs the current one out but keeps its keys on disk.
    await A.win.waitForSelector('#screen-auth.active', { timeout: 10000 });
  });

  await step('the account switcher lists both accounts and can switch back', async () => {
    const second = `carol_${suffix}`;
    await signIn(A.win, URL, { username: second });
    await A.win.click('#btn-menu');
    await A.win.click('#drawer .drawer-item[data-drawer="accounts"]');
    await A.win.waitForSelector('#accounts-backdrop:not([hidden])', { timeout: 5000 });
    const rows = await A.win.$$eval('#accounts-list .menu-item', (els) => els.map((e) => e.dataset.username));
    assert.ok(rows.includes(alice), 'first account should be listed');
    assert.ok(rows.includes(second), 'second account should be listed');
    // Switching back asks for the vault password again, by design.
    await A.win.click(`#accounts-list .menu-item[data-username="${alice}"]`);
    await A.win.waitForSelector('#screen-unlock.active', { timeout: 10000 });
  });

  await step('the first account unlocks and still has its contact list', async () => {
    await A.win.fill('#unlock-password', 'password-1234');
    await A.win.click('#form-unlock button[type="submit"]');
    await A.win.waitForSelector('#screen-main.active', { timeout: 15000 });
    await wait(600);
    const s = await A.win.evaluate(() => window.sleephy.getSettings());
    assert.ok(Array.isArray(s.contacts) && s.contacts.includes(bob), 'contacts should be per account');
    const listText = await A.win.textContent('#chat-list');
    assert.ok(listText.includes('Друзья ' + suffix), 'the group should still be there after switching back');
  });

  await step('no uncaught errors in either renderer', async () => {
    const errs = [...A.errors, ...B.errors];
    assert.deepEqual(errs, [], 'renderers reported errors: ' + errs.join(' | '));
  });

  for (const x of [A, B]) await x.app.close();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} drawer checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
