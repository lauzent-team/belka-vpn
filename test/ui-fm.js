'use strict';

/**
 * Бурмалда FM as a user meets it: the station ships inside the app, so it plays
 * out of the box, repeats forever, and still lets the listener override it by
 * dropping their own tracks into the media folder.
 *
 * Run with: xvfb-run -a node test/ui-fm.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8831;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uifm-${Date.now()}.db`);
const BUNDLED = path.join(__dirname, '..', 'build', 'fm', 'burmalda-fm.ogg');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openStation(win) {
  if (await win.isVisible('#fm-overlay')) await win.click('#btn-fm-close');
  await win.click('#btn-menu');
  await win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
  await win.click('.drawer-item[data-drawer="burmalda"]');
  await win.waitForSelector('#fm-overlay:not([hidden])', { timeout: 8000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await sleep(1500);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-uifm-'));
  const errors = [];
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required'
    ],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));

  await signIn(win, URL, { username: 'fm_' + Math.random().toString(36).slice(2, 6) });

  await step('the station is on air without the listener adding anything', async () => {
    await openStation(win);
    assert.strictEqual((await win.textContent('.fm-title')).trim(), 'Бурмалда FM');
    await win.waitForSelector('.fm-track', { timeout: 8000 });
    assert.ok(!(await win.isVisible('#fm-empty')), 'the bundled station is not empty');
    const title = (await win.textContent('.fm-track-title')).trim();
    assert.ok(title.length > 0, 'the bundled track has a name');
  });

  await step('repeat-one is the default, so the station never falls silent', async () => {
    assert.strictEqual(await win.getAttribute('#btn-fm-repeat', 'data-mode'), 'one');
  });

  await step('the bundled track decodes and plays', async () => {
    await win.waitForFunction(
      () => {
        const el = document.getElementById('fm-dur');
        return el && el.textContent && el.textContent !== '0:00';
      },
      { timeout: 20000 }
    );
    const dur = (await win.textContent('#fm-dur')).trim();
    assert.ok(/^\d+:\d{2}$/.test(dur), `a real duration, got ${dur}`);
    const playing = await win.getAttribute('#btn-fm-play use', 'href');
    assert.strictEqual(playing, '#i-pause', 'playback started on its own');
  });

  await step('the repeat button cycles away from one and back', async () => {
    await win.click('#btn-fm-repeat');
    assert.strictEqual(await win.getAttribute('#btn-fm-repeat', 'data-mode'), 'off');
    await win.click('#btn-fm-repeat');
    await win.click('#btn-fm-repeat');
    assert.strictEqual(await win.getAttribute('#btn-fm-repeat', 'data-mode'), 'one');
  });

  await step("the listener's own tracks win over the bundled station", async () => {
    const mine = path.join(dir, 'media', 'fm');
    fs.mkdirSync(mine, { recursive: true });
    fs.copyFileSync(BUNDLED, path.join(mine, 'burmalda-fm.ogg'));
    fs.writeFileSync(path.join(mine, 'playlist.json'), JSON.stringify({
      tracks: [{ file: 'burmalda-fm.ogg', title: 'Мой эфир', artist: 'Я' }]
    }));
    await openStation(win);
    await win.waitForSelector('.fm-track', { timeout: 8000 });
    assert.strictEqual((await win.textContent('.fm-track-title')).trim(), 'Мой эфир');
  });

  await step('the volume slider is there and drives the readout', async () => {
    assert.ok(await win.isVisible('#fm-volume'), 'the volume slider is shown');
    assert.strictEqual((await win.textContent('#fm-volume-num')).trim(), '50', 'defaults to 50%');
    await win.fill('#fm-volume', '80');
    await win.dispatchEvent('#fm-volume', 'input');
    assert.strictEqual((await win.textContent('#fm-volume-num')).trim(), '80', 'the readout follows the slider');
  });

  await step('the mute button silences the station and comes back', async () => {
    await win.click('#btn-fm-mute');
    assert.strictEqual((await win.textContent('#fm-volume-num')).trim(), '80', 'the level is remembered');
    assert.ok(await win.evaluate(() => document.getElementById('btn-fm-mute').classList.contains('off')),
      'the button shows the muted state');
    await win.click('#btn-fm-mute');
    assert.ok(!(await win.evaluate(() => document.getElementById('btn-fm-mute').classList.contains('off'))),
      'and clears it again');
  });

  await step('no renderer errors were logged', async () => {
    const noisy = errors.filter((e) => !/Autofill|DevTools/.test(e));
    assert.deepStrictEqual(noisy, [], 'no uncaught errors');
  });

  await app.close();
  server.kill('SIGTERM');
  await sleep(300);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} Бурмалда FM checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
