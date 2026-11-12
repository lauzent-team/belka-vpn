'use strict';

/**
 * Rockets and Premium, clicked for real.
 *
 * The relay settles the money; this suite checks the wiring from the settings
 * panes to that settlement: the sign-up grant is visible, a bundle can be
 * bought and the balance moves, Premium activates and survives a re-read, and
 * a gift spends Rockets and reaches the peer. The mock provider is used, so no
 * real payment is involved.
 *
 * Run with: xvfb-run -a node test/ui-premium.js
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
const DB = path.join(os.tmpdir(), `sleephy-uiprem-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uiprem-${label}-`));
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

async function openPane(win, pane) {
  const open = await win.isVisible('#settings-backdrop');
  if (!open) await win.click('#btn-settings');
  await win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 8000 });
  await win.click(`.settings-nav-item[data-pane="${pane}"]`);
  await win.waitForSelector(`.settings-pane[data-pane="${pane}"].active`, { timeout: 8000 });
}

async function balance(win) {
  return Number(await win.textContent('#rockets-balance'));
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_PAY_PROVIDER: 'mock'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const u = await launch('u');
  const s = Math.random().toString(36).slice(2, 6);
  const me = `buyer_${s}`;
  await signIn(u.win, URL, { username: me });
  let v = null;
  let peer = null;

  await step('the sign-up grant shows in the Rockets pane', async () => {
    await openPane(u.win, 'rockets');
    // The relay grants a small welcome balance; the pane must show it, not 0.
    await u.win.waitForFunction(
      () => Number(document.getElementById('rockets-balance').textContent) > 0,
      null, { timeout: 8000 }
    );
    assert.strictEqual(await balance(u.win), 10, 'the welcome grant is 10');
  });

  await step('the bundle shelf lists every bundle with a price', async () => {
    const n = await u.win.$$eval('#rocket-bundles .rocket-bundle', (e) => e.length);
    assert.strictEqual(n, 6, `expected 6 bundles, got ${n}`);
    const first = await u.win.textContent('#rocket-bundles .rocket-bundle');
    assert.ok(first.includes('50'), 'the first bundle is 50');
    assert.ok(first.includes('44.5'), 'and costs 44.5 ₽');
  });

  await step('Premium starts inactive', async () => {
    await openPane(u.win, 'premium');
    await u.win.waitForSelector('#premium-badge', { timeout: 8000 });
    assert.strictEqual(await u.win.textContent('#premium-badge'), 'Не активна');
    assert.strictEqual(await u.win.textContent('#premium-price'), '199');
    assert.ok((await u.win.textContent('#btn-buy-premium')).includes('Оформить'));
  });

  await step('buying a bundle raises the balance', async () => {
    await openPane(u.win, 'rockets');
    const before = await balance(u.win);
    await u.win.click('#rocket-bundles .rocket-bundle[data-rockets="50"]');
    await u.win.waitForFunction(
      (b) => Number(document.getElementById('rockets-balance').textContent) === b + 50,
      before, { timeout: 8000 }
    );
    assert.strictEqual(await balance(u.win), before + 50, 'credited 50');
  });

  await step('buying Premium activates it and shows the date', async () => {
    await openPane(u.win, 'premium');
    await u.win.click('#btn-buy-premium');
    await u.win.waitForFunction(
      () => document.getElementById('premium-badge').textContent === 'Активна',
      null, { timeout: 8000 }
    );
    const status = await u.win.textContent('#premium-status');
    assert.ok(/Активна до \d/.test(status), `status was "${status}"`);
    assert.ok((await u.win.textContent('#btn-buy-premium')).includes('Продлить'), 'now offers renewal');
    // Buying Premium must not have spent Rockets.
    await openPane(u.win, 'rockets');
    assert.strictEqual(await balance(u.win), 60, 'Rockets are untouched by Premium');
  });

  await step('a locked gift is drawn locked until it can be afforded', async () => {
    v = await launch('v');
    peer = `peer_${s}`;
    await signIn(v.win, URL, { username: peer });
    // Open the conversation on the peer's device so the gift has somewhere to
    // land, then on the sender's device.
    await v.win.fill('#search', me);
    await v.win.press('#search', 'Enter');
    await v.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await u.win.click('#btn-settings-close');
    await u.win.fill('#search', peer);
    await u.win.press('#search', 'Enter');
    await u.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await u.win.click('#btn-attach');
    await u.win.waitForSelector('#attach-menu', { timeout: 8000 });
    await u.win.click('[data-attach="gift"]');
    await u.win.waitForSelector('#gifts-backdrop:not([hidden])', { timeout: 8000 });
    // 60 Rockets: the 100-Rocket crown cannot be afforded and must look locked.
    const locked = await u.win.$eval('#gifts-grid .gift-card[data-gift="crown"]', (el) => el.className);
    assert.ok(locked.includes('gift-card-locked'), `crown class was "${locked}"`);
    const affordable = await u.win.$eval('#gifts-grid .gift-card[data-gift="rose"]', (el) => el.className);
    assert.ok(!affordable.includes('gift-card-locked'), 'the rose is affordable');
  });

  await step('sending a gift spends Rockets and reaches the peer', async () => {
    await u.win.click('#gifts-grid .gift-card[data-gift="rose"]');
    await u.win.waitForSelector('#gifts-compose:not([hidden])', { timeout: 8000 });
    await u.win.click('#btn-gift-send');
    await u.win.waitForSelector('#messages .gift-bubble', { timeout: 8000 });
    await v.win.waitForSelector('#messages .gift-bubble', { timeout: 10000 });
    // The rose costs 1 Rocket; the balance must fall by exactly one.
    await u.win.waitForFunction(
      () => Number(document.getElementById('rockets-balance').textContent) === 59,
      null, { timeout: 8000 }
    );
  });

  await step('no uncaught errors in either renderer', async () => {
    assert.deepStrictEqual(u.errors, [], 'buyer renderer errors');
    assert.deepStrictEqual(v.errors, [], 'peer renderer errors');
  });

  await v.app.close();
  await u.app.close();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} UI checks passed`);
  server.kill();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
