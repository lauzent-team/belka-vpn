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
node test/session.js  # token persistence, relay restart, unlock, avatar images
node test/peer-badges.js # a peer's checkmark and picture survive re-entry
node test/streaks.js  # the "огонёк": days active in a row, extend, reset, rename
node test/downloads.js # the relay serves the download page and the installer
node test/handles.js # @-usernames and channel @handles
node test/nicknames.js # nicknames: owner privilege, admin edit, cap, privacy
xvfb-run -a node test/ui.js            # UI tests driving the real Electron app
xvfb-run -a node test/ui-features.js   # the newer UI features, clicked for real
xvfb-run -a node test/ui-drawer.js     # drawer, settings, contacts, groups, accounts
xvfb-run -a node test/ui-menu.js       # menu bar hidden, editing shortcuts intact
xvfb-run -a node test/ui-session.js    # reopen the app: no sign-in screen, photo kept
xvfb-run -a node test/ui-peer-badges.js # a peer's badge and picture survive a re-entry
xvfb-run -a node test/ui-streak.js     # the flame chip and the profile streak line
xvfb-run -a node test/ui-nicknames.js  # the profile nickname editor and the admin popup
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
- **The streak ("огонёк") is metadata, not content.** The `streaks` table stores
  only `(username, day, count)` — the last day the account sent something and the
  running total. It is computed on send and read by `streak.get`; it never holds
  message text, and it follows a rename (`renameStmts.streaks`) and is dropped
  with the account. When it moves, the new profile is pushed to peers and back to
  the sender's own devices so every view agrees.
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
- **A tic-tac-toe move is a cell index and cell `0` is falsy**, so
  `gameMoveEquals` compares with `== null`, not `!a`. Any guard on a move value
  must not use truthiness.
- **Bots are local pseudo-peers** (like Saved Messages): no relay traffic, their
  transcript lives only in `state.chats`. `botReply` answers plain text, and the
  minigames bot starts a game on its own chat.
- **Gifts ride as ordinary encrypted messages** (`giftPayloadOf` /
  `.gift-bubble`), so the server needs no change; `previewOf` shows
  `Подарок: <name>` in the chat list.
- **The bots/games/gifts UI test is `test/ui-bots-games.js`**, run with
  `xvfb-run -a node test/ui-bots-games.js`. It opens two windows and checks a
  game invite and a gift over the real relay. Electron UI tests need
  `xvfb-run`; a test that launches a window without it fails on `Missing X
  server or $DISPLAY`.
