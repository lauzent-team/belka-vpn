'use strict';

/**
 * Tests for the payment adapter, the one process that holds the provider
 * secret. A fake YooMoney stands in for the real service, so the suite
 * exercises the adapter's own code — the quickpay link it builds, the
 * signature it insists on, the amount it checks, the path token — without
 * touching the network or moving money.
 *
 * Run with: node test/pay-adapter.js
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PORT = 8841;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-notify-secret';
const TOKEN = 'test-path-token';
const RECEIVER = '4100117886884814';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A YooMoney that answers operation-history from a canned list. */
function fakeYooMoney() {
  return new Promise((resolve) => {
    const state = { operations: [] };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // YooMoney filters the history by the label the adapter asks for.
        const label = new URLSearchParams(body).get('label');
        const ops = label
          ? state.operations.filter((op) => op.label === label)
          : state.operations;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ operations: ops }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function startAdapter(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'pay-adapter.js')], {
      env: {
        ...process.env,
        PAY_PROVIDER: 'yoomoney',
        PAY_ADAPTER_PORT: String(PORT),
        YOOMONEY_RECEIVER: RECEIVER,
        YOOMONEY_SECRET: SECRET,
        PAY_ADAPTER_TOKEN: TOKEN,
        PAY_STORE: path.join(require('os').tmpdir(), `sleephy-paystore-${Date.now()}.json`),
        YOOMONEY_TOKEN: 'test-oauth-token',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (d) => {
      out += d;
      if (String(d).includes('listening')) resolve({ proc, output: () => out });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => resolve({ proc, output: () => out }), 2000);
  });
}

