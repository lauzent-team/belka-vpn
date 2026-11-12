'use strict';

/**
 * A relay with no real provider and no demo opt-in must refuse a purchase.
 *
 * The built-in checkout credits on a button press and moves no money, so a
 * public relay that is merely unconfigured must not hand it out: that would be
 * free Premium and Rockets. Without SLEEPHY_PAY_DEMO (and with no provider),
 * payMode() is `disabled`, `pay.create` is refused, and no endpoint can credit
 * anything. This is the guard that a default relay cannot be drained for free.
 *
 * Run with: node test/pay-disabled.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8847;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-disabled-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-disabled-${label}-`));
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
      SLEEPHY_WELCOME_ROCKETS: '0'
      // No SLEEPHY_PAY_PROVIDER and no SLEEPHY_PAY_DEMO: the relay is
      // unconfigured, so payment must be switched off rather than free.
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await wait(1200);

  await step('health reports payments as disabled', async () => {
    const r = await get('/health');
    assert.strictEqual(r.status, 200, 'health answers');
    const body = JSON.parse(r.body);
    assert.strictEqual(body.payments, 'disabled', `payments was "${body.payments}"`);
  });

  const client = makeClient('a');
  await client.connect(URL);
  const me = `buyer_${Math.random().toString(36).slice(2, 7)}`;
  await client.register({ username: me, password: 'password-1234' });

  await step('creating a purchase is refused', async () => {
    await assert.rejects(
      () => client.payCreate({ kind: 'premium' }),
      /не настроена/,
      'the relay refuses to start a purchase it cannot take money for'
    );
  });

  await step('creating a Rockets purchase is refused too', async () => {
    await assert.rejects(
      () => client.payCreate({ kind: 'rockets', rockets: 50 }),
      /не настроена/
    );
  });

  await step('the wallet is untouched', async () => {
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'no Rockets appeared');
    assert.strictEqual(w.premium.active, false, 'and no Premium');
  });

  await step('the checkout page is not served for an unknown payment', async () => {
    const page = await get('/pay/checkout?id=does-not-exist');
    assert.strictEqual(page.status, 404, 'no page exists');
  });

  await step('a stray confirm cannot credit anything', async () => {
    // Even if someone guesses a payment id, there is no pending payment to
    // settle, so the confirm endpoint stays inert.
    const done = await post('/pay/confirm?id=whatever');
    assert.strictEqual(done.status, 404, 'unknown payment');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'and nothing was credited');
    assert.strictEqual(w.premium.active, false, 'and no Premium');
  });

  client.disconnect();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} disabled-payment checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
