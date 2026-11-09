'use strict';

/**
 * The "Выбрать фото" button must actually attach a picture.
 *
 * The clipboard path is covered by test/ui-session.js, but a person is far more
 * likely to click the button and pick a file. This drives that button for real
 * and checks the picture reaches the preview, is saved, and shows on the profile.
 *
 * Run with: xvfb-run -a node test/ui-avatar.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8796;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uiavatar-${Date.now()}.db`);

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

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  // A real 8x8 PNG on disk, the way a person has one in Pictures.
  const pngPath = path.join(os.tmpdir(), `sleephy-avatar-${Date.now()}.png`);
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GKgIlhFIxsAAB2agQB6hL1sQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(pngPath, pngBytes);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uiavatar-'));
  const username = `avatar_${Math.random().toString(36).slice(2, 7)}`;

  const A = await launch(dir);
  await signIn(A.win, URL, { username });

  await step('the "Выбрать фото" button opens a picker and previews the picture', async () => {
    await A.win.click('#btn-my-profile');
    await A.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    await A.win.click('#btn-profile-edit');
    await A.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });

    const chooserPromise = A.win.waitForEvent('filechooser', { timeout: 8000 });
    await A.win.click('#btn-avatar-pick');
    let chooser;
    try {
      chooser = await chooserPromise;
    } catch (err) {
      throw new Error('clicking "Выбрать фото" did not open a file picker');
    }
    await chooser.setFiles(pngPath);
    await A.win.waitForSelector('#avatar-preview img', { timeout: 8000 });
    const hint = await A.win.textContent('#avatar-hint');
    assert.ok(!/Нужна картинка|слишком большая|Не удалось/.test(hint || ''), `hint shows a failure: ${hint}`);
  });

  await step('saving shows the picture on the profile and the header', async () => {
    await A.win.click('#profile-form button[type="submit"]');
    await A.win.waitForFunction(
      () => {
        const a = document.getElementById('me-avatar');
        return !!(a && a.querySelector('img'));
      },
      null,
      { timeout: 15000 }
    );
    const shown = await A.win.evaluate(() => {
      const pv = document.getElementById('profile-avatar');
      return !!(pv && pv.querySelector('img'));
    });
    assert.ok(shown, 'the profile view should show the saved picture');
  });

  await step('the relay stored the picture', async () => {
    const saved = await A.win.evaluate(async () => {
      const s = await window.sleephy.status();
      return s.profile && s.profile.avatarImage ? s.profile.avatarImage.slice(0, 15) : null;
    });
    assert.ok(saved && saved.startsWith('data:image/'), `relay profile has no picture: ${saved}`);
  });

  await step('no uncaught errors in the renderer', async () => {
    assert.deepStrictEqual(A.errors, [], `renderer errors: ${A.errors.join(' | ')}`);
  });

  await A.app.close();
  server.kill('SIGTERM');
  await wait(300);
  try { fs.rmSync(pngPath, { force: true }); } catch {}
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} avatar UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
