'use strict';

/**
 * SleePhy cryptography. Runs in the Electron main process only — the renderer
 * never receives private key material.
 *
 * - Identity: X25519 keypair (libsodium crypto_box_keypair)
 * - Messages: crypto_box_easy  = X25519 + XSalsa20-Poly1305 (authenticated)
 * - Private key at rest: crypto_secretbox_easy under a scrypt-derived key
 * - Password verifier: scrypt, identical params to the server
 */

const crypto = require('crypto');
const sodium = require('libsodium-wrappers');

let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = sodium.ready;
  return readyPromise;
}

const B64 = sodium.base64_variants && sodium.base64_variants.ORIGINAL;
const b64 = (u8) => sodium.to_base64(u8, B64);
const unb64 = (s) => sodium.from_base64(s, B64);

/* scrypt params — must match server/index.js exactly. */
const SCRYPT = { N: 16384, r: 8, p: 1 };

function deriveKey(password, saltString) {
  return crypto.scryptSync(password, saltString, 32, SCRYPT);
}

function makeSalt() {
  return crypto.randomBytes(16).toString('base64');
}

/** Server-side password verifier (never used as an encryption key). */
function passwordVerifier(password, saltString) {
  return crypto.scryptSync(password, saltString, 32, SCRYPT).toString('base64');
}

/** Identity keypair, returned as base64 strings. */
async function generateIdentity() {
  await ready();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.privateKey) };
}

/** Encrypt a secret (e.g. the identity secret key) under a password-derived key. */
async function sealSecret(plaintext, keyBytes) {
  await ready();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, keyBytes);
  return { sealed: b64(box), nonce: b64(nonce) };
}

async function openSecret(sealedB64, nonceB64, keyBytes) {
  await ready();
  const box = unb64(sealedB64);
  const nonce = unb64(nonceB64);
  const plain = sodium.crypto_secretbox_open_easy(box, nonce, keyBytes);
  if (!plain) throw new Error('Could not unlock key material (wrong password?)');
  return sodium.to_string(plain);
}

/** Encrypt a message for a recipient. */
async function encryptMessage(plaintext, recipientPublicKeyB64, senderSecretKeyB64) {
  await ready();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const box = sodium.crypto_box_easy(
    sodium.from_string(plaintext), nonce, unb64(recipientPublicKeyB64), unb64(senderSecretKeyB64)
  );
  return { box: b64(box), nonce: b64(nonce) };
}

/** Decrypt a message from a sender. Throws if the box was tampered with. */
async function decryptMessage(boxB64, nonceB64, senderPublicKeyB64, recipientSecretKeyB64) {
  await ready();
  const plain = sodium.crypto_box_open_easy(
    unb64(boxB64), unb64(nonceB64), unb64(senderPublicKeyB64), unb64(recipientSecretKeyB64)
  );
  if (!plain) throw new Error('Message could not be authenticated');
  return sodium.to_string(plain);
}

/**
 * Encrypt raw bytes (an attachment) for a recipient. Same primitive as messages,
 * so the relay sees only an opaque base64 blob and a nonce.
 */
async function encryptBytes(bytes, recipientPublicKeyB64, senderSecretKeyB64) {
  await ready();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const box = sodium.crypto_box_easy(bytes, nonce, unb64(recipientPublicKeyB64), unb64(senderSecretKeyB64));
  return { box: b64(box), nonce: b64(nonce) };
}

/** Decrypt attachment bytes. Throws if the blob was tampered with. */
async function decryptBytes(boxB64, nonceB64, senderPublicKeyB64, recipientSecretKeyB64) {
  await ready();
  const plain = sodium.crypto_box_open_easy(
    unb64(boxB64), unb64(nonceB64), unb64(senderPublicKeyB64), unb64(recipientSecretKeyB64)
  );
  if (!plain) throw new Error('Attachment could not be authenticated');
  return plain;
}

module.exports = {
  ready, makeSalt, deriveKey, passwordVerifier,
  generateIdentity, sealSecret, openSecret,
  encryptMessage, decryptMessage,
  encryptBytes, decryptBytes
};
