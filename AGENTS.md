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
node test/groups.js   # group protocol: create, fan-out, edit, delete, membership
node test/admin.js    # admin panel, verification, blocking, announcements
node test/accounts.js # sign-out, account switching, dropping an account
xvfb-run -a node test/ui.js            # UI tests driving the real Electron app
xvfb-run -a node test/ui-features.js   # the newer UI features, clicked for real
xvfb-run -a node test/ui-drawer.js     # drawer, settings, contacts, groups, accounts
xvfb-run -a node test/ui-menu.js       # menu bar hidden, editing shortcuts intact
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

## Interface rules

- **Icons come from the sprite.** `#icon-sprite` at the top of `src/index.html`
  defines every `<symbol>`. Reference one with
  `<svg class="ico" viewBox="0 0 24 24"><use href="#i-name"></use></svg>`, or from
  JavaScript with the `icon(id)` helper in `renderer.js`. Do not paste inline SVG
  paths or emoji into chrome (buttons, menus, badges, rows) — emoji stay only
  where they are content: the emoji picker, quick reactions and stickers.
- **Style through tokens.** Colours, radii and shadows live as custom properties in
  `:root` in `styles.css`; the light theme re-declares them under
  `body.theme-light`. Do not hardcode a hex outside those two blocks — that is how
  the old two-tone gradient look crept in.
- **Separate with hairlines, not boxes.** Prefer `--line` / `--line-soft` rules and
  background steps (`--bg` → `--bg-2` → `--bg-3` → `--bg-4`) over borders and
  glows.

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

## Attachments, pins, search and settings (v0.4.0)

- **Attachments are `crypto_box_easy` blobs, like message bodies.** `src/lib/crypto.js`
  exports `encryptBytes`/`decryptBytes`; the relay stores only `{kind, name, mime,
  size, duration, box, nonce}` as JSON in `messages.attachment`. The cap is 5 MB of
  ciphertext, enforced server-side in `parseAttachment` — the base64 length check
  (`validB64(value.box, 12MB)`) only guards the frame budget, so keep the byte check
  *after* it or the user sees "Malformed" instead of "too large".
- **`wss` `maxPayload` is 16 MB**, sized for a 5 MB attachment after base64 and JSON
  overhead. Raising the attachment cap means raising this too.
- **The relay cannot search message text** (it holds ciphertext). `messages.search`
  prefilters on peer and the client-supplied attachment file name; the client
  decrypts each hit and filters on the real text. Do not "fix" this by storing text.
- **`openAttachment` fetches the message with `message.get` first.** The renderer
  never holds key material, so decryption happens in the main process and only a
  data URL crosses the bridge.
- **Pins live on the message row (`messages.pinned`), not the chat.** `message.pin`
  notifies the counterpart via a `pinned` event so both sides show the banner.
- **Settings are per account** in `user_settings.settings` (JSON, shallow-merged).
  `settings.set` merges, so a partial update never wipes unrelated keys.
- **Image previews use `blob:` URLs**, which the CSP must allow: `img-src 'self'
  data: blob:` and `media-src 'self' data: blob:`.
- **Select mode is `state.selecting` (a Set of ids).** `messageEl` branches on it;
  right-click and left-click both toggle while it is active.

## Accounts, contacts and the drawer (v0.4.0)

- **Multiple accounts live in `sleephy-accounts.json`; one of them is active.**
  `setActiveAccount` mirrors the chosen record into the single-account identity file
  so `unlock()` keeps working unchanged. `switchAccount` reconnects and re-authenticates
  from the stored token, so the app lands on the unlock screen (not the auth screen).
  Never copy the plaintext key between records — only the sealed blob moves.
- **Adding an account signs the current one out but keeps its keys on disk.**
  "Use another account" (`api.logout()` then `resetToAuth()`) is a different path
  from `switchAccount` and must stay that way: the first forgets nothing, the second
  only rotates the active record.
