'use strict';

/**
 * YooMoney notification signatures, shared by the relay and the payment adapter.
 *
 * YooMoney is retiring the SHA-1 hash it used to send in `sha1_hash` (it stops
 * arriving on 18 May 2026) in favour of `sign`, an HMAC-SHA256 over the sorted
 * notification parameters. A receiver that only understands the old field sees
 * an empty signature once the field stops arriving and rejects every genuine
 * notification, so both are accepted here: `sign` first, the legacy hash as a
 * fallback while older notifications are still in flight.
 *
 * Pure logic — no network, no state — so the relay, the adapter and the test
 * suite all verify with one implementation and cannot drift apart.
 *
 * Reference: https://yoomoney.ru/docs/payment-buttons/using-api/notifications
 */

const crypto = require('crypto');

/**
 * RFC 3986 percent-encoding, which is what YooMoney applies to each value
 * before joining. `encodeURIComponent` leaves a few sub-delimiters alone and
 * writes a space as `%20`; both differ from the documented form.
 */
function rfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/**
 * The string YooMoney signs: every parameter except `sign`, sorted by name and
 * joined as `key=value` with `&`.
 */
function signLine(params) {
  return Object.keys(params)
    .filter((key) => key !== 'sign')
    .sort()
    .map((key) => `${key}=${rfc3986(params[key])}`)
    .join('&');
}

/** The current `sign`: HMAC-SHA256 of `signLine`, hex, lower case. */
function signSignature(params, secret) {
  return crypto.createHmac('sha256', secret).update(signLine(params)).digest('hex');
}

/** The retired `sha1_hash`: a plain SHA-1 over fixed fields with the secret. */
function sha1Signature(params, secret) {
  const fields = [
    params.notification_type, params.operation_id, params.amount, params.currency,
    params.datetime, params.sender, params.codepro, secret, params.label
  ].map((v) => (v === undefined || v === null ? '' : String(v)));
  return crypto.createHash('sha1').update(fields.join('&')).digest('hex');
}

/** A length-safe constant-time comparison of two hex signatures. */
function sameSignature(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * True when a notification carries a signature that matches `secret`. `sign` is
 * preferred; a notification that still carries only `sha1_hash` is accepted too
 * so the cutover does not drop a payment.
 */
function verifyNotification(params, secret) {
  if (!secret) return false;
  const sign = String(params.sign || '').toLowerCase();
  if (sign && sameSignature(sign, signSignature(params, secret))) return true;
  const legacy = String(params.sha1_hash || '').toLowerCase();
  return !!legacy && sameSignature(legacy, sha1Signature(params, secret));
}

module.exports = { rfc3986, signLine, signSignature, sha1Signature, verifyNotification };
