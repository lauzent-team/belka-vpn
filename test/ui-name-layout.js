'use strict';

/**
 * A long name must not push the badge or picture onto its own line.
 *
 * Field report: "if the nickname is long, the checkmark or the picture slides
 * down under the name, and it looks bad". This drives the real app: one account
 * takes a very long display name and gets a badge, then the viewer opens the
 * conversation and the badge must stay on the name's first line, inside the
 * header.
 *
 * Run with: xvfb-run -a node test/ui-name-layout.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8800 + Math.floor(Math.random() * 100);
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uiname-${Date.now()}.db`);
const ADMIN = 'name_admin';
const LONG_NAME = 'ОченьДлинноеИмяПользователяКотороеНеПомещаетсяВШапкуЧата';

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
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: ADMIN },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const peer = `longname_${suffix}`;
  const viewer = `watcher_${suffix}`;

  const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uiname-admin-'));
  const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uiname-peer-'));
  const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uiname-viewer-'));

  const admin = await launch(adminDir);
  const pr = await launch(peerDir);
  const vw = await launch(viewerDir);
  await signIn(admin.win, URL, { username: ADMIN });
  await signIn(pr.win, URL, { username: peer });
  await signIn(vw.win, URL, { username: viewer });

  await step('the peer takes a very long display name', async () => {
    await pr.win.click('#btn-my-profile');
    await pr.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    await pr.win.click('#btn-profile-edit');
    await pr.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });
    await pr.win.fill('#profile-name', LONG_NAME);
    await pr.win.click('#profile-form button[type="submit"]');
    await pr.win.waitForFunction(
      (n) => document.getElementById('me-name').textContent === n,
      LONG_NAME,
      { timeout: 15000 }
    );
    await pr.win.click('#btn-profile-close');
    await wait(200);
  });

  await step('the peer writes to the viewer so a chat row exists', async () => {
    await pr.win.evaluate(async (to) => {
      await window.sleephy.send({ to, text: 'привет' });
    }, viewer);
    await wait(300);
  });

  await step('the admin verifies the peer and gives a badge picture', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAtdgL1h4kAAAAASUVORK5CYII=';
    await admin.win.evaluate(async ({ user, image }) => {
      await window.sleephy.adminAction({ action: 'verify', username: user });
      await window.sleephy.adminAction({ action: 'badge', username: user, image });
    }, { user: peer, image: png });
    await wait(300);
  });

  await step('the viewer opens the conversation', async () => {
    await vw.win.click(`#chat-list .chat-item[data-peer="${peer}"]`);
    await vw.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await vw.win.waitForSelector('#peer-badge:not([hidden])', { timeout: 15000 });
    await wait(200);
  });

  await step('the badge sits on the name line, not under a wrapped name', async () => {
    const box = await vw.win.evaluate(() => {
      const name = document.getElementById('peer-name');
      const badge = document.getElementById('peer-badge');
      const head = document.querySelector('.chat-head');
      const n = name.getBoundingClientRect();
      const b = badge.getBoundingClientRect();
      const h = head.getBoundingClientRect();
      return { nameTop: n.top, nameBottom: n.bottom, badgeTop: b.top, badgeBottom: b.bottom, headRight: h.right, nameRight: n.right };
    });
    assert.ok(box.badgeTop - box.nameTop < 8,
      `the badge must share the name's first line (name top ${box.nameTop}, badge top ${box.badgeTop})`);
    assert.ok(box.nameRight <= box.headRight + 1,
      'a long name must wrap inside the header, not overflow it');
  });

  await step('the wrapped name is fully readable, not clipped', async () => {
    const fits = await vw.win.evaluate(() => {
      const name = document.getElementById('peer-name');
      return name.scrollHeight <= name.clientHeight + 1;
    });
    assert.ok(fits, 'the name must wrap rather than be clipped');
  });

  await step('no uncaught errors in the renderer', async () => {
    assert.deepStrictEqual(vw.errors, [], `renderer errors: ${vw.errors.join(' | ')}`);
  });

  await admin.app.close();
  await pr.app.close();
  await vw.app.close();
  server.kill('SIGTERM');
  await wait(300);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} name-layout UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
