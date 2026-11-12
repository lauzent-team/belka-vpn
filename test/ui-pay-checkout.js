'use strict';

/**
 * A purchase, clicked for real, now goes through a payment page.
 *
 * This is the user-visible half of the checkout change: clicking a bundle no
 * longer credits the wallet on the spot. The app opens a payment screen in the
 * browser and shows a "waiting for payment" line; confirming credits the
 * wallet, while backing out (the browser posting /pay/cancel) credits nothing
 * and shows a cancellation notice.
 *
 * The browser is not really opened here: shell.openExternal is stubbed in the
 * main process so the test can see the URL the app would open and drive the
 * relay's confirm/cancel endpoints itself.
 *
 * Run with: xvfb-run -a node test/ui-pay-checkout.js
 */

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8833;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-ui-checkout-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const post = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST' }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-ui-checkout-${label}-`));
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  // Capture what the app would open instead of launching a real browser.
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => { global.__opened.push(url); return true; };
  });
  return { app, win, dir, errors };
}

const openedUrls = (app) => app.evaluate(() => global.__opened || []);
const lastPaymentId = (app) => app.evaluate(() => {
  const url = (global.__opened || []).slice(-1)[0] || '';
  const m = /[?&]id=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
});

async function openPane(win, pane) {
  const open = await win.isVisible('#settings-backdrop');
  if (!open) await win.click('#btn-settings');
  await win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 8000 });
  await win.click(`.settings-nav-item[data-pane="${pane}"]`);
  await win.waitForSelector(`.settings-pane[data-pane="${pane}"].active`, { timeout: 8000 });
}

const balance = async (win) => Number(await win.textContent('#rockets-balance'));

/** The app checks on focus; this is the "user came back from the browser". */
const returnToApp = (win) => win.evaluate(() => window.dispatchEvent(new Event('focus')));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      // The built-in checkout is the deliberate demo path, so it is opt-in.
      SLEEPHY_PAY_DEMO: '1'
      // No SLEEPHY_PAY_PROVIDER: the default is the built-in checkout page.
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const u = await launch('u');
  const me = `buyer_${Math.random().toString(36).slice(2, 6)}`;
  await signIn(u.win, URL, { username: me });

  await step('buying a bundle opens a payment page instead of crediting at once', async () => {
    await openPane(u.win, 'rockets');
    const before = await balance(u.win);
    await u.win.click('#rocket-bundles .rocket-bundle[data-rockets="50"]');
    // A checkout URL is opened in the browser...
    await u.win.waitForFunction(() => true, null, { timeout: 1000 });
    const urls = await openedUrls(u.app);
    assert.ok(urls.length >= 1, 'a payment page was opened');
    assert.ok(urls[urls.length - 1].includes('/pay/checkout'), `opened ${urls[urls.length - 1]}`);
    // ...the balance has not moved...
    assert.strictEqual(await balance(u.win), before, 'nothing credited before paying');
    // ...and the app says it is waiting.
    await u.win.waitForSelector('#rockets-pending:not([hidden])', { timeout: 8000 });
    const note = await u.win.textContent('#rockets-pending');
    assert.ok(note.includes('Ожидаем подтверждение'), `note was "${note}"`);
  });

  await step('confirming on the payment page credits the wallet and clears the notice', async () => {
    const before = await balance(u.win);
    const id = await lastPaymentId(u.app);
    assert.ok(id, 'the payment id is in the checkout link');
    const done = await post(`/pay/confirm?id=${id}`);
    assert.ok(JSON.parse(done.body).ok, 'the payment page confirms');
    await returnToApp(u.win);
    await u.win.waitForFunction(
      (b) => Number(document.getElementById('rockets-balance').textContent) === b + 50,
      before, { timeout: 8000 }
    );
    await u.win.waitForSelector('#rockets-pending', { state: 'hidden', timeout: 8000 });
  });

  await step('backing out of the payment page credits nothing and says it was cancelled', async () => {
    const before = await balance(u.win);
    await u.win.click('#rocket-bundles .rocket-bundle[data-rockets="100"]');
    await u.win.waitForSelector('#rockets-pending:not([hidden])', { timeout: 8000 });
    const id = await lastPaymentId(u.app);
    // This is what the page's pagehide handler sends when the user goes back.
    const cancel = await post(`/pay/cancel?id=${id}`);
    assert.strictEqual(cancel.status, 200, 'the cancellation is accepted');
    await returnToApp(u.win);
    await u.win.waitForFunction(
      () => {
        const el = document.getElementById('rockets-pending');
        return !el.hidden && el.classList.contains('is-cancelled');
      },
      null, { timeout: 8000 }
    );
    const note = await u.win.textContent('#rockets-pending');
    assert.ok(note.includes('отменена'), `note was "${note}"`);
    assert.strictEqual(await balance(u.win), before, 'nothing was credited');
  });

  await step('Premium uses the same payment page', async () => {
    await openPane(u.win, 'premium');
    await u.win.click('#btn-buy-premium');
    await u.win.waitForSelector('#premium-pending:not([hidden])', { timeout: 8000 });
    const id = await lastPaymentId(u.app);
    assert.ok(id, 'Premium got a payment page too');
    assert.strictEqual(await u.win.textContent('#premium-badge'), 'Не активна', 'not active before paying');
    await post(`/pay/confirm?id=${id}`);
    await returnToApp(u.win);
    await u.win.waitForFunction(
      () => document.getElementById('premium-badge').textContent === 'Активна',
      null, { timeout: 8000 }
    );
  });

  await step('no uncaught errors in the renderer', async () => {
    assert.deepStrictEqual(u.errors, [], 'renderer errors: ' + u.errors.join(' | '));
  });

  await u.app.close();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} UI checkout checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
