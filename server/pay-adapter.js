'use strict';

/**
 * Payment adapter for the SleePhy relay.
 *
 * The relay only knows two calls: "make me a way to pay for this" and "has it
 * been paid yet?". Real providers speak neither shape, and their secrets must
 * never be reachable from a browser. This process sits in between, holds the
 * secret, and is the only part that talks to the provider.
 *
 *     relay ──{id,amount}──▶ adapter ──provider API──▶ YooMoney
 *                    ◀──checkoutUrl──
 *
 * The adapter does not decide what anything costs. The relay sends the amount
 * it computed from its own price list, and the adapter checks that the provider
 * confirms the same amount before reporting a payment as paid.
 *
 *   node server/pay-adapter.js
 *
 * Environment:
 *   PAY_PROVIDER          mock (default) | yoomoney | generic
 *   PAY_ADAPTER_PORT      default 8791
 *   PAY_ADAPTER_TOKEN     optional path secret, see below
 *   PAY_STORE             JSON file for paid payments; default ./pay-store.json
 *
 *   YooMoney (PAY_PROVIDER=yoomoney):
 *   YOOMONEY_RECEIVER     your wallet id (the "receiver")
 *   YOOMONEY_SECRET       the notification secret from the YooMoney settings
 *   YOOMONEY_TOKEN        optional OAuth token, for polling operation history
 *   YOOMONEY_QUICKPAY_URL override the quickpay endpoint (for tests)
 *   YOOMONEY_API_URL      override the API base (for tests)
 *
 *   Any other provider with two URLs (PAY_PROVIDER=generic):
 *   PAY_GENERIC_CREATE_URL  POST {id,amount,label,returnUrl} -> {checkoutUrl}
 *   PAY_GENERIC_VERIFY_URL  POST {id,amount}                 -> {paid,ref}
 *
 * Point the relay at it:
 *   SLEEPHY_PAY_ADAPTER=http://127.0.0.1:8791 \
 *   SLEEPHY_PAY_PROVIDER=yoomoney
 *
 * With PAY_ADAPTER_TOKEN=secret every path gains a trailing /secret. The relay
 * cannot send headers, so the token rides in the path — use it whenever the
 * adapter is reachable from more than localhost.
 *
 * YooMoney must be told to notify this adapter:
 *   https://<public-host>/notify/<token>
 */

const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.PAY_ADAPTER_PORT) || 8791;
const HOST = process.env.PAY_ADAPTER_HOST || '127.0.0.1';
const PROVIDER = (process.env.PAY_PROVIDER || 'mock').toLowerCase();
const TOKEN = process.env.PAY_ADAPTER_TOKEN || '';
const STORE = process.env.PAY_STORE || require('path').join(__dirname, 'pay-store.json');
const YOOMONEY = require('../src/lib/yoomoney');

/**
 * Settled payments, keyed by the relay's payment id. Persisted so a restart
 * does not forget that someone already paid. Kept deliberately small: only the
 * id, the amount and the provider reference, never anything about the person.
 */
