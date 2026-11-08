# SleePhy

An end-to-end encrypted messenger. The server is a **blind relay** — it stores
and forwards ciphertext it cannot read.

> Status: working MVP. Text messaging between two accounts works, with real
> end-to-end encryption and a real relay server. See [What is not done yet](#what-is-not-done-yet).

![Chat](shots/3-chat.png)

## What works

- Create an account and sign in (password-protected keys on your device)
- Start a chat with any username and exchange text messages
- **End-to-end encryption** — the relay never sees plaintext
- Offline delivery: messages sent while you were away arrive on reconnect
- Message history, decrypted locally
- Desktop build for Windows (`.exe`) and Linux (AppImage)

## How the encryption works

Everything is done with [libsodium](https://doc.libsodium.org/) — no hand-rolled
cryptography.

| Purpose | Primitive |
|---|---|
| Identity | X25519 keypair |
| Messages | `crypto_box` — X25519 + XSalsa20-Poly1305 (authenticated) |
| Private key at rest | XSalsa20-Poly1305 under a scrypt-derived key |
| Password verifier | scrypt |

Your private key is generated on your device, encrypted with your password, and
stored in `sleephy-identity.json` (permissions `0600`). It never leaves the
machine, and it is never sent to the server.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the threat model — including what is
**not** protected yet.

## Run it locally

```bash
npm install

# 1. start the relay server
npm run server

# 2. in another terminal, start the app
npm start
```

To try a conversation, run a second copy with a separate profile:

```bash
npm start -- --user-data-dir=/tmp/sleephy-second
```

Register two accounts (for example `alice` and `bob`), then in one window type
the other username into the search box and press Enter.

## Build a Windows installer

```bash
npm run dist:win      # -> dist/SleePhy-Setup-0.2.0.exe
```

Building a Windows `.exe` from Linux/macOS uses Wine; the CI workflow does this
on a native Windows runner instead. See `.github/workflows/build.yml`.

## Tests

```bash
node test/e2e.js                    # real server + real crypto (11 checks)
xvfb-run -a node test/ui.js         # drives the real Electron UI (9 checks)
```

The end-to-end suite verifies, among other things, that the plaintext never
appears in the server database and that tampered ciphertext is rejected.

## Running your own server

The relay is a single Node.js process with SQLite storage:

```bash
SLEEPHY_PORT=8787 SLEEPHY_DB=/var/lib/sleephy/sleephy.db node server/index.js
```

Put it behind TLS (`wss://`) in production — the app accepts any WebSocket URL
in Settings → Server address.

## What is not done yet

This is an honest list. The app should not be described as more secure than it is.

- **No forward secrecy.** Compromising a private key exposes past messages. A
  ratcheting protocol (Double Ratchet) is the fix.
- **No key verification UI.** You can copy your public key from Settings, but
  there is no safety-number comparison, so the server *could* substitute a key.
- **Metadata is visible to the server** — who talks to whom, when, and message
  sizes.
- **No multi-device support** — one key per account, tied to one device.
- **No file or image attachments, no group chats, no calls.**
- **The relay has no rate limiting or abuse protection** — needed before it
  faces the public internet.
- **Accounts cannot be recovered.** Lose the password, lose the keys.

## Layout

```
server/index.js        WebSocket relay + accounts (node:sqlite)
src/lib/crypto.js      libsodium + scrypt helpers (main process)
src/lib/client.js      connection, identity, encryption (main process)
main.js                Electron main process and IPC
preload.js             the only renderer bridge (window.sleephy)
src/index.html|css|js  interface
test/                  end-to-end and UI tests
```
