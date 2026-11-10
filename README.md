# SleePhy

An end-to-end encrypted messenger. The server is a **blind relay** — it stores
and forwards ciphertext it cannot read.

> Status: working MVP. Text messaging between two accounts works, with real
> end-to-end encryption and a real relay server. See [What is not done yet](#what-is-not-done-yet).

![Chat](shots/3-chat.png)

## What works

**Accounts and profiles**
- Create an account and sign in with a username and password
  (the password protects the keys on your device)
- Phone sign-in is built but parked: the button is disabled and shows "Скоро",
  because delivering codes needs a funded SMS provider
- **Claim a username** — it is unique, and nobody else can take it
- **Change your username** at any time; the old one is freed immediately
- Profile: display name, bio, avatar colour and **social links** (Telegram,
  Instagram, X, GitHub, a website…), shown as chips on your profile
- **Privacy switches, enforced by the relay**: hide your last-seen time, and
  hide your profile (name, bio, picture and social links) from everyone but
  yourself

**Messaging**
- Search for users by username and start a chat
- Text messages with **end-to-end encryption** — the relay never sees plaintext
- **Saved Messages** — notes you send to yourself, readable only by you
- **Replies** with a quoted original
- **Edit and delete** your own messages
- **Reactions** (👍 ❤️ 😂 🔥 😮 😢)
- **Typing indicators** and **online presence**
- **Огонёк** — a flame inside each chat: the days in a row the two of you have
  written to each other, shown in the chat header and on the row in the chat
  list. On the day a series starts, a centered note appears in the transcript.
  The relay counts the days; it stores no message content
- **Self-destructing messages** — set a timer on a one-to-one chat and every new
  message vanishes for both people when it runs out. Each bubble shows a live
  countdown. The relay holds only ciphertext, so the clock it enforces wipes the
  stored ciphertext (and any attachment) in place, then tells both devices to
  drop the bubble; an offline device learns on its next history read
- **Scheduled messages ("send later")** — write a message, choose a time in the
  attachment menu, and the relay holds the ciphertext until then and releases it
  automatically. The **Отложенные** drawer entry lists everything waiting, with
  the time and a preview; you can send one early or cancel it. The relay stores
  only ciphertext and the send time, so it never learns what is being sent
- **Key verification (safety numbers)** — open a contact's profile to see a
  twelve-group code derived on your device from both public keys. It is the same
  on both ends and never sent to the relay, so reading it aloud over another
  channel proves the server did not substitute a key. Mark a contact verified to
  keep a tick next to their name
- Offline delivery: messages sent while you were away arrive on reconnect
- Message history, decrypted locally, grouped by day
- **Drafts** — what you typed but did not send is kept per chat and shown in the
  chat list as `Черновик: …`

**Groups, channels and extras**
- **Group chats** with a member list and sender names on each bubble
- **Channels** — one-to-many broadcasts you can discover and follow
- **Bots** and **mini-games** (tic-tac-toe, battleship) played in a chat, one
  move per encrypted message
- **Gifts** — a small sticker-like present in a chat
- **Polls** — a question with options, single- or multiple-choice, sent as an
  ordinary encrypted message; the tally is local and updates on both devices
- **Stories** — a 24-hour post (a caption, a picture, or both) shared with your
  contacts and the people you have talked to. Each viewer gets their own
  encrypted copy, so the relay stores only ciphertext and never learns the text,
  the picture or who watched what. The author sees a view count, not a list

**Calls and music**
- **Calls** — one-to-one and **group** audio and video calls, with a ring card,
  mute, camera toggle, screen share and a running timer. Media flows
  peer-to-peer (WebRTC); the relay forwards only the handshake, so it never
  hears or sees the call. A group call is a mesh: one connection per participant
- **Бурмалда FM** — a built-in music player. Drop your own audio files and a
  playlist into the app's media folder and it plays them with shuffle, repeat
  one/all, a seek bar and a track list

**Search**
- Find people and channels by username from the top box
- **In-chat search** with filters — by sender (me / them), by type (media, photo,
  voice, file, links, polls, gifts, games) and by date (today, week, month);
  matches are highlighted and the count is shown
- **Global search** — the same top box also searches message text across every
  chat, group and channel at once. The relay hands the device the newest slice of
  each conversation and the text is decrypted and matched locally, so the query
  itself never leaves the device. Results are grouped under "Сообщения", show the
  chat and sender, and open that chat at the message

**Chat management**
- Pin, mute and archive conversations
- Unread badges, with a separate section for archived chats
- **Chat folders** ("папки") — named filters by chat type (personal, groups,
  channels, bots, saved) with an unread-only option and an exclusive mode that
  takes its chats out of the main list
- Mark as read, clear history, delete a chat

**Desktop**
- Build for Windows (`.exe`) and Linux (AppImage)

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

The desktop app needs a relay to connect to. Without one, the connection
indicator stays red and you cannot create an account.

```bash
npm install

# 1. start the relay server
npm run server

# 2. in another terminal, start the app
npm start
```

The app connects to `ws://127.0.0.1:8787` by default. To point it somewhere
else, set the environment variable before starting:

```bash
SLEEPHY_SERVER=wss://your-server.example.com npm start
```

or change the address in the app under Settings → Server address.

To try a conversation, run a second copy with a separate profile:

```bash
npm start -- --user-data-dir=/tmp/sleephy-second
```

Register two accounts (for example `alice` and `bob`), then in one window type
the other username into the search box and press Enter.

## Ship a build pointed at your server

Create `server-default.json` in the project root before building:

```json
{ "server": "wss://your-server.example.com" }
```

It is bundled into the app, so the installer works out of the box with no
address to type. A per-machine environment variable (`SLEEPHY_SERVER`) still
overrides it.

## Build a Windows installer

```bash
npm run dist:win      # -> dist/SleePhy-Setup-0.15.0.exe
```

Building a Windows `.exe` from Linux/macOS uses Wine; the CI workflow does this
on a native Windows runner instead. See `.github/workflows/build.yml`.

## Your own music and ringtones

The **Бурмалда FM** player and the call ringtones read from a folder beside the
app's data, so they keep working after the app is installed (an installed app's
own files are read-only):

