# SleePhy — architecture

A private-first messenger. The server is a **blind relay**: it stores and
forwards ciphertext it cannot read.

## Threat model (MVP)
- **Server compromise / curious operator:** cannot read message contents or
  private keys. It only sees usernames, public keys, timestamps, and sizes.
- **Network eavesdropper:** WebSocket traffic carries only ciphertext + metadata.
  Run behind TLS (wss://) in production.
- **Not covered in MVP:** forward secrecy / per-message ratcheting, multi-device,
  metadata hiding, key verification UX. These are honest limitations — the app
  must not claim more than it delivers.

## Cryptography
All crypto runs on the client (Electron main process). The renderer never
touches private key material.

| Purpose | Primitive |
|---|---|
| Identity keypair | X25519 (`crypto_box_keypair`) |
| Message encryption | `crypto_box_easy` — X25519 + XSalsa20-Poly1305 |
| Password verifier (server side) | scrypt (`node:crypto`) |
| Private key at rest | XSalsa20-Poly1305 `crypto_secretbox` with a scrypt-derived key |
| Random | `crypto.randomBytes` / libsodium `randombytes_buf` |

`crypto_box` is authenticated: only the holder of the sender's secret key can
produce a box that opens with the sender's public key, so the recipient gets
sender authenticity for free.

## Flow
```
register:  client generates keypair
           sk_box = secretbox(sk, key=scrypt(password))
           -> server: username, publicKey, scryptVerifier
           local: save sk_box + salt

login:     server verifies scrypt(password) == stored verifier
           -> server: token, publicKey
           client: unseal sk with scrypt(password)

send:      fetch recipient publicKey from directory
           box = crypto_box_easy(plaintext, nonce, recipientPk, senderSk)
           -> server: {to, box, nonce}   (opaque)

recv:      box -> crypto_box_open_easy(box, nonce, senderPk, recipientSk)
```

## Components
```
server/index.js        WebSocket relay + accounts (node:sqlite, ws)
src/lib/crypto.js      libsodium + scrypt helpers (main process)
src/lib/client.js      WebSocket client, key/identity management (main process)
main.js                Electron main: window + IPC
preload.js             contextBridge API (window.sleephy)
src/index.html|css|js  UI: auth, contacts, chat, settings
```

## Protocol (WebSocket JSON)
Client -> server
- `{t:'register', username, password, publicKey}`
- `{t:'login', username, password}`
- `{t:'resume', token}`
- `{t:'directory', username}` -> `{t:'key', username, publicKey}`
- `{t:'send', to, box, nonce}` -> `{t:'sent', id, ts}`
- `{t:'history', with, limit}` -> `{t:'history', items:[...]}`
- `{t:'logout'}`

Server -> client
- `{t:'ok', ...}` / `{t:'error', message}`
- `{t:'message', id, from, box, nonce, ts}`
