'use strict';

/**
 * The relay talking to YooMoney directly, with no adapter in between.
 *
 * This is the wiring a single-process host uses (the Amvera container runs only
 * the relay). Unlike test/pay-flow.js, which puts a fake adapter in the middle,
 * here the relay itself builds the quickpay link and settles the payment from
 * YooMoney's signed notification, so the `/notify/<token>` route and the
 * direct-link branch are exercised end to end.
 *
 * Run with: node test/pay-yoomoney-direct.js
 */

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8846;
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-yoomoney-${Date.now()}.db`);
const RECEIVER = '4100117886884814';
const SECRET = 'test-notify-secret';
const TOKEN = 'direct-token';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The sha1 signature YooMoney would put on a notification with this secret. */
function sign(params) {
  const fields = [
    params.notification_type, params.operation_id, params.amount, params.currency,
    params.datetime, params.sender, params.codepro, SECRET, params.label
  ].map((v) => (v === undefined || v === null ? '' : String(v)));
  return crypto.createHash('sha1').update(fields.join('&')).digest('hex');
}

/** POST a form-encoded notification to the relay's /notify route. */
function notify(pathname, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-yoomoney-${label}-`));
  return new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_WELCOME_ROCKETS: '0',
      SLEEPHY_PAY_PROVIDER: 'yoomoney',
      SLEEPHY_PAY_ADAPTER_TOKEN: TOKEN,
      SLEEPHY_PAY_PUBLIC_URL: 'https://relay.example',
      YOOMONEY_RECEIVER: RECEIVER,
      YOOMONEY_SECRET: SECRET
      // No SLEEPHY_PAY_ADAPTER: the relay speaks to YooMoney itself.
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const client = makeClient('a');
  await client.connect(SERVER_URL);
  const me = `direct_${Math.random().toString(36).slice(2, 7)}`;
  await client.register({ username: me, password: 'password-1234' });

  let paymentId = null;

  await step('a purchase hands back a real YooMoney link, uncredited', async () => {
    const res = await client.payCreate({ kind: 'rockets', rockets: 50 });
    paymentId = res.id;
    assert.strictEqual(res.status, 'pending', 'nothing is credited yet');
    const link = new URL(res.checkoutUrl);
    assert.strictEqual(link.host, 'yoomoney.ru', 'the link is YooMoney, not the relay page');
    assert.strictEqual(link.searchParams.get('receiver'), RECEIVER, 'the receiver is the wallet');
    assert.strictEqual(link.searchParams.get('sum'), '44.50', 'kopecks became rubles');
    assert.strictEqual(link.searchParams.get('label'), paymentId, 'the payment id rides as the label');
    assert.strictEqual(
      link.searchParams.get('successURL'), `https://relay.example/pay/return?id=${paymentId}`,
      'and the return URL points back at the relay'
    );
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'the wallet is untouched');
  });

  await step('a claim before the notification stays pending and credits nothing', async () => {
    const claim = await client.payClaim({ id: paymentId });
    assert.strictEqual(claim.paymentStatus, 'pending', 'still pending');
    assert.strictEqual(claim.balance, 0, 'and no Rockets appeared');
  });

  await step('the notify route rejects a wrong token', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-x', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: paymentId
    };
    params.sha1_hash = sign(params);
    const res = await notify('/notify/wrong-token', params);
    assert.strictEqual(res.status, 404, 'a wrong token is the same as no route');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'and nothing was credited');
  });

  await step('a notification with a bad signature is refused', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-1', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: paymentId, sha1_hash: 'deadbeef'
    };
    const res = await notify(`/notify/${TOKEN}`, params);
    assert.strictEqual(res.status, 403, 'a forged notification does not pass');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'and nothing was credited');
  });

  await step('a confirmation for less than the price is not a payment', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-small', amount: '10.00',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: paymentId
    };
    params.sha1_hash = sign(params);
    const res = await notify(`/notify/${TOKEN}`, params);
    assert.strictEqual(res.status, 200, 'acknowledged');
    const w = await client.wallet();
    assert.strictEqual(w.balance, 0, 'a partial amount credits nothing');
  });

  await step('a correctly signed notification credits the wallet exactly once', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-2', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: paymentId
    };
    params.sha1_hash = sign(params);
    const res = await notify(`/notify/${TOKEN}`, params);
    assert.strictEqual(res.status, 200, 'the signature checks out');
    const claim = await client.payClaim({ id: paymentId });
    assert.strictEqual(claim.paymentStatus, 'paid', 'the payment is settled');
    assert.strictEqual(claim.balance, 50, 'and 50 Rockets appeared');
  });

  await step('a replayed notification does not credit a second time', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-2', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: paymentId
    };
    params.sha1_hash = sign(params);
    await notify(`/notify/${TOKEN}`, params);
    const w = await client.wallet();
    assert.strictEqual(w.balance, 50, 'the balance is unchanged');
  });

  await step('an outgoing notification is acknowledged but ignored', async () => {
    const created = await client.payCreate({ kind: 'rockets', rockets: 50 });
    const params = {
      notification_type: 'card-outgoing', operation_id: 'op-3', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: created.id
    };
    params.sha1_hash = sign(params);
    const res = await notify(`/notify/${TOKEN}`, params);
    assert.strictEqual(res.status, 200, 'acknowledged');
    const claim = await client.payClaim({ id: created.id });
    assert.strictEqual(claim.paymentStatus, 'pending', 'but never credited');
  });

  client.disconnect();
  server.kill();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} direct YooMoney checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
