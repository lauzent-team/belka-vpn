# AGENTS.md

Guidance for agents working in this repository.

## What this is

SleePhy — an end-to-end encrypted messenger. Electron desktop client plus a
Node.js relay server. The server is a blind relay: it must never be able to read
message contents.

## Commands

```bash
npm install
npm run server        # start the relay (ws://127.0.0.1:8787, or $PORT)
npm start             # start the desktop app
npm run dist:win      # build the Windows installer
node test/e2e.js      # end-to-end tests (real server, real crypto)
node test/features.js # profiles, usernames, chats, replies, reactions
node test/groups.js   # group protocol: create, fan-out, edit, delete, membership
node test/admin.js    # admin panel, verification, blocking, announcements
node test/admin-grant.js # an admin granting Rockets and Premium from the panel
node test/accounts.js # sign-out, account switching, dropping an account
node test/session.js  # token persistence, relay restart, unlock, avatar images
node test/peer-badges.js # a peer's checkmark and picture survive re-entry
node test/streaks.js  # the account "огонёк": days active in a row, extend, reset, rename
node test/streak.js   # the shared streak rules (pure): dayKey, view, bump, mutual
node test/dialog-streaks.js # the pair "огонёк": start, extend, reset, the centered note
node test/downloads.js # the relay serves the download page and the installer
node test/handles.js # @-usernames and channel @handles
node test/nicknames.js # nicknames: owner privilege, admin edit, cap, privacy
node test/story.js     # the story rules (pure): defaults, TTL clamp, encode/decode, ordering
node test/story-relay.js # stories against a real relay: publish, per-viewer crypto, expiry, views
node test/ttl.js       # self-destructing messages over the relay: TTL, sweep, notify
node test/scheduled.js # scheduled messages over the relay: hold, list, cancel, reschedule, send now, sweep
node test/safety.js    # safety numbers: both ends agree, per pair, never stored
node test/globalsearch.js       # the global search rules (pure): cross-chat hits, merge, grouping
node test/globalsearch-relay.js # global search over a real relay: decrypt the slice, no leaks
xvfb-run -a node test/ui.js            # UI tests driving the real Electron app
xvfb-run -a node test/ui-features.js   # the newer UI features, clicked for real
xvfb-run -a node test/ui-drawer.js     # drawer, settings, contacts, groups, accounts
xvfb-run -a node test/ui-menu.js       # menu bar hidden, editing shortcuts intact
xvfb-run -a node test/ui-session.js    # reopen the app: no sign-in screen, photo kept
xvfb-run -a node test/ui-peer-badges.js # a peer's badge and picture survive a re-entry
xvfb-run -a node test/ui-streak.js     # the dialog flame chip, the note, the profile streak line
xvfb-run -a node test/ui-nicknames.js  # the profile nickname editor and the admin popup
xvfb-run -a node test/ui-stories.js    # the stories bar, composer and viewer, clicked for real
xvfb-run -a node test/ui-ttl.js        # the auto-delete timer: picker, chip, countdown
xvfb-run -a node test/ui-scheduled.js  # "send later": picker, drawer badge, list, send now, cancel
xvfb-run -a node test/ui-safety.js     # the safety number in a peer profile, clicked for real
xvfb-run -a node test/ui-globalsearch.js # the top box: "Сообщения" section, row, click-through
xvfb-run -a node test/connection.js    # connection and error handling
node test/premium-logic.js             # Rocket prices, Premium expiry math (pure)
node test/payments.js                  # Rockets, Premium and gifts over a real relay
node test/pay-adapter.js               # the provider adapter: link, signature, amount, token
node test/pay-flow.js                  # relay + real adapter: checkout, pending, credit once
node test/pay-disabled.js              # an unconfigured relay refuses purchases (no free Premium)
xvfb-run -a node test/ui-premium.js    # the Rockets and Premium panes, clicked for real
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
- **The streak ("огонёк") is metadata, not content.** The `streaks` table stores
  only `(username, day, count)` — the last day the account sent something and the
  running total. It is computed on send and read by `streak.get`; it never holds
  message text, and it follows a rename (`renameStmts.streaks`) and is dropped
  with the account. When it moves, the new profile is pushed to peers and back to
  the sender's own devices so every view agrees.
- **There are two streaks, and both use `src/lib/streak.js`.** The account streak
  above, and the *dialog* streak — days in a row one pair has written to each
  other, which is the flame inside a chat. The dialog streak lives in
  `dialog_streaks (a, b, day, count)`, always stored with `a < b` so one row
  serves both people and both read the same number. It rides on `send` replies,
  `history`, `chats.list` and the `dialog.streak` broadcast; `streak.get` with a
  `with` returns it too. On the day a pair's flame first appears, `handleSend`
  stores one `system:series` row so both transcripts show the centered "series
  started" note. That note is **not a message**: `unreadCount` and `lastMessage`
  skip `kind LIKE 'system:%'`, and the client's `lastRealMessage` ignores it in
  previews. It is delivered with `from` set to each side's *peer*, so it files
  under the open conversation rather than Saved Messages. The relay's `deleteUserData`
  clears both sides of the pair.
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
- **The relay also serves the download page and the installer** from `dist/`
  (`SLEEPHY_DOWNLOADS` overrides the directory). Only `index.html` and
  `SleePhy-Setup-*.exe` are ever read from disk — everything else is a 404 — so the
  host people reach the relay on is also where they download the app.
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

## Staying signed in (v0.6.2)

A returning device must not be dropped on the sign-in screen. Three things keep
that true, and all three matter:

- **The session token is persisted** (identity file and account registry), not
  held in memory. A relay restart used to invalidate every session because the
  token only ever lived in RAM.
- **The relay address is persisted** in `sleephy-server.json`. A device created
  against a non-default relay came back pointing at the bundled default, where
  its token was unknown — that looked like a session loss. `writeServerUrl()` is
  called from `connect()`, and the constructor reads it back.
- **Boot waits for the connection.** `connect()` resolves only after
  `autoResume()` settles, and `boot()` awaits `connect()` before reading
  `status()`. Otherwise the first `status()` reports no user and the sign-in
  screen flashes (or sticks) for a signed-in device.

`autoResume()` drops only the **token** on an active session refusal, never the
whole identity file, so the sealed private key survives and the user can still
unlock with their password.

## A peer's checkmark and picture (v0.6.3)

A peer's badge (the checkmark, or the admin-set picture that replaces it) and
their profile picture live only in an in-memory profile cache, so a fresh launch
starts empty. Re-entry must not depend on having seen the grant live: an admin
usually grants a badge while the viewer is offline.

`chats.list` therefore carries each peer's public profile on its row, and both
sides seed the cache from it — `SleePhyClient.listChats()` fills `peerProfiles`,
and `loadChats()` in the renderer fills `state.profiles`. Do not drop the
`profile` field from a chat row: without it the checkmark and the picture
disappear on every re-entry, which is the exact symptom users reported. After
seeding, `loadChats()` repaints the open conversation's header, since a profile
arriving now can change a header that is already on screen.

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



## Presence, last seen and group size (v0.6.4)

- **The relay records `users.last_seen` only when the last socket for an account
  closes.** `unbindSocket()` writes it in the `set.size === 0` branch and then
  broadcasts `presence` with the timestamp. Do not move it to every disconnect:
  a second tab closing would mark an online user offline.
- **`announcePresence()` always sends `lastSeen`.** It is `null` while online and
  the timestamp while offline, so the client can clear a stale value on reconnect.
  `profile.get` and each `chats` row carry the same field so a fresh launch shows
  it before any live event arrives.
- **A peer's picture is drawn from the fetched profile, not the cache.** In
  `showProfile()` the cache is seeded a line earlier, but the header (`#profile-avatar`)
  must read `p` directly through `avatarInnerHtml(p.username, p)`. Painting only
  the initial here is the bug v0.6.4 fixes.