- **Contacts are per account** in `user_settings.settings.contacts` (a JSON array),
  the same shallow-merged store the settings modal uses. Do not keep them in memory
  only, or they vanish on switch.
- **`humanSize` formats attachment byte counts** for the storage row; keep the
  settings "Storage used" figure derived from in-memory attachments only, so it
  never implies the relay knows what is cached.

## Window chrome (v0.4.1)

- **The menu bar is hidden, not removed.** `installHiddenMenu()` installs an
  application menu and the window calls `setMenuBarVisibility(false)`. Do not
  replace that with `win.removeMenu()`: removing the menu also removes the
  role-based accelerators, so Ctrl+C / Ctrl+V stop working in the composer.
- **Linux CI needs a display and Wine.** UI tests use `xvfb-run -a`; a Windows
  build on Linux needs `wine`, `wine32:i386` (with `dpkg --add-architecture i386`),
  and a writable `XDG_RUNTIME_DIR`, or `rcedit` fails with exit status 53.
  The `wine32` package is required because `rcedit-ia32.exe` is a 32-bit binary;
  a prefix created before i386 was enabled must be deleted (`rm -rf ~/.wine`) and
  recreated with `wineboot --init`.

## Admin, verification and the settings shell (v0.5.0)

- **Admin status is a relay flag, not a client claim.** `SLEEPHY_ADMINS` (comma
  separated) names accounts that get `users.is_admin = 1` at register/login, and
  `ADMINS` members are protected from `admin.action` delete. The client only
  learns `admin: true` from its own `publicProfile`, and `setAdminMode()` shows
  the settings section from that. Never let the renderer decide it is an admin.
- **`verified` is public, `admin` is a hint.** `publicProfile()` returns both, but
  only `verified` is rendered as the checkmark (`isVerified()` / `paintBadge()`).
  A badge must never be drawn from local state alone — it comes from the profile
  cache that the relay filled in.
- **The badge can be a picture, not just a checkmark.** An admin sets
  `users.badge_image` through `admin.action` with `action: 'badge'`; the relay
  validates it as a small raster `data:` URL (`cleanBadgeImage`, ≤128 KB, PNG /
  JPEG / GIF / WebP) and exposes it as `publicProfile().badgeImage`. The renderer
  crops and downscales the picked file to 128 px on the admin's device before
  sending, so the payload stays tiny. Setting a picture also sets `verified`;
  clearing it (`image: null`) leaves the account verified with the checkmark.
  Anywhere a badge is drawn, use `fillBadge()`/`paintBadge()` so the picture and
  the checkmark stay interchangeable.
- **`kicked` is the ban/delete notice.** `kickUser()` sends `{t:'kicked', reason}`
  then closes; `handleKicked()` toasts it and returns to sign-in. Do not remove a
  user's local keys on kick — the account may simply be blocked, and the keys are
  the only way back if it is later unbanned.
- **The settings modal is a two-column shell.** `#settings-nav` items carry
  `data-pane`, `#settings-panes` sections carry the same `data-pane`, and
  `selectSettingsPane()` toggles `.active` on both. Controls moved between panes
  over time, so a UI test that clicks `#btn-theme-toggle` or a `.wallpaper-swatch`
  must first click `.settings-nav-item[data-pane="chats"]`.
- **Stickers reuse the encrypted attachment path.** `renderStickerDataUrl()` draws
  a 128px PNG from an emoji and `sendWithAttachment()` sends it as `kind: 'image'`,
  so the relay still only sees ciphertext. Do not invent a sticker wire format.

## Phone sign-in, i18n and vault passwords (v0.6.0)

- **Sign-in is two steps: phone, then one-time code.** The auth screen has two
  `auth-step` panels (`data-step="phone"` / `data-step="code"`); `showAuthStep()`
  toggles them. `resetToAuth()` must call `showAuthStep('phone')` — leaving the
  code step active hides the phone field and the next sign-in cannot start.
