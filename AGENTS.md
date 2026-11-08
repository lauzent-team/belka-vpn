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
node test/features.js # profiles, usernames, chats, replies, reactions
xvfb-run -a node test/ui.js            # UI tests driving the real Electron app
xvfb-run -a node test/ui-features.js   # the newer UI features, clicked for real
xvfb-run -a node test/connection.js    # connection and error handling
xvfb-run -a node test/shots.js         # regenerate shots/*.png
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
- **Every server handler must reply, even on error.** The client matches replies by
  `_id`; a handler that returns nothing hangs the caller for the full 15 s timeout.
  `bad(ws, rid, message)` is the shared error path — check its argument order.

## Data model rules

- **A username is a primary key.** Renaming (`profile.username`) rewrites every
  reference in one transaction and rebinds live sockets and tokens. If you add a
  table that references usernames, add it to that transaction — see
  `renameStmts` in `server/index.js`.
- **Chat settings are per-owner.** `pinned`, `muted`, `archived`, `last_read` and
  `cleared_at` belong to one side and must never be shared with the peer.
- **Deleting a message blanks the ciphertext and leaves the row** (`deleted = 1`).
  Keep the tombstone: the other side needs to be told, and history must not be
  silently rewritable.
- **Migration statements run at startup and are allowed to fail.** New columns are
  added with `ALTER TABLE ... ADD COLUMN` inside a try/catch so an existing
  database upgrades in place. Add new columns that way rather than editing the
  `CREATE TABLE` only.

## Protocol

WebSocket JSON messages are defined in `ARCHITECTURE.md` and implemented in
`server/index.js` (handlers) and `src/lib/client.js` (requests). Replies echo the
request's `_id` so the client can match them — keep that behaviour when adding
requests.

## Gotchas learned the hard way

- **The app is useless without a reachable relay.** A red connection indicator
  means the address in the Server field has nothing listening on it. When a user
  reports "cannot create an account", check the address first.
- **`server-default.json` is bundled at build time** so an installer can ship with
  a working address. `SLEEPHY_SERVER` overrides it at runtime.
- **Changing the server address must tear down the old socket.** `connect()`
  compares the new address with the current one and only reuses a live socket when
  they match; otherwise requests silently go to the previous server.
- **Do not clear the error message in a `finally` block.** The auth form restores
  its label with `setMode(mode, { clearError: false })` — clearing it there wipes
  the error before the user can read it.
- **`[hidden]` needs `display: none !important`** (see Architecture rules).
- **Replies must be resolved after a history load.** `resolveQuotes()` fills in the
  quoted text once a whole page of messages is in memory; live messages resolve
  their quote as they arrive. Without it, quotes disappear after reopening a chat.
- **The chat list is the union of `messages` and `chats`.** A conversation with no
  settings row still belongs in the list — do not iterate only `chats`. The same
  union drives presence, so a new message makes presence work without a contact
  list.

## Testing expectations

- Behaviour changes need a test that exercises real code paths. `test/e2e.js`
  starts a real server and uses real crypto; `test/features.js` covers the server
  protocol; `test/ui.js` and `test/ui-features.js` drive the real app.
- Do not use mocks. If something is hard to test, that is a design signal.

## Conventions

- `'use strict'` at the top of every JS file.
- CommonJS (`require`) — the app is not bundled, so the renderer cannot use ESM.
- No build step for the client: `src/` is shipped as-is.
- Comments explain *why*, not *what*.
