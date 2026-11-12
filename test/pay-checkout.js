'use strict';

/**
 * The relay's own checkout, which is the deliberate demo payment path.
 *
 * The built-in checkout credits a purchase on a button press and moves no
 * money, so it is opt-in: the relay serves it only with SLEEPHY_PAY_DEMO=1.
 * Without that flag (and no real provider) payMode() is `disabled` and a
 * purchase is refused — see test/pay-disabled.js.
 *
 * This exercises the built-in checkout page: a purchase is created uncredited,
 * the page is served with the price and the two buttons, confirming credits the
 * wallet exactly once, and cancelling credits nothing.
 *
 * Run with: node test/pay-checkout.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8846;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-checkout-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-checkout-${label}-`));
  return new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
}

const get = (p) => new Promise((resolve, reject) => {
  require('http').get(`http://127.0.0.1:${PORT}${p}`, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

const post = (p) => new Promise((resolve, reject) => {
  const req = require('http').request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST' }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_WELCOME_ROCKETS: '0',
      // The built-in checkout credits on a button press, so it is opt-in.
      SLEEPHY_PAY_DEMO: '1'
      // No SLEEPHY_PAY_PROVIDER: the default is the built-in checkout.
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await wait(1200);

  const client = makeClient('a');
  await client.connect(URL);
  const me = `buyer_${Math.random().toString(36).slice(2, 7)}`;
  await client.register({ username: me, password: 'password-1234' });

  let paymentId = null;

  await step('a purchase is created uncredited with a checkout link', async () => {
    const res = await client.payCreate({ kind: 'rockets', rockets: 50 });
    paymentId = res.id;
    assert.strictEqual(res.status, 'pending', 'nothing is credited yet');
    assert.ok(res.checkoutUrl, 'the app gets a link to open');
    assert.ok(res.checkoutUrl.includes('/pay/checkout'), `link points at the checkout, got ${res.checkoutUrl}`);
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'the wallet is untouched');
  });

  await step('the checkout page shows the item, its price and both buttons', async () => {
    const page = await get(`/pay/checkout?id=${paymentId}`);
    assert.strictEqual(page.status, 200, 'the page is served');
    assert.ok(page.body.includes('SleePhy Rockets'), 'it names what is being bought');
    assert.ok(page.body.includes('50 ракет'), 'and the bundle');
    assert.ok(page.body.includes('44.5'), 'and the price');
    assert.ok(page.body.includes('btn-pay') && page.body.includes('Оплатить'), 'a pay button');
    assert.ok(page.body.includes('btn-cancel') && page.body.includes('Отмена'), 'and a cancel button');
  });

  await step('a claim before confirming stays pending and credits nothing', async () => {
    const claim = await client.payClaim({ id: paymentId });
    assert.strictEqual(claim.paymentStatus, 'pending', 'still pending');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'no Rockets appeared');
  });

  await step('confirming the checkout credits the wallet exactly once', async () => {
    const done = await post(`/pay/confirm?id=${paymentId}`);
    assert.strictEqual(done.status, 200, 'the confirm endpoint answers');
    assert.ok(JSON.parse(done.body).ok, 'and reports success');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 50, 'the Rockets landed');
    // A reload of the page or a double click must not credit again.
    await post(`/pay/confirm?id=${paymentId}`);
    const after = await client.wallet();
    assert.strictEqual(after.balance, 50, 'still exactly 50');
  });

  await step('a claim reports the confirmed payment as paid', async () => {
    const claim = await client.payClaim({ id: paymentId });
    assert.strictEqual(claim.paymentStatus, 'paid', 'the app sees it as paid');
  });

  await step('cancelling a checkout credits nothing', async () => {
    const res = await client.payCreate({ kind: 'rockets', rockets: 100 });
    const before = (await client.wallet()).balance;
    const cancel = await post(`/pay/cancel?id=${res.id}`);
    assert.strictEqual(cancel.status, 200, 'the cancel endpoint answers');
    // Confirming a cancelled payment must not resurrect it.
    const late = await post(`/pay/confirm?id=${res.id}`);
    assert.ok(!JSON.parse(late.body).ok, 'a cancelled payment cannot be confirmed');
    const w = await client.wallet();
    assert.strictEqual(w.balance, before, 'nothing was credited');
    const claim = await client.payClaim({ id: res.id });
    assert.strictEqual(claim.paymentStatus, 'cancelled', 'and the app is told it was cancelled');
  });

  await step('Premium goes through the same checkout', async () => {
    const res = await client.payCreate({ kind: 'premium' });
    assert.strictEqual(res.status, 'pending', 'not credited up front');
    const page = await get(`/pay/checkout?id=${res.id}`);
    assert.ok(page.body.includes('Premium'), 'the page names the subscription');
    await post(`/pay/confirm?id=${res.id}`);
    const w = await client.wallet();
    assert.strictEqual(w.premium.active, true, 'Premium activated on confirmation');
  });

  await step('an unknown payment is not served', async () => {
    const page = await get('/pay/checkout?id=does-not-exist');
    assert.strictEqual(page.status, 404, 'no page for a payment that does not exist');
  });

  await step('leaving the page without paying cancels the payment', async () => {
    const res = await client.payCreate({ kind: 'rockets', rockets: 2500 });
    const before = (await client.wallet()).balance;
    // This is what the page's pagehide handler sends when the user hits back or
    // closes the tab: a beacon POST to /pay/cancel.
    const beacon = await post(`/pay/cancel?id=${res.id}`);
    assert.strictEqual(beacon.status, 200, 'the beacon is accepted');
    const claim = await client.payClaim({ id: res.id });
    assert.strictEqual(claim.paymentStatus, 'cancelled', 'the app sees the cancellation');
    const w = await client.wallet();
    assert.strictEqual(w.balance, before, 'and nothing was credited');
  });

  client.disconnect();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checkout checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
