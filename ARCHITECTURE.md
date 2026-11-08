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

## Data model (server)
```
users     username PK, salt, verifier, public_key,
          display_name, bio, avatar_color, created_at, updated_at
messages  id PK, sender, recipient, box, nonce, ts, delivered,
          reply_to, edited_at, deleted
chats     (owner, peer) PK, pinned, muted, archived, last_read, cleared_at
reactions (message_id, username) PK, emoji, ts
```

The server never stores plaintext. `box` is a `crypto_box` sealed by the sender
for the recipient's public key; the relay can copy it but not open it.

Two things worth knowing:
- **`messages` rows are tombstones after deletion.** `deleted = 1` and the
  ciphertext columns are blanked. The row stays so the other side can be told,
  and so an edit cannot be silently rewritten into history.
- **`chats` is per-owner.** `last_read` drives unread counts, `cleared_at` hides
  everything older than a clear, and `pinned`/`muted`/`archived` are personal to
  the owner — they are never shared with the peer.

## Profile, usernames and chats
- A **username is a primary key**. Registration refuses a taken name, and
  `profile.username` renames an account inside one transaction, rewriting every
  reference (messages, chats, reactions) and rebinding live sockets and tokens.
  The old name becomes free immediately.
- **Saved Messages is just a chat with yourself.** `send` accepts the sender as
  its own recipient, which needs no special storage.
- **Presence and typing are best-effort** and never persisted. Presence is pushed
  to everyone who shares a conversation, computed from the `messages`/`chats`
  union rather than from a stored contact list.

## Components
```
server/index.js        WebSocket relay + accounts, profiles, chats (node:sqlite, ws)
src/lib/crypto.js      libsodium + scrypt helpers (main process)
src/lib/client.js      WebSocket client, key/identity management (main process)
main.js                Electron main: window + IPC
preload.js             contextBridge API (window.sleephy)
src/index.html|css|js  UI: auth, chats, profiles, chat settings
```

## Protocol (WebSocket JSON)
Every request may carry `_id`; the reply echoes it so the client can match
responses. Every handler replies, including on error — a request that gets no
reply hangs the caller for the 15 s timeout.

Client -> server
- `{t:'register', username, password, publicKey, salt, verifier}` -> `{t:'ok', action:'register', username, token, publicKey, profile}`
- `{t:'login', username, password}` -> `{t:'ok', action:'login', ...}`
- `{t:'resume', token}` -> `{t:'ok', action:'resume', ...}`
- `{t:'directory', username}` -> `{t:'key', username, publicKey, profile, online}`
- `{t:'profile.get', username}` -> `{t:'profile', profile, online, isSelf}`
- `{t:'profile.set', displayName?, bio?, avatarColor?}` -> `{t:'profile.saved', profile}`
- `{t:'profile.username', username}` -> `{t:'username.changed', username, profile}`
- `{t:'users.search', query}` -> `{t:'users', items:[...]}`
- `{t:'send', to, box, nonce, replyTo?}` -> `{t:'sent', id, ts, to, replyTo}`
- `{t:'history', with, limit}` -> `{t:'history', items:[...]}`
- `{t:'message.edit', id, box, nonce}` -> `{t:'edited', id, editedAt}`
- `{t:'message.delete', id}` -> `{t:'deleted', id}`
- `{t:'reaction', id, emoji}` -> `{t:'reactions', id, reactions:[...]}` (empty emoji clears)
- `{t:'typing', to, state:'start'|'stop'}` -> `{t:'ok'}`
- `{t:'chats.list'}` -> `{t:'chats', items:[...]}`
- `{t:'chat.settings', peer, pinned?, muted?, archived?}` -> `{t:'chat.settings', ...}`
- `{t:'chat.read', peer}` -> `{t:'chat.read', peer, lastRead}`
- `{t:'chat.clear', peer}` -> `{t:'chat.cleared', peer}`
- `{t:'chat.delete', peer}` -> `{t:'chat.deleted', peer}`

Server -> client (unsolicited)
- `{t:'ok', ...}` / `{t:'error', message}`
- `{t:'message', id, from, box, nonce, ts, replyTo}`
- `{t:'edited', id, from, box, nonce, ts, editedAt}`
- `{t:'deleted', id, from}`
- `{t:'reactions', id, reactions}`
- `{t:'typing', from, state}`
- `{t:'presence', username, online}`
- `{t:'profile', username, profile}`