function post(pathname, body, { form = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = form
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** The legacy signature YooMoney used to put on a notification (sha1_hash). */
function sign(params) {
  const fields = [
    params.notification_type, params.operation_id, params.amount, params.currency,
    params.datetime, params.sender, params.codepro, SECRET, params.label
  ].map((v) => (v === undefined || v === null ? '' : String(v)));
  return crypto.createHash('sha1').update(fields.join('&')).digest('hex');
}

/** The current signature YooMoney puts on a notification (`sign`). */
function signNew(params) {
  const line = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(params[k])).replace(/%20/g, '+')}`)
    .join('&');
  return crypto.createHmac('sha256', SECRET).update(line).digest('hex');
}

async function main() {
  const yoomoney = await fakeYooMoney();
  const adapter = await startAdapter({ YOOMONEY_API_URL: `http://127.0.0.1:${yoomoney.port}/api` });
  await sleep(300);

  await step('the adapter refuses anything but POST', async () => {
    const get = await new Promise((resolve) => {
      http.get(`${BASE}/create/${TOKEN}`, (r) => { r.resume(); resolve(r.statusCode); });
    });
    assert.strictEqual(get, 405, 'GET is rejected');
  });

  await step('the path token guards every route', async () => {
    const noToken = await post('/create', { id: 'a', amount: 100 });
    assert.strictEqual(noToken.status, 404, 'without the token the route does not exist');
    const wrongToken = await post('/create/wrong', { id: 'a', amount: 100 });
    assert.strictEqual(wrongToken.status, 404, 'a wrong token is the same as none');
  });

  await step('create builds a quickpay link with the relay\'s own amount', async () => {
    const res = await post(`/create/${TOKEN}`, { id: 'pay_1', amount: 4450, label: 'SleePhy Rockets' });
    assert.strictEqual(res.status, 200, 'accepted');
    const url = new URL(res.json.checkoutUrl);
    assert.strictEqual(url.searchParams.get('receiver'), RECEIVER, 'the receiver is the wallet');
    assert.strictEqual(url.searchParams.get('sum'), '44.50', 'kopecks became rubles');
    assert.strictEqual(url.searchParams.get('label'), 'pay_1', 'the payment id rides as the label');
    assert.strictEqual(url.searchParams.get('targets'), 'SleePhy Rockets', 'and the label is shown');
  });

  await step('a notification with a bad signature is refused', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-1', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: 'pay_forged', sha1_hash: 'deadbeef'
    };
    const res = await post(`/notify/${TOKEN}`, params, { form: true });
    assert.strictEqual(res.status, 403, 'a forged notification does not pass');
    const verify = await post(`/verify/${TOKEN}`, { id: 'pay_forged', amount: 4450 });
    assert.strictEqual(verify.json.paid, false, 'and nothing was credited');
  });

  await step('a correctly signed notification marks the payment paid', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-2', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: 'pay_ok'
    };
    params.sign = signNew(params);
    const res = await post(`/notify/${TOKEN}`, params, { form: true });
    assert.strictEqual(res.status, 200, 'the signature checks out');
    const verify = await post(`/verify/${TOKEN}`, { id: 'pay_ok', amount: 4450 });
    assert.strictEqual(verify.json.paid, true, 'and verify reports it paid');
    assert.strictEqual(verify.json.ref, 'op-2', 'the provider reference comes back');
  });

  await step('a notification signed with the retired sha1_hash is still accepted', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-legacy', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: 'pay_legacy'
    };
    params.sha1_hash = sign(params);
    const res = await post(`/notify/${TOKEN}`, params, { form: true });
    assert.strictEqual(res.status, 200, 'the old signature still checks out');
    const verify = await post(`/verify/${TOKEN}`, { id: 'pay_legacy', amount: 4450 });
    assert.strictEqual(verify.json.paid, true, 'and the payment is credited');
  });

  await step('a notification signed with the wrong secret is refused', async () => {
    const params = {
      notification_type: 'card-incoming', operation_id: 'op-bad-secret', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: 'pay_bad_secret'
    };
    const line = Object.keys(params).sort()
      .map((k) => `${k}=${encodeURIComponent(String(params[k])).replace(/%20/g, '+')}`).join('&');
    params.sign = crypto.createHmac('sha256', 'not-the-secret').update(line).digest('hex');
    const res = await post(`/notify/${TOKEN}`, params, { form: true });
    assert.strictEqual(res.status, 403, 'a signature from another secret does not pass');
    const verify = await post(`/verify/${TOKEN}`, { id: 'pay_bad_secret', amount: 4450 });
    assert.strictEqual(verify.json.paid, false, 'and nothing was credited');
  });

  await step('a confirmation for less than the price is not a payment', async () => {
    const verify = await post(`/verify/${TOKEN}`, { id: 'pay_ok', amount: 5000 });
    assert.strictEqual(verify.json.paid, false, 'a partial amount is refused');
  });

  await step('an outgoing notification is acknowledged but ignored', async () => {
    const params = {
      notification_type: 'card-outgoing', operation_id: 'op-3', amount: '44.50',
      currency: '643', datetime: '2026-01-01T00:00:00Z', sender: '4100', codepro: 'false',
      label: 'pay_out'
    };
    params.sha1_hash = sign(params);
    const res = await post(`/notify/${TOKEN}`, params, { form: true });
    assert.strictEqual(res.status, 200, 'acknowledged');
    const verify = await post(`/verify/${TOKEN}`, { id: 'pay_out', amount: 4450 });
    assert.strictEqual(verify.json.paid, false, 'but never credited');
  });

  await step('polling the history credits a payment with no notification', async () => {
    yoomoney.state.operations = [
      { status: 'success', amount: 44.50, label: 'pay_polled' },
      { status: 'success', amount: 1.00, label: 'pay_small' }
    ];
    const good = await post(`/verify/${TOKEN}`, { id: 'pay_polled', amount: 4450 });
    assert.strictEqual(good.json.paid, true, 'the full deposit counts');
    const small = await post(`/verify/${TOKEN}`, { id: 'pay_small', amount: 4450 });
    assert.strictEqual(small.json.paid, false, 'a smaller deposit does not');
  });

  adapter.proc.kill();
  yoomoney.server.close();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} adapter checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
