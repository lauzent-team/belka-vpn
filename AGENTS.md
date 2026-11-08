# AGENTS.md

Guidance for agents working in this repository.

## What this is

SleePhy — an end-to-end encrypted messenger. Electron desktop client plus a
Node.js relay server. The server is a blind relay: it must never be able to read
message contents.

## Commands

```bash
npm install
npm run server        # start the relay (ws://127.0.0.1:8787)
npm start             # start the desktop app
npm run dist:win      # build the Windows installer
node test/e2e.js      # end-to-end tests (real server, real crypto)
xvfb-run -a node test/ui.js   # UI tests driving the real Electron app
```

## Architecture rules

- **Cryptography lives in the main process only** (`src/lib/`). The renderer must
  never receive private keys or plaintext-crypto primitives. It talks to the main
  process exclusively through `window.sleephy` (see `preload.js`).
- **Never hand-roll crypto.** Use libsodium via `src/lib/crypto.js`. If a
  primitive is missing from `libsodium-wrappers`, add `libsodium` or a different
  vetted library rather than implementing it.
- **The server must stay blind.** Anything the server stores or logs must be
  ciphertext or non-sensitive metadata. When adding a feature, ask what the
  server learns.
- **Do not overstate security.** If a guarantee is not implemented (forward
  secrecy, key verification, metadata hiding), document it in README's
  "What is not done yet" section instead of implying it.
- Keep the `[hidden] { display: none !important; }` rule in `styles.css` — without
  it, hidden overlays intercept clicks and the UI becomes unusable.

## Protocol

WebSocket JSON messages are defined in `ARCHITECTURE.md` and implemented in
`server/index.js` (handlers) and `src/lib/client.js` (requests). Replies echo the
request's `_id` so the client can match them — keep that behaviour when adding
requests.

## Testing expectations

- Behaviour changes need a test that exercises real code paths. `test/e2e.js`
  starts a real server and uses real crypto; `test/ui.js` drives the real app.
- Do not use mocks. If something is hard to test, that is a design signal.

## Conventions

- `'use strict'` at the top of every JS file.
- CommonJS (`require`) — the app is not bundled, so the renderer cannot use ESM.
- No build step for the client: `src/` is shipped as-is.
- Comments explain *why*, not *what*.
