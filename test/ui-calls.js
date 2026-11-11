'use strict';

/**
 * A real call between two real windows, over a real relay, with WebRTC's fake
 * microphone and camera. Alice rings Bob, Bob picks up, the call goes active and
 * the timer runs; then Alice hangs up and both sides close. The relay only ever
 * sees the handshake, so this is the whole path a user's audio takes.
 *
 * The same suite checks the Бурмалда FM tab and that chats which cannot be
 * called do not offer the buttons.
 *
 * Run with: xvfb-run -a node test/ui-calls.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8826;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uicalls-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uicalls-${label}-`));
  const errors = [];
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win, dir, errors };
}

/** The folder the app seeds for the user's own music and ringtones. */
function mediaDir(profileDir, kind) {
  return path.join(profileDir, 'media', kind);
}

/** A one-second silent WAV, so the FM player has something real to decode. */
function makeWav() {
  const rate = 8000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

async function openChatWith(win, peer) {
  await win.fill('#search', peer);
  await win.press('#search', 'Enter');
  await win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
  await win.waitForSelector('#btn-call-audio:not([hidden])', { timeout: 8000 });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await sleep(1200);

  const a = await launch('a');
  const b = await launch('b');
  const suffix = Math.random().toString(36).slice(2, 6);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  await signIn(a.win, URL, { username: alice });
  await signIn(b.win, URL, { username: bob });

  // A message makes the chat real on both sides.
  await openChatWith(a.win, bob);
  await a.win.fill('#composer-input', 'привет');
  await a.win.press('#composer-input', 'Enter');
  await a.win.waitForSelector('#messages .msg', { timeout: 8000 });

  await step('the chat header offers audio and video calls', async () => {
    assert.ok(await a.win.isVisible('#btn-call-audio'), 'the audio button is shown');
    assert.ok(await a.win.isVisible('#btn-call-video'), 'the video button is shown');
  });

  await step('an outgoing call shows the in-call panel', async () => {
    await a.win.click('#btn-call-audio');
    await a.win.waitForSelector('#call-overlay:not([hidden])', { timeout: 10000 });
    const title = (await a.win.textContent('#call-title')).trim();
    assert.strictEqual(title, bob, 'the panel names the person being called');
  });

  await step('the callee sees the incoming-call ring', async () => {
    await b.win.waitForSelector('#call-ring:not([hidden])', { timeout: 10000 });
    const title = (await b.win.textContent('#ring-title')).trim();
    assert.strictEqual(title, alice, 'the ring names the caller');
  });

  await step('accepting connects the call and starts the timer', async () => {
    await b.win.click('#btn-ring-accept');
    await b.win.waitForSelector('#call-ring', { state: 'hidden', timeout: 10000 });
    await b.win.waitForSelector('#call-overlay:not([hidden])', { timeout: 10000 });
    // The connection is real: wait for the timer to leave 00:00.
    await b.win.waitForFunction(
      () => {
        const el = document.getElementById('call-timer');
        return el && !el.hidden && el.textContent !== '00:00';
      },
      { timeout: 25000 }
    );
    assert.ok(await a.win.isVisible('#call-overlay'), 'the caller is still in the call');
  });

  await step('the in-call controls are all present', async () => {
    assert.ok(await a.win.isVisible('#btn-call-mic'), 'mute');
    assert.ok(await a.win.isVisible('#btn-call-end'), 'hang up');
  });

  await step('hanging up closes the call on both sides', async () => {
    await a.win.click('#btn-call-end');
    await a.win.waitForSelector('#call-overlay', { state: 'hidden', timeout: 10000 });
    await b.win.waitForSelector('#call-overlay', { state: 'hidden', timeout: 10000 });
  });

  await step('a group call rings every member', async () => {
    // Alice makes a group with Bob and rings it.
    await a.win.click('#btn-menu');
    await a.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await a.win.click('.drawer-item[data-drawer="create"]');
    await a.win.waitForSelector('#create-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#create-group');
    await a.win.waitForSelector('#group-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.fill('#group-name', 'Звонок');
    await a.win.fill('#group-members', bob);
    await a.win.click('#btn-group-create');
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 10000 });
    await a.win.waitForSelector('#btn-call-audio:not([hidden])', { timeout: 8000 });
    await a.win.click('#btn-call-audio');
    await a.win.waitForSelector('#call-overlay:not([hidden])', { timeout: 10000 });

    await b.win.waitForSelector('#call-ring:not([hidden])', { timeout: 12000 });
    const title = (await b.win.textContent('#ring-title')).trim();
    assert.strictEqual(title, 'Звонок', 'the group name is on the ring');

    await b.win.click('#btn-ring-accept');
    await b.win.waitForSelector('#call-overlay:not([hidden])', { timeout: 10000 });
    await b.win.waitForFunction(
      () => {
        const el = document.getElementById('call-timer');
        return el && !el.hidden && el.textContent !== '00:00';
      },
      { timeout: 25000 }
    );
    await a.win.click('#btn-call-end');
    await a.win.waitForSelector('#call-overlay', { state: 'hidden', timeout: 10000 });
    await b.win.waitForSelector('#call-overlay', { state: 'hidden', timeout: 10000 });
  });

  await step('the Бурмалда FM tab opens the station', async () => {
    await a.win.click('#btn-menu');
    await a.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await a.win.click('.drawer-item[data-drawer="burmalda"]');
    await a.win.waitForSelector('#fm-overlay:not([hidden])', { timeout: 8000 });
    const title = (await a.win.textContent('.fm-title')).trim();
    assert.strictEqual(title, 'Бурмалда FM');
    // The station ships inside the app, so it has something to play before the
    // user drops in a single file of their own. test/ui-fm.js covers the rest.
    await a.win.waitForSelector('.fm-track', { timeout: 8000 });
    assert.ok(!(await a.win.isVisible('#fm-empty')), 'the bundled station is not empty');
  });

  await step('adding a track makes it playable', async () => {
    // The station reads its manifest from the user's own media folder, so a
    // track dropped in while the window is open appears on the next visit.
    const dir = mediaDir(a.dir, 'fm');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-tone.wav'), makeWav());
    fs.writeFileSync(path.join(dir, 'playlist.json'), JSON.stringify({
      tracks: [{ file: 'test-tone.wav', title: 'Тестовый эфир', artist: 'Бурмалда' }]
    }));
    await a.win.click('#btn-fm-close');
    await a.win.click('#btn-menu');
    await a.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await a.win.click('.drawer-item[data-drawer="burmalda"]');
    await a.win.waitForSelector('.fm-track', { timeout: 8000 });
    const t = (await a.win.textContent('.fm-track-title')).trim();
    assert.strictEqual(t, 'Тестовый эфир');
    assert.ok(!(await a.win.isVisible('#fm-empty')), 'the empty notice is gone');
  });

  await step('playing a track advances the transport', async () => {
    await a.win.click('.fm-track');
    await a.win.waitForFunction(
      () => {
        const el = document.getElementById('fm-dur');
        return el && el.textContent && el.textContent !== '0:00';
      },
      { timeout: 10000 }
    );
    const icon = await a.win.getAttribute('#btn-fm-play use', 'href');
    assert.strictEqual(icon, '#i-pause', 'the button offers pause while playing');
    await a.win.click('#btn-fm-play');
    const icon2 = await a.win.getAttribute('#btn-fm-play use', 'href');
    assert.strictEqual(icon2, '#i-play', 'and play again once paused');
    await a.win.click('#btn-fm-close');
    await a.win.waitForSelector('#fm-overlay', { state: 'hidden', timeout: 8000 });
  });

  await step('saved messages offers no call buttons', async () => {
    await a.win.click('#btn-menu');
    await a.win.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
    await a.win.click('.drawer-item[data-drawer="saved"]');
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    assert.ok(await a.win.isHidden('#btn-call-audio'), 'the audio button is hidden');
    assert.ok(await a.win.isHidden('#btn-call-video'), 'the video button is hidden');
  });

  await step('no renderer errors were logged', async () => {
    const noisy = [...a.errors, ...b.errors].filter((e) => !/Autofill|DevTools/.test(e));
    assert.deepStrictEqual(noisy, [], 'no uncaught errors');
  });

  await a.app.close();
  await b.app.close();
  server.kill('SIGTERM');
  await sleep(300);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} call UI checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
