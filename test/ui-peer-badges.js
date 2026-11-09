'use strict';

/**
 * The other person's checkmark and badge picture must be there after a re-entry.
 *
 * Field report: "on re-entry the other person loses the checkmark and the
 * picture". This drives the real app: an admin gives a friend a badge picture,
 * then the viewer closes and reopens the app and must still see it in the chat
 * list, without opening the conversation first.
 *
 * Run with: xvfb-run -a node test/ui-peer-badges.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn, DEFAULT_PASSWORD } = require('./_auth');

const PORT = 8798;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uibadge-${Date.now()}.db`);
const ADMIN = 'badge_admin';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A 2x2 PNG, built in the page so the picker sees a real File.
const PASTE_AVATAR = `(async () => {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cc3344'; ctx.fillRect(0, 0, 2, 2);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'me.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const form = document.getElementById('profile-form');
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  form.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 700));
})()`;

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

/** True when the friend's chat row shows the badge picture and a picture avatar. */
function rowHasBadgeAndPicture(win, friend) {
  return win.evaluate((peer) => {
    const items = Array.from(document.querySelectorAll('#chat-list .chat-item'));
    const row = items.find((el) => {
      const name = el.querySelector('.chat-item-name');
      return name && name.textContent.includes(peer);
    });
    if (!row) return { found: false };
    const badge = row.querySelector('.verified-badge');
    const badgeImg = row.querySelector('.verified-badge.verified-badge-img img');
    const avatarImg = row.querySelector('.avatar img.avatar-img');
    return {
      found: true,
      badgeVisible: !!(badge && !badge.hidden),
      badgeImage: badgeImg ? badgeImg.getAttribute('src') : null,
      avatarImage: avatarImg ? avatarImg.getAttribute('src') : null
    };
  }, friend);
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: ADMIN },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const friend = `friend_${suffix}`;
  const viewer = `viewer_${suffix}`;

  const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uibadge-admin-'));
  const friendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uibadge-friend-'));
  const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uibadge-viewer-'));

  const admin = await launch(adminDir);
  const fr = await launch(friendDir);
  const viewer1 = await launch(viewerDir);
  await signIn(admin.win, URL, { username: ADMIN });
  await signIn(fr.win, URL, { username: friend });
  await signIn(viewer1.win, URL, { username: viewer });

  await step('the friend sets a profile picture', async () => {
    await fr.win.click('#btn-my-profile');
    await fr.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    await fr.win.click('#btn-profile-edit');
    await fr.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });
    await fr.win.evaluate(PASTE_AVATAR);
    await fr.win.waitForSelector('#avatar-preview img', { timeout: 8000 });
    await fr.win.click('#profile-form button[type="submit"]');
    await fr.win.waitForFunction(
      () => !!(document.getElementById('me-avatar') || {}).querySelector?.('img'),
      null, { timeout: 15000 }
    );
    await fr.win.click('#btn-profile-close');
    await wait(200);
  });

  await step('the friend writes to the viewer so a chat row exists', async () => {
    await fr.win.evaluate(async (to) => {
      await window.sleephy.send({ to, text: 'привет' });
    }, viewer);
    await wait(300);
  });

  await step('the admin verifies the friend and gives a badge picture', async () => {
    const png = await fr.win.evaluate(() => document.querySelector('#me-avatar img').getAttribute('src'));
    assert.ok(/^data:image\//.test(png), 'the friend should have a picture to reuse as a badge');
    await admin.win.evaluate(async ({ user, image }) => {
      await window.sleephy.adminAction({ action: 'verify', username: user });
      await window.sleephy.adminAction({ action: 'badge', username: user, image });
    }, { user: friend, image: png });
    await wait(300);
  });

  await step('the viewer sees the checkmark and picture while online', async () => {
    await viewer1.win.waitForFunction(
      (peer) => {
        const items = Array.from(document.querySelectorAll('#chat-list .chat-item'));
        const row = items.find((el) => {
          const n = el.querySelector('.chat-item-name');
          return n && n.textContent.includes(peer);
        });
        if (!row) return false;
        const badge = row.querySelector('.verified-badge.verified-badge-img img');
        const avatar = row.querySelector('.avatar img.avatar-img');
        return !!(badge && avatar);
      },
      friend,
      { timeout: 15000 }
    );
  });

  await viewer1.app.close();
  await wait(400);

  await step('after a re-entry the badge and picture are still shown', async () => {
    const viewer2 = await launch(viewerDir);
    // Same device: it may ask for the password, but must not be a fresh sign-in.
    await viewer2.win.waitForFunction(
      () => {
        const onAuth = document.getElementById('screen-auth').classList.contains('active');
        return !onAuth;
      },
      null,
      { timeout: 15000 }
    );
    if (await viewer2.win.isVisible('#screen-unlock')) {
      await viewer2.win.fill('#unlock-password', DEFAULT_PASSWORD);
      await viewer2.win.click('#form-unlock button[type="submit"]');
      await viewer2.win.waitForSelector('#screen-main.active', { timeout: 20000 });
    }
    // The badge must be there without opening the conversation first.
    await viewer2.win.waitForFunction(
      (peer) => {
        const items = Array.from(document.querySelectorAll('#chat-list .chat-item'));
        const row = items.find((el) => {
          const n = el.querySelector('.chat-item-name');
          return n && n.textContent.includes(peer);
        });
        if (!row) return false;
        const badge = row.querySelector('.verified-badge.verified-badge-img img');
        const avatar = row.querySelector('.avatar img.avatar-img');
        return !!(badge && avatar);
      },
      friend,
      { timeout: 15000 }
    );
    const state = await rowHasBadgeAndPicture(viewer2.win, friend);
    assert.ok(state.badgeVisible, 'the checkmark must be visible');
    assert.ok(/^data:image\//.test(state.badgeImage || ''), 'the badge must be the picture');
    assert.ok(/^data:image\//.test(state.avatarImage || ''), 'the avatar must be the picture');

    await step('the conversation header shows it too', async () => {
      await viewer2.win.click(`#chat-list .chat-item:has-text("${friend}")`);
      await viewer2.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
      const header = await viewer2.win.evaluate(() => ({
        badge: !!document.querySelector('#peer-badge.verified-badge-img img'),
        badgeHidden: document.getElementById('peer-badge').hidden,
        avatar: !!document.querySelector('#peer-avatar img.avatar-img')
      }));
      assert.ok(!header.badgeHidden, 'the header checkmark must be visible');
      assert.ok(header.badge, 'the header badge must be the picture');
      assert.ok(header.avatar, 'the header avatar must be the picture');
    });

    await step('no uncaught errors in the renderer', async () => {
      assert.deepStrictEqual(viewer2.errors, [], `renderer errors: ${viewer2.errors.join(' | ')}`);
    });
    await viewer2.app.close();
  });

  await admin.app.close();
  await fr.app.close();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} peer-badge UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
