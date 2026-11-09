'use strict';

/**
 * SMS adapter for the SleePhy relay.
 *
 * The relay only knows how to POST `{ phone, code }` as JSON to one URL. Real
 * providers do not speak that shape, and they must never be reachable from a
 * browser or a stranger. This process sits in between: it takes the relay's
 * simple JSON on one side and calls the provider on the other.
 *
 *     relay ──{phone,code}──▶ adapter ──provider API──▶ SMS gateway
 *
 * It also enforces the throttle the relay does not have. Every request here
 * costs money, and `phone.request` is open to anyone who can reach the relay,
 * so an unthrottled adapter is a way to drain the balance.
 *
 *   node server/sms-adapter.js
 *
 * Environment:
 *   SMS_PROVIDER      smsru (default) | generic
 *   SMSRU_API_ID      your SMS.ru api_id
 *   SMS_TEXT          template, `{code}` is replaced; default below
 *   SMS_ADAPTER_PORT  default 8790
 *   SMS_ADAPTER_TOKEN optional path secret, see below
 *   SMS_MIN_INTERVAL  seconds between codes to one number (default 60)
 *   SMS_PER_HOUR      codes to one number per hour (default 3)
 *   SMS_PER_DAY       codes to one number per day (default 5)
 *   SMS_DAILY_CAP     codes to all numbers per day (default 500)
 *
 * Point the relay at it:
 *   SLEEPHY_SMS_WEBHOOK=http://127.0.0.1:8790/send
 *
 * With SMS_ADAPTER_TOKEN=secret the URL becomes /send/secret. The relay cannot
 * send headers, so the token rides in the path — use it if the adapter is ever
 * reachable from more than localhost.
 */

const http = require('http');

const PORT = Number(process.env.SMS_ADAPTER_PORT) || 8790;
const PROVIDER = (process.env.SMS_PROVIDER || 'smsru').toLowerCase();
const TOKEN = process.env.SMS_ADAPTER_TOKEN || '';
const TEXT = process.env.SMS_TEXT || 'SleePhy: код входа {code}';
const MIN_INTERVAL_MS = (Number(process.env.SMS_MIN_INTERVAL) || 60) * 1000;
const PER_HOUR = Number(process.env.SMS_PER_HOUR) || 3;
const PER_DAY = Number(process.env.SMS_PER_DAY) || 5;
const DAILY_CAP = Number(process.env.SMS_DAILY_CAP) || 500;

/** phone -> array of send timestamps, newest last. Kept in memory on purpose:
 *  a restart should not lock a user out, and losing it costs little. */
const sentAt = new Map();
let dayStamp = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStamp) {
    dayStamp = today;
    dayCount = 0;
    sentAt.clear();
  }
}

/**
 * Decide whether this number may receive another code.
 * Returns null when allowed, or a short reason when it is not.
 */
function throttled(phone, now) {
  rollDay();
  if (dayCount >= DAILY_CAP) return 'daily cap reached';
  const times = (sentAt.get(phone) || []).filter((t) => now - t < 24 * 60 * 60 * 1000);
  sentAt.set(phone, times);
  const last = times[times.length - 1];
  if (last && now - last < MIN_INTERVAL_MS) return 'too soon';
  if (times.filter((t) => now - t < 60 * 60 * 1000).length >= PER_HOUR) return 'hourly limit';
  if (times.length >= PER_DAY) return 'daily limit';
  return null;
}

function remember(phone, now) {
  const times = sentAt.get(phone) || [];
  times.push(now);
  sentAt.set(phone, times);
  dayCount += 1;
}

/** The relay writes numbers as E.164 with a leading '+'; gateways want digits. */
const digits = (phone) => String(phone).replace(/[^\d]/g, '');

/**
 * Send through SMS.ru. Their endpoint is a plain GET and answers with JSON:
 *   {"status":"OK","sms":{"79255070602":{"status":"OK",...}}}
 * Anything that is not status OK is an error we must surface, not swallow.
 */
async function sendSmsRu(phone, code) {
  const apiId = process.env.SMSRU_API_ID;
  if (!apiId) throw new Error('SMSRU_API_ID is not set');
  // Overridable so the suite can point it at a local fake instead of the real
  // gateway; production leaves it alone.
  const url = new URL(process.env.SMSRU_API_URL || 'https://sms.ru/sms/send');
  url.searchParams.set('api_id', apiId);
  url.searchParams.set('to', digits(phone));
  url.searchParams.set('msg', TEXT.replace('{code}', code));
  url.searchParams.set('json', '1');

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`provider returned ${res.status}, not JSON`);
  if (body.status !== 'OK') {
    throw new Error(`provider refused: ${body.status_text || body.status}${body.status_code ? ' (' + body.status_code + ')' : ''}`);
  }
  const perNumber = body.sms && body.sms[digits(phone)];
  if (perNumber && perNumber.status !== 'OK') {
    throw new Error(`provider refused the message: ${perNumber.status_text || perNumber.status}`);
  }
  return body;
}

/** Any provider with a single URL of its own: set SMS_GENERIC_URL. */
async function sendGeneric(phone, code) {
  const url = process.env.SMS_GENERIC_URL;
  if (!url) throw new Error('SMS_GENERIC_URL is not set');
  const method = (process.env.SMS_GENERIC_METHOD || 'POST').toUpperCase();
  const template = process.env.SMS_GENERIC_BODY || '{"phone":"{phone}","message":"{text}"}';
  const body = template
    .replace('{phone}', digits(phone))
    .replace('{text}', TEXT.replace('{code}', code));

  const res = method === 'GET'
    ? await fetch(url.replace('{phone}', digits(phone)).replace('{text}', encodeURIComponent(TEXT.replace('{code}', code))), { signal: AbortSignal.timeout(15000) })
    : await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000)
      });
  if (!res.ok) throw new Error(`provider returned ${res.status}`);
  return res.text();
}

const senders = { smsru: sendSmsRu, generic: sendGeneric };

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const path = req.url.split('?')[0];
  const expected = TOKEN ? `/send/${TOKEN}` : '/send';
  if (path !== expected) return json(res, 404, { error: 'not found' });

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 4096) req.destroy(); // the relay only ever sends two short fields
  });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const phone = typeof payload.phone === 'string' ? payload.phone : '';
    const code = typeof payload.code === 'string' ? payload.code : '';
    if (!phone || !/^\d{6}$/.test(code)) return json(res, 400, { error: 'phone and a 6-digit code are required' });

    const now = Date.now();
    const reason = throttled(phone, now);
    if (reason) {
      console.warn(`[sms-adapter] skipped ${digits(phone)}: ${reason}`);
      return json(res, 429, { error: reason });
    }

    try {
      await (senders[PROVIDER] || sendSmsRu)(phone, code);
      remember(phone, now);
      console.log(`[sms-adapter] sent to ${digits(phone)} via ${PROVIDER}`);
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error(`[sms-adapter] failed for ${digits(phone)}: ${err.message}`);
      return json(res, 502, { error: err.message });
    }
  });
});

// Localhost only. The relay and this process belong on the same host, and an
// SMS gateway open to the world is a bill waiting to happen.
const HOST = process.env.SMS_ADAPTER_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`[sms-adapter] listening on http://${HOST}:${PORT}${TOKEN ? '/send/<token>' : '/send'} via ${PROVIDER}`);
  if (!senders[PROVIDER]) console.warn(`[sms-adapter] unknown SMS_PROVIDER "${PROVIDER}", falling back to smsru`);
});
