'use strict';

/**
 * The whole payment path with a real provider adapter in the middle.
 *
 * Unlike test/payments.js (which uses the mock provider and settles at once),
 * this runs the relay against a fake adapter, so the branch that hands out a
 * checkout URL, waits for a provider confirmation and credits exactly once is
 * exercised end to end. The adapter is the only thing faked; the relay and the
 * client are the real ones.
 *
 * Run with: node test/pay-flow.js
 */

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8842;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-flow-${Date.now()}.db`);
const TOKEN = 'flow-token';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A provider adapter that stays pending until the test says otherwise. */
function fakeAdapter() {
  return new Promise((resolve) => {
    const state = { paid: false, creates: [], verifies: [] };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        let out = {};
        if (req.url === `/create/${TOKEN}`) {
          state.creates.push(payload);
          out = { checkoutUrl: 'https://pay.example/checkout/1' };
        } else if (req.url === `/verify/${TOKEN}`) {
          state.verifies.push(payload);
          out = { paid: state.paid, ref: state.paid ? 'op-flow-1' : '' };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-flow-${label}-`));
  return new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
}

async function main() {
  const adapter = await fakeAdapter();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_WELCOME_ROCKETS: '0',
      SLEEPHY_PAY_PROVIDER: 'yoomoney',
      SLEEPHY_PAY_ADAPTER: `http://127.0.0.1:${adapter.port}`,
      SLEEPHY_PAY_ADAPTER_TOKEN: TOKEN,
      SLEEPHY_PAY_PUBLIC_URL: 'https://relay.example'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const client = makeClient('a');
  await client.connect(URL);
  const me = `payer_${Math.random().toString(36).slice(2, 7)}`;
  await client.register({ username: me, password: 'password-1234' });

  let paymentId = null;

  await step('a purchase with a real provider hands back a checkout URL, uncredited', async () => {
    const res = await client.payCreate({ kind: 'rockets', rockets: 50 });
    paymentId = res.id;
    assert.strictEqual(res.status, 'pending', 'nothing is credited yet');
    assert.strictEqual(res.checkoutUrl, 'https://pay.example/checkout/1', 'the app gets a link to open');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'the wallet is untouched');
  });

  await step('the adapter was told the price and where to send the browser back', async () => {
    assert.strictEqual(adapter.state.creates.length, 1, 'one create call');
    const create = adapter.state.creates[0];
    assert.strictEqual(create.amount, 4450, 'the relay sent its own price, not the client\'s');
    assert.strictEqual(create.id, paymentId, 'for this payment');
    assert.strictEqual(
      create.returnUrl, `https://relay.example/pay/return?id=${paymentId}`,
      'and the return URL points at the relay'
    );
  });

  await step('claiming while the provider has not confirmed credits nothing', async () => {
    const claim = await client.payClaim({ id: paymentId });
    assert.strictEqual(claim.paymentStatus, 'pending', 'still pending');
    assert.strictEqual(claim.balance, 0, 'and no Rockets appeared');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'the balance is unchanged');
  });

  await step('a client cannot invent the amount it is buying', async () => {
    // The client asks for 50 Rockets; the price is the relay's to set. A second
    // create must quote the same price, never one the client suggests.
    const res = await client.payCreate({ kind: 'rockets', rockets: 50 });
    const create = adapter.state.creates[adapter.state.creates.length - 1];
    assert.strictEqual(create.amount, 4450, 'the price is the relay\'s');
    assert.strictEqual(res.status, 'pending', 'and it is still pending');
  });

  await step('once the provider confirms, a claim credits exactly once', async () => {
    adapter.state.paid = true;
    const first = await client.payClaim({ id: paymentId });
    assert.strictEqual(first.paymentStatus, 'paid', 'the confirmation landed');
    assert.strictEqual(first.balance, 50, 'and the Rockets were credited');
    // The return page, a reload or a double click must not credit again.
    await client.payClaim({ id: paymentId });
    await client.payClaim({ id: paymentId });
    const w = await client.wallet();
    assert.strictEqual(w.balance, 50, 'still exactly 50');
  });

  client.disconnect();
  server.kill();
  adapter.server.close();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} flow checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