let paid = {};
try { paid = JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch { paid = {}; }

function remember(id, amount, ref) {
  paid[id] = { amount, ref, ts: Date.now() };
  try { fs.writeFileSync(STORE, JSON.stringify(paid)); } catch (err) {
    console.error(`[pay-adapter] could not persist ${STORE}: ${err.message}`);
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/* ------------------------------ providers ------------------------------ */

/** Build a YooMoney quickpay link the user can open in a browser. */
function yoomoneyCreate({ id, amount, label, returnUrl }) {
  const receiver = process.env.YOOMONEY_RECEIVER;
  if (!receiver) throw new Error('YOOMONEY_RECEIVER is not set');
  const url = new URL(process.env.YOOMONEY_QUICKPAY_URL || 'https://yoomoney.ru/quickpay/confirm');
  url.searchParams.set('receiver', receiver);
  url.searchParams.set('quickpay-form', 'button');
  url.searchParams.set('paymentType', 'AC'); // bank card
  url.searchParams.set('sum', (amount / 100).toFixed(2));
  url.searchParams.set('label', id); // comes back on the notification
  url.searchParams.set('targets', label || 'SleePhy');
  if (returnUrl) url.searchParams.set('successURL', returnUrl);
  return url.toString();
}

/**
 * Ask YooMoney's operation history whether this label has been paid. Only used
 * when an OAuth token is configured; otherwise the notification webhook is the
 * source of truth and `/verify` simply reads the store.
 */
async function yoomoneyPoll({ id, amount }) {
  const token = process.env.YOOMONEY_TOKEN;
  if (!token) return false;
  const base = process.env.YOOMONEY_API_URL || 'https://yoomoney.ru/api';
  const res = await fetch(`${base}/operation-history`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ label: id, type: 'deposition', records: '10' }).toString(),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`provider returned ${res.status}`);
  const data = await res.json();
  const ops = Array.isArray(data.operations) ? data.operations : [];
  // Only a deposit of at least the expected amount counts. A partial payment is
  // not a payment.
  return ops.some((op) => op.status === 'success' && Math.round(Number(op.amount) * 100) >= amount);
}

async function genericCall(url, payload) {
  if (!url) throw new Error('PAY_GENERIC_*_URL is not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`provider returned ${res.status}`);
  return res.json();
}

const providers = {
  mock: {
    // Nothing to talk to: the payment is simply considered settled at once.
    create: ({ id }) => `mock://pay/${id}`,
    verify: () => true
  },
  yoomoney: {
    create: yoomoneyCreate,
    verify: async (p) => (paid[p.id] ? true : yoomoneyPoll(p))
  },
  generic: {
    create: async (p) => (await genericCall(process.env.PAY_GENERIC_CREATE_URL, p)).checkoutUrl,
    verify: async (p) => !!(await genericCall(process.env.PAY_GENERIC_VERIFY_URL, p)).paid
  }
};

const provider = providers[PROVIDER] || providers.mock;

/* -------------------------------- server -------------------------------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const path = req.url.split('?')[0];
  const suffix = TOKEN ? `/${TOKEN}` : '';
  const route = (name) => path === `/${name}${suffix}`;

  let raw;
  try { raw = await readBody(req, 16384); }
  catch { return json(res, 413, { error: 'too large' }); }

  // YooMoney posts its notification as form-encoded, not JSON.
  if (route('notify')) {
    const params = Object.fromEntries(new URLSearchParams(raw));
    // YooMoney signs with `sign` (HMAC-SHA256); the older `sha1_hash` is
    // accepted while notifications still carry it.
    // A signature that does not match is either a bug or an attempt to credit
    // an account for free. Either way it is refused.
    if (!YOOMONEY.verifyNotification(params, process.env.YOOMONEY_SECRET || '')) {
      console.warn('[pay-adapter] rejected a notification with a bad signature');
      return json(res, 403, { error: 'bad signature' });
    }
    // Only a payment *into* the wallet counts. YooMoney marks those with an
    // "incoming" notification type; anything else is acknowledged and ignored.
    const kind = String(params.notification_type || '');
    if (!kind.includes('incoming')) return json(res, 200, { ok: true });
    const label = params.label || '';
    const amount = Math.round(Number(params.amount) * 100);
    if (!label || !Number.isFinite(amount)) return json(res, 400, { error: 'label and amount required' });
    remember(label, amount, params.operation_id || '');
    console.log(`[pay-adapter] notified: ${label} paid ${amount} kopecks`);
    return json(res, 200, { ok: true });
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return json(res, 400, { error: 'invalid JSON' }); }
  const id = typeof payload.id === 'string' ? payload.id : '';
  const amount = Math.trunc(Number(payload.amount));
  if (!id || !Number.isFinite(amount) || amount <= 0) {
    return json(res, 400, { error: 'id and a positive amount are required' });
  }

  try {
    if (route('create')) {
      const checkoutUrl = await provider.create({ ...payload, id, amount });
      return json(res, 200, { checkoutUrl });
    }
    if (route('verify')) {
      const isPaid = await provider.verify({ ...payload, id, amount });
      // A stored amount that does not match what the relay asked for is not
      // accepted, even if the provider says something was paid.
      const stored = paid[id];
      const ok = isPaid && (!stored || stored.amount >= amount);
      if (ok && !stored) remember(id, amount, '');
      return json(res, 200, { paid: !!ok, ref: (paid[id] && paid[id].ref) || '' });
    }
  } catch (err) {
    console.error(`[pay-adapter] ${path} failed: ${err.message}`);
    return json(res, 502, { error: err.message });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[pay-adapter] listening on http://${HOST}:${PORT}${TOKEN ? '/<token>' : ''} via ${PROVIDER}`);
  if (!providers[PROVIDER]) console.warn(`[pay-adapter] unknown PAY_PROVIDER "${PROVIDER}", using mock`);
});
