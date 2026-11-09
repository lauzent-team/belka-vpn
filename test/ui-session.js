'use strict';

/**
 * Drives the real Electron UI for the two things a returning user notices
 * first: the app must not drop them on the sign-in screen when they reopen it,
 * and a profile photo must survive a save.
 *
 * Run with: xvfb-run -a node test/ui-session.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn, setAccountPassword } = require('./_auth');

const PORT = 8793;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uisess-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(dir) {
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

/** A 2x2 PNG, built in the page so the picker sees a real File. */
const PASTE_AVATAR = `(async () => {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#33cc88'; ctx.fillRect(0, 0, 2, 2);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'me.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const form = document.getElementById('profile-form');
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  form.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 700));
  const pv = document.getElementById('avatar-preview');
  return { html: pv.innerHTML.slice(0, 40), hint: document.getElementById('avatar-hint').textContent, formHidden: document.getElementById('profile-form').hidden };
})()`;

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uisess-'));
  const username = `reenter_${Math.random().toString(36).slice(2, 7)}`;

  const A = await launch(dir);
  await signIn(A.win, URL, { username });
  await setAccountPassword(A.win, 'password-1234');

  await step('a profile photo can be set from the clipboard and saved', async () => {
    await A.win.click('#btn-my-profile');
    await A.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    await A.win.click('#btn-profile-edit');
    await A.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });
    const pasted = await A.win.evaluate(PASTE_AVATAR);
    assert.ok(/avatar-img/.test(pasted.html), `the picked picture should show in the preview (hint: ${pasted.hint})`);
    // The preview switches from the initial to the picked picture.
    await A.win.waitForSelector('#avatar-preview img', { timeout: 8000 });
    await A.win.click('#profile-form button[type="submit"]');
    await A.win.waitForFunction(
      () => {
        const a = document.getElementById('me-avatar');
        return !!(a && a.querySelector('img'));
      },
      null,
      { timeout: 15000 }
    );
    await A.win.click('#btn-profile-close');
    await wait(200);
  });

  await step('reopening the app does not land on the sign-in screen', async () => {
    await A.app.close();
    await wait(400);
    // Same device directory: this is a person opening the app again.
    const B = await launch(dir);
    // It may ask for the password, but it must not treat the device as new.
    await B.win.waitForFunction(
      () => {
        const auth = document.getElementById('screen-auth');
        const unlock = document.getElementById('screen-unlock');
        const main = document.getElementById('screen-main');
        const onAuth = auth && auth.classList.contains('active');
        const onUnlock = unlock && unlock.classList.contains('active');
        const onMain = main && main.classList.contains('active');
        return !onAuth && (onUnlock || onMain);
      },
      null,
      { timeout: 15000 }
    );

    await step('the stored photo is still there on the next launch', async () => {
      if (await B.win.isVisible('#screen-unlock')) {
        await B.win.fill('#unlock-password', 'password-1234');
        await B.win.click('#form-unlock button[type="submit"]');
        await B.win.waitForSelector('#screen-main.active', { timeout: 20000 });
      }
      await B.win.waitForFunction(
        () => {
          const a = document.getElementById('me-avatar');
          return !!(a && a.querySelector('img'));
        },
        null,
        { timeout: 15000 }
      );
    });

    await step('no uncaught errors in the renderer', async () => {
      assert.deepStrictEqual(B.errors, [], `renderer errors: ${B.errors.join(' | ')}`);
    });
    await B.app.close();
  });

  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} session UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