- Windows: `%APPDATA%\SleePhy\media\fm\` and `...\media\ringtones\`
- Linux: `~/.config/SleePhy/media/fm/` and `.../media/ringtones/`

Open Бурмалда FM once and the app creates the folder with a starter
`playlist.json`. Drop audio files in and list them:

```json
{ "tracks": ["night-air.mp3", { "file": "dawn.ogg", "title": "Рассвет", "artist": "Бурмалда" }] }
```

For a custom ringtone, put a file in `media/ringtones/` and name it in
`manifest.json`:

```json
{ "ringtones": { "incoming": "ring.mp3", "outgoing": "dial.mp3" } }
```

With no files the station is honestly empty ("тишина в эфире") and calls use a
built-in chime, so nothing is broken by a missing folder.

## Tests

```bash
node test/e2e.js                          # real server + real crypto (11 checks)
node test/features.js                     # profiles, chats, replies (32 checks)
node test/sms-adapter.js                  # SMS delivery against a fake provider (19 checks)
xvfb-run -a node test/ui.js               # drives the real Electron UI (16 checks)
xvfb-run -a node test/ui-features.js      # the new features, clicked for real (22 checks)
xvfb-run -a node test/ui-drafts.js        # drafts survive a restart (5 checks)
xvfb-run -a node test/ui-polls.js         # polls voted on by two devices (11 checks)
xvfb-run -a node test/ui-folders.js       # chat folders, tabs and restart (7 checks)
xvfb-run -a node test/ui-chatsearch.js    # in-chat search filters (9 checks)
xvfb-run -a node test/ui-bots-games.js    # a game and a gift over the relay
xvfb-run -a node test/connection.js       # connection and error handling (4 checks)
node test/folders.js                      # folder filter rules (12 checks)
node test/polls.js                        # poll encode, validate, tally (12 checks)
node test/games.js                        # game rules (21 checks)
node test/chatsearch.js                   # in-chat search filter rules (18 checks)
node test/globalsearch.js                 # global search rules (15 checks)
node test/globalsearch-relay.js           # global search over a real relay (10 checks)
xvfb-run -a node test/ui-globalsearch.js  # the "Сообщения" section, clicked for real (6 checks)
node test/ttl.js                          # self-destructing messages over the relay (8 checks)
node test/scheduled.js                    # scheduled messages over the relay (10 checks)
xvfb-run -a node test/ui-ttl.js           # the auto-delete timer, clicked for real (8 checks)
xvfb-run -a node test/ui-scheduled.js     # "send later" picker and list, clicked for real (9 checks)
node test/safety.js                       # safety numbers: both ends agree, per pair (8 checks)
xvfb-run -a node test/ui-safety.js        # the safety number in the profile, clicked for real (6 checks)
node test/calls-logic.js                  # call labels, ringtone choice, participant text (15 checks)
node test/calls.js                        # call signaling over a real relay (13 checks)
xvfb-run -a node test/ui-calls.js         # real calls and the FM station, clicked for real (12 checks)
node test/fm-logic.js                     # playlist, shuffle and repeat rules (17 checks)
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