- **`peerPresenceText()` is the one place that decides the subtitle.** It returns
  `в сети`, `был(а) <time>`, or `null` (caller falls back to "end-to-end
  encrypted"). Use it in both the chat header and the profile so they never drift.
- **The group header counts online members, not just size.** `updatePeerSub()`
  builds `N участников, M в сети` from `state.presence`; `plural()` handles the
  Russian 1/2/5 forms. Do not hand-roll the ending again.

## Keeping the relay up

- **`uncaughtException` and `unhandledRejection` are logged, not fatal.** Both
  handlers at the bottom of `server/index.js` print and return, so one bad
  connection cannot take the relay down for everyone. The async SMS `deliverCode()`
  is the known source of stray rejections; keep the guards even after it is fixed.
- **The public link 502s whenever the relay is a child of a chat session.** Start
  it detached: `deploy/healthcheck.sh` launches `supervise.sh` with `setsid`, so
  the supervisor reparents to PID 1 and survives the session ending. Verify with
  `ps -o pid,ppid,sess -p <supervisor>` — `ppid` must be `1`.
- **After changing server code, restart the relay, not just the client.** The
  supervisor runs the code as it was when it started; a shipped client that talks
  to a stale relay sees `undefined` for new fields. `deploy/healthcheck.sh` only
  starts a relay when none answers, so kill the supervisor and relay first.
- **A real deployment lives in `deploy/oracle/`.** It is separate from the sandbox
  supervisor above: systemd units (`sleephy-relay.service`, and a second unit for
  `pay-adapter.js` so the provider secret stays in its own process), a `Caddyfile`
  that terminates TLS and proxies `/notify/*` to the adapter while keeping
  `/create` and `/verify` private, `install.sh`, and env-file templates. The guide
  is in Russian because that is the user's language. Only ports 80/443 open;
  12000 and 8791 stay on localhost.
- **`deploy/free/` is the container path.** A `Dockerfile` (prod deps only — the
  image needs `ws`, `node:sqlite` and `src/lib`, not electron) plus `amvera.yml`.
  Two traps it documents: the relay needs **Node ≥ 22.13** because `node:sqlite`
  is behind `--experimental-sqlite` before that, and the SQLite file must live on
  the mounted volume (`SLEEPHY_DB=/data/sleephy.db`) or every redeploy wipes the
  accounts. `amvera.yml` has only meta/build/run — env vars go in the Amvera UI.

## Privacy and social links (v0.8.0)

- **Privacy is enforced by the relay, never by the client.** `users.last_seen_hidden`
  and `users.profile_hidden` are read in `publicProfile(user, viewer)`; a hidden
  profile comes back as `@handle` plus the verified badge, with name, bio, picture,
  streak and socials cleared. Every call site that hands a profile to someone else
  must pass the viewer — presence broadcasts, `chats.list`, group members, channel
  owners, search, directory. A new call site that forgets the viewer leaks.
- **`socials` is a small JSON array of `{network, url}`.** `cleanSocials` checks
  the network against `SOCIAL_NETWORKS` and requires an `http(s)` URL, so a
  `javascript:`/`data:` link cannot be stored. The client validates again before
  rendering, because it must not trust stored data to build an `href`.

## Nicknames (v0.9.0)

- **Nicknames are extra display names under a profile name**, stored as a JSON
  array in `users.nicknames` and returned by `publicProfile` as `nicknames`.
  Like `socials`, they are cleared when a hidden profile is viewed by someone
  else, so a new profile call site must go through `publicProfile`.
- **The privilege is asymmetric and enforced on the relay.** Only the owner
  account (the first name in `SLEEPHY_ADMINS`, overridable with `SLEEPHY_OWNER`)
  may hold an unbounded list and set it from its own profile form; every other
  account is capped at `MAX_NICKNAMES` (3) and is edited only by an
  administrator. `nicknameLimit(username)` is the single source of that rule.
- **`cleanNicknames` validates the list for the target, not the actor**, so an
  admin cannot hand a normal account an unbounded list. `cleanNickname` checks a
  single entry strictly — `cleanText` truncates silently and must not be used
  where the client relies on a length error.
- **`publicProfile` carries two permission hints**: `owner` (only to the owner's
  own devices) turns on the profile-form editor, and `canEditNicknames` (to any
  admin viewer) turns on the hover popup in the admin list. The relay decides;
  the client only reflects.
- **The admin popup is a floating `.nick-pop`** anchored under the `@handle`;
  it stays open while hovered and closes a beat after the pointer leaves, so a
  click inside is possible. It calls the `nicknameAdd` / `nicknameSet` /
  `nicknameRemove` admin actions.
- **A nickname is claimed, so it belongs to one account at most (v0.16.6).**
  `users.nickname_claims` holds the reserved keys (trimmed, lowercased) beside
  the display list. `cleanNicknamesWithClaims` returns the list and the keys
  together, so a caller cannot persist one without the other, and it refuses a
  name that `reservedKeys` shows another account already holds. Releasing a name
  drops its key and frees it again. The relay is the only authority; the client
  only asks.
- **`nickname.check` lets the editor warn before saving.** It answers
  `available` and `heldBySelf`, treating the caller's own claims as free so an
  account re-checking a name it already owns is not told it is taken. The save
  still refuses a taken name; the check is only an early heads-up.

## Games, bots and gifts (v0.9.0)

- **Games live in `src/lib/games.js`** (`window.SleePhyGames`), a pure library
  with a `byId` registry. Each game exposes `create`, `moves`, `apply`,
  `result`, `bot`, `encode`, `decode`; the renderer owns only the DOM. Unit
  tests are `test/games.js`, and the game logic must stay DOM-free so those
  tests keep running under plain `node`.
- **A game is one evolving object on the chat (`chat.game`), not one message per
  move.** `renderMessagesNow` skips payload messages (`gamePayloadOf`) and
  `renderGameBoardInto` appends a single `.game-msg` board pinned at the end.
  `appendMessageEl` must re-append that board after a new message, or the board
  ends up above the newest bubble.
- **A move is the whole position, encoded** (`{g, s, seat, status}`), sent as an
  ordinary encrypted message, so the relay stays blind and a replayed or
  reordered message cannot desync the game. `applyPeerGame` adopts it and flips
  the seat.
- **Game-driven renders use `renderMessagesImmediate`.** The coalesced
  `renderMessages` waits on `requestAnimationFrame`, which is throttled in a
  backgrounded window, so a peer that is not focused would not repaint its board
  until focused.
- **Beware shadowing the module-level `state`.** `applyPeerGame` once declared
  `let state` for the decoded position, which made `state.activePeer` undefined
  and silently skipped the repaint. Decoded positions are named `position`.
- **The board can be got out of the way.** It is pinned under the transcript, so
  it must not be permanent: the head's close button collapses it to a thin
  `.game-min-bar` (`chat.gameMinimized`), which expands it again or ends the
  match. `endGame` clears `chat.game` locally and, in a match with a real person,
  sends `{g:'end', end:true}` so the peer's `endPeerGame` clears theirs too. That
  notice is a control message: `gameEndOf` keeps it out of the transcript and
  `previewOf`/`lastRealMessage` skip it, exactly like a position message.
- **A tic-tac-toe move is a cell index and cell `0` is falsy**, so
  `gameMoveEquals` compares with `== null`, not `!a`. Any guard on a move value
  must not use truthiness.
- **Bots are local pseudo-peers** (like Saved Messages): no relay traffic, their
  transcript lives only in `state.chats`. `botReply` answers plain text, and the
  minigames bot starts a game on its own chat.
- **A hidden bot is summoned by a mention, not opened.** `@minigames` typed in a
  personal chat is handled on the device (`runHiddenBotMention`) and never sent;
  the peer sees only the invitation that follows, and the relay learns nothing.
  Only a message that *is* the mention (`parseBotMention`, anchored `^@name…$`)
  is intercepted, so a mention inside a sentence goes out as ordinary text. The
  bot's note is `kind: 'system:bot'`, local, one per bot per chat, and never a
  preview or unread.
- **Gifts ride as ordinary encrypted messages** (`giftPayloadOf` /
  `.gift-bubble`), so the server needs no change; `previewOf` shows
  `Подарок: <name>` in the chat list.
- **The bots/games/gifts UI test is `test/ui-bots-games.js`**, run with
  `xvfb-run -a node test/ui-bots-games.js`. It opens two windows and checks a
  game invite and a gift over the real relay. Electron UI tests need
  `xvfb-run`; a test that launches a window without it fails on `Missing X
  server or $DISPLAY`. `test/ui-hidden-bot.js` covers the mention bot and
  `test/ui-game-close.js` covers collapsing and ending a board.

## Polls, drafts and folders (v0.9.0)

- **A poll is an ordinary encrypted message** (`pollPayloadOf` / `.poll-msg`),
  encoded by `src/lib/polls.js` (`window.SleePhyPolls`) so the relay stays blind
  and needs no poll table. The library is DOM-free and unit-tested by
  `test/polls.js`.
- **A vote is a second encrypted message**, not a server call: `encodeVote`
  carries `{t:'poll-vote', pollId, options}`. Both devices recompute the tally
  locally, which is why a vote needs no relay state and why the sender's own
  vote shows up immediately.
- **Tap the same option again to withdraw**, and a multiple-choice vote keeps
  more than one option. Voting never posts a "…voted" bubble — the card updates
  in place.
- **The tally bar sets `style.width` from JS, never an inline `style="…"`.** The
  CSP is `style-src 'self'` with no `unsafe-inline`, so an inline width style is
  dropped and the bar would sit at zero.
- **Drafts are per-account settings** (`state.drafts`, `setDraft`/`loadDrafts`/
  `saveDrafts`), keyed by chat. `setDraft` coalesces keystrokes into one write
  with a 600 ms timer. `resetToAuth` and `restartSession` clear them so a
  different account never inherits another's text. `test/ui-drafts.js` proves a
  draft survives a full app restart by reusing the same `--user-data-dir`.
- **Folders live in `src/lib/folders.js`** (`window.SleePhyFolders`), a pure
  library: `kindOf` classifies a chat, `normalize`/`normalizeAll` clean stored
  data, and `filter` selects chats for a folder. Unit tests are `test/folders.js`.
- **An exclusive folder owns its chats.** `exclusiveKeys(folders, descs)` returns
  the chats an exclusive folder claims, and the "all" list drops them, matching
  Telegram. A folder tab is edited by right-click; the "all" tab is built in and
  cannot be renamed or deleted.
- **`test/ui-folders.js` drives the real UI** — create, refuse a nameless folder,
  switch tabs, and survive a restart. Run it with `xvfb-run`.
- **When a UI test waits for a hidden element, use `waitForSelector(sel, {state:
  'hidden'})`.** Playwright's default wait is for *visible*, so waiting on
  `#folder-editor[hidden]` hangs forever even though the element is correct.

## In-chat search (v0.9.0)

- **The filter rules live in `src/lib/chatsearch.js`** (`window.SleePhyChatSearch`),
  a pure library with no DOM: `search(messages, filter, extrasOf)` returns the
  matches, `counts` labels the chips. Unit tests are `test/chatsearch.js`.
- **A message is classified once**, by `classify`: a poll/gift/game payload wins
  over its carrier text, then the attachment kind, then a link, then plain text.
  The payload checks live in other libraries, so the caller passes a per-message
  `extra` tag ('poll' | 'gift' | 'game') rather than this module reaching for
  them. `searchExtraOf` in the renderer builds that tag.
- **The chip counts come from `search` itself**, not a second counting pass, so a
  chip label can never disagree with the list the chip produces.
- **A filter with no words still searches** — "every photo" is a valid query with
  an empty box. Only a fully default filter (no text, from=any, kind=any,
  date=any) clears the highlight.
- **Highlighting keys off `state.searchHits`, not off a non-empty query**, so a
  filter-only search shows its hits.
- **`closeChatSearch` renders immediately** (`renderMessagesImmediate`). The
  coalesced `renderMessages` waits on `requestAnimationFrame`, throttled in a
  background window, so the highlight lingered in `test/ui-chatsearch.js`.
- **The filter button shows a dot** (`.has-filter`) whenever a chip is not on its
  default; `activeFilterCount` is the single source of that.

## Stories (v0.9.0)

- **The story rules live in `src/lib/stories.js`** (`window.SleePhyStories`), a
  pure library with no DOM, no crypto and no network: `make`/`clampTtl` normalize
  a draft (TTL clamped to 1–24 h), `encode`/`decode` wrap the caption in a tiny
  JSON body, `expiresAt`/`isExpired`/`remainingMs`/`remainingLabel` handle the
  24-hour window, and `filterActive`/`byAuthor`/`orderAuthors`/`unseenCount`/
  `nextId` drive the bar. Unit tests are `test/story.js`.
- **A story body is an ordinary end-to-end encrypted envelope**, one copy per
  viewer, exactly like a group message. The relay stores only the ciphertext plus
  an audience list, so it never learns the caption, the picture or who watched
  what. `test/story-relay.js` asserts no plaintext body reaches the relay.
- **The relay keeps the audience, not a broadcast.** `story_audience` lists who
  may open a story (contacts and peers the author has talked to), and
  `story_views` records who opened it. `handleStoryList` returns only the rows
  the signed-in account is in the audience of, or authored.
- **The author learns a count, never a list, from the socket.** `story.viewed`
  increments `story_views` and pushes `story.views { id, count }` to the author.
  The who-viewed list is a separate, author-only request (`story.viewers`).
- **An expired story is hidden and swept on read.** `handleStoryList` drops rows
  past `expires_at` and deletes them, so a 24-hour story leaves the relay store
  without a background job.
- **A story picture is encrypted per viewer too**, in the same envelope as the
  caption: `{ perMember: { viewer: { box, nonce } } }`. `openStoryAttachment`
  decrypts the signed-in viewer's own blob; a stranger has no blob and is refused.
- **The stories bar stays visible once signed in** (the "my story" button is how
  a person adds one, and it must be reachable before the first story exists). It
  is hidden only while signed out.
- **The viewer's prev/next tap zones sit between the header and the footer**
  (`top: 64px; bottom: 60px`), not over the whole screen — otherwise they cover
  the close and delete buttons. `test/ui-stories.js` caught this.
- **`test/ui-stories.js` drives the real UI** — publish, see the ring, open it,
  watch the ring go from unseen to seen, and read the author's view count. Run it
  with `xvfb-run`.

## Self-destructing messages (v0.11.0)

- **The timer belongs to the pair, not the message.** `chats.ttl` (seconds, 0 =
  off) is written for both owners in one `handleChatTtl`, and each side is told
  with `chat.ttl`, so both devices show the same clock. Only future messages are
  affected; a message already sent keeps the countdown it was given.
- **The relay enforces the clock on the ciphertext alone.** On send, `expires_at`
  is stamped as `ts + ttl`, clamped to `[MIN_TTL_MS, MAX_TTL_MS]`
  (`1s … 7 days`). The relay never reads the body, so a timer can only mean "wipe
  this row", not "read then wipe".
- **The sweeper wipes in place, then tells both sides.** A 5-second interval
  (`q.expired` → `q.expireMessage`) clears `box`, `nonce` and `attachment` on
  rows past `expires_at`, leaving a `deleted` marker, then pushes `expired` to
  the sender and the recipient. Running on a timer (not per message) is what
  makes it correct for a device that was offline when the clock ran out; that
  device learns on its next history read, where the row already reads as deleted.
- **The optimistic bubble seeds its own countdown.** `send()` paints the bubble
  before the relay replies, so it sets `expiresAt = Date.now() + chat.ttl` and
  the relay's confirmed value replaces it on `sent`. The renderer repaints after
  confirmation (`renderMessages`) so a clamped value still shows.
- **The countdown ticks on the client.** `messageEl` draws a `.ttl-mark` with a
  `.ttl-remain` and a `data-exp`; `tickTtlMarks()` refreshes the text on a 1s
  interval and right after every render, so a fresh bubble is never blank for a
  second. `test/ui-ttl.js` caught exactly that blank.
- **`test/ttl.js` asserts the sweep on the raw database**, not just the protocol:
  after expiry the row's `box`/`nonce` are empty and a history read returns it as
  deleted. No plaintext ever reaches the relay.

## Key verification (v0.12.0)

- **The safety number is computed on the device, never fetched.** Both public
  keys are decoded, sorted (`Buffer.compare`) and hashed with
  `crypto_generichash(64, …)`; the 64-byte digest is cut into twelve five-digit
  groups. Sorting is what makes the two ends agree without a round trip, and it
  is also why the number can never be a value the relay chooses.
- **`safetyNumberWith` reuses `ensurePeerKey`.** A peer key already cached by a
  send is used as-is; otherwise the directory is asked once. There is no new wire
  message for verification, so the relay learns nothing new.
- **The verified tick is a local note, not a server flag.** `state.verifiedPeers`
  is mirrored into the account settings (`verifiedPeers`) exactly like drafts, so
  it survives a reload and follows the account. Marking is a one-way button: the
  tick replaces it, and it cannot be un-set from the UI.
- **A self profile hides the block** (`renderSafetyNumber` returns early), since
  there is nothing to compare against yourself.
- **`test/safety.js` checks the property that matters**: the same pair on two
  devices yields one number, a different peer yields another, a substituted key
  changes it, and the number never appears in the message store. `test/ui-safety.js`
  drives the real profile overlay, including the tick surviving a reopen.

## Global message search (v0.14.0)

- **The relay never sees the query.** `search.global` (`handleSearchGlobal`)
  returns the newest slice of *every* conversation the caller can open — direct
  (`recentMessages`, `send_at IS NULL`, `deleted = 0`), group
  (`groupRecentMessages`) and channel (`channelRecentMessages`) — each row
  carrying its `chatKey`. The client decrypts the slice and matches the text on
  the device, so a search string is never transmitted.
- **One filter layer, reused.** The pure `src/lib/globalsearch.js`
  (`window.SleePhyGlobalSearch`) owns `searchAcross(conversations, filter, opts)`
  and `groupByChat`, mirroring `chatsearch.js`. The renderer runs the same filter
  over chats already in memory *and* over the decrypted relay slice, then merges
  by `chatKey:id` (direct and group ids come from different tables and can
  collide) and sorts newest-first.
- **The slice is cached, and invalidated on any message event.** `globalSearchItems`
  holds the decrypted slice for 20s so a burst of keystrokes does not re-fetch;
  `MESSAGE_EVENTS` (`message`, `edited`, `deleted`, `scheduled.released`, and the
  group/channel equivalents) clears it in `api.onEvent` before the switch.
- **Hits land in the existing top box.** `runSearch` renders the people/channels
  as before, then `renderGlobalSearch` fills the `#search-messages` list under a
  "Сообщения" heading. A row shows the chat, the sender (or "Вы"), a snippet and
  the day; clicking it opens that chat and `scrollToMessage`s to the hit, paging
  older direct history when the message is not in the loaded page.
- **`test/globalsearch.js`** covers the pure rules (15 checks);
  `test/globalsearch-relay.js` proves the relay slice decrypts across direct,
  group and channel chats and never leaks a held or deleted message;
  `test/ui-globalsearch.js` drives the real box, section, row and click-through.

## Scheduled messages (v0.13.0)

- **A scheduled message is a held row, not a new table.** `messages.send_at`
  holds the intended instant; while it is set, the row is invisible to the
  recipient: `undeliveredFor` requires `send_at IS NULL`, so it never appears in
  offline delivery or in the peer's `history`. The sender reads it back through
  `scheduled.list`, which decrypts `box`/`nonce` on the device like any other
  message — the relay still only ever holds ciphertext plus the send time.
- **The sweeper releases before it expires.** On each 5-second tick the relay
  first takes rows whose `send_at` has passed (`q.dueScheduled` → 
  `releaseScheduledMessage`), clears `send_at`, and pushes the normal `message`
  frame to the recipient plus `scheduled.released` to the sender. Releasing first
  matters: a message can carry both a `send_at` and an `expires_at`, and the
  self-destruct clock must start when the message actually arrives, not when it
  was written.
- **`releaseScheduledMessage` is the single release path.** "Send now"
  (`scheduled.sendNow`) and the sweeper both call it, so a message sent early and
  a message sent on time behave identically. Cancel and reschedule only touch
  `send_at`; cancel also sets `scheduled_hidden = 1` so a cancelled row stays out
  of the list on every one of the sender's devices without becoming a message.
- **`sendAt` is clamped, never trusted.** `handleSend` and `scheduled.reschedule`
  lift any time below `MIN_SCHEDULE_MS` into the future and cap it at
  `MAX_SCHEDULE_MS`, mirroring the TTL clamp — a client clock that is wrong or a
  crafted request cannot schedule something in the past or years out.
- **The renderer mirrors the TTL picker.** `openSchedulePicker` reuses the timer
  modal's look; the drawer's **Отложенные** entry (`data-drawer="scheduled"`) and
  a badge count the queue. `scheduled.new` / `released` / `cancelled` /
  `rescheduled` keep every one of the sender's devices in step, and `refreshScheduled`
  runs on sign-in beside the other loaders.
- **`test/scheduled.js` checks the property that matters**: a held message is
  absent from the recipient's history and the relay store is still ciphertext,
  cancel never delivers, "send now" and the sweep both deliver exactly once, and
  the send time is clamped. `test/ui-scheduled.js` drives the real picker, badge,
  list, send-now and cancel.

## Calls and Бурмалда FM (v0.15.0)

- **Calls are signaling only.** The relay (`handleCallInvite`/`Answer`/`Signal`/
  `Decline`/`Hangup` in `server/index.js`) forwards WebRTC handshake frames and
  never touches media, which flows peer-to-peer under DTLS-SRTP. Call state lives
  in the in-memory `calls` Map keyed by `c<seq>`; nothing about a call is written
  to the database. `call.participants` is a `Set` of usernames and `callFanout`
  is the single broadcast helper (everyone on the call except the sender).
- **A group call is a mesh, capped at `CALL_MAX_PARTICIPANTS` (6).** Each peer
  opens one `RTCPeerConnection` per other peer; `call.signal` carries a `to` field
  so a frame addresses one leg. The roster comes from the group's member list at
  invite time; `call.answer` replies with the others so the answerer knows which
  legs to build.
- **Legs are built on answer, not on invite.** `startCall` rings first and builds
  a leg only when a `call.answered` arrives, so an offer cannot open the callee's
  microphone while their phone is still ringing. `acceptIncoming` builds legs
  lazily as offers arrive. `flushPendingSignals(peer)` buffers any signal that
  reaches a device before its leg exists.
- **A dropped socket must not leave a phantom in a call.** `unbindSocket` removes
  the user from every call and fans out `call.left`, or `call.ended` when they
  were the second-to-last (mirroring `handleCallHangup`).
- **ICE servers are user-supplied.** `CALLS.DEFAULT_ICE` is empty, so calls work
  on one LAN with no configuration; Settings → Advanced writes `iceServers` into
  saved settings and `iceServers()` merges them under the defaults.
- **Бурмалда FM reads a writable folder.** `sleephy:readMediaManifest` seeds and
  reads `userData/media/{fm,ringtones}` (templates `FM_TEMPLATE` /
  `RINGTONES_TEMPLATE` in `main.js`) and returns `{ dir, manifest }`. This matters
  because an installed app's own files sit in read-only `app.asar`; a user must be
  able to drop music in after install. The renderer turns `dir` into a `file://`
  URL via `mediaUrl(dir, name)`. `src/lib/fm.js` stays pure: `buildPlaylist(manifest,
  base)` takes the base folder so the same code serves the app and the tests.
- **Empty is honest.** With no manifest the station shows "тишина в эфире" and
  calls fall back to a synthesized chime (`startRingToneFallback`), so a missing
  folder is never an error.
- **Port 8795 is shared by several suites** (`features`, `safety`, `accounts`,
  `shots`, `sms-adapter`). A leftover `server/sms-adapter.js` or relay process
  squats on it and makes those suites fail with `EADDRINUSE` / "Vault is locked";
  kill the stray process before believing a failure. Verify any suspected
  regression against a clean tree with `git stash -u` before calling it
  pre-existing.
- **`test/ui-calls.js` exercises real WebRTC** with `--use-fake-device-for-media-stream`
  and drives the FM station against the launched profile's own `media/fm` folder.

## Rockets, Premium and payments (v0.16.0)

- **The relay is the only authority on money.** `src/lib/money.js` is pure
  arithmetic shared by the relay and the renderer, but it *computes* prices; it
  never decides them. The relay holds the price table (`ROCKET_PRICE_KOPECKS`,
  `PREMIUM_PRICE_KOPECKS`, the fixed `ROCKET_BUNDLES` list and `GIFT_CATALOGUE`)
  and recomputes the amount on every request. A client that names a bundle the
  relay does not list, or a gift the catalogue does not price, is refused — the
  amount is never taken from the request.
- **Money is credited exactly once, keyed by the provider's reference.**
  `payments.provider_ref` is unique; `settlePayment(id, ref)` is the single place
  that credits a wallet or extends Premium, and it no-ops when the row is already
  `paid`. A duplicate notification, a retry, or a claim after a restart all land
  on the same row. `wallet.get`/`pay.claim` re-read it rather than trusting the
  request.
- **Premium extends, it does not restart.** `MONEY.extendPremium(until, now)` adds
  a month to the later of "now" and the current expiry, so buying again while
  subscribed stacks. `premium_until` lives on the user row; `premiumState` derives
  the active flag from it.
- **Rockets move through `moveRockets(username, delta, reason, detail)`** — it
  writes the new balance and one `rocket_ledger` row in the same call, so the
  ledger is the audit trail and never drifts from `wallets.balance`. `gift.send`
  debits first, then lets the gift message go; an unaffordable gift is refused
  before anything is sent.
- **The sign-up grant is a ledger row, not a special balance.** `WELCOME_ROCKETS`
  (default 10) is credited in `handleRegister` via `moveRockets(..., 'welcome')`.
  Tests that assert exact balances set `SLEEPHY_WELCOME_ROCKETS=0`.
- **The provider secret never reaches the relay or the app.**
  `server/pay-adapter.js` mirrors `sms-adapter.js`: the relay posts
  `{id,amount}` and the adapter talks to the provider, holds the secret, and
  checks the provider's confirmed amount matches before reporting `paid`. The
  default provider is `mock`, which settles instantly so the flow works with no
  account; `yoomoney` builds a real checkout link. The token rides in the URL path
  (`/create/<token>`), because the relay cannot send headers.
- **A single-process host has no adapter, so the relay can talk to YooMoney
  itself.** `amvera.yaml` runs only `server/index.js`; the adapter is a second
  process that never starts there. So when `SLEEPHY_PAY_PROVIDER=yoomoney`, the
  wallet (`YOOMONEY_RECEIVER`) and the secret (`YOOMONEY_SECRET`) are set and
  `SLEEPHY_PAY_ADAPTER` is **empty**, `payMode()` returns `direct`: the relay
  builds the quickpay link in `yoomoneyDirectCreate` and settles from YooMoney's
  signed notification posted to `/notify/<SLEEPHY_PAY_ADAPTER_TOKEN>`. A missing
  wallet or secret falls back to `disabled`, which refuses a purchase rather
  than crediting one for free, so a half-configured host can never take a payment
  it cannot credit. `payMode()`
  is the single source of truth for create/confirm/claim, so a link is only ever
  handed out together with the handler that can settle it. `test/pay-yoomoney-direct.js`
  covers the direct path.
- **The built-in checkout is opt-in, and an unconfigured relay refuses
  purchases.** `/pay/checkout` credits on a button press and moves no money, so
  it is a demo: `payMode()` returns `checkout` only when `SLEEPHY_PAY_DEMO` is
  set (1/true/yes/on). Otherwise, with no real provider, `payMode()` is
  `disabled`: `handlePayCreate` answers with an error and no payment row is
  written, so a default relay cannot be drained for free. `mock` is unaffected
  (tests only). `/health` reports the mode as `payments`, and the admin panel
  shows it as a banner, so the owner can tell a live relay from a demo one.
  `test/pay-disabled.js` pins this; `test/pay-checkout.js` and
  `test/ui-pay-checkout.js` set `SLEEPHY_PAY_DEMO=1` to exercise the demo.
- **`/notify` checks the sha1 signature and the amount, and settles once.**
  `yoomoneyDirectSignature` mirrors the adapter's check; a bad signature is
  refused (403), a non-`incoming` notification is acknowledged and ignored, and
  only a payment the relay is waiting on, for at least the asked amount, settles.
  A replay is a no-op because `settlePayment` is guarded by the payment's
  `pending` status and the ledger's UNIQUE index.
- **`SLEEPHY_PAY_ADAPTER` is the bare host; the token goes in
  `SLEEPHY_PAY_ADAPTER_TOKEN`.** `payAdapterEndpoint` appends `/create` (or
  `/verify`) and then the token, so the adapter must see `/create/<token>`. Putting
  the token in the host too (`.../8791/<token>`) makes the relay ask for
  `/<token>/create`, which the adapter does not serve — the README had this wrong
  and `test/pay-flow.js` caught it. Same token on both sides: `PAY_ADAPTER_TOKEN`
  on the adapter, `SLEEPHY_PAY_ADAPTER_TOKEN` on the relay.
- **A purchase with a real provider is `pending` until a claim confirms it.**
  `pay.create` returns a `checkoutUrl` and the app opens it in the browser; the
  renderer keeps the payment id in `state.wallet.pending` and calls `payClaim` on
  the next window `focus`/`visibilitychange`. `handlePayClaim` returns a
  `paymentStatus` (`pending`/`paid`) so the UI can tell "not yet" from "failed",
  and `settlePayment` credits exactly once however many times it is claimed. The
  `/pay/return` page on the relay is inert — it only tells the browser to go back;
  it can never move money.
- **`pay.create` returns a checkout URL; the app opens it in the system browser**
  (`openExternal` over IPC, not a renderer `window.open`). Settlement arrives on
  the relay's own `wallet` push, which every device of that user receives — so a
  balance paid on one device shows on the others.
- **Wallet state is pushed, not polled.** `walletState(username)` is the one
  shape; `deliverToUser` sends it as a `wallet` event after any change, and
  `src/lib/client.js` turns it into `{type:'wallet', balance, premium, settled}`.
  The renderer's `applyWallet` is the only place that updates the panes.
- **The Premium CTA keeps its price in a child span.** `renderWallet` writes
  `#premium-cta` and `#premium-price` separately; setting `textContent` on the
  button itself deletes the price span (this was a real bug `test/ui-premium.js`
  caught).


## Tray, notifications and the persistent relay (v0.16.2)

- **The app lives in the tray.** `main.js` creates a `Tray` on ready; the window's
  `close` handler calls `event.preventDefault()` and hides instead of quitting,
  so messages and notifications keep arriving with the window closed. The tray
  menu's "Выйти" (and `before-quit`) sets `isQuitting = true`, which is the only
  way the close handler lets the window actually close. If `Tray` construction
  throws (no tray on the desktop), `tray` stays `null` and the close handler
  quits instead of hiding — otherwise the app would be stranded invisible.
- **Toasts go through the main process, not the renderer.** The renderer's
  `notifyNewMessage` calls `window.sleephy.notify({title, body})` (IPC
  `sleephy:notify`), and `main.js` raises the `Notification`. An HTML5
  `new Notification()` in the renderer is attributed to "Electron App" on
  Windows; only a main-process notification carries the app identity. The
  renderer keeps the old path as a fallback for a missing bridge.
- **`app.setAppUserModelId('ru.sleephy.desktop')` is what titles the toast.**
  The value must equal the electron-builder `appId`, because Windows matches a
  toast to the installed Start Menu shortcut by AppUserModelID. Change one and
  the toast goes back to "Electron App".
- **The app icon ships via `extraResources`.** `build/` is not inside the asar
  and is not copied by default, so `extraResources` maps `build/icon.png` to
  `resources/icon.png`. `appIconPath()` prefers the packaged copy and falls back
  to `build/icon.png` in development; it is used for the window, the tray and the
  notification, so all three stay branded.
- **`app.setName()` is deliberately NOT called.** In the packaged app `name` is
  `sleephy` while `productName` is `SleePhy`; Electron already reports the
  productName, so `app.getName()` is `SleePhy` and the userData path is stable.
  Calling `setName` only risks moving `app.getPath('userData')` and orphaning the
  existing profile.
- **The relay keeps its data only where `SLEEPHY_DB` points.** `server/index.js`
  defaults to `server/sleephy.db`, which is *inside* the image and therefore
  ephemeral on Amvera; the `persistenceMount: /data` volume is only useful if
  `SLEEPHY_DB=/data/sleephy.db` is set. Without it a redeploy starts from an
  empty `users` table and the admin panel looks "wiped" — the accounts were never
  deleted, the relay is reading a different file. The old data is in the local
  `server/sleephy.db` (gitignored, so it never reaches the image).
- **`SLEEPHY_ADMINS` defaults to `pidoras`.** Anyone who registers that name
  becomes an admin on a relay where the env var is unset. Always set the variable
  to a private name in production.

## Sockets, crash guards and the "closed before established" error (v0.16.3)

- **A socket in `CONNECTING` cannot be closed politely.** `ws` answers
  `close()` (and `terminate()`) on a handshake that has not finished by aborting
  it and emitting `error` with "WebSocket was closed before the connection was
  established". `teardownSocket()` used to call `removeAllListeners()` first, so
  that `error` had no listener and became an **uncaught exception that killed the
  Electron main process** — the user saw a raw "A JavaScript error occurred in
  the main process" dialog on every launch and every quit. The fix keeps one
  no-op `error` listener on the socket being torn down. Do not remove it; a
  listener attached *before* `close()` is what absorbs the abort.
- **Both crash sites came from the same line.** Launch ran `connect()` from
  `sleephy:connect`, quit ran `disconnect()`; both reach `teardownSocket()`. One
  fix covers both, which is why the two reported dialogs had identical stacks.
- **`main.js` now has `uncaughtException` / `unhandledRejection` handlers.** The
  relay had them from the start (`server/index.js`) but the desktop app did not,
  so any stray error closed every window with a stack trace. The guard logs and
  keeps running; it is a safety net, not a substitute for fixing the cause.
- **Test the teardown without Electron.** `test/socket-teardown.js` drives
  `SleePhyClient` directly in plain Node (the client does not require `electron`)
  against a dead port, so it reproduces the crash in milliseconds. It also
  asserts a live socket still connects, so the fix cannot be "swallow
  everything".

## Бурмалда FM ships inside the app (v0.16.4)

- **The station is bundled, not empty by default.** `build/fm/` holds
  `burmalda-fm.ogg` (a 5h26m Opus track, ~70 MB) and `playlist.json`, copied into
  `resources/fm` by the `extraResources` entry in `package.json`. Opening the tab
  is a user gesture, so `openFm()` starts playback itself and `repeat-one` keeps
  it going for as long as the app is open. Do not switch the default mode back to
  `'all'`: a single bundled track would stop after one pass and look broken.
- **The listener's own folder still wins.** `readMediaManifest('fm')` returns the
  user's `media/fm` when its `tracks` array is non-empty, and falls back to
  `resources/fm` only when it is empty. Ringtones are unaffected — the bundled
  fallback is FM-only.
- **A 70 MB resource makes the installer ~145 MB.** The audio is transcoded to
  Opus 32 kbps stereo; keep the source out of git history if it is ever
  re-encoded. GitHub rejects files over 100 MB, so the track must stay under that
  or move to a release asset.
- **`test/ui-fm.js` covers the station** (on-air by default, repeat-one default,
  real decode, mode cycling, personal folder overriding). The `ui-calls.js` FM
  step was trimmed to a smoke check so the two suites do not duplicate each other.
- **`test/e2e.js` skips the `0600` check on Windows.** Windows has no POSIX mode
  bits — `statSync().mode` always reads `0o666` there — so the assertion failed on
  the CI runner and blocked the release job. It is skipped on `win32` only.

## Releases, the download link and CI (v0.16.4)

- **The download button must stay version-free.** `deploy/free/index.html` points
  at `/download/latest`; the relay resolves the newest release through the GitHub
  API (5-minute cache) and 302s to its installer, falling back to its own
  `package.json` version when the API is unreachable. Pinning a version is what
  left the live Amvera page offering `0.16.2` — a build with the socket bug —
  long after `0.16.3` had shipped.
- **`amvera.yaml` builds `deploy/free/Dockerfile`, and that Dockerfile copies
  `deploy/free/index.html` into the image.** The page is baked in at build time,
  so a page change only reaches Amvera after the image is rebuilt there. The
  `/download/latest` route is what makes an un-rebuilt image harmless.
- **The CI release job needs `permissions: contents: write` and
  `generate_release_notes: false`.** Without the permission the attach step fails
  with "Resource not accessible by integration"; generating notes on top of a
  hand-written release hits the same wall. Notes are written by hand on GitHub.
- **`test/e2e.js` is the gate that blocked every tagged build.** It asserted
  POSIX `0600` on the identity file, which Windows reports as `0666`; the check
  now returns early on `win32`.

## The toolchain must be declared, and CI must use it (v0.16.4)

- **`electron`, `electron-builder` and `playwright-core` belong in
  `devDependencies`.** They were installed locally but never declared, so `npm ci`
  in CI installed only `ws` and `libsodium-wrappers`; the build then died with
  "Cannot compute electron version from installed node modules". Any tool a
  script or test invokes must be in `devDependencies`, or CI cannot run it.
- **The workflow calls `npm run dist:win`, not `npx electron-builder`.** `npx`
  fetched whatever version was current (26.x) instead of the pinned 24.13.3, so
  the CI build and the local build could disagree. Add `-- --publish never` too:
  the workflow attaches files with `action-gh-release`, and electron-builder
  otherwise auto-publishes under CI detection.
- **Beware `npx asar extract-file`.** It writes the extracted file into the
  current directory, not a temp path; one run dropped a stray `client.js` in the
  repo root and a truncated `package.json` into a commit. Extract to an explicit
  path and delete it afterwards.

## The dead sandbox address and the stuck sign-in screen (v0.16.5)

- **One build shipped a development sandbox host as its default relay**
  (`work-1-….prod-runtime.all-hands.dev`). Because `connect()` remembers the
  address in `sleephy-server.json`, that dead host **outlived the build**: an
  upgrade kept the app pointed at a host that no longer resolves, so it sat
  offline with a grey connection dot while the bundled default had long since
  moved to the real relay. `readServerUrl()` now ignores any
  `*.prod-runtime.all-hands.dev` address and `writeServerUrl()` refuses to store
  one, so the bundled default takes over. `test/server-migration.js` covers it.
- **A user who pastes a working address still saw the app die**, because that
  build predates the teardown fix (v0.16.3) and the `uncaughtException` guard in
  `main.js`: switching the server while the old socket was still CONNECTING ran
  `removeAllListeners()` then `close()`, `ws` emitted `error` with no listener,
  and the main process exited. The window stayed up showing "Входим…" with a grey
  dot, which is exactly the reported symptom.
- **`server-default.json` is read from `path.join(__dirname,'..','..')`**, i.e.
  the app root, and `package.json` `build.files` includes it. Keep that path in
  sync if the file ever moves.
- **Never point a shipped build at an ephemeral dev host.** It is not enough to
  fix the default later — the saved address has to be filtered too.

## Chat actions live in the profile, gifts are a collection (v0.16.7)

- **There is no chat options menu any more.** `#btn-chat-menu` and
  `#chatmenu-backdrop` were removed; the entry point is `#btn-peer-profile` in
  the chat header, which opens `#profile-backdrop`. Pin, mute, archive,
  auto-delete, mark-as-read, clear, leave and delete sit in
  `#profile-chat-actions-list` as `.menu-item[data-action=…]`, driven by
  `renderProfileChatActions()` and routed through the shared `runChatAction()`.
  Tests that drove `#menu-*` now drive `#pa-*` (see `#pa-ttl`,
  `#pa-channel-settings`). Only one copy of each action exists; do not
  reintroduce a second entry point, or the two will drift.
- **Your own profile shows no chat actions.** `showProfile()` hides
  `#profile-chat-actions` when `isSelf`, because your profile manages no chat.
  A test that opens the profile and expects the actions must open the *peer*
  profile (`#btn-peer-profile`), not `#btn-my-profile`.
- **The profile is tabbed: `Профиль` and `Подарки`.** The gifts tab is for the
  owner only (`data-tab="gifts"` is hidden on someone else's profile) and is
  populated by `loadProfileGifts()`. An equipped gift shows as a card
  (`#profile-gift-card`) on the public profile.
- **The public-key block is gone.** `renderPubkey()` and `#profile-pubkey` were
  removed; the safety number is the one way to check a contact. Do not bring the
  raw key back.
- **The relay keeps a gift inventory per account** (`gifts.changed` is pushed to
  clients and handled in `src/lib/client.js`). A received gift can be equipped
  on the profile or sold back for part of its price; `test/payments.js` covers
  ownership, resale value, equip/replace, sell, claim-twice and report status.
- **Rockets are granted only after the provider confirms.** The old order
  credited the wallet first, so a failed top-up still paid out. `WELCOME_ROCKETS`
  (`server/index.js`) is the sign-up grant.
- **Building the Windows installer locally works** with Wine present
  (`/usr/local/bin/wine`) and the electron-builder cache warm:
  `npx electron-builder --win` → `dist/SleePhy-Setup-<version>.exe`. The CI job
  on a tag does the same and attaches the file to the release.
- **The repo token can push and create releases, but not edit repository
  metadata.** `gh repo edit` (description, topics, homepage) returns
  `403 Resource not accessible by integration`; the README is the page that can
  be changed.
- **`xvfb-run -a node test/ui-features.js` is flaky in this sandbox.** The first
  step ("search finds the other user") times out on a clean tree too, and every
  later step that depends on the peer chat then fails with it — the same 6
  failures appear with and without local changes. Do not read that cascade as a
  regression; check a focused test against a real relay instead. Kill stray
  `server/index.js` processes between runs or they collide on the port.

## Rate limits, the device account cap and the device tab (v0.16.8)

- **The relay rate-limits bursts and forgets stale keys.** `server/index.js`
  holds a small in-memory limiter (`rateLimit`) keyed per socket and per
  identity; a refused request answers with the usual error plus `retryAfterMs`,
  which `src/lib/client.js` surfaces on the thrown error. `test/ratelimit-relay.js`
  and `test/ratelimit.js` cover the relay and the pure limiter.
- **A device may hold three accounts, five with Premium.** The cap is keyed by a
  client-generated installation id (`device_id` on `users`, created by
  `SleePhyClient.ensureDeviceId()` and sent on `register`, `phone.request` and
  `resume`). The relay counts accounts per `device_id` in `canCreateAccount`
  before it writes a new user. `test/account-limit.js` covers three-allowed,
  fourth-refused, per-device isolation, missing id, the Premium raise and the
  sixth refusal.
- **The device id is a grouping key, not an identity.** It never leaves the
  relay's admin surface, it is not shown to other users, and it carries no
  message content. Do not treat it as an account credential.
- **`device_id` is a migration, not a fresh column.** Existing databases get it
  through an `ALTER TABLE users ADD COLUMN device_id` guarded by a
  `PRAGMA table_info` check; `test/server-migration.js` guards that path.
- **The admin panel gained a devices tab.** `admin.devices` returns one row per
  device (`accounts`, `usernames`, `premium`, first/last seen) and
  `admin.action { action: 'deviceClear', deviceId }` detaches every account from
  a device without deleting anything. The panel also has a Premium stat and a
  Premium filter chip. `test/admin.js` covers the list, the clear and the
  non-admin refusal; `test/ui-admin.js` drives the tab.
- **A new admin bridge method needs three edits, not one.** `adminDevices` had
  to be added to `src/lib/client.js`, `preload.js` (`contextBridge`) and
  `main.js` (`ipcMain.handle`). Missing the preload/main pair leaves the panel
  empty and the whole admin UI suite failing — check all three when adding an
  admin call.
- **`test/ui-admin.js` is flaky in this sandbox too.** Two steps ("the filter
  chips narrow the list" and "an admin grants Rockets and Premium") fail on a
  clean tree as well; the baseline run scored 8/10. Do not read those two as a
  regression.