- **The username is assigned by the relay, not chosen at sign-up.** `freeUsername()`
  returns a handle like `user_5848a98c`; the user renames it later in the profile.
  Renaming is a real account move: `changeUsername()` must rewrite the identity
  file **and** carry the `sleephy-accounts.json` entry across, because the registry
  keys accounts by username. Skipping the registry leaves a stale handle and the
  account switcher lists the wrong name.
- **A phone account has no password until the user sets one.** Such an account is
  sealed with the per-device key (`sealedWith: 'device'`) and `autoResume()`
  unlocks it on restart so the user never sees the unlock screen. `setPassword()`
  re-seals with the derived key and may `clearDeviceKey()` **only when no other
  account still depends on it** — several passwordless accounts can share one
  device key.
- **`i18n.js` is generated; do not hand-edit it.** Rows are `[English, Russian]`
  and the generator normalises direction (a Cyrillic left side means the row was
  written the other way round). Keep every row pointing the same way: if a string
  appears as both an English and a Russian source, `translate()` maps it to itself
  and part of the UI stays untranslated.
- **Translate in place, and expect to run it again.** `i18n.apply(root)` rewrites
  text nodes and `placeholder` / `title` / `aria-label` attributes under a root.
  It is idempotent, so call it after any markup the renderer rebuilds (drawer,
  admin rows, chat list) via `refreshLocalizedText()`.

## Sign-in

Sign-in is a username and a password. The password never leaves the device: it
unlocks the private key, and the relay only ever stores a verifier.

Phone sign-in (phone number + one-time code) is built and wired to the same
relay, but it is **parked**. The button on the sign-in screen is disabled and
shows "Скоро"; the flow sits behind it, ready to switch on once an SMS provider
is funded. `test/_auth.js` reaches it by enabling the button, so the path stays
covered in the meantime.

## Errors shown to the user

- **IPC rejections arrive wrapped, and `showError()` translates them.** Electron
  turns a rejection from `ipcMain.handle` into `"Error invoking remote method
  'sleephy:x': Error: <reason>"`. `preload.js` unwraps that once in its `invoke()`
  helper, and `showError()` runs the result through `i18n.t()` so the user reads
  the reason in their own language. Add new server error strings to `src/i18n.js`
  or they will show up in English.
- **Keep the reason text identical to the dictionary key.** `i18n.translate()`
  matches whole normalised strings; a reworded server message silently stops
  being translated.

## Closing overlays

- **Clear the state that reopens an overlay when you close it.** The `profile`
  event calls `showProfile()` whenever `state.profileTarget` matches, so closing
  the profile with `els.profileBackdrop.hidden = true` alone lets the next event
  pop it straight back open. Use `closeProfile()`, which also nulls
  `profileTarget`. The same trap applies to any overlay a broadcast can re-open.

## Delivering login codes (v0.6.0)

- **The relay cannot talk to a real SMS provider directly.** `deliverCode()` POSTs
  `{ phone, code }` as JSON to `SLEEPHY_SMS_WEBHOOK` and nothing else; providers
  want their own shape (SMS.ru wants `api_id`/`to`/`msg`/`json=1` as query
  params). Keep the translation in `server/sms-adapter.js` rather than teaching
  the relay provider-specific code.
- **The number arrives with a leading `+`.** `PHONE_RE` requires E.164, and
  gateways want bare digits — strip the `+` at the adapter boundary.
- **Every `phone.request` costs money and nothing throttles it.** The relay has no
  rate limiting, so an open `SLEEPHY_SMS_WEBHOOK` is a way to drain the balance in
  a loop. The adapter enforces per-number and global limits for that reason; do
  not remove them to "make testing easier".
- **A provider error must not be swallowed.** `deliverCode()` logs a failed
  webhook and still answers `phone.request` with `ok`, because the code is
  already stored. That is deliberate: the user retries, the log shows why. Do not
  make the reply depend on the provider being reachable.
- **`SLEEPHY_DEV_CODES=1` puts the code in the reply.** That is for tests and for
  a server with no provider. Never leave it on in production — it hands anyone
  who knows a phone number the ability to log in as it.