### Sending login codes by SMS (not enabled)

Sign-in is by username and password, so nothing here is needed for the app to
work. This is the phone flow, kept ready for when an SMS provider is paid for.
The button on the sign-in screen stays disabled until then.

The flow is phone plus a one-time code, so the relay needs a way to deliver that
code. Without a provider it prints the code to its own log, which is fine for
development and useless for real users.

The relay only knows how to POST `{ phone, code }` as JSON to one URL
(`SLEEPHY_SMS_WEBHOOK`). Providers do not speak that shape, so a small adapter
translates between them and adds the throttling the relay does not have:

```
relay ──{phone,code}──▶ sms-adapter ──provider API──▶ SMS gateway
```

1. Get an account with a provider and an API key. For SMS.ru that is `api_id`
   on the dashboard; the endpoint is `https://sms.ru/sms/send`.
2. Start the adapter next to the relay, with the key in the environment:

```bash
SMSRU_API_ID=your-api-id SMS_ADAPTER_TOKEN=$(openssl rand -hex 16) \
  node server/sms-adapter.js
```

3. Point the relay at it and restart the relay:

```bash
SLEEPHY_SMS_WEBHOOK=http://127.0.0.1:8790/send/your-token node server/index.js
```

4. Sign in with a real number and confirm the message arrives.

The adapter listens on `127.0.0.1` only and is not meant to be exposed. Its
limits are deliberately low, because **every `phone.request` costs money and the
relay has no rate limiting of its own** — anyone who can reach the relay could
otherwise drain the balance by requesting codes in a loop:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMS_MIN_INTERVAL` | 60 | seconds between codes to one number |
| `SMS_PER_HOUR` | 3 | codes to one number per hour |
| `SMS_PER_DAY` | 5 | codes to one number per day |
| `SMS_DAILY_CAP` | 500 | codes to all numbers per day |

A refused request is logged and answered with `429`; the relay logs the failure
and the user sees the normal "try again" path. Set `SMS_TEXT` to change the
message (`{code}` is replaced), or `SMS_PROVIDER=generic` with
`SMS_GENERIC_URL` to use a different gateway. `test/sms-adapter.js` covers all of
this against a fake provider, so it runs without sending anything.

## What is not done yet

This is an honest list. The app should not be described as more secure than it is.

- **No forward secrecy.** Compromising a private key exposes past messages. A
  ratcheting protocol (Double Ratchet) is the fix.
- **Key verification is manual.** Each profile shows a safety number derived from
  both public keys, and you can mark a contact verified, but the app does not
  force a comparison before the first message, so a substituted key is only
  caught if you check the code.
- **Metadata is visible to the server** — who talks to whom, when, and message
  sizes.
- **No multi-device support** — one key per account, tied to one device.
- **Calls are best-effort.** One-to-one and group audio/video calls work over
  WebRTC, but they rely on a signaling relay and, across the public internet, on
  ICE/STUN servers. Set them in Settings → Advanced; on one local network calls
  connect without any. Group calls are a mesh, so they get heavy past a handful
  of people.
- **Message history lives on the server** until you clear the chat. It is stored
  as ciphertext the server cannot read, and "Clear history" deletes it — but a
  copy exists on the relay until then.
- **Deleting a message leaves a tombstone** in the other person's copy so the row
  cannot be silently rewritten; the ciphertext is wiped.
- **Profiles and usernames are public metadata** — anyone can search for a
  username and see the display name, bio and avatar colour.
- **The relay has no rate limiting or abuse protection** — needed before it
  faces the public internet. The SMS adapter throttles code requests, but nothing
  yet limits messages, searches or failed logins.
- **Accounts cannot be recovered.** Lose the password, lose the keys.

## Layout

```
server/index.js        WebSocket relay + accounts, profiles and chats (node:sqlite)
server/sms-adapter.js  relay JSON -> provider API, with per-number throttling
src/lib/crypto.js      libsodium + scrypt helpers (main process)
src/lib/client.js      connection, identity, encryption (main process)
src/lib/calls.js       call labels, ringtone choice, participant text
src/lib/fm.js          Бурмалда FM playlist and play-order rules
main.js                Electron main process and IPC
preload.js             the only renderer bridge (window.sleephy)
src/index.html|css|js  interface
test/                  end-to-end, feature and UI tests
```
