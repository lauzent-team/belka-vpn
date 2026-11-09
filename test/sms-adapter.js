'use strict';

/**
 * Tests for the SMS adapter. A fake provider stands in for SMS.ru so the suite
 * exercises the real adapter code — argument building, response parsing, the
 * error paths and the throttle — without sending anything or spending money.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A provider that records what it was asked to send and replies as told. */
function fakeProvider(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      calls.push(Object.fromEntries(url.searchParams));
      const { status = 200, body } = handler(calls.length, url.searchParams) || {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body !== undefined ? body : {
        status: 'OK',
        sms: { [url.searchParams.get('to')]: { status: 'OK', sms_id: 'x' } }
      }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function startAdapter(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'sms-adapter.js')], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const done = () => resolve({ proc, output: () => out });
    proc.stdout.on('data', (d) => { if (String(d).includes('listening')) done(); });
    proc.on('error', reject);
    setTimeout(done, 1500); // fallback if the line is missed
  });
}

async function post(port, path_, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path_}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  let checks = 0;
  const ok = (cond, label) => {
    checks += 1;
    assert.ok(cond, label);
    console.log('  ✓ ' + label);
  };

  /* ---------- 1. happy path: the code reaches the provider ---------- */
  console.log('sms adapter: sends the code in the provider\'s format');
  {
    const provider = await fakeProvider(() => ({}));
    const { proc } = await startAdapter({
      SMS_ADAPTER_PORT: '8791',
      SMSRU_API_ID: 'test-api-id',
      SMSRU_API_URL: `http://127.0.0.1:${provider.port}/sms/send`,
      SMS_TEXT: 'SleePhy: код входа {code}',
      SMS_MIN_INTERVAL: '0',
      SMS_PER_HOUR: '99',
      SMS_PER_DAY: '99'
    });
    const res = await post(8791, '/send', { phone: '+79991234567', code: '123456' });
    ok(res.status === 200, 'adapter answers 200');
    ok(provider.calls.length === 1, 'provider called once');
    const call = provider.calls[0];
    ok(call.api_id === 'test-api-id', 'api_id forwarded');
    ok(call.to === '79991234567', 'the leading + is stripped');
    ok(call.msg === 'SleePhy: код входа 123456', 'the code is substituted into the text');
    ok(call.json === '1', 'json=1 requested');
    proc.kill('SIGKILL');
    provider.server.close();
  }

  /* ---------- 2. the provider refusing must not look like success ---------- */
  console.log('sms adapter: a provider error is reported, not hidden');
  {
    const provider = await fakeProvider(() => ({ body: { status: 'ERROR', status_code: 202, status_text: 'Not enough money' } }));
    const { proc } = await startAdapter({
      SMS_ADAPTER_PORT: '8792',
      SMSRU_API_ID: 'x',
      SMSRU_API_URL: `http://127.0.0.1:${provider.port}/sms/send`,
      SMS_MIN_INTERVAL: '0'
    });
    const res = await post(8792, '/send', { phone: '+79991234567', code: '123456' });
    ok(res.status === 502, 'a refused message answers 502');
    ok(/Not enough money/.test(res.json.error), 'the provider reason is passed through');
    proc.kill('SIGKILL');
    provider.server.close();
  }

  /* ---------- 3. the throttle that stops the balance being drained ---------- */
  console.log('sms adapter: throttles repeated requests to one number');
  {
    const provider = await fakeProvider(() => ({}));
    const { proc } = await startAdapter({
      SMS_ADAPTER_PORT: '8793',
      SMSRU_API_ID: 'x',
      SMSRU_API_URL: `http://127.0.0.1:${provider.port}/sms/send`,
      SMS_MIN_INTERVAL: '60',
      SMS_PER_HOUR: '99',
      SMS_PER_DAY: '99'
    });
    const first = await post(8793, '/send', { phone: '+79990000001', code: '111111' });
    const second = await post(8793, '/send', { phone: '+79990000001', code: '222222' });
    ok(first.status === 200, 'the first code is sent');
    ok(second.status === 429, 'an immediate second request is refused');
    ok(/too soon/.test(second.json.error), 'the reason is reported');
    ok(provider.calls.length === 1, 'the provider was called only once');
    proc.kill('SIGKILL');
    provider.server.close();
  }

  /* ---------- 4. bad input never reaches the provider ---------- */
  console.log('sms adapter: rejects malformed requests before spending');
  {
    const provider = await fakeProvider(() => ({}));
    const { proc } = await startAdapter({
      SMS_ADAPTER_PORT: '8794',
      SMSRU_API_ID: 'x',
      SMSRU_API_URL: `http://127.0.0.1:${provider.port}/sms/send`
    });
    const bad = await post(8794, '/send', { phone: '+79991234567', code: 'nope' });
    ok(bad.status === 400, 'a non-numeric code is rejected');
    const wrong = await post(8794, '/wrong-path', { phone: '+79991234567', code: '123456' });
    ok(wrong.status === 404, 'an unknown path is rejected');
    ok(provider.calls.length === 0, 'the provider was never called');
    proc.kill('SIGKILL');
    provider.server.close();
  }

  /* ---------- 5. the relay and the adapter really do fit together ---------- */
  console.log('sms adapter: the relay delivers through it end to end');
  {
    const provider = await fakeProvider(() => ({}));
    const { proc: adapter } = await startAdapter({
      SMS_ADAPTER_PORT: '8795',
      SMSRU_API_ID: 'x',
      SMSRU_API_URL: `http://127.0.0.1:${provider.port}/sms/send`,
      SMS_MIN_INTERVAL: '0'
    });
    const { WebSocket } = require('ws');
    const relay = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        SLEEPHY_PORT: '8796',
        SLEEPHY_DB: '/tmp/sms-adapter-test.db',
        SLEEPHY_DEV_CODES: '0',
        SLEEPHY_SMS_WEBHOOK: 'http://127.0.0.1:8795/send'
      },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    await sleep(1500);
    const ws = new WebSocket('ws://127.0.0.1:8796');
    await new Promise((r) => ws.on('open', r));
    const reply = await new Promise((resolve) => {
      ws.on('message', (d) => resolve(JSON.parse(d)));
      ws.send(JSON.stringify({ t: 'phone.request', phone: '+79995550001', publicKey: Buffer.alloc(32, 3).toString('base64'), _id: 'a' }));
    });
    ok(reply.t === 'ok' && reply.action === 'phone.request', 'the relay accepted the request');
    ok(reply.code === undefined, 'no code leaks in the reply once a provider is wired up');
    await sleep(600);
    ok(provider.calls.length === 1, 'the provider received exactly one message');
    const sentCode = /(\d{6})/.exec(provider.calls[0].msg || '');
    ok(!!sentCode, 'a 6-digit code went out through the provider');
    ws.close();
    relay.kill('SIGKILL');
    adapter.kill('SIGKILL');
    provider.server.close();
    require('fs').rmSync('/tmp/sms-adapter-test.db', { force: true });
  }

  console.log(`\nsms adapter: ${checks}/${checks} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error('\nsms adapter FAILED:', err.message);
  process.exit(1);
});
