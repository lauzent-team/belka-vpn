'use strict';

/**
 * SleePhy relay server.
 *
 * A deliberately blind relay: it stores and forwards ciphertext. It never sees
 * plaintext, private keys, or password-derived decryption keys. What it does
 * know: usernames, profile fields, public keys, and message metadata
 * (who, to whom, when, how large).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');
const STREAK = require('../src/lib/streak');
const MONEY = require('../src/lib/money');

// A host (Render, Fly, Heroku-style) hands the port in PORT; SLEEPHY_PORT wins
// when it is set, so the same build runs on a VPS and on a platform.
const PORT = process.env.SLEEPHY_PORT
  ? Number(process.env.SLEEPHY_PORT)
  : (process.env.PORT ? Number(process.env.PORT) : 8787);
const DB_PATH = process.env.SLEEPHY_DB || path.join(__dirname, 'sleephy.db');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// The download page and the built installer, when they sit next to the relay.
// Only these names are ever served, so the relay cannot be walked for files.
const DOWNLOAD_DIR = process.env.SLEEPHY_DOWNLOADS || path.join(__dirname, '..', 'dist');
const DOWNLOAD_NAME = /^(index\.html|SleePhy-Setup-[\w.-]+\.exe)$/;

// The download page points its button at /download/latest rather than pinning a
// version, so a relay that is redeployed without a fresh page still hands out
// the newest installer. Pinned links are what left the live page offering
// 0.16.2 after 0.16.3 had shipped.
const GITHUB_REPO = process.env.SLEEPHY_REPO || 'lauzent-team/belka-vpn';
const INSTALLER_RE = /^SleePhy-Setup-[\w.-]+\.exe$/;
const RELEASE_CACHE_MS = 5 * 60 * 1000;
let latestInstaller = null; // { url, name, at }

/**
 * Resolve the newest installer's download URL. GitHub's API is the source of
 * truth; if it is unreachable or rate-limited we fall back to the version this
 * build was cut from, which is what the tag convention produces.
 */
async function resolveLatestInstaller() {
  const now = Date.now();
  if (latestInstaller && now - latestInstaller.at < RELEASE_CACHE_MS) return latestInstaller;

  const headers = { 'user-agent': 'sleephy-relay', accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let releases = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`, {
      headers,
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) releases = await r.json();
  } catch { /* offline or blocked — use the fallback below */ }

  if (Array.isArray(releases)) {
    for (const rel of releases) {
      if (rel.draft) continue;
      const asset = (rel.assets || []).find((a) => INSTALLER_RE.test(a.name || ''));
      if (asset && asset.browser_download_url) {
        latestInstaller = { url: asset.browser_download_url, name: asset.name, at: now };
        return latestInstaller;
      }
    }
  }

  const version = require('../package.json').version;
  const name = `SleePhy-Setup-${version}.exe`;
  latestInstaller = {
    url: `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${name}`,
    name,
    at: now
  };
  return latestInstaller;
}

// The first admin. Listed by name, never by password: the server only ever holds
// a verifier, so there is no way to hand out an account and no way to recover one.
// Extra names can be added with SLEEPHY_ADMINS="alice,bob".
const ADMINS = new Set(
  (process.env.SLEEPHY_ADMINS || 'pidoras')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

/* --------------------------- payments --------------------------- */
// The prices live here, on the relay, and nowhere else. A client can *ask* to
// buy 500 Rockets, but it cannot say what they cost: the relay picks the price
// from this table and, if the provider later confirms a different amount, the
// credit is refused. This is the only way a top-up cannot be forged.
const ROCKET_PRICE_KOPECKS = Number(process.env.SLEEPHY_ROCKET_PRICE_KOPECKS) || 89;
const PREMIUM_PRICE_KOPECKS = Number(process.env.SLEEPHY_PREMIUM_PRICE_KOPECKS) || 19900;
const PREMIUM_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
// Rocket bundles a user may buy, in whole Rockets. Fixed so the price of any
// bundle is unambiguous; `rockets * unit price` would let a client invent one.
const ROCKET_BUNDLES = [50, 100, 250, 500, 1000, 2500];
// A small gift on sign-up, so the very first gift a new user sends works and
// the shelf is not a wall of locked cards. It is a one-time grant, not a
// balance: it is written to the ledger so the accounting stays honest.
const WELCOME_ROCKETS = Number(process.env.SLEEPHY_WELCOME_ROCKETS ?? 10);
// Premium can itself be given as a gift: the sender spends Rockets and the
// recipient's subscription is extended. The price is derived from the two
// tables above so a price change cannot leave the gift out of step with the
// subscription it buys.
const PREMIUM_GIFT_ROCKETS = Number(process.env.SLEEPHY_PREMIUM_GIFT_ROCKETS)
  || Math.ceil(PREMIUM_PRICE_KOPECKS / ROCKET_PRICE_KOPECKS);
// How many months one Premium gift may cover. The sender picks a count from
// this range; anything outside is clamped, so the debit is never unbounded.
const PREMIUM_GIFT_MAX_MONTHS = Number(process.env.SLEEPHY_PREMIUM_GIFT_MAX_MONTHS) || 12;
// The gift catalogue, priced in Rockets. It lives on the relay so the debit is
// authoritative — the renderer's copy is only for drawing the shelf. A gift is
// still sent as an ordinary encrypted message; the relay only moves Rockets.
// `tier` drives the card's look only (common → legendary), never the price.
const GIFT_CATALOGUE = {
  rose: { emoji: '🌹', name: 'Роза', cost: 1, tier: 'common' },
  candy: { emoji: '🍬', name: 'Конфета', cost: 2, tier: 'common' },
  balloon: { emoji: '🎈', name: 'Шарик', cost: 3, tier: 'common' },
  teddy: { emoji: '🧸', name: 'Мишка', cost: 5, tier: 'common' },
  cake: { emoji: '🎂', name: 'Торт', cost: 5, tier: 'common' },
  pizza: { emoji: '🍕', name: 'Пицца', cost: 8, tier: 'common' },
  heart: { emoji: '💝', name: 'Сердце', cost: 10, tier: 'rare' },
  bouquet: { emoji: '💐', name: 'Букет', cost: 15, tier: 'rare' },
  guitar: { emoji: '🎸', name: 'Гитара', cost: 20, tier: 'rare' },
  ring: { emoji: '💍', name: 'Кольцо', cost: 25, tier: 'rare' },
  trophy: { emoji: '🏆', name: 'Кубок', cost: 25, tier: 'rare' },
  champagne: { emoji: '🍾', name: 'Шампанское', cost: 35, tier: 'epic' },
  plane: { emoji: '✈️', name: 'Самолёт', cost: 40, tier: 'epic' },
  diamond: { emoji: '💎', name: 'Алмаз', cost: 50, tier: 'epic' },
  rocket: { emoji: '🚀', name: 'Ракета', cost: 50, tier: 'epic' },
  unicorn: { emoji: '🦄', name: 'Единорог', cost: 75, tier: 'legendary' },
  crown: { emoji: '👑', name: 'Корона', cost: 100, tier: 'legendary' },
  star: { emoji: '🌟', name: 'Звезда', cost: 100, tier: 'legendary' }
};

// Where top-ups are collected. `checkout` is the default: the relay serves its
// own payment page and waits for the user to confirm or cancel there, so a
// purchase really goes through a payment screen instead of settling on a click.
// `mock` still settles at once, which is what the automated tests use;
// `yoomoney` asks the adapter to build a real provider link.
const PAY_PROVIDER = (process.env.SLEEPHY_PAY_PROVIDER || 'checkout').toLowerCase();
const PAY_ADAPTER_URL = process.env.SLEEPHY_PAY_ADAPTER || '';
const PAY_ADAPTER_TOKEN = process.env.SLEEPHY_PAY_ADAPTER_TOKEN || '';
// Public base of the relay, used to build the return URL a provider redirects
// to, and the checkout link handed to the app. When it is empty the link is
// built from the address the client is already talking to, which is correct for
// a single-host deployment.
const PAY_PUBLIC_URL = process.env.SLEEPHY_PAY_PUBLIC_URL || '';
// A single-process host (the Amvera container) runs only the relay, so there is
// no separate adapter to reach. In that case the relay speaks to YooMoney
// itself: it builds the quickpay link from its own config and settles a payment
// when YooMoney posts its signed notification to /notify/<token>. The secret
// stays on the server and never reaches the app.
const YOOMONEY_RECEIVER = process.env.YOOMONEY_RECEIVER || '';
const YOOMONEY_SECRET = process.env.YOOMONEY_SECRET || '';
const YOOMONEY_TOKEN = process.env.YOOMONEY_TOKEN || '';
const YOOMONEY_QUICKPAY_URL = process.env.YOOMONEY_QUICKPAY_URL || 'https://yoomoney.ru/quickpay/confirm';
const YOOMONEY_API_URL = process.env.YOOMONEY_API_URL || 'https://yoomoney.ru/api';
// Guards /notify so a stranger cannot settle a payment by guessing ids. Reuses
// the adapter token name so one value covers both wiring styles.
const PAY_NOTIFY_TOKEN = process.env.SLEEPHY_PAY_ADAPTER_TOKEN || process.env.SLEEPHY_PAY_NOTIFY_TOKEN || '';

/* ----------------------------- storage ----------------------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    salt         TEXT NOT NULL,
    verifier     TEXT NOT NULL,
    public_key   TEXT NOT NULL,
    display_name TEXT,
    bio          TEXT,
    avatar_color TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    box        TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 0,
    reply_to   INTEGER,
    edited_at  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender, recipient, id);
  CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient, delivered);
  CREATE TABLE IF NOT EXISTS chats (
    owner      TEXT NOT NULL,
    peer       TEXT NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0,
    muted      INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    last_read  INTEGER NOT NULL DEFAULT 0,
    cleared_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, peer)
  );
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    username   TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    PRIMARY KEY (message_id, username)
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    username   TEXT PRIMARY KEY,
    settings   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL,
    username  TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, username)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    sender     TEXT NOT NULL,
    envelope   TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    reply_to   INTEGER,
    edited_at  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0,
    kind       TEXT,
    attachment TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gmsg_group ON group_messages(group_id, id);
  -- Channels are one-to-many: only the owner posts, subscribers read. They reuse
  -- the group_messages envelope layout (one ciphertext copy per subscriber) so a
  -- post is stored and delivered the same way a group message is.
  CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    owner       TEXT NOT NULL,
    description TEXT,
    verified    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_subs (
    channel_id INTEGER NOT NULL,
    username   TEXT NOT NULL,
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (channel_id, username)
  );
  CREATE TABLE IF NOT EXISTS channel_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    sender     TEXT NOT NULL,
    envelope   TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    reply_to   INTEGER,
    edited_at  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0,
    kind       TEXT,
    attachment TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cmsg_channel ON channel_messages(channel_id, id);
  CREATE TABLE IF NOT EXISTS announcements (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    sender   TEXT NOT NULL,
    text     TEXT NOT NULL,
    ts       INTEGER NOT NULL
  );
  -- Every administrative action, so the panel can show what was done and by
  -- whom. The relay stores no message content, so a row is only ever a target,
  -- an action name and a short free-text detail.
  CREATE TABLE IF NOT EXISTS admin_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ts     INTEGER NOT NULL
  );
  -- One-time codes for phone sign-in. The relay only ever stores the code, its
  -- expiry and an attempt counter; the phone number itself lives on the users row.
  CREATE TABLE IF NOT EXISTS phone_codes (
    phone      TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  -- Issued session tokens. Kept on disk so a relay restart does not sign every
  -- device out: the token survives, and the client resumes without a password.
  CREATE TABLE IF NOT EXISTS sessions (
    token    TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    exp      INTEGER NOT NULL
  );
  -- The "огонёк" streak: how many days in a row the account has sent something.
  -- Only the day and the count are stored; the relay never sees a message.
  CREATE TABLE IF NOT EXISTS streaks (
    username TEXT PRIMARY KEY,
    day      TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0
  );
  -- The dialog "огонёк": days in a row *this pair* has written to each other.
  -- The pair is stored in a fixed order (a sorts before b) so there is exactly
  -- one row per conversation no matter who sends first.
  CREATE TABLE IF NOT EXISTS dialog_streaks (
    a     TEXT NOT NULL,
    b     TEXT NOT NULL,
    day   TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (a, b)
  );
  -- Stories: a 24-hour post. The body is an ordinary encrypted envelope, stored
  -- once per viewer exactly like a group message, so the relay holds ciphertext
  -- and the list of who may open it and never learns the caption or the picture.
  CREATE TABLE IF NOT EXISTS stories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author     TEXT NOT NULL,
    envelope   TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    kind       TEXT,
    attachment TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stories_author ON stories(author, id);
  CREATE INDEX IF NOT EXISTS idx_stories_exp ON stories(expires_at);
  -- Who may open a story. Kept beside the per-viewer envelope so the relay can
  -- answer "which stories can I see?" without parsing any ciphertext blob.
  CREATE TABLE IF NOT EXISTS story_audience (
    story_id INTEGER NOT NULL,
    viewer   TEXT NOT NULL,
    PRIMARY KEY (story_id, viewer)
  );
  CREATE INDEX IF NOT EXISTS idx_story_audience_viewer ON story_audience(viewer);
  -- Who has opened a story. Only the viewer id and the story id are stored, so a
  -- "seen" mark carries no content and the author never learns more than a count.
  CREATE TABLE IF NOT EXISTS story_views (
    story_id INTEGER NOT NULL,
    viewer   TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    PRIMARY KEY (story_id, viewer)
  );
  -- Rockets: the in-app currency. One balance per account, in whole Rockets.
  -- A fresh row is created on first read, so there is no separate "create".
  CREATE TABLE IF NOT EXISTS wallets (
    username   TEXT PRIMARY KEY,
    balance    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  -- Every movement of Rockets, so a balance can always be explained and a
  -- purchase can never be credited twice. provider_ref is the payment
  -- provider's own identifier for a top-up; the UNIQUE index on it is what
  -- makes crediting idempotent even if a claim is retried.
  CREATE TABLE IF NOT EXISTS rocket_ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL,
    delta        INTEGER NOT NULL,
    reason       TEXT NOT NULL,
    detail       TEXT,
    provider_ref TEXT,
    ts           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON rocket_ledger(username, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref ON rocket_ledger(provider_ref) WHERE provider_ref IS NOT NULL;
  -- A top-up intent: created when the user asks to buy Rockets, settled when
  -- the provider confirms payment. amount_rub is what the user pays, in
  -- kopecks, and rockets is what the relay will credit: both fixed here,
  -- never taken from the client.
  CREATE TABLE IF NOT EXISTS payments (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    amount_rub INTEGER NOT NULL,
    rockets    INTEGER,
    months     INTEGER,
    status     TEXT NOT NULL DEFAULT 'pending',
    provider   TEXT,
    provider_ref TEXT,
    created_at INTEGER NOT NULL,
    paid_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(username, id);
`);

// Columns added after the first release. Existing databases are upgraded in
// place; a fresh database already has them and the statement is skipped.
for (const sql of [
  'ALTER TABLE users ADD COLUMN display_name TEXT',
  'ALTER TABLE users ADD COLUMN bio TEXT',
  'ALTER TABLE users ADD COLUMN avatar_color TEXT',
  'ALTER TABLE users ADD COLUMN updated_at INTEGER',
  'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
  'ALTER TABLE messages ADD COLUMN edited_at INTEGER',
  'ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE messages ADD COLUMN kind TEXT',
  'ALTER TABLE messages ADD COLUMN attachment TEXT',
  'ALTER TABLE chats ADD COLUMN pinned_message INTEGER',
  'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN phone TEXT',
  'ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 0',
  // A custom badge image (a small data: URL) that replaces the plain checkmark.
  'ALTER TABLE users ADD COLUMN badge_image TEXT',
  // A profile picture (a small data: URL). Distinct from the admin badge.
  'ALTER TABLE users ADD COLUMN avatar_image TEXT',
  // When this account was last seen online, so peers can show "last seen".
  'ALTER TABLE users ADD COLUMN last_seen INTEGER',
  // A public @handle for a channel, so it can be found and shared as `@name`
  // instead of by an opaque numeric id.
  'ALTER TABLE channels ADD COLUMN handle TEXT',
  // Privacy switches. The relay enforces them so a hidden "last seen" or bio is
  // never sent to another account in the first place, not merely hidden in the UI.
  'ALTER TABLE users ADD COLUMN last_seen_hidden INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN profile_hidden INTEGER NOT NULL DEFAULT 0',
  // Social links shown on the profile (a JSON array of {network, url}). Stored as
  // text on the relay, which never fetches them.
  'ALTER TABLE users ADD COLUMN socials TEXT',
  // Extra display names ("никнеймы"), a JSON array of strings. Only the owner
  // account may have more than a handful, and only it may edit anyone's.
  'ALTER TABLE users ADD COLUMN nicknames TEXT',
  // The nicknames an account has reserved ("занял"): a JSON array of lowercased
  // keys. A name belongs to at most one account; another account may still show
  // it as a plain label, but only the holder owns it.
  'ALTER TABLE users ADD COLUMN nickname_claims TEXT',
  // Self-destructing messages. `expires_at` is the ms timestamp at which the
  // relay wipes the ciphertext; NULL means the message never expires.
  'ALTER TABLE messages ADD COLUMN expires_at INTEGER',
  // The auto-delete timer both sides agreed on for this conversation (ms), or
  // NULL for "off". Stored per owner so each device can show and change it.
  'ALTER TABLE chats ADD COLUMN ttl INTEGER',
  // Scheduled ("send later") messages. `send_at` is the ms timestamp at which
  // the relay should release the message to its recipient; NULL means the
  // message is already live. While it is set the row is invisible to history
  // and to offline delivery, so the sender's own devices show it only in the
  // scheduled list.
  'ALTER TABLE messages ADD COLUMN send_at INTEGER',
  // Set when the sender removes a message from the scheduled list, so the row
  // is hidden on every one of their devices without being wiped.
  'ALTER TABLE messages ADD COLUMN scheduled_hidden INTEGER NOT NULL DEFAULT 0',
  // When a Premium subscription runs out (ms), or NULL for "no subscription".
  // The relay is the only authority on this: a client cannot claim Premium.
  'ALTER TABLE users ADD COLUMN premium_until INTEGER'
]) {
  try { db.exec(sql); } catch { /* column already present */ }
}

// A channel handle is unique, like a username. SQLite exempts NULLs from a
// UNIQUE index, so legacy channels without a handle never collide.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_handle ON channels(handle)'); }
catch { /* a legacy database already holds a duplicate handle */ }

// One account per phone number. Username/password accounts keep phone NULL,
// and SQLite exempts NULLs from a UNIQUE index, so they never collide.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)'); }
catch { /* a legacy database already holds a duplicate number */ }

const q = {
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(
    `INSERT INTO users (username, salt, verifier, public_key, display_name, bio, avatar_color, created_at, updated_at, has_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getUserByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  setPhone: db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE username = ?'),
  setPassword: db.prepare(
    'UPDATE users SET salt = ?, verifier = ?, has_password = ?, updated_at = ? WHERE username = ?'
  ),
  insertPhoneCode: db.prepare(
    `INSERT INTO phone_codes (phone, code, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(phone) DO UPDATE SET
       code = excluded.code, expires_at = excluded.expires_at, attempts = 0,
       created_at = excluded.created_at`
  ),
  getPhoneCode: db.prepare('SELECT * FROM phone_codes WHERE phone = ?'),
  bumpPhoneCodeAttempts: db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE phone = ?'),
  deletePhoneCode: db.prepare('DELETE FROM phone_codes WHERE phone = ?'),
  setProfile: db.prepare(
    'UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, updated_at = ? WHERE username = ?'
  ),
  // Wipe the public-facing profile fields, leaving the account, its keys and its
  // messages alone. Used by an administrator to moderate an abusive profile.
  resetProfile: db.prepare(
    `UPDATE users SET display_name = NULL, bio = NULL, avatar_color = NULL,
            avatar_image = NULL, socials = NULL, nicknames = NULL, nickname_claims = NULL,
            updated_at = ?
      WHERE username = ?`
  ),
  setAvatarImage: db.prepare('UPDATE users SET avatar_image = ?, updated_at = ? WHERE username = ?'),
  setSocials: db.prepare('UPDATE users SET socials = ?, updated_at = ? WHERE username = ?'),
  setNicknames: db.prepare('UPDATE users SET nicknames = ?, updated_at = ? WHERE username = ?'),
  setNicknameClaims: db.prepare('UPDATE users SET nickname_claims = ?, updated_at = ? WHERE username = ?'),
  allNicknameClaims: db.prepare('SELECT username, nickname_claims FROM users WHERE nickname_claims IS NOT NULL'),
  setLastSeen: db.prepare('UPDATE users SET last_seen = ? WHERE username = ?'),
  setPrivacy: db.prepare('UPDATE users SET last_seen_hidden = ?, profile_hidden = ? WHERE username = ?'),
  searchUsers: db.prepare(
    `SELECT username, display_name, bio, avatar_color, avatar_image FROM users
      WHERE username LIKE ? OR display_name LIKE ? ORDER BY username ASC LIMIT 20`
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (sender, recipient, box, nonce, ts, delivered, reply_to, kind, attachment, expires_at, send_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markDelivered: db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?'),
  editMessage: db.prepare('UPDATE messages SET box = ?, nonce = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare(
    "UPDATE messages SET deleted = 1, box = '', nonce = '', attachment = NULL, pinned = 0, send_at = NULL WHERE id = ?"
  ),
  setPinned: db.prepare('UPDATE messages SET pinned = ? WHERE id = ?'),
  undeliveredFor: db.prepare(
    'SELECT * FROM messages WHERE recipient = ? AND delivered = 0 AND deleted = 0 AND send_at IS NULL ORDER BY id ASC LIMIT 500'
  ),
  // A message still waiting for its send time: not yet visible in any history,
  // and listed only for the sender who scheduled it.
  scheduledFor: db.prepare(
    'SELECT * FROM messages WHERE sender = ? AND send_at IS NOT NULL AND scheduled_hidden = 0 ORDER BY send_at ASC LIMIT 500'
  ),
  // Rows whose send time has arrived and that still hold ciphertext to release.
  dueScheduled: db.prepare(
    'SELECT * FROM messages WHERE send_at IS NOT NULL AND send_at <= ? ORDER BY send_at ASC LIMIT 500'
  ),
  // Releasing clears send_at, which is what makes the row appear in history.
  releaseScheduled: db.prepare('UPDATE messages SET send_at = NULL WHERE id = ?'),
  reschedule: db.prepare('UPDATE messages SET send_at = ? WHERE id = ?'),
  hideScheduled: db.prepare('UPDATE messages SET scheduled_hidden = 1 WHERE id = ?'),
  history: db.prepare(
    `SELECT * FROM messages
      WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
        AND id > ?
        AND send_at IS NULL
      ORDER BY id DESC LIMIT ?`
  ),
  clearChat: db.prepare(
    `DELETE FROM messages
      WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)`
  ),
  getChat: db.prepare('SELECT * FROM chats WHERE owner = ? AND peer = ?'),
  setChatFlags: db.prepare(
    `INSERT INTO chats (owner, peer, pinned, muted, archived, last_read, cleared_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(owner, peer) DO UPDATE SET
       pinned = excluded.pinned, muted = excluded.muted, archived = excluded.archived`
  ),
  setLastRead: db.prepare(
    `INSERT INTO chats (owner, peer, pinned, muted, archived, last_read, cleared_at)
     VALUES (?, ?, 0, 0, 0, ?, 0)
     ON CONFLICT(owner, peer) DO UPDATE SET last_read = excluded.last_read`
  ),
  setClearedAt: db.prepare('UPDATE chats SET cleared_at = ? WHERE owner = ? AND peer = ?'),
  deleteChat: db.prepare('DELETE FROM chats WHERE owner = ? AND peer = ?'),
  listChats: db.prepare('SELECT * FROM chats WHERE owner = ?'),
  // The auto-delete timer is a property of the conversation, not of one device,
  // so setting it writes the same value to both owners' rows. A missing row for
  // the peer is created on the fly; flags are left at their defaults.
  setTtlBoth: db.prepare(
    `INSERT INTO chats (owner, peer, pinned, muted, archived, last_read, cleared_at, ttl)
     VALUES (?, ?, 0, 0, 0, 0, 0, ?)
     ON CONFLICT(owner, peer) DO UPDATE SET ttl = excluded.ttl`
  ),
  // Ciphertext whose timer has run out: these rows are wiped by the sweeper.
  expired: db.prepare(
    'SELECT id, sender, recipient FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?'
  ),
  // Wiping keeps the row so both sides can still show "message deleted", but
  // clears everything the relay ever held and drops the pin and the timer.
  expireMessage: db.prepare(
    "UPDATE messages SET deleted = 1, box = '', nonce = '', attachment = NULL, pinned = 0, expires_at = NULL WHERE id = ?"
  ),
  // Every peer this user has a conversation with, either from messages or from
  // an explicit chat-settings row. Saved Messages (peer = self) is included.
  allPeers: db.prepare(
    `SELECT DISTINCT peer FROM (
       SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS peer
         FROM messages WHERE sender = ? OR recipient = ?
       UNION
       SELECT peer FROM chats WHERE owner = ?
     )`
  ),
  peersOf: db.prepare('SELECT peer FROM chats WHERE owner = ?'),
  // Unread = incoming messages newer than the last time the owner opened the chat.
  // The centered "series started" note is not a message, so it never counts.
  unreadCount: db.prepare(
    `SELECT COUNT(*) AS c FROM messages
      WHERE sender = ? AND recipient = ? AND deleted = 0 AND ts > ?
        AND (kind IS NULL OR kind NOT LIKE 'system:%')`
  ),
  lastMessage: db.prepare(
    `SELECT * FROM messages
      WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
        AND (kind IS NULL OR kind NOT LIKE 'system:%')
      ORDER BY id DESC LIMIT 1`
  ),
  setReaction: db.prepare(
    `INSERT INTO reactions (message_id, username, emoji, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, username) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`
  ),
  clearReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND username = ?'),
  reactionsFor: db.prepare('SELECT username, emoji FROM reactions WHERE message_id = ?'),
  // Pinned messages in a conversation, newest first.
  pinnedIn: db.prepare(
    `SELECT * FROM messages
      WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
        AND pinned = 1 AND deleted = 0
      ORDER BY id DESC`
  ),
  getUserSettings: db.prepare('SELECT settings FROM user_settings WHERE username = ?'),
  setUserSettings: db.prepare(
    `INSERT INTO user_settings (username, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`
  ),
  // The relay holds no plaintext, so a search can only prefilter on the peer and
  // the (client-supplied) attachment file name. The client filters message text.
  searchMessages: db.prepare(
    `SELECT * FROM messages
      WHERE (sender = ? OR recipient = ?) AND deleted = 0
        AND (sender LIKE ? OR recipient LIKE ? OR attachment LIKE ?)
      ORDER BY id DESC LIMIT ?`
  ),
  // Global search reads the newest slice of every conversation and filters the
  // decrypted text on the device; the relay only picks the rows. The slice is
  // per conversation, so one busy chat cannot crowd out the others, and a held
  // scheduled message (send_at set) is left out exactly as in history.
  recentMessages: db.prepare(
    `SELECT * FROM (
       SELECT m.*, ROW_NUMBER() OVER (
         PARTITION BY CASE WHEN sender = ? THEN recipient ELSE sender END ORDER BY id DESC
       ) AS rn
       FROM messages m
       WHERE (sender = ? OR recipient = ?) AND deleted = 0 AND send_at IS NULL
     ) WHERE rn <= ?`
  ),

  /* ------------------------------- groups ------------------------------- */
  insertGroup: db.prepare('INSERT INTO groups (name, owner, created_at) VALUES (?, ?, ?)'),
  getGroup: db.prepare('SELECT * FROM groups WHERE id = ?'),
  renameGroup: db.prepare('UPDATE groups SET name = ? WHERE id = ?'),
  deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
  addMember: db.prepare(
    `INSERT INTO group_members (group_id, username, joined_at) VALUES (?, ?, ?)
     ON CONFLICT(group_id, username) DO NOTHING`
  ),
  removeMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND username = ?'),
  membersOf: db.prepare('SELECT username FROM group_members WHERE group_id = ? ORDER BY joined_at ASC'),
  isMember: db.prepare('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND username = ?'),
  groupsFor: db.prepare(
    'SELECT group_id FROM group_members WHERE username = ? ORDER BY joined_at ASC'
  ),
  insertGroupMessage: db.prepare(
    `INSERT INTO group_messages (group_id, sender, envelope, ts, reply_to, kind, attachment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getGroupMessage: db.prepare('SELECT * FROM group_messages WHERE id = ?'),
  groupHistory: db.prepare(
    'SELECT * FROM group_messages WHERE group_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?'
  ),
  // The newest slice of each group this account belongs to, for global search.
  recentGroupMessages: db.prepare(
    `SELECT * FROM (
       SELECT m.*, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY id DESC) AS rn
       FROM group_messages m
       WHERE group_id IN (SELECT group_id FROM group_members WHERE username = ?)
         AND deleted = 0
     ) WHERE rn <= ?`
  ),
  editGroupMessage: db.prepare('UPDATE group_messages SET envelope = ?, edited_at = ? WHERE id = ?'),
  deleteGroupMessage: db.prepare(
    "UPDATE group_messages SET deleted = 1, envelope = '', attachment = NULL WHERE id = ?"
  ),
  // Clear the relay copy of a group's messages (owner only).
  clearGroupMessages: db.prepare('DELETE FROM group_messages WHERE group_id = ?'),
  renameGroupMessages: db.prepare('UPDATE group_messages SET sender = ? WHERE sender = ?'),
  renameGroupMembers: db.prepare('UPDATE group_members SET username = ? WHERE username = ?'),
  renameGroupsOwner: db.prepare('UPDATE groups SET owner = ? WHERE owner = ?'),

  /* ------------------------------ channels ------------------------------ */
  insertChannel: db.prepare(
    'INSERT INTO channels (name, owner, description, handle, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  getChannel: db.prepare('SELECT * FROM channels WHERE id = ?'),
  getChannelByHandle: db.prepare('SELECT * FROM channels WHERE handle = ?'),
  renameChannel: db.prepare('UPDATE channels SET name = ?, description = ?, handle = ? WHERE id = ?'),
  setChannelVerified: db.prepare('UPDATE channels SET verified = ? WHERE id = ?'),
  clearChannelVerified: db.prepare('UPDATE channels SET verified = 0 WHERE verified = 1'),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
  deleteChannelPosts: db.prepare('DELETE FROM channel_messages WHERE channel_id = ?'),
  deleteChannelSubs: db.prepare('DELETE FROM channel_subs WHERE channel_id = ?'),
  addSub: db.prepare(
    `INSERT INTO channel_subs (channel_id, username, joined_at) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, username) DO NOTHING`
  ),
  removeSub: db.prepare('DELETE FROM channel_subs WHERE channel_id = ? AND username = ?'),
  subsOf: db.prepare('SELECT username FROM channel_subs WHERE channel_id = ? ORDER BY joined_at ASC'),
  isSub: db.prepare('SELECT 1 AS ok FROM channel_subs WHERE channel_id = ? AND username = ?'),
  countSubs: db.prepare('SELECT COUNT(*) AS c FROM channel_subs WHERE channel_id = ?'),
  channelsFor: db.prepare(
    'SELECT channel_id FROM channel_subs WHERE username = ? ORDER BY joined_at ASC'
  ),
  channelsOwned: db.prepare('SELECT id FROM channels WHERE owner = ? ORDER BY created_at ASC'),
  // Discovery: every channel, newest first. The client filters by name.
  allChannels: db.prepare('SELECT * FROM channels ORDER BY created_at DESC LIMIT 200'),
  insertChannelMessage: db.prepare(
    `INSERT INTO channel_messages (channel_id, sender, envelope, ts, reply_to, kind, attachment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getChannelMessage: db.prepare('SELECT * FROM channel_messages WHERE id = ?'),
  channelHistory: db.prepare(
    'SELECT * FROM channel_messages WHERE channel_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?'
  ),
  // The newest slice of each channel this account follows, for global search.
  recentChannelMessages: db.prepare(
    `SELECT * FROM (
       SELECT m.*, ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY id DESC) AS rn
       FROM channel_messages m
       WHERE channel_id IN (SELECT channel_id FROM channel_subs WHERE username = ?)
         AND deleted = 0
     ) WHERE rn <= ?`
  ),
  editChannelMessage: db.prepare('UPDATE channel_messages SET envelope = ?, edited_at = ? WHERE id = ?'),
  deleteChannelMessage: db.prepare(
    "UPDATE channel_messages SET deleted = 1, envelope = '', attachment = NULL WHERE id = ?"
  ),
  countChannels: db.prepare('SELECT COUNT(*) AS c FROM channels'),
  countChannelPosts: db.prepare('SELECT COUNT(*) AS c FROM channel_messages WHERE channel_id = ?'),
  deleteUserSubs: db.prepare('DELETE FROM channel_subs WHERE username = ?'),
  renameChannelMessages: db.prepare('UPDATE channel_messages SET sender = ? WHERE sender = ?'),
  renameChannelSubs: db.prepare('UPDATE channel_subs SET username = ? WHERE username = ?'),
  renameChannelsOwner: db.prepare('UPDATE channels SET owner = ? WHERE owner = ?'),

  /* -------------------------------- admin -------------------------------- */
  setAdmin: db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE username = ?'),
  setVerified: db.prepare('UPDATE users SET verified = ?, updated_at = ? WHERE username = ?'),
  setBadgeImage: db.prepare('UPDATE users SET badge_image = ?, updated_at = ? WHERE username = ?'),
  setBanned: db.prepare('UPDATE users SET banned = ?, updated_at = ? WHERE username = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE username = ?'),
  deleteUserSettings: db.prepare('DELETE FROM user_settings WHERE username = ?'),
  deleteUserChats: db.prepare('DELETE FROM chats WHERE owner = ? OR peer = ?'),
  deleteUserMessages: db.prepare('DELETE FROM messages WHERE sender = ? OR recipient = ?'),
  deleteUserGroupMessages: db.prepare('DELETE FROM group_messages WHERE sender = ?'),
  deleteUserReactions: db.prepare('DELETE FROM reactions WHERE username = ?'),
  deleteUserMemberships: db.prepare('DELETE FROM group_members WHERE username = ?'),
  adminListUsers: db.prepare(
    `SELECT u.username, u.display_name, u.bio, u.avatar_color, u.avatar_image, u.created_at,
            u.is_admin, u.verified, u.banned, u.badge_image, u.nicknames, u.last_seen,
            u.has_password, u.phone, u.profile_hidden, u.last_seen_hidden, u.premium_until,
            (SELECT COALESCE(w.balance, 0) FROM wallets w WHERE w.username = u.username) AS rockets,
            (SELECT COUNT(*) FROM messages m WHERE m.sender = u.username) AS sent,
            (SELECT COUNT(*) FROM messages m WHERE m.recipient = u.username) AS received,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.username = u.username) AS groups,
            (SELECT COUNT(*) FROM channel_subs cs WHERE cs.username = u.username) AS subs
       FROM users u ORDER BY u.created_at ASC`
  ),
  countUsers: db.prepare('SELECT COUNT(*) AS c FROM users'),
  countMessages: db.prepare('SELECT COUNT(*) AS c FROM messages'),
  countGroups: db.prepare('SELECT COUNT(*) AS c FROM groups'),
  countAnnouncements: db.prepare('SELECT COUNT(*) AS c FROM announcements'),
  countSessions: db.prepare('SELECT COUNT(*) AS c FROM sessions'),
  countBanned: db.prepare('SELECT COUNT(*) AS c FROM users WHERE banned = 1'),
  countVerified: db.prepare('SELECT COUNT(*) AS c FROM users WHERE verified = 1'),
  countAdmins: db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1'),
  countDialogStreaks: db.prepare('SELECT COUNT(*) AS c FROM dialog_streaks WHERE count > 0'),
  insertAnnouncement: db.prepare('INSERT INTO announcements (sender, text, ts) VALUES (?, ?, ?)'),
  recentAnnouncements: db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 20'),
  insertAdminLog: db.prepare(
    'INSERT INTO admin_log (actor, action, target, detail, ts) VALUES (?, ?, ?, ?, ?)'
  ),
  recentAdminLog: db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100'),

  /* ------------------------------ sessions ------------------------------ */
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, username, exp) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE username = ?'),
  renameSessions: db.prepare('UPDATE sessions SET username = ? WHERE username = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE exp < ?'),

  /* ------------------------------- streaks ------------------------------- */
  getStreak: db.prepare('SELECT * FROM streaks WHERE username = ?'),
  setStreak: db.prepare(
    `INSERT INTO streaks (username, day, count) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET day = excluded.day, count = excluded.count`
  ),
  deleteUserStreak: db.prepare('DELETE FROM streaks WHERE username = ?'),

  getDialogStreak: db.prepare('SELECT * FROM dialog_streaks WHERE a = ? AND b = ?'),
  setDialogStreak: db.prepare(
    `INSERT INTO dialog_streaks (a, b, day, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(a, b) DO UPDATE SET day = excluded.day, count = excluded.count`
  ),
  deleteUserDialogStreaks: db.prepare('DELETE FROM dialog_streaks WHERE a = ? OR b = ?'),
  deleteDialogStreak: db.prepare('DELETE FROM dialog_streaks WHERE a = ? AND b = ?'),
  // Every dialog flame this account is part of, so the chat list can show them.
  dialogStreaksFor: db.prepare('SELECT * FROM dialog_streaks WHERE a = ? OR b = ?'),

  /* ------------------------------- stories ------------------------------- */
  insertStory: db.prepare(
    'INSERT INTO stories (author, envelope, ts, expires_at, kind, attachment) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getStory: db.prepare('SELECT * FROM stories WHERE id = ?'),
  deleteStory: db.prepare('DELETE FROM stories WHERE id = ?'),
  // Every story still inside its 24 hours, newest first. The author's id is
  // enough to show the bar; the envelope is per-viewer.
  activeStories: db.prepare('SELECT * FROM stories WHERE expires_at > ? ORDER BY id DESC LIMIT 500'),
  storiesByAuthor: db.prepare('SELECT * FROM stories WHERE author = ? ORDER BY id ASC'),
  expiredStories: db.prepare('SELECT id FROM stories WHERE expires_at <= ?'),
  deleteStoryViews: db.prepare('DELETE FROM story_views WHERE story_id = ?'),
  deleteUserStories: db.prepare('DELETE FROM stories WHERE author = ?'),
  renameStoryAuthor: db.prepare('UPDATE stories SET author = ? WHERE author = ?'),
  insertStoryView: db.prepare(
    `INSERT INTO story_views (story_id, viewer, ts) VALUES (?, ?, ?)
     ON CONFLICT(story_id, viewer) DO NOTHING`
  ),
  storyViewers: db.prepare('SELECT viewer, ts FROM story_views WHERE story_id = ? ORDER BY ts ASC'),
  countStoryViews: db.prepare('SELECT COUNT(*) AS c FROM story_views WHERE story_id = ?'),
  deleteUserStoryViews: db.prepare('DELETE FROM story_views WHERE viewer = ?'),
  countStories: db.prepare('SELECT COUNT(*) AS c FROM stories'),
  addStoryViewer: db.prepare(
    `INSERT INTO story_audience (story_id, viewer) VALUES (?, ?)
     ON CONFLICT(story_id, viewer) DO NOTHING`
  ),
  deleteStoryAudience: db.prepare('DELETE FROM story_audience WHERE story_id = ?'),
  deleteUserStoryAudience: db.prepare('DELETE FROM story_audience WHERE viewer = ?'),
  renameStoryAudience: db.prepare('UPDATE story_audience SET viewer = ? WHERE viewer = ?'),
  // The active stories a viewer may open, newest first.
  storiesForViewer: db.prepare(
    `SELECT s.* FROM stories s
       JOIN story_audience a ON a.story_id = s.id
      WHERE a.viewer = ? AND s.expires_at > ?
      ORDER BY s.id DESC LIMIT 500`
  ),
  isStoryViewer: db.prepare('SELECT 1 AS ok FROM story_audience WHERE story_id = ? AND viewer = ?'),

  /* -------------------------- rockets and premium -------------------------- */
  getWallet: db.prepare('SELECT * FROM wallets WHERE username = ?'),
  insertWallet: db.prepare('INSERT OR IGNORE INTO wallets (username, balance, updated_at) VALUES (?, 0, ?)'),
  setWalletBalance: db.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE username = ?'),
  insertLedger: db.prepare(
    `INSERT INTO rocket_ledger (username, delta, reason, detail, provider_ref, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  ledgerForUser: db.prepare('SELECT * FROM rocket_ledger WHERE username = ? ORDER BY id DESC LIMIT 50'),
  ledgerByRef: db.prepare('SELECT * FROM rocket_ledger WHERE provider_ref = ?'),
  insertPayment: db.prepare(
    `INSERT INTO payments (id, username, kind, amount_rub, rockets, months, status, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ),
  getPayment: db.prepare('SELECT * FROM payments WHERE id = ?'),
  setPaymentPaid: db.prepare(
    `UPDATE payments SET status = 'paid', provider_ref = ?, paid_at = ? WHERE id = ? AND status = 'pending'`
  ),
  setPaymentCancelled: db.prepare(
    `UPDATE payments SET status = 'cancelled', paid_at = ? WHERE id = ? AND status = 'pending'`
  ),
  paymentsForUser: db.prepare('SELECT * FROM payments WHERE username = ? ORDER BY id DESC LIMIT 50'),
  setPremiumUntil: db.prepare('UPDATE users SET premium_until = ?, updated_at = ? WHERE username = ?'),
  deleteUserWallet: db.prepare('DELETE FROM wallets WHERE username = ?'),
  deleteUserLedger: db.prepare('DELETE FROM rocket_ledger WHERE username = ?'),
  deleteUserPayments: db.prepare('DELETE FROM payments WHERE username = ?')
};

/* Statements used only by the username rename, which rewrites every reference. */
const renameStmts = {
  user: db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE username = ?'),
  sent: db.prepare('UPDATE messages SET sender = ? WHERE sender = ?'),
  received: db.prepare('UPDATE messages SET recipient = ? WHERE recipient = ?'),
  chatsOwner: db.prepare('UPDATE chats SET owner = ? WHERE owner = ?'),
  chatsPeer: db.prepare('UPDATE chats SET peer = ? WHERE peer = ?'),
  reactions: db.prepare('UPDATE reactions SET username = ? WHERE username = ?'),
  groupMessages: db.prepare('UPDATE group_messages SET sender = ? WHERE sender = ?'),
  groupMembers: db.prepare('UPDATE group_members SET username = ? WHERE username = ?'),
  groupsOwner: db.prepare('UPDATE groups SET owner = ? WHERE owner = ?'),
  channelMessages: db.prepare('UPDATE channel_messages SET sender = ? WHERE sender = ?'),
  channelSubs: db.prepare('UPDATE channel_subs SET username = ? WHERE username = ?'),
  channelsOwner: db.prepare('UPDATE channels SET owner = ? WHERE owner = ?'),
  sessions: db.prepare('UPDATE sessions SET username = ? WHERE username = ?'),
  streaks: db.prepare('UPDATE streaks SET username = ? WHERE username = ?'),
  stories: db.prepare('UPDATE stories SET author = ? WHERE author = ?'),
  storyViews: db.prepare('UPDATE story_views SET viewer = ? WHERE viewer = ?'),
  storyAudience: db.prepare('UPDATE story_audience SET viewer = ? WHERE viewer = ?'),
  wallets: db.prepare('UPDATE wallets SET username = ? WHERE username = ?'),
  ledger: db.prepare('UPDATE rocket_ledger SET username = ? WHERE username = ?'),
  payments: db.prepare('UPDATE payments SET username = ? WHERE username = ?')
};

/* --------------------------- password KDF --------------------------- */
// Server-side scrypt. The client derives its *key-encryption* key separately,
// so this verifier never doubles as an encryption key.
function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------ tokens ------------------------------ */
// Tokens are kept in memory for speed and mirrored to the `sessions` table so
// they survive a relay restart. A restart used to wipe every session, which
// signed every device out and forced the password again.
const tokens = new Map(); // token -> { username, exp }

function issueToken(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + TOKEN_TTL_MS;
  tokens.set(token, { username, exp });
  try { q.insertSession.run(token, username, exp); } catch { /* best effort */ }
  return token;
}

function resolveToken(token) {
  const rec = tokens.get(token);
  if (rec) {
    if (rec.exp < Date.now()) { tokens.delete(token); try { q.deleteSession.run(token); } catch { /* best effort */ } return null; }
    return rec.username;
  }
  // Not in memory: a token issued before the last restart. Fall back to disk.
  const row = q.getSession.get(token);
  if (!row) return null;
  if (row.exp < Date.now()) { try { q.deleteSession.run(token); } catch { /* best effort */ } return null; }
  tokens.set(token, { username: row.username, exp: row.exp });
  return row.username;
}

/* ------------------------------ helpers ------------------------------ */
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
// A username is stored bare (`alice`); the leading `@` is how people write and
// read it, so every entry point strips it before validating. Keeping the stored
// form bare means it stays a clean primary key and nothing about the schema
// changes.
function normalizeUsername(value) {
  if (typeof value !== 'string') return value;
  return value.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Turn a channel name into a candidate @handle: lowercase, ASCII letters,
 * digits and underscores, 3-32 chars. Returns null when nothing usable remains
 * (for example a name written only in Cyrillic), so the caller can ask for one.
 */
function slugHandle(name) {
  if (typeof name !== 'string') return null;
  const slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return USERNAME_RE.test(slug) ? slug : null;
}

/** A handle the caller asked for, validated; `undefined` when none was sent. */
function cleanHandle(value) {
  if (value === undefined) return undefined;
  const bare = normalizeUsername(value);
  if (!USERNAME_RE.test(bare)) return { error: 'Handle must be 3-32 chars: a-z, 0-9, _' };
  return { value: bare };
}
const VALID_B64 = /^[A-Za-z0-9+/=_-]+$/;
const AVATAR_COLORS = new Set(['mint', 'sky', 'violet', 'amber', 'rose', 'lime', 'cyan', 'coral']);

/**
 * Social links on a profile: a small array of `{ network, url }`. The network
 * is one of a fixed set (the client picks the icon from it), and the url must be
 * http(s) so a profile can never smuggle a `javascript:` or `data:` link.
 */
const SOCIAL_NETWORKS = new Set([
  'telegram', 'instagram', 'twitter', 'facebook', 'youtube', 'tiktok',
  'github', 'linkedin', 'vk', 'website'
]);
const MAX_SOCIALS = 8;

function cleanSocials(value) {
  if (value === null) return { value: null };
  if (!Array.isArray(value)) return { error: 'Socials must be a list' };
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object') return { error: 'Malformed social link' };
    const network = typeof item.network === 'string' ? item.network.toLowerCase() : '';
    if (!SOCIAL_NETWORKS.has(network)) return { error: 'Unknown social network' };
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (url.length === 0 || url.length > 200) return { error: 'Social link is too long' };
    let parsed;
    try { parsed = new URL(url); } catch { return { error: 'Social link must be a full http(s) URL' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'Social link must be a full http(s) URL' };
    }
    if (seen.has(network)) continue;
    seen.add(network);
    out.push({ network, url });
    if (out.length >= MAX_SOCIALS) break;
  }
  return { value: out.length ? JSON.stringify(out) : null };
}

function parseSocials(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * Extra display names ("никнеймы") a profile can show under the main name.
 *
 * The owner account is allowed an unbounded list; everyone else is capped, so
 * the unbounded case stays a privilege rather than a way to bloat a profile
 * broadcast for every viewer. This is enforced here, on the relay, and never
 * trusted from the client.
 */
const MAX_NICKNAMES = 3;
const OWNER_USERNAME = (process.env.SLEEPHY_OWNER || [...ADMINS][0] || '').toLowerCase();
const NICKNAME_MAX = 32;

function isOwner(username) {
  return !!username && username.toLowerCase() === OWNER_USERNAME;
}

function nicknameLimit(username) {
  return isOwner(username) ? Infinity : MAX_NICKNAMES;
}

function cleanNicknames(value, username) {
  if (value === null) return { value: null };
  if (!Array.isArray(value)) return { error: 'Nicknames must be a list' };
  const limit = nicknameLimit(username);
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') return { error: 'Malformed nickname' };
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name.length === 0) continue;
    if (name.length > NICKNAME_MAX) return { error: 'Nickname is too long' };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= limit) break;
  }
  return { value: out.length ? JSON.stringify(out) : null };
}

function parseNicknames(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === 'string') : [];
  } catch { return []; }
}

/** The form a nickname is reserved and compared by: trimmed, lowercased. */
function nicknameKey(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseNicknameKeys(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === 'string') : [];
  } catch { return []; }
}

/**
 * The account that has reserved `name`, or null when nobody has. The relay is
 * the only authority on this: a name belongs to at most one account, so two
 * profiles can never both "own" the same nickname.
 */
function nicknameHolder(name) {
  const key = nicknameKey(name);
  if (!key) return null;
  for (const row of q.allNicknameClaims.all()) {
    if (parseNicknameKeys(row.nickname_claims).includes(key)) return row.username;
  }
  return null;
}

/** Every key reserved by some *other* account; the ones `username` may not take. */
function reservedKeys(username) {
  const set = new Set();
  for (const row of q.allNicknameClaims.all()) {
    if (row.username === username) continue;
    for (const k of parseNicknameKeys(row.nickname_claims)) set.add(k);
  }
  return set;
}

/** One nickname from an admin, validated strictly (no silent truncation). */
function cleanNickname(value) {
  if (typeof value !== 'string') return { error: 'Nickname is required' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Nickname is required' };
  if (name.length > NICKNAME_MAX) return { error: 'Nickname is too long' };
  return { value: name };
}

/**
 * Validate a nickname list for `username` and derive the keys it reserves.
 * Every name must be free: a name another account already holds is refused, so
 * a claim is exclusive. The stored list and the reserved keys are returned
 * together so a caller cannot persist one without the other.
 */
function cleanNicknamesWithClaims(value, username) {
  const base = cleanNicknames(value, username);
  if (base.error) return base;
  if (base.value === null) return { value: null, claims: null };
  const names = JSON.parse(base.value);
  const reserved = reservedKeys(username);
  for (const n of names) {
    if (reserved.has(nicknameKey(n))) {
      return { error: `Никнейм «${n}» уже занят` };
    }
  }
  return { value: base.value, claims: JSON.stringify(names.map(nicknameKey)) };
}

/**
 * A badge picture arrives as a small data: URL from the admin's device. Only
 * raster images are accepted, and the size is capped so a single account cannot
 * bloat the database or every profile broadcast.
 */
const BADGE_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_BADGE_IMAGE_CHARS = 128 * 1024;

function cleanBadgeImage(value) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Badge image must be a string' };
  if (value.length > MAX_BADGE_IMAGE_CHARS) return { error: 'Badge image is too large' };
  if (!BADGE_IMAGE_RE.test(value)) return { error: 'Badge image must be a PNG, JPEG, GIF or WebP' };
  return { value };
}

/**
 * A profile picture arrives as a small data: URL. Same rules as the badge, but
 * a tighter cap: every profile broadcast carries it, so it must stay tiny.
 */
const MAX_AVATAR_IMAGE_CHARS = 64 * 1024;

function cleanAvatarImage(value) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Avatar image must be a string' };
  if (value.length > MAX_AVATAR_IMAGE_CHARS) return { error: 'Avatar image is too large' };
  if (!BADGE_IMAGE_RE.test(value)) return { error: 'Avatar image must be a PNG, JPEG, GIF or WebP' };
  return { value };
}

function bad(ws, rid, message) {
  reply(ws, rid, { t: 'error', message });
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/** Reply to a request, echoing its id so the client can match the response. */
function reply(ws, reqId, obj) {
  send(ws, reqId === undefined ? obj : { ...obj, _id: reqId });
}

function validB64(s, maxLen) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && VALID_B64.test(s);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/** The UTC day of a timestamp, as YYYY-MM-DD. The relay has no timezone. */
function dayKey(ts) {
  return STREAK.dayKey(ts);
}

/**
 * The current "огонёк" streak for an account: the number of days in a row it has
 * sent at least one message, and whether today is already counted. A streak that
 * missed a whole day reads as 0, so it visibly breaks the way it should.
 */
function streakView(username) {
  return STREAK.view(q.getStreak.get(username), Date.now());
}

/** Extend the streak when the account sends something today. */
function bumpStreak(username, ts) {
  const next = STREAK.bump(q.getStreak.get(username), ts);
  q.setStreak.run(username, next.day, next.count);
}

/* --------------------------- dialog streaks --------------------------- */
// The flame *inside a chat*: days in a row this pair has written to each other.
// It is the pair's streak, not either account's, so both people see the same
// number and the same "series started" note.

/** The two accounts of a dialog in a fixed order, so one row serves both. */
function dialogPair(x, y) {
  return x < y ? [x, y] : [y, x];
}

function dialogStreakView(x, y) {
  const [a, b] = dialogPair(x, y);
  return STREAK.view(q.getDialogStreak.get(a, b), Date.now());
}

/**
 * Record a message between two people and return how the dialog flame moved.
 * `started` is true on the day the flame first appears for this pair, which is
 * exactly when the chat should show the centered "series started" note.
 */
function touchDialogStreak(from, to) {
  const [a, b] = dialogPair(from, to);
  const before = STREAK.view(q.getDialogStreak.get(a, b), Date.now());
  const next = STREAK.bump(q.getDialogStreak.get(a, b), Date.now());
  q.setDialogStreak.run(a, b, next.day, next.count);
  const after = STREAK.view({ day: next.day, count: next.count }, Date.now());
  return {
    count: after.count,
    active: after.active,
    started: after.count === 1 && before.count === 0
  };
}

/**
 * Tell both people in a dialog the flame's new value. The client draws it in the
 * header and in the chat list; nothing here reveals a message.
 */
function broadcastDialogStreak(from, to, view) {
  const payload = { t: 'dialog.streak', with: null, from, to, count: view.count, active: view.active };
  deliverToUser(from, { ...payload, with: to });
  deliverToUser(to, { ...payload, with: from });
}

/**
 * Count today's activity for the sender and, when the streak actually moved,
 * tell their peers so the fire updates live instead of on the next profile fetch.
 */
function touchStreak(username) {
  const before = streakView(username);
  bumpStreak(username, Date.now());
  const after = streakView(username);
  if (before.count !== after.count || before.active !== after.active) {
    const user = q.getUser.get(username);
    if (user) {
      const profile = publicProfile(user);
      // The sender's own other devices, and the sender, need the new count too.
      broadcastProfile(username, profile);
      deliverToUser(username, { t: 'profile', username, profile });
    }
  }
}

function publicProfile(user, viewer) {
  const isSelf = !viewer || viewer === user.username;
  // Profile privacy hides the name, bio, picture and streak from everyone else;
  // the @handle and the verification badge stay, so the account is still
  // reachable and recognisable.
  const hidden = !isSelf && !!user.profile_hidden;
  const streak = hidden ? { count: 0, active: false } : streakView(user.username);
  return {
    username: user.username,
    displayName: hidden ? user.username : (user.display_name || user.username),
    bio: hidden ? '' : (user.bio || ''),
    avatarColor: hidden ? 'mint' : (user.avatar_color || 'mint'),
    // Social links are part of the profile, so hiding the profile hides them.
    socials: hidden ? [] : parseSocials(user.socials),
    // Extra display names shown under the main name. Also part of the profile.
    nicknames: hidden ? [] : parseNicknames(user.nicknames),
    // A profile picture set by the user, shown instead of their initial.
    avatarImage: hidden ? null : (user.avatar_image || null),
    // When the account was last connected, for "last seen" under the name.
    // Hidden either when the owner turned it off or when the profile is hidden.
    lastSeen: (hidden || user.last_seen_hidden) && !isSelf ? null : (user.last_seen || null),
    verified: !!user.verified,
    // A custom badge picture replaces the plain checkmark when present.
    badgeImage: user.badge_image || null,
    // Whether this account has an active Premium subscription. Public, like a
    // checkmark, so a Premium badge can show next to the name.
    premium: premiumUntil(user) > 0,
    // Days in a row the account has sent something, and whether today counts.
    streak: streak.count,
    streakActive: streak.active,
    admin: !!user.is_admin,
    // Whether the *viewer* may add, remove or rename this account's nicknames.
    // Only administrators get the tooltip that does that.
    canEditNicknames: isAdmin(viewer),
    // Named in ADMINS but not yet flagged: the relay still treats them as an
    // admin, so the client must show the panel. The flag is set on next login.
    adminByConfig: ADMINS.has(user.username),
    // The owner's own devices learn the privacy switches so the settings
    // controls reflect what the relay is enforcing. Never sent to anyone else.
    privacy: isSelf
      ? { lastSeenHidden: !!user.last_seen_hidden, profileHidden: !!user.profile_hidden }
      : undefined,
    // The owner account may set its own nickname list; tell its own devices so
    // the editor appears. Not sent to anyone else.
    owner: isSelf ? isOwner(user.username) : undefined
  };
}

/** True when the account is an administrator (by name or by a granted flag). */
function isAdmin(username) {
  if (!username) return false;
  if (ADMINS.has(username)) return true;
  const user = q.getUser.get(username);
  return !!(user && user.is_admin);
}

function requireAdmin(ws, rid) {
  if (!ws.username) { bad(ws, rid, 'Not authenticated'); return false; }
  if (!isAdmin(ws.username)) { bad(ws, rid, 'Administrator access required'); return false; }
  return true;
}

/* ----------------------------- connections ----------------------------- */
/** username -> Set<ws> (a user may be connected from several devices) */
const sockets = new Map();

function bindSocket(username, ws) {
  if (!sockets.has(username)) sockets.set(username, new Set());
  sockets.get(username).add(ws);
}

function unbindSocket(ws) {
  if (!ws.username) return;
  // A dropped socket must not leave a phantom in a call: drop the user from
  // every call they were on and tell the others they left.
  for (const [id, call] of calls) {
    if (!call.participants.has(ws.username)) continue;
    call.participants.delete(ws.username);
    if (call.participants.size <= 1) {
      callFanout(call, ws.username, { t: 'call.ended', callId: id, from: ws.username });
      calls.delete(id);
    } else {
      callFanout(call, ws.username, { t: 'call.left', callId: id, from: ws.username });
    }
  }
  const set = sockets.get(ws.username);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(ws.username);
    const seen = Date.now();
    q.setLastSeen.run(seen, ws.username);
    announcePresence(ws.username, false, seen);
  }
}

function isOnline(username) {
  return sockets.has(username);
}

function lastSeenOf(username, viewer) {
  if (isOnline(username)) return null;
  const user = q.getUser.get(username);
  if (!user) return null;
  // The owner's own devices always see the real value; everyone else sees
  // nothing when the owner hid last-seen or hid the whole profile.
  if (viewer && viewer !== username && (user.last_seen_hidden || user.profile_hidden)) return null;
  return user.last_seen || null;
}

function deliverToUser(username, payload) {
  const set = sockets.get(username);
  if (!set) return false;
  let delivered = false;
  for (const ws of set) { send(ws, payload); delivered = true; }
  return delivered;
}

/** Everyone who shares a conversation with this user, in either direction. */
function audienceOf(username) {
  const audience = new Set();
  for (const row of q.allPeers.all(username, username, username, username)) {
    if (row.peer !== username) audience.add(row.peer);
  }
  return audience;
}

function announcePresence(username, online, lastSeen) {
  const user = q.getUser.get(username);
  const hidesSeen = !!user && (user.last_seen_hidden || user.profile_hidden);
  const explicit = online ? null : (lastSeen !== undefined ? lastSeen : lastSeenOf(username));
  for (const who of audienceOf(username)) {
    // Each viewer gets their own privacy-filtered last-seen, so a hidden value
    // never leaves the relay to anyone but the owner's own devices.
    const seen = (!online && hidesSeen && who !== username) ? null : explicit;
    deliverToUser(who, { t: 'presence', username, online, lastSeen: online ? null : seen });
  }
}

function broadcastProfile(username, profile) {
  const user = q.getUser.get(username);
  for (const who of audienceOf(username)) {
    // Rebuild per viewer so profile privacy is enforced on the way out.
    const p = user ? publicProfile(user, who) : profile;
    deliverToUser(who, { t: 'profile', username, profile: p });
  }
}

function flushUndelivered(username) {
  for (const row of q.undeliveredFor.all(username)) {
    const delivered = deliverToUser(username, {
      t: 'message', id: row.id, from: row.sender, box: row.box, nonce: row.nonce,
      ts: row.ts, replyTo: row.reply_to,
      kind: row.kind || null, attachment: row.attachment || null
    });
    if (delivered) q.markDelivered.run(row.id);
  }
}

/**
 * Release a scheduled message whose send time has arrived. Clearing `send_at`
 * is what makes the row visible to history and to offline delivery; from then on
 * it behaves exactly like an ordinary message. The sender's other devices are
 * told so the entry leaves the scheduled list without a reload.
 */
function releaseScheduledMessage(row) {
  q.releaseScheduled.run(row.id);
  const delivered = deliverToUser(row.recipient, {
    t: 'message', id: row.id, from: row.sender, box: row.box, nonce: row.nonce,
    ts: row.ts, replyTo: row.reply_to,
    kind: row.kind || null, attachment: row.attachment || null,
    expiresAt: row.expires_at || null
  });
  if (delivered) q.markDelivered.run(row.id);
  deliverToUser(row.sender, { t: 'scheduled.released', id: row.id, to: row.recipient });
}

function reactionsOf(messageId) {
  return q.reactionsFor.all(messageId).map((r) => ({ username: r.username, emoji: r.emoji }));
}

/* --------------------------- phone sign-in --------------------------- */
// Codes are 6 digits and live for five minutes. Three wrong guesses drop the
// code, so a short code cannot be brute-forced inside its window.
const PHONE_CODE_TTL_MS = 5 * 60 * 1000;
const PHONE_CODE_MAX_ATTEMPTS = 3;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Deliver a login code. Without an SMS provider the relay prints the code to
 * its log so a self-hosted server can be used before one is wired up. Set
 * SLEEPHY_SMS_WEBHOOK to POST {phone, code} to a provider instead.
 */
async function deliverCode(phone, code) {
  const hook = process.env.SLEEPHY_SMS_WEBHOOK;
  if (hook) {
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, code })
      });
      return;
    } catch (err) {
      console.error('[sms] webhook failed:', err.message);
    }
  }
  console.log(`[sms] code for ${phone}: ${code}`);
}

/** A free username derived from the phone number, e.g. user_7f3a91c2. */
function freeUsername() {
  for (let i = 0; i < 50; i++) {
    const name = 'user_' + crypto.randomBytes(4).toString('hex');
    if (!q.getUser.get(name)) return name;
  }
  return 'user_' + crypto.randomBytes(8).toString('hex');
}

/**
 * First step of phone sign-in: create an account if the number is new and send
 * a one-time code. The account has no password yet — the owner sets one from
 * Privacy settings, and it only ever guards the keys on their device.
 */
async function handlePhoneRequest(ws, msg, rid) {
  const phone = typeof msg.phone === 'string' ? msg.phone.replace(/[\s()-]/g, '') : '';
  if (!PHONE_RE.test(phone)) {
    return bad(ws, rid, 'Enter a phone number in international format, e.g. +79991234567');
  }
  if (!validB64(msg.publicKey, 200)) return bad(ws, rid, 'Invalid public key');

  let user = q.getUserByPhone.get(phone);
  let created = false;
  if (!user) {
    const username = freeUsername();
    const now = Date.now();
    const salt = crypto.randomBytes(16).toString('base64');
    // A phone account starts passwordless: the verifier is a random secret the
    // client never learns, and has_password = 0 makes login refuse it.
    const verifier = crypto.randomBytes(32).toString('base64');
    q.insertUser.run(username, salt, verifier, msg.publicKey, null, null, null, now, now, 0);
    q.setPhone.run(phone, now, username);
    if (ADMINS.has(username)) q.setAdmin.run(1, now, username);
    user = q.getUser.get(username);
    created = true;
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  q.insertPhoneCode.run(phone, code, now + PHONE_CODE_TTL_MS, now);
  await deliverCode(phone, code);

  const res = { t: 'ok', action: 'phone.request', phone, isNew: created };
  // Handing the code back in the reply is opt-in, for tests and for a server
  // whose SMS delivery is not configured yet.
  if (process.env.SLEEPHY_DEV_CODES === '1') res.code = code;
  reply(ws, rid, res);
}

/** Second step: check the code and open a session. */
function handlePhoneVerify(ws, msg, rid) {
  const phone = typeof msg.phone === 'string' ? msg.phone.replace(/[\s()-]/g, '') : '';
  const code = typeof msg.code === 'string' ? msg.code.trim() : '';
  if (!PHONE_RE.test(phone)) return bad(ws, rid, 'Invalid phone number');
  if (!/^\d{6}$/.test(code)) return bad(ws, rid, 'Enter the 6-digit code');

  const rec = q.getPhoneCode.get(phone);
  if (!rec) return bad(ws, rid, 'Request a new code');
  if (rec.expires_at < Date.now()) {
    q.deletePhoneCode.run(phone);
    return bad(ws, rid, 'The code has expired, request a new one');
  }
  if (rec.attempts >= PHONE_CODE_MAX_ATTEMPTS) {
    q.deletePhoneCode.run(phone);
    return bad(ws, rid, 'Too many attempts, request a new code');
  }
  if (rec.code !== code) {
    q.bumpPhoneCodeAttempts.run(phone);
    return bad(ws, rid, 'Wrong code');
  }
  q.deletePhoneCode.run(phone);

  const user = q.getUserByPhone.get(phone);
  if (!user) return bad(ws, rid, 'No account for this number');
  if (user.banned) return bad(ws, rid, 'This account has been blocked by an administrator');
  if (ADMINS.has(user.username) && !user.is_admin) q.setAdmin.run(1, Date.now(), user.username);

  const token = issueToken(user.username);
  ws.username = user.username;
  bindSocket(user.username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'phone.verify', username: user.username, token,
    publicKey: user.public_key, hasPassword: !!user.has_password,
    profile: publicProfile(q.getUser.get(user.username))
  });
  announcePresence(user.username, true);
  flushUndelivered(user.username);
}

/** Set or change the account password. Guarded by the live session. */
function handlePasswordSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const { password, salt, verifier } = msg;
  if (typeof password !== 'string' || password.length < 8 || password.length > 512) {
    return bad(ws, rid, 'Password must be at least 8 characters');
  }
  if (!validB64(salt, 64)) return bad(ws, rid, 'Invalid salt');
  if (!validB64(verifier, 128)) return bad(ws, rid, 'Invalid verifier');

  // The client sends salt + verifier so the server never sees the password and
  // the same secret can protect the local key file.
  q.setPassword.run(salt, verifier, 1, Date.now(), ws.username);
  reply(ws, rid, { t: 'ok', action: 'password.set' });
}

/* ------------------------------- handlers ------------------------------- */
function handleRegister(ws, msg, rid) {
  const { password, publicKey, salt, verifier } = msg;
  const username = normalizeUsername(msg.username);
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return bad(ws, rid, 'Username must be 3-32 chars: a-z, 0-9, _');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 512) {
    return bad(ws, rid, 'Password must be at least 8 characters');
  }
  if (!validB64(publicKey, 200)) return bad(ws, rid, 'Invalid public key');
  if (q.getUser.get(username)) return bad(ws, rid, 'Username already taken');

  // The client sends its own salt + verifier so the same password can also
  // protect the local private key without the server ever seeing the password.
  const useSalt = typeof salt === 'string' && validB64(salt, 64)
    ? salt
    : crypto.randomBytes(16).toString('base64');
  const useVerifier = typeof verifier === 'string' && validB64(verifier, 128)
    ? verifier
    : scrypt(password, useSalt);

  const now = Date.now();
  q.insertUser.run(username, useSalt, useVerifier, publicKey, null, null, null, now, now, 1);
  if (ADMINS.has(username)) q.setAdmin.run(1, now, username);
  if (WELCOME_ROCKETS > 0) moveRockets(username, WELCOME_ROCKETS, 'welcome', 'welcome bonus');

  const token = issueToken(username);
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'register', username, token, publicKey,
    profile: publicProfile(q.getUser.get(username))
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleLogin(ws, msg, rid) {
  const password = msg.password;
  const username = normalizeUsername(msg.username);
  if (typeof username !== 'string' || typeof password !== 'string') {
    return bad(ws, rid, 'Username and password required');
  }
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Wrong username or password');
  // Phone accounts start without a password; they sign in by phone number.
  if (!user.has_password) return bad(ws, rid, 'This account signs in by phone number');
  if (!timingSafeEqual(scrypt(password, user.salt), user.verifier)) {
    return bad(ws, rid, 'Wrong username or password');
  }
  if (user.banned) return bad(ws, rid, 'This account has been blocked by an administrator');
  if (ADMINS.has(username) && !user.is_admin) q.setAdmin.run(1, Date.now(), username);

  const token = issueToken(username);
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'login', username, token, publicKey: user.public_key,
    profile: publicProfile(q.getUser.get(username))
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleResume(ws, msg, rid) {
  const username = resolveToken(msg.token);
  if (!username) return bad(ws, rid, 'Session expired');
  const user = q.getUser.get(username);
  if (!user) return bad(ws, rid, 'Unknown account');
  if (user.banned) return bad(ws, rid, 'This account has been blocked by an administrator');
  ws.username = username;
  bindSocket(username, ws);
  reply(ws, rid, {
    t: 'ok', action: 'resume', username, token: msg.token, publicKey: user.public_key,
    profile: publicProfile(user)
  });
  announcePresence(username, true);
  flushUndelivered(username);
}

function handleDirectory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(normalizeUsername(msg.username));
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, {
    t: 'key', username: user.username, publicKey: user.public_key,
    profile: publicProfile(user, ws.username), online: isOnline(user.username)
  });
}

function handleProfileGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(normalizeUsername(msg.username) || ws.username);
  if (!user) return bad(ws, rid, 'No such user');
  reply(ws, rid, {
    t: 'profile', profile: publicProfile(user, ws.username), online: isOnline(user.username),
    lastSeen: lastSeenOf(user.username, ws.username),
    isSelf: user.username === ws.username
  });
}

function handleNicknameCheck(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const name = typeof msg.nickname === 'string' ? msg.nickname.trim().replace(/\s+/g, ' ') : '';
  if (!name) return bad(ws, rid, 'Nickname is required');
  if (name.length > NICKNAME_MAX) return bad(ws, rid, 'Nickname is too long');
  // "Free" means no *other* account holds it; the account's own claims do not
  // make its own name look taken when the editor re-checks it.
  const holder = nicknameHolder(name);
  reply(ws, rid, {
    t: 'nickname.check',
    nickname: name,
    available: !holder || holder === ws.username,
    heldBySelf: !!holder && holder === ws.username
  });
}

function handleStreakGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const base = { t: 'streak', ...streakView(ws.username) };
  // A `with` asks for the dialog flame instead, so one request type serves both.
  if (typeof msg.with === 'string') base.dialog = dialogStreakView(ws.username, msg.with);
  reply(ws, rid, base);
}

/**
 * Privacy switches, enforced by the relay. The client also keeps the same
 * preferences locally for the UI, but the server is the authority: a hidden
 * last-seen or profile is filtered out of every reply and broadcast here.
 */
function handlePrivacySet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(ws.username);
  if (!user) return bad(ws, rid, 'Unknown account');
  const lastSeenHidden = msg.lastSeenHidden === undefined
    ? !!user.last_seen_hidden : !!msg.lastSeenHidden;
  const profileHidden = msg.profileHidden === undefined
    ? !!user.profile_hidden : !!msg.profileHidden;
  q.setPrivacy.run(lastSeenHidden ? 1 : 0, profileHidden ? 1 : 0, ws.username);
  const profile = publicProfile(q.getUser.get(ws.username), ws.username);
  reply(ws, rid, {
    t: 'privacy.saved',
    privacy: { lastSeenHidden, profileHidden },
    profile
  });
  // Tell peers the new view right away so a just-hidden profile disappears.
  broadcastProfile(ws.username, profile);
}

function handleProfileSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const user = q.getUser.get(ws.username);
  if (!user) return bad(ws, rid, 'Unknown account');

  const displayName = msg.displayName === undefined ? user.display_name : cleanText(msg.displayName, 64);
  const bio = msg.bio === undefined ? user.bio : cleanText(msg.bio, 200);
  let avatarColor = user.avatar_color;
  if (msg.avatarColor !== undefined) {
    avatarColor = AVATAR_COLORS.has(msg.avatarColor) ? msg.avatarColor : null;
  }

  q.setProfile.run(displayName, bio, avatarColor, Date.now(), ws.username);
  // The picture is separate so a display-name edit never clears it, and a
  // picture edit never touches the name.
  if (msg.avatarImage !== undefined) {
    const parsed = cleanAvatarImage(msg.avatarImage);
    if (parsed.error) return bad(ws, rid, parsed.error);
    q.setAvatarImage.run(parsed.value, Date.now(), ws.username);
  }
  if (msg.socials !== undefined) {
    const parsed = cleanSocials(msg.socials);
    if (parsed.error) return bad(ws, rid, parsed.error);
    q.setSocials.run(parsed.value, Date.now(), ws.username);
  }
  // Nicknames are a privilege: only the owner account may set its own list from
  // the profile form. Everyone else is edited by an administrator.
  if (msg.nicknames !== undefined && isOwner(ws.username)) {
    const parsed = cleanNicknamesWithClaims(msg.nicknames, ws.username);
    if (parsed.error) return bad(ws, rid, parsed.error);
    q.setNicknames.run(parsed.value, Date.now(), ws.username);
    q.setNicknameClaims.run(parsed.claims, Date.now(), ws.username);
  }
  const updated = publicProfile(q.getUser.get(ws.username));
  reply(ws, rid, { t: 'profile.saved', profile: updated });
  broadcastProfile(ws.username, updated);
}

function handleUsernameSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const next = normalizeUsername(msg.username);
  if (typeof next !== 'string' || !USERNAME_RE.test(next)) {
    return bad(ws, rid, 'Username must be 3-32 chars: a-z, 0-9, _');
  }
  if (next === ws.username) return bad(ws, rid, 'That is already your username');
  if (q.getUser.get(next)) return bad(ws, rid, 'Username already taken');

  const prev = ws.username;
  const now = Date.now();
  try {
    db.exec('BEGIN');
    renameStmts.user.run(next, now, prev);
    renameStmts.sent.run(next, prev);
    renameStmts.received.run(next, prev);
    renameStmts.chatsOwner.run(next, prev);
    renameStmts.chatsPeer.run(next, prev);
    renameStmts.reactions.run(next, prev);
    renameStmts.groupMessages.run(next, prev);
    renameStmts.groupMembers.run(next, prev);
    renameStmts.groupsOwner.run(next, prev);
    renameStmts.channelMessages.run(next, prev);
    renameStmts.channelSubs.run(next, prev);
    renameStmts.channelsOwner.run(next, prev);
    renameStmts.sessions.run(next, prev);
    renameStmts.streaks.run(next, prev);
    renameStmts.stories.run(next, prev);
    renameStmts.storyViews.run(next, prev);
    renameStmts.storyAudience.run(next, prev);
    renameStmts.wallets.run(next, prev);
    renameStmts.ledger.run(next, prev);
    renameStmts.payments.run(next, prev);
    // The pair must stay sorted (`a` < `b`). Renaming can flip that, so rebuild
    // each affected row in place instead of patching one column.
    for (const row of q.dialogStreaksFor.all(prev, prev)) {
      const other = row.a === prev ? row.b : row.a;
      q.deleteDialogStreak.run(row.a, row.b);
      const [a, b] = dialogPair(next, other);
      q.setDialogStreak.run(a, b, row.day, row.count);
    }
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    return bad(ws, rid, 'Could not change username');
  }

  // Rebind live sockets and issued tokens to the new name.
  const set = sockets.get(prev);
  if (set) { sockets.delete(prev); sockets.set(next, set); }
  for (const rec of tokens.values()) {
    if (rec.username === prev) rec.username = next;
  }
  for (const client of set || []) client.username = next;

  reply(ws, rid, {
    t: 'username.changed', username: next, profile: publicProfile(q.getUser.get(next))
  });
}

function handleUserSearch(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const query = typeof msg.query === 'string' ? msg.query.trim().toLowerCase().replace(/^@+/, '') : '';
  if (query.length < 1) return reply(ws, rid, { t: 'users', items: [] });
  const like = `%${query}%`;
  const rows = q.searchUsers.all(like, like);
  const items = rows.map((r) => ({ ...publicProfile(r, ws.username), online: isOnline(r.username) }));
  reply(ws, rid, { t: 'users', items });
}

const ATTACHMENT_KINDS = new Set(['image', 'file', 'voice']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// Self-destructing messages. The relay clamps a client-supplied timer into this
// range so a bad value can neither expire instantly nor pin ciphertext forever.
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Scheduled messages ("send later"). The relay holds the ciphertext until the
// send time, so the clock it enforces is the only one that matters; the window
// is bounded so a bad value cannot pin ciphertext for longer than a year.
const MIN_SCHEDULE_MS = 60 * 1000;
const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60 * 1000;
// The client caps the file the user picks; the ciphertext it sends is that file
// plus the 16-byte box MAC and base64 padding. The stored blob is checked
// against the file limit with this slack, so a file exactly at the limit is
// accepted instead of failing on the encryption overhead.
const ATTACHMENT_BOX_SLACK = 1024;

/** Shared metadata checks for both direct and group attachments. */
function attachmentMeta(value) {
  const kind = value.kind;
  if (!ATTACHMENT_KINDS.has(kind)) return { error: 'Unsupported attachment type' };
  const name = cleanText(value.name, 120) || null;
  const mime = cleanText(value.mime, 80) || null;
  const size = Number.isFinite(value.size) ? Math.max(0, Math.floor(value.size)) : 0;
  const duration = Number.isFinite(value.duration) ? Math.max(0, Math.floor(value.duration)) : null;
  if (size > MAX_ATTACHMENT_BYTES) return { error: 'Attachment is too large' };
  return { kind, name, mime, size, duration };
}

/** Validate the attachment envelope. Ciphertext only; the relay never sees plaintext. */
function parseAttachment(value) {
  if (value === undefined || value === null) return { kind: null, attachment: null };
  if (typeof value !== 'object') return { error: 'Malformed attachment' };
  const meta = attachmentMeta(value);
  if (meta.error) return meta;
  // The length cap only guards the frame budget; the byte check below produces
  // the user-facing "too large" message.
  if (!validB64(value.box, 12 * 1024 * 1024) || !validB64(value.nonce, 100)) {
    return { error: 'Malformed attachment payload' };
  }
  // base64 length overestimates bytes by ~4/3; this keeps the stored blob bounded.
  const approxBytes = Math.floor(value.box.length * 3 / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES + ATTACHMENT_BOX_SLACK) return { error: 'Attachment is too large' };
  return {
    kind: meta.kind,
    attachment: JSON.stringify({
      kind: meta.kind, name: meta.name, mime: meta.mime,
      size: meta.size || approxBytes, duration: meta.duration,
      box: value.box, nonce: value.nonce
    })
  };
}

/** A group attachment carries one encrypted blob per member under `perMember`. */
function parseGroupAttachment(value) {
  if (value === undefined || value === null) return { kind: null, attachment: null };
  if (typeof value !== 'object') return { error: 'Malformed attachment' };
  const meta = attachmentMeta(value);
  if (meta.error) return meta;
  if (!value.perMember || typeof value.perMember !== 'object') {
    return { error: 'Malformed attachment payload' };
  }
  const perMember = {};
  for (const [user, env] of Object.entries(value.perMember)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (!validB64(box, 12 * 1024 * 1024) || !validB64(nonce, 100)) {
      return { error: 'Malformed attachment payload' };
    }
    if (Math.floor(box.length * 3 / 4) > MAX_ATTACHMENT_BYTES + ATTACHMENT_BOX_SLACK) {
      return { error: 'Attachment is too large' };
    }
    perMember[user] = { box, nonce };
  }
  if (Object.keys(perMember).length === 0) return { error: 'Malformed attachment payload' };
  return {
    kind: meta.kind,
    attachment: JSON.stringify({
      kind: meta.kind, name: meta.name, mime: meta.mime,
      size: meta.size, duration: meta.duration, perMember
    })
  };
}

function handleSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const { to, box, nonce } = msg;
  // Sending to yourself is allowed: that is how Saved Messages works.
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such recipient');

  const parsed = parseAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);
  const isAttachment = !!parsed.attachment;

  // A caption-less text message must still carry a box; an attachment may have an
  // empty caption, in which case box/nonce are allowed to be blank.
  if (isAttachment) {
    if (box !== undefined && box !== '' && (!validB64(box, 100000) || !validB64(nonce, 100))) {
      return bad(ws, rid, 'Malformed payload');
    }
  } else if (!validB64(box, 100000) || !validB64(nonce, 100)) {
    return bad(ws, rid, 'Malformed payload');
  }

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const safeBox = typeof box === 'string' ? box : '';
  const safeNonce = typeof nonce === 'string' ? nonce : '';
  const kind = parsed.kind;
  // A self-destructing message carries the shared timer in effect at send time.
  // The relay never reads the text; it only counts down the clock on the
  // ciphertext it already holds. The client sends the timer so the two devices
  // agree even if one changed it while the other was offline.
  const ttl = Number.isFinite(msg.ttl) && msg.ttl > 0
    ? Math.min(Math.max(Math.floor(msg.ttl), MIN_TTL_MS), MAX_TTL_MS)
    : 0;
  const expiresAt = ttl ? ts + ttl : null;
  // A scheduled message is held by the relay until its send time. The send time
  // is clamped into a sane window and must lie in the future; anything else is
  // sent immediately, so a bad value can never silently drop a message.
  const wantsSchedule = Number.isFinite(msg.sendAt) && msg.sendAt > 0;
  const sendAt = wantsSchedule
    ? Math.min(Math.max(Math.floor(msg.sendAt), Date.now() + MIN_SCHEDULE_MS), Date.now() + MAX_SCHEDULE_MS)
    : null;
  const info = q.insertMessage.run(
    ws.username, to, safeBox, safeNonce, ts, replyTo, kind, parsed.attachment, expiresAt, sendAt
  );
  const id = Number(info.lastInsertRowid);
  touchStreak(ws.username);

  // A message held for later is not delivered and not yet part of the flame; it
  // is simply acknowledged so the sender's device can list and cancel it. The
  // sender's other devices are told too, so the scheduled list stays in sync.
  if (sendAt) {
    deliverToUser(ws.username, {
      t: 'scheduled.new',
      item: {
        id, to, ts, sendAt, replyTo, kind, attachment: parsed.attachment,
        expiresAt, box: safeBox, nonce: safeNonce
      }
    });
    return reply(ws, rid, {
      t: 'sent', id, ts, to, replyTo, kind, attachment: parsed.attachment,
      expiresAt, scheduled: true, sendAt
    });
  }

  // The dialog flame moves only between two real accounts; Saved Messages and
  // group/channel posts have no pair and are skipped.
  let note = null;
  let flame = null;
  if (to !== ws.username && q.getUser.get(to)) {
    flame = touchDialogStreak(ws.username, to);
    broadcastDialogStreak(ws.username, to, flame);
    if (flame.started) {
      // One centered note for the pair. Stored once, with a real sender and
      // recipient, so it lands in both people's history (the history query is
      // symmetric) yet is never mistaken for a message in previews or unread.
      const noteId = Number(
        q.insertMessage.run(ws.username, to, '', '', ts, null, 'system:series', null, null, null).lastInsertRowid
      );
      q.markDelivered.run(noteId);
      note = { id: noteId, ts };
    }
  }

  reply(ws, rid, { t: 'sent', id, ts, to, replyTo, kind, attachment: parsed.attachment, streak: flame, expiresAt });
  const delivered = deliverToUser(to, {
    t: 'message', id, from: ws.username, box: safeBox, nonce: safeNonce, ts, replyTo,
    kind, attachment: parsed.attachment, expiresAt
  });
  if (delivered) q.markDelivered.run(id);
  if (note) {
    // Each side must receive the note with `from` set to *their peer*, so the
    // client files it under the same conversation they are looking at. A single
    // shared frame would land in the sender's Saved Messages instead.
    deliverToUser(to, {
      t: 'message', id: note.id, from: ws.username, box: '', nonce: '',
      ts: note.ts, kind: 'system:series'
    });
    deliverToUser(ws.username, {
      t: 'message', id: note.id, from: to, box: '', nonce: '',
      ts: note.ts, kind: 'system:series'
    });
  }
}

function handleHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const other = msg.with;
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  if (typeof other !== 'string') return bad(ws, rid, 'Bad request');

  const chat = q.getChat.get(ws.username, other);
  const after = chat ? chat.cleared_at : 0;
  const rows = q.history.all(ws.username, other, other, ws.username, after, limit).reverse();

  reply(ws, rid, {
    t: 'history',
    with: other,
    ttl: chat && chat.ttl ? chat.ttl : 0,
    streak: dialogStreakView(ws.username, other),
    items: rows.map((r) => ({
      id: r.id, from: r.sender, to: r.recipient,
      box: r.box, nonce: r.nonce, ts: r.ts,
      replyTo: r.reply_to, editedAt: r.edited_at, deleted: !!r.deleted,
      kind: r.kind || null, attachment: r.attachment || null, pinned: !!r.pinned,
      expiresAt: r.expires_at || null,
      reactions: reactionsOf(r.id)
    }))
  });
}

/* --------------------------- scheduled messages --------------------------- */

/** The sender's own view of a message that is still waiting for its send time. */
function scheduledView(row) {
  return {
    id: row.id, to: row.recipient, ts: row.ts, sendAt: row.send_at,
    replyTo: row.reply_to, kind: row.kind || null, attachment: row.attachment || null,
    expiresAt: row.expires_at || null,
    box: row.box, nonce: row.nonce
  };
}

function handleScheduledList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const rows = q.scheduledFor.all(ws.username);
  reply(ws, rid, { t: 'scheduled', items: rows.map(scheduledView) });
}

function handleScheduledCancel(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row || row.sender !== ws.username) return bad(ws, rid, 'No such scheduled message');
  if (row.send_at == null) return bad(ws, rid, 'Message already sent');
  // The row keeps its ciphertext but is hidden from the scheduled list on every
  // one of the sender's devices. It never becomes a message: `send_at` stays set,
  // so history and offline delivery keep ignoring it.
  q.hideScheduled.run(row.id);
  reply(ws, rid, { t: 'scheduled.cancelled', id: row.id });
  deliverToUser(ws.username, { t: 'scheduled.cancelled', id: row.id });
}

function handleScheduledReschedule(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row || row.sender !== ws.username) return bad(ws, rid, 'No such scheduled message');
  if (row.send_at == null) return bad(ws, rid, 'Message already sent');
  if (!Number.isFinite(msg.sendAt)) return bad(ws, rid, 'Bad send time');
  const sendAt = Math.min(
    Math.max(Math.floor(msg.sendAt), Date.now() + MIN_SCHEDULE_MS),
    Date.now() + MAX_SCHEDULE_MS
  );
  q.reschedule.run(sendAt, row.id);
  reply(ws, rid, { t: 'scheduled.rescheduled', id: row.id, sendAt });
  deliverToUser(ws.username, { t: 'scheduled.rescheduled', id: row.id, sendAt });
}

function handleScheduledSendNow(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row || row.sender !== ws.username) return bad(ws, rid, 'No such scheduled message');
  if (row.send_at == null) return bad(ws, rid, 'Message already sent');
  // Releasing it now is the same path the sweeper takes when the time arrives:
  // the message becomes live and lands in both people's history.
  releaseScheduledMessage(row);
  reply(ws, rid, { t: 'scheduled.sent', id: row.id });
}

function handleMessageEdit(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');
  if (row.deleted) return bad(ws, rid, 'Message was deleted');
  if (!validB64(msg.box, 100000) || !validB64(msg.nonce, 100)) {
    return bad(ws, rid, 'Malformed payload');
  }

  const editedAt = Date.now();
  q.editMessage.run(msg.box, msg.nonce, editedAt, row.id);
  reply(ws, rid, { t: 'edited', id: row.id, editedAt });

  if (row.recipient !== ws.username) {
    deliverToUser(row.recipient, {
      t: 'edited', id: row.id, from: row.sender, box: msg.box, nonce: msg.nonce,
      ts: row.ts, editedAt
    });
  }
}

function handleMessageDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');

  q.deleteMessage.run(row.id);
  reply(ws, rid, { t: 'deleted', id: row.id });
  if (row.recipient !== ws.username) {
    deliverToUser(row.recipient, { t: 'deleted', id: row.id, from: row.sender });
  }
}

function handleReaction(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username && row.recipient !== ws.username) {
    return bad(ws, rid, 'Not your conversation');
  }
  const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, 8) : '';
  if (emoji) q.setReaction.run(row.id, ws.username, emoji, Date.now());
  else q.clearReaction.run(row.id, ws.username);

  const list = reactionsOf(row.id);
  reply(ws, rid, { t: 'reactions', id: row.id, reactions: list });

  const other = row.sender === ws.username ? row.recipient : row.sender;
  if (other !== ws.username) deliverToUser(other, { t: 'reactions', id: row.id, reactions: list });
}

function handleTyping(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.to !== 'string') return bad(ws, rid, 'Bad request');
  reply(ws, rid, { t: 'ok', action: 'typing' });
  deliverToUser(msg.to, {
    t: 'typing', from: ws.username, state: msg.state === 'stop' ? 'stop' : 'start'
  });
}

/* --------------------------------- calls --------------------------------- */
// The relay is a switchboard, not a mixer: it forwards the little WebRTC
// handshake frames (offer/answer/ICE) and never touches the audio or video,
// which flow peer-to-peer, encrypted by DTLS-SRTP. It cannot listen in any more
// than it can read a message. A call is kept as in-memory state only — nothing
// about who rang whom is written to the database.

/** Call state per id: { from, to, groupId, video, participants:Set, startedAt }. */
const calls = new Map();
let callSeq = 0;
const CALL_MAX_PARTICIPANTS = 6; // a mesh, so each peer connects to every other

function callState(callId) { return calls.get(String(callId)) || null; }

/** A participant may signal on a call only if they are on it. */
function callAllows(call, username) {
  if (!call || !username) return false;
  return call.participants.has(username);
}

/** Fan a signaling frame out to every participant except the sender. */
function callFanout(call, exceptUser, payload) {
  for (const u of call.participants) {
    if (u !== exceptUser) deliverToUser(u, payload);
  }
}

function handleCallInvite(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const video = !!msg.video;

  // A group call rings every other member; a direct call rings one peer.
  if (msg.groupId != null) {
    const groupId = Number(msg.groupId);
    if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
    const participants = new Set(q.membersOf.all(groupId).map((m) => m.username));
    if (participants.size > CALL_MAX_PARTICIPANTS) {
      return bad(ws, rid, `Групповой звонок — до ${CALL_MAX_PARTICIPANTS} участников`);
    }
    const callId = `c${++callSeq}`;
    calls.set(callId, { from: ws.username, to: null, groupId, video, participants, startedAt: Date.now() });
    reply(ws, rid, { t: 'call.ringing', callId, video, groupId, participants: [...participants].filter((u) => u !== ws.username) });
    callFanout(calls.get(callId), ws.username, {
      t: 'call.incoming', callId, from: ws.username, video, groupId
    });
    return;
  }

  const to = msg.to;
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such user');
  if (to === ws.username) return bad(ws, rid, 'Cannot call yourself');
  const callId = `c${++callSeq}`;
  calls.set(callId, { from: ws.username, to, groupId: null, video, participants: new Set([ws.username, to]), startedAt: Date.now() });
  reply(ws, rid, { t: 'call.ringing', callId, video, participants: [to] });
  deliverToUser(to, { t: 'call.incoming', callId, from: ws.username, video });
}

function handleCallAnswer(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const call = callState(msg.callId);
  if (!callAllows(call, ws.username)) return bad(ws, rid, 'No such call');
  // Hand the answerer the roster of everyone else already on the call, so a
  // mesh knows exactly which legs to build and does not have to guess.
  const others = [...call.participants].filter((u) => u !== ws.username);
  reply(ws, rid, { t: 'ok', action: 'call.answer', participants: others });
  callFanout(call, ws.username, {
    t: 'call.answered', callId: String(msg.callId), from: ws.username, video: call.video
  });
}

/**
 * WebRTC handshake traffic: the SDP offer/answer and ICE candidates. `to`
 * names the single peer this frame is for, so a mesh call can address one leg
 * at a time; without it the frame goes to everyone else on the call.
 */
function handleCallSignal(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const call = callState(msg.callId);
  if (!callAllows(call, ws.username)) return bad(ws, rid, 'No such call');
  const frame = {
    t: 'call.signal', callId: String(msg.callId), from: ws.username,
    sdp: typeof msg.sdp === 'string' ? msg.sdp : null,
    candidate: msg.candidate || null
  };
  reply(ws, rid, { t: 'ok', action: 'call.signal' });
  if (typeof msg.to === 'string' && call.participants.has(msg.to)) {
    deliverToUser(msg.to, { ...frame, to: msg.to });
  } else {
    callFanout(call, ws.username, frame);
  }
}

function handleCallDecline(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const call = callState(msg.callId);
  if (!call) return reply(ws, rid, { t: 'ok', action: 'call.decline' });
  reply(ws, rid, { t: 'ok', action: 'call.decline' });
  callFanout(call, ws.username, { t: 'call.declined', callId: String(msg.callId), from: ws.username });
  // A direct call is over once the callee declines; a group call keeps going
  // for the others, so only the two-party case tears down the whole call.
  if (!call.groupId) calls.delete(String(msg.callId));
}

function handleCallHangup(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const call = callState(msg.callId);
  reply(ws, rid, { t: 'ok', action: 'call.hangup' });
  if (!call) return;
  const id = String(msg.callId);
  if (call.groupId) {
    // Leaving a group call removes just this participant; the rest carry on.
    call.participants.delete(ws.username);
    callFanout(call, ws.username, { t: 'call.left', callId: id, from: ws.username });
    if (call.participants.size <= 1) {
      // One person left: the call is over for them too, so close their panel.
      callFanout(call, ws.username, { t: 'call.ended', callId: id, from: ws.username });
      calls.delete(id);
    }
  } else {
    calls.delete(id);
    callFanout(call, ws.username, { t: 'call.ended', callId: id, from: ws.username });
  }
}

/* --------------------------- rockets and premium --------------------------- */
// Rockets are the in-app currency; Premium is a subscription. Both are settled
// here, on the relay, because a client is not trusted with money. Every balance
// change goes through `moveRockets`, and every top-up is keyed by the provider's
// own reference so a retried confirmation credits once.

function rocketBalance(username) {
  q.insertWallet.run(username, Date.now());
  const row = q.getWallet.get(username);
  return row ? row.balance : 0;
}

/** Move Rockets and record why. Returns the new balance. */
function moveRockets(username, delta, reason, detail) {
  const now = Date.now();
  q.insertWallet.run(username, now);
  const next = rocketBalance(username) + delta;
  q.setWalletBalance.run(next, now, username);
  q.insertLedger.run(username, delta, reason, detail || null, null, now);
  return next;
}

function premiumUntil(user) {
  const until = user && user.premium_until ? Number(user.premium_until) : 0;
  return until > Date.now() ? until : 0;
}

function premiumState(user) {
  const until = premiumUntil(user);
  return {
    active: until > 0,
    until: until || null,
    priceRub: MONEY.rubles(PREMIUM_PRICE_KOPECKS),
    months: 1
  };
}

/** The wallet and Premium state a client is allowed to see about itself. */
function walletState(username) {
  const user = q.getUser.get(username);
  return {
    t: 'wallet',
    balance: rocketBalance(username),
    premium: premiumState(user),
    bundles: MONEY.priceBundles(ROCKET_PRICE_KOPECKS, ROCKET_BUNDLES),
    gifts: GIFT_CATALOGUE,
    // What a Premium gift costs and how far it may reach. The renderer draws
    // the picker from this, so the shelf cannot advertise a price the relay
    // would refuse.
    premiumGift: {
      rocketsPerMonth: PREMIUM_GIFT_ROCKETS,
      maxMonths: PREMIUM_GIFT_MAX_MONTHS,
      priceRub: MONEY.rubles(PREMIUM_PRICE_KOPECKS)
    }
  };
}

function handleWalletGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  reply(ws, rid, { ...walletState(ws.username), _id: rid });
}

/** How a provider is reached, or `null` when no real one is configured. */
function payAdapterEndpoint(pathname) {
  if (!PAY_ADAPTER_URL) return null;
  const base = PAY_ADAPTER_URL.replace(/\/$/, '');
  const url = new URL(base + pathname);
  if (PAY_ADAPTER_TOKEN) url.pathname += '/' + PAY_ADAPTER_TOKEN;
  return url;
}

/**
 * Ask the adapter to create a payment. Returns the checkout URL to open, or
 * null when the provider is not configured (the caller then settles locally).
 * A failure here is not fatal: the user is told to try again, and no Rockets
 * have moved.
 */
async function providerCreatePayment(payment) {
  const url = payAdapterEndpoint('/create');
  if (!url) return null;
  const body = JSON.stringify({
    id: payment.id,
    amount: payment.amount_rub,
    label: payment.kind === 'premium' ? 'SleePhy Premium' : 'SleePhy Rockets',
    returnUrl: PAY_PUBLIC_URL ? `${PAY_PUBLIC_URL}/pay/return?id=${payment.id}` : ''
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  if (!res.ok) throw new Error('provider create failed');
  const data = await res.json();
  return typeof data.checkoutUrl === 'string' ? data.checkoutUrl : null;
}

/**
 * Whether the relay should speak to YooMoney itself. That is the case on a
 * single-process host (Amvera) where no adapter is reachable: the provider is
 * `yoomoney`, the wallet is configured, and no adapter URL is set.
 */
function usesDirectYooMoney() {
  // The secret is required: without it a notification cannot be verified, so a
  // real link would take money that could never be credited. Missing config
  // falls back to the built-in demo checkout, which moves no money.
  return PAY_PROVIDER === 'yoomoney' && !!YOOMONEY_RECEIVER && !!YOOMONEY_SECRET && !PAY_ADAPTER_URL;
}

/**
 * Which payment path is actually in effect. Deciding it in one place keeps the
 * create, confirm and claim handlers from disagreeing: a link is only ever
 * handed out together with the handler that can settle it.
 *   mock     - settles at once (tests)
 *   direct   - the relay itself talks to YooMoney
 *   adapter  - an external adapter talks to the provider
 *   checkout - the relay's own demo page, which takes no money
 */
function payMode() {
  if (PAY_PROVIDER === 'mock') return 'mock';
  if (usesDirectYooMoney()) return 'direct';
  if (PAY_PROVIDER !== 'checkout' && PAY_ADAPTER_URL) return 'adapter';
  return 'checkout';
}

/** Build the YooMoney quickpay link the user opens in a browser. */
function yoomoneyDirectCreate(payment) {
  const url = new URL(YOOMONEY_QUICKPAY_URL);
  url.searchParams.set('receiver', YOOMONEY_RECEIVER);
  url.searchParams.set('quickpay-form', 'button');
  url.searchParams.set('paymentType', 'AC');
  url.searchParams.set('sum', MONEY.amountString(payment.amount_rub));
  url.searchParams.set('label', payment.id);
  url.searchParams.set('targets', payment.kind === 'premium' ? 'SleePhy Premium' : 'SleePhy Rockets');
  if (PAY_PUBLIC_URL) url.searchParams.set('successURL', `${PAY_PUBLIC_URL.replace(/\/+$/, '')}/pay/return?id=${payment.id}`);
  return url.toString();
}

/** The sha1 signature YooMoney puts on every notification, for verification. */
function yoomoneyDirectSignature(p) {
  const fields = [
    p.notification_type, p.operation_id, p.amount, p.currency, p.datetime,
    p.sender, p.codepro, YOOMONEY_SECRET, p.label
  ].map((v) => (v === undefined || v === null ? '' : String(v)));
  return crypto.createHash('sha1').update(fields.join('&')).digest('hex');
}

/**
 * Fallback for a payment whose notification never arrived: ask YooMoney's
 * operation history whether the label was paid. Only used when an OAuth token
 * is configured. Any error (no token, network, provider) is a plain "not paid"
 * so a claim can never fail the whole request.
 */
async function yoomoneyDirectPoll(payment) {
  if (!YOOMONEY_TOKEN) return false;
  try {
    const res = await fetch(`${YOOMONEY_API_URL}/operation-history`, {
      method: 'POST',
      headers: { authorization: `Bearer ${YOOMONEY_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ label: payment.id, type: 'deposition', records: '10' }).toString(),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return false;
    const data = await res.json();
    const ops = Array.isArray(data.operations) ? data.operations : [];
    // Only a deposit of at least the price counts; a partial payment is not one.
    return ops.some((op) => op.status === 'success' && Math.round(Number(op.amount) * 100) >= payment.amount_rub);
  } catch {
    return false;
  }
}

/** Read a POST body as a string, capped so a huge body cannot exhaust memory. */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** The public base of this relay, from configuration or the request itself. */
function publicBase(req) {
  if (PAY_PUBLIC_URL) return PAY_PUBLIC_URL.replace(/\/+$/, '');
  const host = (req && req.headers && req.headers.host) || `127.0.0.1:${PORT}`;
  const forwarded = req && req.headers && req.headers['x-forwarded-proto'];
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host);
  const proto = forwarded ? String(forwarded).split(',')[0].trim() : (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * Create a pending top-up (Rockets or Premium) and a way to pay for it.
 * Every provider now returns a checkout URL: the mock one points back at the
 * relay's own payment page, and a real one points at the provider.
 */
async function handlePayCreate(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const kind = msg.kind === 'premium' ? 'premium' : 'rockets';
  let amount;
  let rockets = null;
  let months = null;

  if (kind === 'premium') {
    amount = PREMIUM_PRICE_KOPECKS;
    months = 1;
  } else {
    const wanted = Number(msg.rockets);
    if (!MONEY.isKnownBundle(ROCKET_BUNDLES, wanted)) return bad(ws, rid, 'Неизвестный пакет');
    rockets = Math.trunc(wanted);
    amount = MONEY.bundlePrice(ROCKET_PRICE_KOPECKS, rockets);
  }

  const id = crypto.randomBytes(12).toString('base64url');
  q.insertPayment.run(id, ws.username, kind, amount, rockets, months, PAY_PROVIDER, Date.now());

  // The mock provider is a convenience for tests and local runs: it settles at
  // once so no browser is involved. Every other provider hands the app a real
  // checkout URL and credits nothing until that payment is confirmed.
  if (payMode() === 'mock') {
    settlePayment(id, 'mock:' + id);
    reply(ws, rid, { t: 'payment', id, kind, amountRub: MONEY.rubles(amount), status: 'paid', ...walletState(ws.username), _id: rid });
    return;
  }

  // The relay's own checkout page is the payment screen when no external
  // provider is configured; a real provider replaces the link through the
  // adapter. Nothing is credited here either way.
  const payment = q.getPayment.get(id);
  let checkoutUrl = `${publicBase(ws._req)}/pay/checkout?id=${id}`;
  if (payMode() === 'direct') {
    // No adapter: the relay builds the real YooMoney link itself.
    checkoutUrl = yoomoneyDirectCreate(payment);
  } else if (payMode() === 'adapter') {
    try {
      checkoutUrl = (await providerCreatePayment(payment)) || checkoutUrl;
    } catch {
      reply(ws, rid, { t: 'error', message: 'Платёжный сервис недоступен, попробуйте позже' });
      return;
    }
  }
  reply(ws, rid, { t: 'payment', id, kind, amountRub: MONEY.rubles(amount), status: 'pending', checkoutUrl, _id: rid });
}

/**
 * Mark a pending payment as cancelled. The user backed out of the checkout, so
 * nothing is credited; a later claim finds it cancelled and does nothing. Only
 * the owner of the payment may cancel it.
 */
function handlePayCancel(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const payment = q.getPayment.get(String(msg.id || ''));
  if (!payment || payment.username !== ws.username) return bad(ws, rid, 'Платёж не найден');
  if (payment.status === 'pending') q.setPaymentCancelled.run(Date.now(), payment.id);
  reply(ws, rid, { ...walletState(ws.username), paymentStatus: payment.status === 'pending' ? 'cancelled' : payment.status, _id: rid });
}

/**
 * Settle a pending payment exactly once. `providerRef` is the provider's own
 * identifier; the UNIQUE index on the ledger is what makes a repeated
 * confirmation a no-op instead of a second credit.
 */
function settlePayment(paymentId, providerRef) {
  const payment = q.getPayment.get(paymentId);
  if (!payment || payment.status !== 'pending') return null;
  const now = Date.now();
  const changed = q.setPaymentPaid.run(providerRef, now, paymentId).changes;
  if (!changed) return null; // another confirmation won the race

  if (payment.kind === 'premium') {
    const user = q.getUser.get(payment.username);
    // Extend from the later of "now" and the current expiry, so buying while
    // still subscribed adds a month instead of throwing the rest away.
    const until = MONEY.extendPremium(premiumUntil(user), now, payment.months || 1, PREMIUM_MONTH_MS);
    q.setPremiumUntil.run(until, now, payment.username);
  } else {
    q.insertWallet.run(payment.username, now);
    const balance = rocketBalance(payment.username) + (payment.rockets || 0);
    q.setWalletBalance.run(balance, now, payment.username);
    q.insertLedger.run(payment.username, payment.rockets || 0, 'topup', paymentId, providerRef, now);
  }

  const state = walletState(payment.username);
  deliverToUser(payment.username, { ...state, t: 'wallet', paymentId, settled: true });
  return state;
}

/**
 * A client saying "I have paid". The relay does not take that on faith: it asks
 * the adapter to confirm the payment with the provider first. Only a
 * confirmation credits anything. With the mock provider there is nothing to
 * confirm, so the pending payment settles immediately.
 */
async function handlePayClaim(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const payment = q.getPayment.get(String(msg.id || ''));
  if (!payment || payment.username !== ws.username) return bad(ws, rid, 'Платёж не найден');
  if (payment.status !== 'pending') {
    return reply(ws, rid, { ...walletState(ws.username), paymentStatus: payment.status, _id: rid });
  }

  if (payMode() === 'mock') {
    settlePayment(payment.id, 'mock:' + payment.id);
    return reply(ws, rid, { ...walletState(ws.username), paymentStatus: 'paid', _id: rid });
  }

  // The relay's own checkout page settles the payment itself, and with no
  // adapter there is nothing to ask, so a claim just reports the current
  // status: paid if the user confirmed, cancelled if they backed out. When the
  // relay speaks to YooMoney directly it polls the provider as a fallback, in
  // case the notification was missed.
  if (payMode() === 'direct') {
    if (await yoomoneyDirectPoll(payment)) {
      settlePayment(payment.id, 'yoomoney:' + payment.id);
      return reply(ws, rid, { ...walletState(ws.username), paymentStatus: 'paid', _id: rid });
    }
    return reply(ws, rid, { ...walletState(ws.username), paymentStatus: payment.status, _id: rid });
  }

  if (payMode() === 'checkout') {
    return reply(ws, rid, { ...walletState(ws.username), paymentStatus: payment.status, _id: rid });
  }

  const url = payAdapterEndpoint('/verify');
  let paid = false;
  let ref = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: payment.id, amount: payment.amount_rub })
    });
    if (res.ok) {
      const data = await res.json();
      paid = data.paid === true;
      ref = typeof data.ref === 'string' ? data.ref : '';
    }
  } catch {
    return bad(ws, rid, 'Платёжный сервис недоступен, попробуйте позже');
  }
  if (!paid) return reply(ws, rid, { ...walletState(ws.username), paymentStatus: 'pending', _id: rid });
  settlePayment(payment.id, ref || payment.id);
  reply(ws, rid, { ...walletState(ws.username), paymentStatus: 'paid', _id: rid });
}

/** Buy a gift: debit the sender's Rockets, then let the gift message go out. */
function handleGiftSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const gift = GIFT_CATALOGUE[String(msg.gift || '')];
  if (!gift) return bad(ws, rid, 'Такого подарка нет');
  const to = msg.to;
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such user');
  if (to === ws.username) return bad(ws, rid, 'Cannot gift yourself');

  const balance = rocketBalance(ws.username);
  if (balance < gift.cost) {
    return reply(ws, rid, { t: 'error', message: 'Недостаточно ракет', need: gift.cost, balance });
  }
  const next = moveRockets(ws.username, -gift.cost, 'gift', `${msg.gift} -> ${to}`);
  reply(ws, rid, { t: 'gift.ok', gift: msg.gift, to, balance: next, _id: rid });
}

/**
 * Gift Premium: the sender spends Rockets, the recipient's subscription is
 * extended. The relay prices it from its own table and clamps the month count,
 * so a tampered request can neither buy a year for one Rocket nor hand out an
 * unbounded subscription. The gift itself rides as an ordinary encrypted
 * message, exactly like a catalogue gift; only the extension happens here.
 */
function handleGiftPremium(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const to = msg.to;
  if (typeof to !== 'string' || !q.getUser.get(to)) return bad(ws, rid, 'No such user');
  if (to === ws.username) return bad(ws, rid, 'Cannot gift yourself');

  const months = Math.min(Math.max(Math.trunc(Number(msg.months) || 1), 1), PREMIUM_GIFT_MAX_MONTHS);
  const cost = PREMIUM_GIFT_ROCKETS * months;
  const balance = rocketBalance(ws.username);
  if (balance < cost) {
    return reply(ws, rid, { t: 'error', message: 'Недостаточно ракет', need: cost, balance });
  }

  const next = moveRockets(ws.username, -cost, 'gift-premium', `${months}mo -> ${to}`);
  const target = q.getUser.get(to);
  const now = Date.now();
  const until = MONEY.extendPremium(premiumUntil(target), now, months, PREMIUM_MONTH_MS);
  q.setPremiumUntil.run(until, now, to);
  // The recipient's own devices learn about the subscription at once; the
  // sender gets its new balance back in the reply.
  deliverToUser(to, walletState(to));
  reply(ws, rid, { t: 'gift.ok', gift: 'premium', months, to, balance: next, _id: rid });
}

/** The owner can hand out Rockets and Premium, e.g. to seed a promotion or
 *  refund someone. `rockets` and `premiumMonths` are independent: either, both
 *  or — when nothing is asked for — nothing happens. */
function handleAdminGrant(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (!isAdmin(ws.username)) return bad(ws, rid, 'Not allowed');
  const target = String(msg.username || '').toLowerCase();
  const user = q.getUser.get(target);
  if (!user) return bad(ws, rid, 'No such user');

  const amount = Math.trunc(Number(msg.amount || 0));
  const months = Math.trunc(Number(msg.premiumMonths || 0));
  const hasRockets = Number.isFinite(amount) && amount !== 0;
  const hasPremium = Number.isFinite(months) && months !== 0;
  if (!hasRockets && !hasPremium) return bad(ws, rid, 'Укажите ракеты или месяцы Premium');

  let balance = rocketBalance(target);
  if (hasRockets) {
    balance = moveRockets(target, amount, 'admin', ws.username);
    logAdmin(ws.username, 'grant', target, `${amount} rockets`);
  }
  if (hasPremium) {
    // A negative count takes time away; the result is floored at "now" so an
    // admin cannot leave a subscription in the past and confuse the UI.
    const until = MONEY.extendPremium(premiumUntil(user), Date.now(), months, PREMIUM_MONTH_MS);
    q.setPremiumUntil.run(Math.max(until, 0), Date.now(), target);
    logAdmin(ws.username, 'grantPremium', target, `${months} months`);
  }

  const updated = q.getUser.get(target);
  deliverToUser(target, walletState(target));
  reply(ws, rid, {
    t: 'admin.ok',
    action: 'grant',
    username: target,
    balance,
    premium: premiumState(updated),
    _id: rid
  });
}

function handleChatsList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const items = [];
  const seen = new Set();
  const rows = q.listChats.all(ws.username).map((c) => ({ ...c, exists: true }));
  for (const row of rows) seen.add(row.peer);
  for (const p of q.allPeers.all(ws.username, ws.username, ws.username, ws.username)) {
    if (!seen.has(p.peer)) {
      rows.push({ peer: p.peer, pinned: 0, muted: 0, archived: 0, last_read: 0, cleared_at: 0, ttl: null });
    }
  }

  for (const chat of rows) {
    const last = q.lastMessage.get(ws.username, chat.peer, chat.peer, ws.username);
    const unread = q.unreadCount.get(chat.peer, ws.username, chat.last_read).c;
    // Carry the peer's public profile so a fresh launch can draw the checkmark
    // and the badge/profile picture. The badge is usually granted while the
    // viewer is offline, so re-entry must not depend on having seen it live.
    const peerUser = q.getUser.get(chat.peer);
    items.push({
      peer: chat.peer,
      profile: peerUser ? publicProfile(peerUser, ws.username) : null,
      pinned: !!chat.pinned,
      muted: !!chat.muted,
      archived: !!chat.archived,
      unread,
      lastRead: chat.last_read,
      ttl: chat.ttl || 0,
      streak: dialogStreakView(ws.username, chat.peer),
      last: last ? {
        id: last.id, from: last.sender, to: last.recipient, box: last.box,
        nonce: last.nonce, ts: last.ts, editedAt: last.edited_at, deleted: !!last.deleted,
        expiresAt: last.expires_at || null
      } : null
    });
  }
  reply(ws, rid, { t: 'chats', items });
}

function handleChatSettings(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const peer = msg.peer;
  if (typeof peer !== 'string') return bad(ws, rid, 'Bad request');
  const current = q.getChat.get(ws.username, peer);
  const pinned = msg.pinned === undefined ? !!(current && current.pinned) : !!msg.pinned;
  const muted = msg.muted === undefined ? !!(current && current.muted) : !!msg.muted;
  const archived = msg.archived === undefined ? !!(current && current.archived) : !!msg.archived;

  q.setChatFlags.run(ws.username, peer, pinned ? 1 : 0, muted ? 1 : 0, archived ? 1 : 0);
  reply(ws, rid, { t: 'chat.settings', peer, pinned, muted, archived });
}

/**
 * Set the conversation's auto-delete timer. It belongs to the pair, so both
 * owners' rows are written and both are told, which is what keeps the two
 * devices showing the same clock. A timer of 0 turns it off. Only the future is
 * affected: messages already sent keep the countdown they were given.
 */
function handleChatTtl(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const peer = msg.peer;
  if (typeof peer !== 'string' || !peer) return bad(ws, rid, 'Bad request');
  const ttl = Number.isFinite(msg.ttl) && msg.ttl > 0
    ? Math.min(Math.max(Math.floor(msg.ttl), MIN_TTL_MS), MAX_TTL_MS)
    : 0;
  q.setTtlBoth.run(ws.username, peer, ttl);
  q.setTtlBoth.run(peer, ws.username, ttl);
  reply(ws, rid, { t: 'chat.ttl', peer, ttl });
  deliverToUser(peer, { t: 'chat.ttl', from: ws.username, peer: ws.username, ttl });
}

function handleChatRead(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.peer !== 'string') return bad(ws, rid, 'Bad request');
  const ts = Date.now();
  q.setLastRead.run(ws.username, msg.peer, ts);
  reply(ws, rid, { t: 'chat.read', peer: msg.peer, lastRead: ts });
}

function handleChatClear(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.peer !== 'string') return bad(ws, rid, 'Bad request');
  q.clearChat.run(ws.username, msg.peer, msg.peer, ws.username);
  q.setChatFlags.run(ws.username, msg.peer, 0, 0, 0);
  q.setClearedAt.run(Date.now(), ws.username, msg.peer);
  reply(ws, rid, { t: 'chat.cleared', peer: msg.peer });
}

function handleChatDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (typeof msg.peer !== 'string') return bad(ws, rid, 'Bad request');
  q.clearChat.run(ws.username, msg.peer, msg.peer, ws.username);
  q.deleteChat.run(ws.username, msg.peer);
  reply(ws, rid, { t: 'chat.deleted', peer: msg.peer });
}

function handleMessageGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username && row.recipient !== ws.username) {
    return bad(ws, rid, 'Not your conversation');
  }
  reply(ws, rid, {
    t: 'message', message: {
      id: row.id, from: row.sender, to: row.recipient, ts: row.ts,
      box: row.box, nonce: row.nonce, kind: row.kind || null,
      attachment: row.attachment || null, deleted: !!row.deleted
    }
  });
}

function handleMessagesPinned(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const peer = msg.peer;
  if (typeof peer !== 'string') return bad(ws, rid, 'Bad request');
  const rows = q.pinnedIn.all(ws.username, peer, peer, ws.username);
  reply(ws, rid, {
    t: 'messages.pinned',
    items: rows.map((r) => ({
      id: r.id, from: r.sender, to: r.recipient, ts: r.ts,
      box: r.box, nonce: r.nonce, kind: r.kind || null, attachment: r.attachment || null
    }))
  });
}

function handleMessagePin(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username && row.recipient !== ws.username) {
    return bad(ws, rid, 'Not your conversation');
  }
  if (row.deleted) return bad(ws, rid, 'Message was deleted');

  const pin = msg.pinned === undefined ? !row.pinned : !!msg.pinned;
  q.setPinned.run(pin ? 1 : 0, row.id);
  const peer = row.sender === ws.username ? row.recipient : row.sender;

  reply(ws, rid, { t: 'message.pinned', id: row.id, pinned: pin, peer });
  // Both sides see the pinned banner, so notify the counterpart too.
  if (peer !== ws.username) {
    deliverToUser(peer, { t: 'pinned', id: row.id, pinned: pin, peer: ws.username });
  }
}

function handleMessagesSearch(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const query = cleanText(msg.query, 120);
  if (!query) return bad(ws, rid, 'Empty query');
  const limit = Math.min(Math.max(Number(msg.limit) || 50, 1), 200);
  const peer = typeof msg.peer === 'string' ? msg.peer : null;

  // The relay cannot read message text, so it can only match metadata it holds:
  // the peer and the attachment file name. The client filters decrypted text.
  const rows = q.searchMessages.all(
    ws.username, ws.username, `%${query}%`, `%${query}%`, `%${query}%`, limit
  );
  reply(ws, rid, {
    t: 'messages.search',
    items: rows
      .filter((r) => !peer || r.sender === peer || r.recipient === peer)
      .map((r) => ({
        id: r.id, from: r.sender, to: r.recipient, ts: r.ts,
        replyTo: r.reply_to, editedAt: r.edited_at,
        kind: r.kind || null, attachment: r.attachment || null
      }))
  });
}

/**
 * Global search: hand the client the newest slice of every conversation it can
 * already open, and let it filter the decrypted text on the device. The relay
 * never learns the query, so it cannot narrow the scan — it just caps how much
 * history is sent. Per-chat search (`messages.search`) stays for the old flow.
 */
function handleSearchGlobal(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const limit = Math.min(Math.max(Number(msg.limit) || 300, 1), 500);

  const direct = q.recentMessages.all(ws.username, ws.username, ws.username, limit).map((r) => {
    const peer = r.sender === ws.username ? r.recipient : r.sender;
    return {
      id: r.id, from: r.sender, ts: r.ts, peer,
      box: r.box, nonce: r.nonce,
      replyTo: r.reply_to, editedAt: r.edited_at,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });

  const groups = q.recentGroupMessages.all(ws.username, limit).map((r) => {
    let envelope = null;
    try { envelope = (JSON.parse(r.envelope) || {})[ws.username] || null; } catch { envelope = null; }
    return {
      id: r.id, groupId: r.group_id, from: r.sender, ts: r.ts, envelope,
      replyTo: r.reply_to, editedAt: r.edited_at,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });

  const channels = q.recentChannelMessages.all(ws.username, limit).map((r) => {
    let envelope = null;
    try { envelope = (JSON.parse(r.envelope) || {})[ws.username] || null; } catch { envelope = null; }
    return {
      id: r.id, channelId: r.channel_id, from: r.sender, ts: r.ts, envelope,
      replyTo: r.reply_to, editedAt: r.edited_at,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });

  reply(ws, rid, { t: 'search.global', direct, groups, channels });
}

function handleSettingsGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getUserSettings.get(ws.username);
  let settings = {};
  if (row) { try { settings = JSON.parse(row.settings) || {}; } catch { settings = {}; } }
  reply(ws, rid, { t: 'settings', settings });
}

function handleSettingsSet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const incoming = msg.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return bad(ws, rid, 'Malformed settings');
  }
  const row = q.getUserSettings.get(ws.username);
  let current = {};
  if (row) { try { current = JSON.parse(row.settings) || {}; } catch { current = {}; } }
  // Shallow merge so a partial update never wipes unrelated keys.
  const merged = { ...current, ...incoming };
  const json = JSON.stringify(merged);
  if (json.length > 20000) return bad(ws, rid, 'Settings too large');
  q.setUserSettings.run(ws.username, json, Date.now());
  reply(ws, rid, { t: 'settings', settings: merged });
}

/* -------------------------------- groups -------------------------------- */
const MAX_GROUP_MEMBERS = 200;

function groupView(groupId, viewer) {
  const group = q.getGroup.get(groupId);
  if (!group) return null;
  const members = q.membersOf.all(groupId).map((m) => ({
    username: m.username,
    profile: publicProfile(q.getUser.get(m.username), viewer),
    online: isOnline(m.username)
  }));
  return { id: group.id, name: group.name, owner: group.owner, members };
}

/** Send a payload to every member of a group except an optional sender. */
function deliverToGroup(groupId, payload, exceptUser) {
  for (const m of q.membersOf.all(groupId)) {
    if (m.username !== exceptUser) deliverToUser(m.username, payload);
  }
}

/**
 * Send a group view to each member built for that member, so profile privacy
 * inside the member list is enforced per viewer rather than once for everyone.
 */
function deliverGroupView(groupId, type, exceptUser, extra) {
  for (const m of q.membersOf.all(groupId)) {
    if (m.username === exceptUser) continue;
    deliverToUser(m.username, { t: type, ...(extra || {}), group: groupView(groupId, m.username) });
  }
}

function handleGroupCreate(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const name = cleanText(msg.name, 64);
  if (!name) return bad(ws, rid, 'Group needs a name');
  const raw = Array.isArray(msg.members) ? msg.members : [];
  const members = new Set([ws.username]);
  for (const u of raw.slice(0, MAX_GROUP_MEMBERS)) {
    if (typeof u === 'string' && q.getUser.get(u)) members.add(u);
  }

  const now = Date.now();
  const info = q.insertGroup.run(name, ws.username, now);
  const groupId = Number(info.lastInsertRowid);
  for (const u of members) q.addMember.run(groupId, u, now);

  reply(ws, rid, { t: 'group.created', group: groupView(groupId, ws.username) });
  // Everyone else learns about the new group, each with a view built for them.
  deliverGroupView(groupId, 'group.joined', ws.username);
}

function handleGroupList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const items = q.groupsFor.all(ws.username).map((r) => groupView(r.group_id, ws.username)).filter(Boolean);
  reply(ws, rid, { t: 'groups', items });
}

function handleGroupAdd(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  const group = q.getGroup.get(groupId);
  if (!group) return bad(ws, rid, 'No such group');
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  const target = msg.username;
  if (typeof target !== 'string' || !q.getUser.get(target)) return bad(ws, rid, 'No such user');
  if (q.isMember.get(groupId, target)) return bad(ws, rid, 'Already a member');

  q.addMember.run(groupId, target, Date.now());
  reply(ws, rid, { t: 'group.added', group: groupView(groupId, ws.username) });
  deliverGroupView(groupId, 'group.joined');
}

function handleGroupLeave(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  const group = q.getGroup.get(groupId);
  if (!group) return bad(ws, rid, 'No such group');
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');

  q.removeMember.run(groupId, ws.username);
  reply(ws, rid, { t: 'group.left', groupId });
  deliverGroupView(groupId, 'group.memberLeft', null, { groupId, username: ws.username });
}

function handleGroupMembers(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  reply(ws, rid, { t: 'group.members', group: groupView(groupId, ws.username) });
}

/**
 * Send to a group. The client sends one encrypted copy per member in
 * `envelopes: { username: {box, nonce} }`; the relay stores the map and hands
 * each member only their own copy. It never sees plaintext.
 */
function handleGroupSend(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const parsed = parseGroupAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);

  const envelopes = {};
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (box && (!validB64(box, 100000) || !validB64(nonce, 100))) continue;
    envelopes[user] = { box, nonce };
  }
  if (Object.keys(envelopes).length === 0) return bad(ws, rid, 'No valid envelopes');

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const info = q.insertGroupMessage.run(
    groupId, ws.username, JSON.stringify(envelopes), ts, replyTo, parsed.kind, parsed.attachment
  );
  const id = Number(info.lastInsertRowid);
  touchStreak(ws.username);

  reply(ws, rid, { t: 'group.sent', id, groupId, ts, replyTo, kind: parsed.kind, attachment: parsed.attachment });
  for (const [user, env] of Object.entries(envelopes)) {
    // The sender already rendered its own copy; a socket echo would duplicate it.
    if (user === ws.username) continue;
    deliverToUser(user, {
      t: 'group.message', id, groupId, from: ws.username, box: env.box, nonce: env.nonce,
      ts, replyTo, kind: parsed.kind, attachment: parsed.attachment
    });
  }
}

function handleGroupHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const groupId = Number(msg.groupId);
  if (!q.isMember.get(groupId, ws.username)) return bad(ws, rid, 'Not a member');
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  const rows = q.groupHistory.all(groupId, limit).reverse();
  const items = rows.map((r) => {
    let envelopes = {};
    try { envelopes = JSON.parse(r.envelope) || {}; } catch { envelopes = {}; }
    return {
      id: r.id, groupId: r.group_id, from: r.sender, ts: r.ts,
      envelope: envelopes[ws.username] || null,
      replyTo: r.reply_to, editedAt: r.edited_at, deleted: !!r.deleted,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });
  reply(ws, rid, { t: 'group.history', groupId, items });
}

function handleGroupEdit(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getGroupMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');
  if (!q.isMember.get(row.group_id, ws.username)) return bad(ws, rid, 'Not a member');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const editedAt = Date.now();
  q.editGroupMessage.run(JSON.stringify(msg.envelopes), editedAt, row.id);
  reply(ws, rid, { t: 'group.edited', id: row.id, editedAt });
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (user === ws.username) continue;
    deliverToUser(user, { t: 'group.edited', id: row.id, groupId: row.group_id, from: row.sender, box: env.box, nonce: env.nonce, editedAt });
  }
}

function handleGroupDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getGroupMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (row.sender !== ws.username) return bad(ws, rid, 'Not your message');
  q.deleteGroupMessage.run(row.id);
  reply(ws, rid, { t: 'group.deleted', id: row.id });
  deliverToGroup(row.group_id, { t: 'group.deleted', id: row.id, groupId: row.group_id, from: row.sender }, ws.username);
}

function handleGroupMessageGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getGroupMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (!q.isMember.get(row.group_id, ws.username)) return bad(ws, rid, 'Not a member');
  let envelopes = {};
  try { envelopes = JSON.parse(row.envelope) || {}; } catch { envelopes = {}; }
  reply(ws, rid, {
    t: 'group.message', message: {
      id: row.id, groupId: row.group_id, from: row.sender, ts: row.ts,
      envelope: envelopes[ws.username] || null, attachment: row.attachment || null,
      kind: row.kind || null, deleted: !!row.deleted
    }
  });
}

/* ------------------------------- channels ------------------------------- */
// A channel is one-to-many. Only the owner posts; subscribers read. Posts are
// stored exactly like group messages (a ciphertext copy per subscriber), so the
// relay never holds plaintext and the delivery path is the same.

function channelView(channelId, viewer) {
  const ch = q.getChannel.get(channelId);
  if (!ch) return null;
  const owner = q.getUser.get(ch.owner);
  const isOwner = viewer === ch.owner;
  return {
    id: ch.id,
    name: ch.name,
    handle: ch.handle || null,
    description: ch.description || '',
    owner: ch.owner,
    ownerProfile: owner ? publicProfile(owner, viewer) : null,
    verified: !!ch.verified,
    subs: q.countSubs.get(ch.id).c,
    subscribed: viewer ? !!q.isSub.get(ch.id, viewer) : false,
    isOwner,
    // The owner needs every subscriber's name to encrypt one copy per reader.
    subscribers: isOwner ? q.subsOf.all(ch.id).map((s) => s.username) : undefined
  };
}

/** Send a payload to every subscriber of a channel except an optional user. */
function deliverToChannel(channelId, payload, exceptUser) {
  for (const s of q.subsOf.all(channelId)) {
    if (s.username !== exceptUser) deliverToUser(s.username, payload);
  }
}

/**
 * Tell everyone about a membership change. Each subscriber gets a view built
 * for them, so the owner receives the fresh list of names to encrypt against.
 */
function broadcastChannelUpdate(channelId, exceptUser) {
  for (const s of q.subsOf.all(channelId)) {
    if (s.username === exceptUser) continue;
    const view = channelView(channelId, s.username);
    if (view) deliverToUser(s.username, { t: 'channel.updated', channel: view });
  }
}

function handleChannelCreate(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const name = cleanText(msg.name, 64);
  if (!name) return bad(ws, rid, 'Channel needs a name');
  const description = cleanText(msg.description, 200) || null;

  // The handle is how a channel is shared and found. Use the one asked for, or
  // derive one from the name; if neither works, pick the next free `channel_N`.
  const asked = cleanHandle(msg.handle);
  if (asked && asked.error) return bad(ws, rid, asked.error);
  let handle = asked ? asked.value : slugHandle(name);
  if (handle && q.getChannelByHandle.get(handle)) {
    if (asked) return bad(ws, rid, 'That handle is already taken');
    handle = null;
  }
  if (!handle) {
    for (let i = 1; i < 1000 && !handle; i += 1) {
      const candidate = `channel_${i}`;
      if (!q.getChannelByHandle.get(candidate)) handle = candidate;
    }
  }

  const info = q.insertChannel.run(name, ws.username, description, handle, Date.now());
  const channelId = Number(info.lastInsertRowid);
  // The creator is the first subscriber, so the channel appears in their list.
  q.addSub.run(channelId, ws.username, Date.now());

  reply(ws, rid, { t: 'channel.created', channel: channelView(channelId, ws.username) });
}

function handleChannelList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const ids = new Set([
    ...q.channelsFor.all(ws.username).map((r) => r.channel_id),
    ...q.channelsOwned.all(ws.username).map((r) => r.id)
  ]);
  const items = [...ids].map((id) => channelView(id, ws.username)).filter(Boolean);
  reply(ws, rid, { t: 'channels', items });
}

function handleChannelDiscover(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const items = q.allChannels.all().map((c) => channelView(c.id, ws.username)).filter(Boolean);
  reply(ws, rid, { t: 'channels.discover', items });
}

/**
 * Resolve a channel from a request that may carry either a numeric id or a
 * `@handle` (the client sends `handle` when the user typed `@name`).
 */
function resolveChannel(msg) {
  if (msg.handle) return q.getChannelByHandle.get(normalizeUsername(msg.handle)) || null;
  return q.getChannel.get(Number(msg.channelId)) || null;
}

function handleChannelInfo(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const ch = resolveChannel(msg);
  if (!ch) return bad(ws, rid, 'No such channel');
  reply(ws, rid, { t: 'channel.info', channel: channelView(ch.id, ws.username) });
}

function handleChannelJoin(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const ch = resolveChannel(msg);
  if (!ch) return bad(ws, rid, 'No such channel');
  const channelId = ch.id;
  q.addSub.run(channelId, ws.username, Date.now());
  // Notify the rest of the channel so the owner picks up the new subscriber.
  broadcastChannelUpdate(channelId, ws.username);
  reply(ws, rid, { t: 'channel.joined', channel: channelView(channelId, ws.username) });
}

function handleChannelLeave(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner === ws.username) return bad(ws, rid, 'The owner cannot leave the channel');
  q.removeSub.run(channelId, ws.username);
  // Keep the owner's subscriber list current so posts stop going to the leaver.
  broadcastChannelUpdate(channelId);
  reply(ws, rid, { t: 'channel.left', channelId });
}

function handleChannelEdit(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can edit the channel');
  const name = cleanText(msg.name, 64) || ch.name;
  const description = msg.description === undefined ? ch.description : (cleanText(msg.description, 200) || null);
  // The handle is optional on edit; when sent it must be free and valid.
  let handle = ch.handle;
  if (msg.handle !== undefined) {
    const asked = cleanHandle(msg.handle);
    if (asked && asked.error) return bad(ws, rid, asked.error);
    if (asked.value !== ch.handle && q.getChannelByHandle.get(asked.value)) {
      return bad(ws, rid, 'That handle is already taken');
    }
    handle = asked.value;
  }
  q.renameChannel.run(name, description, handle, channelId);
  const view = channelView(channelId, ws.username);
  reply(ws, rid, { t: 'channel.edited', channel: view });
  broadcastChannelUpdate(channelId, ws.username);
}

function handleChannelDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can delete the channel');
  deliverToChannel(channelId, { t: 'channel.deleted', channelId });
  try {
    db.exec('BEGIN');
    q.deleteChannelPosts.run(channelId);
    q.deleteChannelSubs.run(channelId);
    q.deleteChannel.run(channelId);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    return bad(ws, rid, 'Could not delete the channel');
  }
  reply(ws, rid, { t: 'channel.deleted', channelId });
}

/**
 * Publish to a channel. The owner sends one encrypted copy per subscriber in
 * `envelopes: { username: {box, nonce} }`; the relay stores the map and hands
 * each subscriber only their own copy.
 */
function handleChannelPost(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  const ch = q.getChannel.get(channelId);
  if (!ch) return bad(ws, rid, 'No such channel');
  if (ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can post');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const parsed = parseGroupAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);

  const envelopes = {};
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (box && (!validB64(box, 100000) || !validB64(nonce, 100))) continue;
    envelopes[user] = { box, nonce };
  }
  if (Object.keys(envelopes).length === 0) return bad(ws, rid, 'No valid envelopes');

  const replyTo = Number.isInteger(msg.replyTo) ? msg.replyTo : null;
  const ts = Date.now();
  const info = q.insertChannelMessage.run(
    channelId, ws.username, JSON.stringify(envelopes), ts, replyTo, parsed.kind, parsed.attachment
  );
  const id = Number(info.lastInsertRowid);
  touchStreak(ws.username);

  reply(ws, rid, { t: 'channel.posted', id, channelId, ts, replyTo, kind: parsed.kind, attachment: parsed.attachment });
  for (const [user, env] of Object.entries(envelopes)) {
    if (user === ws.username) continue;
    deliverToUser(user, {
      t: 'channel.message', id, channelId, from: ws.username, box: env.box, nonce: env.nonce,
      ts, replyTo, kind: parsed.kind, attachment: parsed.attachment
    });
  }
}

function handleChannelHistory(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const channelId = Number(msg.channelId);
  if (!q.isSub.get(channelId, ws.username)) return bad(ws, rid, 'Not subscribed');
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  const rows = q.channelHistory.all(channelId, limit).reverse();
  const items = rows.map((r) => {
    let envelopes = {};
    try { envelopes = JSON.parse(r.envelope) || {}; } catch { envelopes = {}; }
    return {
      id: r.id, channelId: r.channel_id, from: r.sender, ts: r.ts,
      envelope: envelopes[ws.username] || null,
      replyTo: r.reply_to, editedAt: r.edited_at, deleted: !!r.deleted,
      kind: r.kind || null, attachment: r.attachment || null
    };
  });
  reply(ws, rid, { t: 'channel.history', channelId, items });
}

function handleChannelEditMessage(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getChannelMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  const ch = q.getChannel.get(row.channel_id);
  if (!ch || ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can edit a post');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const editedAt = Date.now();
  q.editChannelMessage.run(JSON.stringify(msg.envelopes), editedAt, row.id);
  reply(ws, rid, { t: 'channel.edited', id: row.id, editedAt });
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (user === ws.username) continue;
    deliverToUser(user, { t: 'channel.edited', id: row.id, channelId: row.channel_id, from: row.sender, box: env.box, nonce: env.nonce, editedAt });
  }
}

function handleChannelDeleteMessage(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getChannelMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  const ch = q.getChannel.get(row.channel_id);
  if (!ch || ch.owner !== ws.username) return bad(ws, rid, 'Only the owner can delete a post');
  q.deleteChannelMessage.run(row.id);
  reply(ws, rid, { t: 'channel.deletedMessage', id: row.id });
  deliverToChannel(row.channel_id, { t: 'channel.deletedMessage', id: row.id, channelId: row.channel_id, from: row.sender }, ws.username);
}

function handleChannelMessageGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getChannelMessage.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such message');
  if (!q.isSub.get(row.channel_id, ws.username)) return bad(ws, rid, 'Not subscribed');
  let envelopes = {};
  try { envelopes = JSON.parse(row.envelope) || {}; } catch { envelopes = {}; }
  reply(ws, rid, {
    t: 'channel.message', message: {
      id: row.id, channelId: row.channel_id, from: row.sender, ts: row.ts,
      envelope: envelopes[ws.username] || null, attachment: row.attachment || null,
      kind: row.kind || null, deleted: !!row.deleted
    }
  });
}

/* ------------------------------- stories ------------------------------- */
// A story is a 24-hour post. Like a group message, the body is one encrypted
// copy per viewer (`envelopes: { viewer: {box, nonce} }`), so the relay stores
// ciphertext and the audience list, and never learns the caption or picture.
// Expiry is a wall-clock timestamp: a story simply stops being returned once it
// passes, and a lazy sweep drops the rows and their views.

const MAX_STORY_VIEWERS = 500;
const MAX_STORY_TTL_MS = 24 * 3600000;

/** The people who may see an author's story: their contacts plus their peers. */
function storyAudienceFor(author, requested) {
  const audience = audienceOf(author);
  for (const u of Array.isArray(requested) ? requested.slice(0, MAX_STORY_VIEWERS) : []) {
    if (typeof u === 'string' && q.getUser.get(u)) audience.add(u);
  }
  audience.add(author); // the author can always reopen their own story
  return [...audience];
}

/** Drop stories whose 24 hours are up, together with their views and audience. */
function sweepExpiredStories() {
  const now = Date.now();
  for (const row of q.expiredStories.all(now)) {
    q.deleteStoryViews.run(row.id);
    q.deleteStoryAudience.run(row.id);
    q.deleteStory.run(row.id);
  }
}

/** Whether one viewer has already opened a story. */
function storySeenBy(storyId, viewer) {
  return q.storyViewers.all(storyId).some((v) => v.viewer === viewer);
}

/** A story row as the viewer sees it, with only their own envelope attached. */
function storyView(row, viewer) {
  let envelopes = {};
  try { envelopes = JSON.parse(row.envelope) || {}; } catch { envelopes = {}; }
  return {
    id: row.id, author: row.author, ts: row.ts, expiresAt: row.expires_at,
    kind: row.kind || null, attachment: row.attachment || null,
    envelope: envelopes[viewer] || null,
    seen: storySeenBy(row.id, viewer),
    views: q.countStoryViews.get(row.id).c
  };
}

function handleStoryPost(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  if (!msg.envelopes || typeof msg.envelopes !== 'object') return bad(ws, rid, 'Malformed envelopes');

  const parsed = parseGroupAttachment(msg.attachment);
  if (parsed.error) return bad(ws, rid, parsed.error);

  const audience = storyAudienceFor(ws.username, msg.audience);
  const envelopes = {};
  for (const [user, env] of Object.entries(msg.envelopes)) {
    if (typeof user !== 'string') continue;
    const box = env && typeof env.box === 'string' ? env.box : '';
    const nonce = env && typeof env.nonce === 'string' ? env.nonce : '';
    if (!box || !validB64(box, 100000) || !validB64(nonce, 100)) continue;
    envelopes[user] = { box, nonce };
  }
  if (Object.keys(envelopes).length === 0) return bad(ws, rid, 'No valid envelopes');

  const now = Date.now();
  const ttl = Math.min(MAX_STORY_TTL_MS, Math.max(60000, Number(msg.ttl) || MAX_STORY_TTL_MS));
  const expiresAt = now + ttl;
  const info = q.insertStory.run(
    ws.username, JSON.stringify(envelopes), now, expiresAt, parsed.kind, parsed.attachment
  );
  const id = Number(info.lastInsertRowid);
  for (const viewer of audience) q.addStoryViewer.run(id, viewer);

  sweepExpiredStories();
  reply(ws, rid, { t: 'story.posted', id, ts: now, expiresAt });

  // Everyone in the audience hears about it, but only a viewer with an envelope
  // can actually open it; the rest just see the ring.
  for (const viewer of audience) {
    if (viewer === ws.username) continue;
    deliverToUser(viewer, {
      t: 'story.new', id, author: ws.username, ts: now, expiresAt,
      kind: parsed.kind, attachment: parsed.attachment
    });
  }
}

function handleStoryList(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  sweepExpiredStories();
  const rows = q.storiesForViewer.all(ws.username, Date.now());
  reply(ws, rid, { t: 'stories', items: rows.map((r) => storyView(r, ws.username)) });
}

/**
 * Who a new story would reach: the author's saved contacts plus everyone they
 * have a conversation with. The list is built from the relay's own view (peer
 * rows and the account's `contacts` setting), so it never depends on the client
 * remembering it.
 */
function handleStoryAudience(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const contacts = [];
  const raw = q.getUserSettings.get(ws.username);
  if (raw && raw.settings) {
    try {
      const s = JSON.parse(raw.settings);
      if (s && Array.isArray(s.contacts)) {
        for (const u of s.contacts.slice(0, MAX_STORY_VIEWERS)) {
          if (typeof u === 'string' && q.getUser.get(u) && u !== ws.username) contacts.push(u);
        }
      }
    } catch { /* a malformed settings blob just means no extra contacts */ }
  }
  const items = storyAudienceFor(ws.username, contacts).filter((u) => u !== ws.username);
  reply(ws, rid, { t: 'story.audience', items });
}

function handleStoryGet(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getStory.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such story');
  if (!q.isStoryViewer.get(row.id, ws.username)) return bad(ws, rid, 'Not in the audience');
  if (row.expires_at <= Date.now()) return bad(ws, rid, 'This story has expired');
  reply(ws, rid, { t: 'story', story: storyView(row, ws.username) });
}

function handleStoryViewed(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getStory.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such story');
  if (!q.isStoryViewer.get(row.id, ws.username)) return bad(ws, rid, 'Not in the audience');
  q.insertStoryView.run(row.id, ws.username, Date.now());
  const count = q.countStoryViews.get(row.id).c;
  reply(ws, rid, { t: 'story.viewed', id: row.id, views: count });
  // The author learns only how many opened it; the list of who is a separate,
  // author-only request.
  if (row.author !== ws.username) deliverToUser(row.author, { t: 'story.views', id: row.id, count });
}

function handleStoryViewers(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getStory.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such story');
  if (row.author !== ws.username) return bad(ws, rid, 'Not your story');
  const viewers = q.storyViewers.all(row.id).map((v) => ({
    username: v.viewer, ts: v.ts, profile: publicProfile(q.getUser.get(v.viewer), ws.username)
  }));
  reply(ws, rid, { t: 'story.viewers', id: row.id, viewers });
}

function handleStoryDelete(ws, msg, rid) {
  if (!ws.username) return bad(ws, rid, 'Not authenticated');
  const row = q.getStory.get(Number(msg.id));
  if (!row) return bad(ws, rid, 'No such story');
  if (row.author !== ws.username) return bad(ws, rid, 'Not your story');
  const viewers = q.storyViewers.all(row.id).map((v) => v.viewer);
  q.deleteStoryViews.run(row.id);
  q.deleteStoryAudience.run(row.id);
  q.deleteStory.run(row.id);
  reply(ws, rid, { t: 'story.deleted', id: row.id });
  for (const viewer of viewers) {
    if (viewer !== ws.username) deliverToUser(viewer, { t: 'story.deleted', id: row.id, author: ws.username });
  }
}

/* -------------------------------- admin -------------------------------- */
// Every admin operation is gated on requireAdmin. The relay still cannot read
// messages, so an admin can moderate accounts but never message contents.

function handleAdminOverview(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  reply(ws, rid, {
    t: 'admin.overview',
    stats: {
      users: q.countUsers.get().c,
      online: sockets.size,
      messages: q.countMessages.get().c,
      groups: q.countGroups.get().c,
      channels: q.countChannels.get().c,
      banned: q.countBanned.get().c,
      verified: q.countVerified.get().c,
      admins: q.countAdmins.get().c,
      announcements: q.countAnnouncements.get().c,
      sessions: q.countSessions.get().c,
      flames: q.countDialogStreaks.get().c,
      stories: q.countStories.get().c
    },
    isAdmin: true,
    announcements: q.recentAnnouncements.all().map((a) => ({
      id: a.id, sender: a.sender, text: a.text, ts: a.ts
    })),
    log: q.recentAdminLog.all().map((r) => ({
      id: r.id, actor: r.actor, action: r.action, target: r.target,
      detail: r.detail || '', ts: r.ts
    }))
  });
}

function handleAdminUsers(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  const rows = q.adminListUsers.all();
  reply(ws, rid, {
    t: 'admin.users',
    items: rows.map((r) => ({
      username: r.username,
      displayName: r.display_name || r.username,
      bio: r.bio || '',
      avatarColor: r.avatar_color || 'mint',
      avatarImage: r.avatar_image || null,
      createdAt: r.created_at,
      lastSeen: r.last_seen || null,
      sent: r.sent,
      received: r.received,
      groups: r.groups,
      subs: r.subs,
      hasPassword: !!r.has_password,
      hasPhone: !!r.phone,
      profileHidden: !!r.profile_hidden,
      lastSeenHidden: !!r.last_seen_hidden,
      admin: !!r.is_admin || ADMINS.has(r.username),
      adminByConfig: ADMINS.has(r.username),
      verified: !!r.verified,
      badgeImage: r.badge_image || null,
      nicknames: parseNicknames(r.nicknames),
      banned: !!r.banned,
      online: isOnline(r.username),
      rockets: r.rockets || 0,
      premiumUntil: r.premium_until || null,
      premium: premiumUntil(r) > 0
    }))
  });
}

function handleAdminChannels(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  const items = q.allChannels.all().map((c) => ({
    id: c.id,
    name: c.name,
    handle: c.handle || null,
    description: c.description || '',
    owner: c.owner,
    verified: !!c.verified,
    subs: q.countSubs.get(c.id).c,
    posts: q.countChannelPosts.get(c.id).c,
    createdAt: c.created_at
  }));
  reply(ws, rid, { t: 'admin.channels', items });
}

/** Record one administrative action so the panel can show a history. */
function logAdmin(actor, action, target, detail) {
  try { q.insertAdminLog.run(actor, action, target || null, detail || null, Date.now()); }
  catch { /* the log is best-effort: it must never fail the action itself */ }
}

function handleAdminAction(ws, msg, rid) {
  if (!requireAdmin(ws, rid)) return;
  const actor = ws.username;

  // Announcements are the one action that targets nobody, so handle them first.
  if (msg.action === 'announce') {
    const text = cleanText(msg.text, 300);
    if (!text) return bad(ws, rid, 'Announcement text is required');
    q.insertAnnouncement.run(actor, text, Date.now());
    broadcastAll({ t: 'announcement', from: actor, text, ts: Date.now() });
    logAdmin(actor, 'announce', null, text);
    return reply(ws, rid, { t: 'admin.ok', action: 'announce' });
  }

  // Channel moderation targets a channel id, not a username.
  if (msg.action === 'channelVerify' || msg.action === 'channelDelete' ||
      msg.action === 'channelUnverifyAll') {
    if (msg.action === 'channelUnverifyAll') {
      const n = q.clearChannelVerified.run();
      for (const c of q.allChannels.all()) broadcastChannelUpdate(c.id);
      logAdmin(actor, 'channelUnverifyAll', null, `${n.changes || 0}`);
      return reply(ws, rid, { t: 'admin.ok', action: 'channelUnverifyAll' });
    }
    const channelId = Number(msg.channelId);
    const ch = q.getChannel.get(channelId);
    if (!ch) return bad(ws, rid, 'No such channel');
    if (msg.action === 'channelVerify') {
      q.setChannelVerified.run(ch.verified ? 0 : 1, channelId);
      const view = channelView(channelId, actor);
      broadcastChannelUpdate(channelId);
      logAdmin(actor, 'channelVerify', null, `${ch.name} -> ${ch.verified ? 0 : 1}`);
      return reply(ws, rid, { t: 'admin.ok', action: 'channelVerify', channelId, channel: view });
    }
    deliverToChannel(channelId, { t: 'channel.deleted', channelId });
    try {
      db.exec('BEGIN');
      q.deleteChannelPosts.run(channelId);
      q.deleteChannelSubs.run(channelId);
      q.deleteChannel.run(channelId);
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      return bad(ws, rid, 'Could not delete the channel');
    }
    logAdmin(actor, 'channelDelete', null, ch.name);
    return reply(ws, rid, { t: 'admin.ok', action: 'channelDelete', channelId });
  }

  const target = typeof msg.username === 'string' ? msg.username : '';
  const user = q.getUser.get(target);
  if (!user) return bad(ws, rid, 'No such user');
  const now = Date.now();

  switch (msg.action) {
    case 'verify':
      q.setVerified.run(user.verified ? 0 : 1, now, target);
      break;
    case 'badge': {
      // An admin-supplied picture replaces the checkmark. `null` clears it, and
      // setting a picture also marks the account verified, since the badge is
      // what a verified account is meant to show.
      const parsed = cleanBadgeImage(msg.image === undefined ? null : msg.image);
      if (parsed.error) return bad(ws, rid, parsed.error);
      q.setBadgeImage.run(parsed.value, now, target);
      if (parsed.value && !user.verified) q.setVerified.run(1, now, target);
      break;
    }
    case 'grantAdmin':
      // Refuse self-demotion: it would hide the panel mid-click and, for the
      // last admin, lock everyone out of the panel entirely.
      if (target === actor && user.is_admin && !ADMINS.has(target)) {
        return bad(ws, rid, 'You cannot remove your own admin rights');
      }
      q.setAdmin.run(user.is_admin ? 0 : 1, now, target);
      break;
    case 'nicknameAdd':
    case 'nicknameRemove':
    case 'nicknameSet': {
      // Editing someone's nicknames is an administrator tool, so it is gated on
      // requireAdmin above. `nicknameSet` replaces one entry by index; the other
      // two add or drop an entry.
      const current = parseNicknames(user.nicknames);
      let next = current;
      if (msg.action === 'nicknameAdd') {
        const parsed = cleanNickname(msg.nickname);
        if (parsed.error) return bad(ws, rid, parsed.error);
        next = [...current, parsed.value];
      } else if (msg.action === 'nicknameRemove') {
        const idx = Number(msg.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
          return bad(ws, rid, 'No such nickname');
        }
        next = current.filter((_, i) => i !== idx);
      } else {
        const idx = Number(msg.index);
        const parsed = cleanNickname(msg.nickname);
        if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
          return bad(ws, rid, 'No such nickname');
        }
        if (parsed.error) return bad(ws, rid, parsed.error);
        next = current.map((n, i) => (i === idx ? parsed.value : n));
      }
      // The list is validated for the *target*, so an admin cannot hand a normal
      // account an unbounded list; the owner keeps the unbounded privilege. A
      // name another account already holds is refused, so a claim stays unique.
      const validated = cleanNicknamesWithClaims(next, target);
      if (validated.error) return bad(ws, rid, validated.error);
      q.setNicknames.run(validated.value, now, target);
      q.setNicknameClaims.run(validated.claims, now, target);
      break;
    }
    case 'grantRockets':
    case 'grantPremium': {
      // Premium and Rockets are settled through the same code path the panel
      // uses, so an admin grant and a real purchase cannot drift apart.
      const months = Math.trunc(Number(msg.months || 0));
      const amount = Math.trunc(Number(msg.amount || 0));
      if (msg.action === 'grantPremium') {
        if (!Number.isFinite(months) || months === 0) return bad(ws, rid, 'Укажите месяцы Premium');
        const until = MONEY.extendPremium(premiumUntil(user), now, months, PREMIUM_MONTH_MS);
        q.setPremiumUntil.run(Math.max(until, 0), now, target);
        logAdmin(actor, 'grantPremium', target, `${months} months`);
      } else {
        if (!Number.isFinite(amount) || amount === 0) return bad(ws, rid, 'Укажите число ракет');
        moveRockets(target, amount, 'admin', actor);
        logAdmin(actor, 'grant', target, `${amount} rockets`);
      }
      deliverToUser(target, walletState(target));
      return reply(ws, rid, {
        t: 'admin.ok',
        action: msg.action,
        username: target,
        wallet: walletState(target),
        premium: premiumState(q.getUser.get(target))
      });
    }
    case 'ban':
      if (target === actor) return bad(ws, rid, 'You cannot block your own account');
      q.setBanned.run(user.banned ? 0 : 1, now, target);
      if (!user.banned) kickUser(target, 'You were blocked by an administrator');
      break;
    case 'forceLogout':
      // Drop every device of the account without blocking it, so the owner can
      // simply sign in again. Useful after a suspected key theft.
      if (target === actor) return bad(ws, rid, 'You cannot sign yourself out here');
      kickUser(target, 'Signed out by an administrator');
      break;
    case 'resetProfile':
      // Wipe the public-facing profile fields; the account, its keys and its
      // messages are untouched. A moderation tool for an abusive profile.
      q.resetProfile.run(now, target);
      break;
    case 'clearMessages':
      // Delete the relay's copies of every message this account sent or
      // received. The relay only ever held ciphertext, so nothing readable is
      // lost; both sides simply stop seeing the history.
      q.deleteUserMessages.run(target, target);
      break;
    case 'delete':
      if (target === actor) return bad(ws, rid, 'You cannot delete your own account');
      if (ADMINS.has(target)) return bad(ws, rid, 'That account is protected');
      deleteUserData(target);
      logAdmin(actor, 'delete', target, user.display_name || target);
      return reply(ws, rid, { t: 'admin.ok', action: 'delete', username: target });
    default:
      return bad(ws, rid, 'Unknown admin action');
  }

  const updated = q.getUser.get(target);
  if (updated) {
    const profile = publicProfile(updated);
    broadcastProfile(target, profile);
    deliverToUser(target, { t: 'profile', username: target, profile });
  }
  logAdmin(actor, msg.action, target, user.display_name || target);
  reply(ws, rid, { t: 'admin.ok', action: msg.action, username: target });
}

/** Disconnect every socket of a user, with a reason the client can display. */
function kickUser(username, reason) {
  const set = sockets.get(username);
  if (!set) return;
  for (const client of [...set]) {
    send(client, { t: 'kicked', reason });
    client.username = null;
    try { client.close(); } catch { /* already closing */ }
  }
  sockets.delete(username);
}

/** Erase an account and every row that references it. */
function deleteUserData(username) {
  kickUser(username, 'This account was deleted by an administrator');
  try {
    db.exec('BEGIN');
    q.deleteUserMessages.run(username, username);
    q.deleteUserGroupMessages.run(username);
    q.deleteUserSubs.run(username);
    q.deleteUserReactions.run(username);
    q.deleteUserMemberships.run(username);
    q.deleteUserChats.run(username, username);
    q.deleteUserSettings.run(username);
    q.deleteUserSessions.run(username);
    q.deleteUserStreak.run(username);
    q.deleteUserDialogStreaks.run(username, username);
    q.deleteUserStories.run(username);
    q.deleteUserStoryViews.run(username);
    q.deleteUserStoryAudience.run(username);
    q.deleteUserWallet.run(username);
    q.deleteUserLedger.run(username);
    q.deleteUserPayments.run(username);
    q.deleteUser.run(username);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
  }
}

function broadcastAll(payload) {
  for (const ws of wss.clients) send(ws, payload);
}

const handlers = {
  register: handleRegister,
  login: handleLogin,
  resume: handleResume,
  'phone.request': handlePhoneRequest,
  'phone.verify': handlePhoneVerify,
  'password.set': handlePasswordSet,
  directory: handleDirectory,
  'profile.get': handleProfileGet,
  'nickname.check': handleNicknameCheck,
  'profile.set': handleProfileSet,
  'streak.get': handleStreakGet,
  'profile.username': handleUsernameSet,
  'users.search': handleUserSearch,
  send: handleSend,
  history: handleHistory,
  'scheduled.list': handleScheduledList,
  'scheduled.cancel': handleScheduledCancel,
  'scheduled.reschedule': handleScheduledReschedule,
  'scheduled.sendNow': handleScheduledSendNow,
  'message.edit': handleMessageEdit,
  'message.delete': handleMessageDelete,
  'message.get': handleMessageGet,
  'message.pin': handleMessagePin,
  'messages.pinned': handleMessagesPinned,
  'messages.search': handleMessagesSearch,
  'search.global': handleSearchGlobal,
  reaction: handleReaction,
  typing: handleTyping,
  'call.invite': handleCallInvite,
  'call.answer': handleCallAnswer,
  'call.signal': handleCallSignal,
  'call.decline': handleCallDecline,
  'call.hangup': handleCallHangup,
  'wallet.get': handleWalletGet,
  'pay.create': handlePayCreate,
  'pay.claim': handlePayClaim,
  'pay.cancel': handlePayCancel,
  'gift.send': handleGiftSend,
  'gift.premium': handleGiftPremium,
  'admin.grant': handleAdminGrant,
  'chats.list': handleChatsList,
  'chat.settings': handleChatSettings,
  'chat.ttl': handleChatTtl,
  'chat.read': handleChatRead,
  'chat.clear': handleChatClear,
  'chat.delete': handleChatDelete,
  'settings.get': handleSettingsGet,
  'settings.set': handleSettingsSet,
  'privacy.set': handlePrivacySet,
  'group.create': handleGroupCreate,
  'group.list': handleGroupList,
  'group.add': handleGroupAdd,
  'group.leave': handleGroupLeave,
  'group.members': handleGroupMembers,
  'group.send': handleGroupSend,
  'group.history': handleGroupHistory,
  'group.edit': handleGroupEdit,
  'group.delete': handleGroupDelete,
  'group.message.get': handleGroupMessageGet,
  'channel.create': handleChannelCreate,
  'channel.list': handleChannelList,
  'channel.discover': handleChannelDiscover,
  'channel.info': handleChannelInfo,
  'channel.join': handleChannelJoin,
  'channel.leave': handleChannelLeave,
  'channel.edit': handleChannelEdit,
  'channel.delete': handleChannelDelete,
  'channel.post': handleChannelPost,
  'channel.history': handleChannelHistory,
  'channel.message.edit': handleChannelEditMessage,
  'channel.message.delete': handleChannelDeleteMessage,
  'channel.message.get': handleChannelMessageGet,
  'story.post': handleStoryPost,
  'story.list': handleStoryList,
  'story.audience': handleStoryAudience,
  'story.get': handleStoryGet,
  'story.viewed': handleStoryViewed,
  'story.viewers': handleStoryViewers,
  'story.delete': handleStoryDelete,
  'admin.overview': handleAdminOverview,
  'admin.users': handleAdminUsers,
  'admin.channels': handleAdminChannels,
  'admin.action': handleAdminAction
};

/* -------------------------------- server -------------------------------- */
/** Answer an HTTP request with a small JSON body. */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * The relay's own payment page. This is the screen the app opens for a top-up
 * when no external provider is configured: it shows what is being bought and
 * its price, and offers "Оплатить" and "Отмена". Confirming posts to
 * /pay/confirm, which credits the wallet; cancelling (or simply leaving) posts
 * to /pay/cancel, which credits nothing. It is a plain page so it opens in the
 * system browser without any provider account.
 */
function payCheckoutPage(payment) {
  const id = String(payment.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const amount = MONEY.rubles(payment.amount_rub);
  const title = payment.kind === 'premium'
    ? 'SleePhy Premium, 1 месяц'
    : `SleePhy Rockets, ${Math.trunc(payment.rockets || 0)} ракет`;
  const safeTitle = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SleePhy — оплата</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1115;color:#e8eaf0;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  main{width:min(26rem,92vw);padding:2.25rem;border-radius:18px;background:#171a21;
       box-shadow:0 24px 70px rgba(0,0,0,0.5);text-align:center}
  .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:1.5rem}
  .logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#7b2ff7,#f107a3)}
  .brand b{font-size:1.05rem;letter-spacing:.3px}
  h1{margin:0 0 .35rem;font-size:1.2rem}
  .item{color:#9aa3b2;margin:0 0 1.25rem}
  .price{font-size:2rem;font-weight:700;margin:0 0 1.5rem}
  .price small{font-size:1rem;font-weight:400;color:#9aa3b2}
  button{width:100%;padding:.85rem 1rem;border:0;border-radius:12px;font-size:1rem;
         font-weight:600;cursor:pointer;transition:filter .15s}
  button:hover{filter:brightness(1.08)}
  .pay{background:linear-gradient(135deg,#7b2ff7,#f107a3);color:#fff;margin-bottom:.6rem}
  .cancel{background:#232833;color:#c9cfda}
  .done{display:none;padding:1rem 0}
  .done .mark{font-size:2.5rem}
  .done p{color:#9aa3b2;margin:.5rem 0 0}
  .note{margin-top:1.25rem;font-size:12.5px;color:#6f7787}
</style></head><body><main>
  <div class="brand"><span class="logo"></span><b>SleePhy</b></div>
  <div id="form">
    <h1>Оплата покупки</h1>
    <p class="item">${safeTitle}</p>
    <p class="price">${amount}&nbsp;₽</p>
    <button class="pay" id="btn-pay">Оплатить</button>
    <button class="cancel" id="btn-cancel">Отмена</button>
    <p class="note">Это демонстрационная страница оплаты SleePhy. Средства не списываются.</p>
  </div>
  <div class="done" id="done">
    <div class="mark" id="done-mark">✅</div>
    <h1 id="done-title">Готово</h1>
    <p id="done-text"></p>
  </div>
</main>
<script>
  var ID = ${JSON.stringify(id)};
  var settled = false;
  function show(mark, title, text) {
    document.getElementById('form').style.display = 'none';
    var d = document.getElementById('done');
    d.style.display = 'block';
    document.getElementById('done-mark').textContent = mark;
    document.getElementById('done-title').textContent = title;
    document.getElementById('done-text').textContent = text;
  }
  function post(path) {
    return fetch(path + '?id=' + encodeURIComponent(ID), { method: 'POST' })
      .then(function (r) { return r.json(); }).catch(function () { return {}; });
  }
  document.getElementById('btn-pay').addEventListener('click', function () {
    settled = true; // a decision was made: pagehide must not cancel it now
    post('/pay/confirm').then(function (r) {
      if (r && r.ok) show('✅', 'Оплата принята', 'Вернитесь в приложение SleePhy — покупка будет зачислена.');
      else show('⚠️', 'Не удалось оплатить', 'Платёж не найден или уже закрыт.');
    });
  });
  document.getElementById('btn-cancel').addEventListener('click', function () {
    settled = true;
    post('/pay/cancel').then(function () {
      show('🚫', 'Оплата отменена', 'Средства не списаны, покупка не зачислена. Можно закрыть эту страницу.');
    });
  });
  // Leaving the page — the back button, closing the tab, following any link —
  // is a cancellation unless the payment was already confirmed. sendBeacon
  // survives the unload, so the relay learns about it and the app can say the
  // purchase was cancelled instead of leaving it hanging.
  window.addEventListener('pagehide', function () {
    if (settled) return;
    settled = true;
    if (navigator.sendBeacon) navigator.sendBeacon('/pay/cancel?id=' + encodeURIComponent(ID));
  });
</script>
</body></html>`;
}

/**
 * The page a provider sends the browser to after a payment. It says only that
 * the browser made it back; the app is what asks the adapter to confirm, and
 * the confirmation is what credits anything. Nothing here can move money, so it
 * is safe to render for anyone who knows a payment id.
 */
function payReturnPage(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SleePhy — оплата</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1115;color:#e8eaf0;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:26rem;padding:2.5rem;text-align:center}
  h1{margin:0 0 .75rem;font-size:1.35rem}
  p{margin:0;color:#9aa3b2}
</style></head><body><main>
<h1>Оплата принята</h1>
<p>Вернитесь в приложение SleePhy — оно проверит платёж и зачислит покупку. Эту страницу можно закрыть.</p>
</main></body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'sleephy-relay' }));
    return;
  }
  if (req.url === '/pay/return' || req.url.startsWith('/pay/return?')) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    const body = payReturnPage(id);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  // YooMoney posts its signed notification here when the relay speaks to it
  // directly (no adapter). The token in the path is the shared secret that
  // keeps strangers out; the sha1 signature is checked before anything settles.
  if (req.url.startsWith('/notify/')) {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const token = req.url.slice('/notify/'.length).split('?')[0];
    if (!PAY_NOTIFY_TOKEN || token !== PAY_NOTIFY_TOKEN) { res.writeHead(404); res.end(); return; }
    readRequestBody(req, 16384).then((raw) => {
      const params = Object.fromEntries(new URLSearchParams(raw));
      const expected = yoomoneyDirectSignature(params);
      const got = String(params.sha1_hash || '').toLowerCase();
      if (!YOOMONEY_SECRET || expected !== got) {
        json(res, 403, { error: 'bad signature' });
        return;
      }
      const kind = String(params.notification_type || '');
      if (!kind.includes('incoming')) { json(res, 200, { ok: true }); return; }
      const label = String(params.label || '');
      const payment = q.getPayment.get(label);
      // Only a payment this relay is actually waiting on can be settled, and
      // only for the amount it asked for. Anything else is acknowledged and
      // dropped, so a replay or a smaller deposit credits nothing.
      const paidKopecks = Math.round(Number(params.amount) * 100);
      if (!payment || payment.status !== 'pending' || !Number.isFinite(paidKopecks) || paidKopecks < payment.amount_rub) {
        json(res, 200, { ok: true });
        return;
      }
      settlePayment(payment.id, String(params.operation_id || 'yoomoney:' + payment.id));
      json(res, 200, { ok: true });
    }).catch(() => { res.writeHead(413); res.end(); });
    return;
  }
  // The relay's own checkout page, opened by the app for a top-up.
  if (req.url === '/pay/checkout' || req.url.startsWith('/pay/checkout?')) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    const payment = q.getPayment.get(id);
    if (!payment) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Платёж не найден'); return; }
    const body = payCheckoutPage(payment);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  // Confirming the checkout credits the wallet. This is the "provider
  // confirmation" for the built-in checkout; a real provider reaches the wallet
  // through the adapter instead. Only a payment the relay itself is waiting on
  // is settled, so the endpoint cannot be used to invent a purchase.
  if (req.url === '/pay/confirm' || req.url.startsWith('/pay/confirm?')) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    const payment = q.getPayment.get(id);
    if (!payment) return json(res, 404, { ok: false, error: 'not found' });
    if (payment.status === 'pending' && payMode() === 'checkout') {
      settlePayment(payment.id, 'checkout:' + payment.id);
    }
    const now = q.getPayment.get(id);
    return json(res, 200, { ok: now && now.status === 'paid', status: now ? now.status : 'unknown' });
  }
  // Backing out of the checkout. Nothing is credited, and a later claim finds
  // the payment cancelled and does nothing.
  if (req.url === '/pay/cancel' || req.url.startsWith('/pay/cancel?')) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    const payment = q.getPayment.get(id);
    if (!payment) return json(res, 404, { ok: false, error: 'not found' });
    if (payment.status === 'pending') q.setPaymentCancelled.run(Date.now(), payment.id);
    return json(res, 200, { ok: true, status: 'cancelled' });
  }
  // One stable link for "the current installer". It redirects to whatever the
  // latest release holds, so it cannot go stale the way a pinned version can.
  if (req.url === '/download/latest' || req.url.startsWith('/download/latest?')) {
    resolveLatestInstaller().then((target) => {
      res.writeHead(302, { location: target.url, 'cache-control': 'no-store' });
      res.end();
    }).catch(() => {
      res.writeHead(302, { location: `https://github.com/${GITHUB_REPO}/releases/latest` });
      res.end();
    });
    return;
  }

  // Serve the download page and the installer, if they were shipped alongside.
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (DOWNLOAD_NAME.test(name)) {
    const file = path.join(DOWNLOAD_DIR, name);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
      const headers = { 'content-type': type, 'content-length': data.length };
      if (name.endsWith('.exe')) headers['content-disposition'] = `attachment; filename="${name}"`;
      res.writeHead(200, headers);
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// Attachments are capped at 5 MB of ciphertext, which base64-encodes to ~6.7 MB,
// plus JSON overhead; 16 MB leaves headroom without allowing unbounded frames.
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.username = null;
  // Kept so a checkout link can be built from the address the client reached
  // the relay on, without any extra configuration.
  ws._req = req;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return bad(ws, undefined, 'Bad JSON'); }
    if (!msg || typeof msg.t !== 'string') return bad(ws, undefined, 'Missing type');
    const handler = handlers[msg.t];
    if (!handler) return bad(ws, msg._id, 'Unknown request');
    try { handler(ws, msg, msg._id); } catch { reply(ws, msg._id, { t: 'error', message: 'Server error' }); }
  });

  ws.on('close', () => unbindSocket(ws));
  ws.on('error', () => unbindSocket(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

/**
 * Self-destructing messages. The relay holds only ciphertext, so the clock it
 * enforces is on the ciphertext alone: when `expires_at` passes, the row's box,
 * nonce and attachment are wiped in place, leaving a "deleted" marker. Both
 * sides are told so an open chat drops the bubble without waiting for a reload.
 * Running on a timer (not per message) keeps it correct for a device that was
 * offline when the timer ran out.
 */
const sweeper = setInterval(() => {
  // Scheduled messages whose send time has arrived are released first, so a
  // message that was also given a self-destruct timer starts its clock on time.
  let due;
  try { due = q.dueScheduled.all(Date.now()); } catch { due = []; }
  for (const row of due) {
    try { releaseScheduledMessage(row); } catch { /* keep sweeping the rest */ }
  }

  let rows;
  try { rows = q.expired.all(Date.now()); } catch { return; }
  if (!rows.length) return;
  for (const row of rows) {
    try {
      q.expireMessage.run(row.id);
      const payload = { t: 'expired', id: row.id };
      deliverToUser(row.sender, { ...payload, from: row.recipient });
      if (row.recipient !== row.sender) deliverToUser(row.recipient, { ...payload, from: row.sender });
    } catch { /* keep sweeping the rest */ }
  }
}, 5000);
wss.on('close', () => clearInterval(sweeper));

// One bad connection must not take the relay down for everyone. Log and keep
// serving: a relay that stays up is worth more than a crash that loses it.
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandled rejection:', reason);
});

server.listen(PORT, () => {
  console.log(`SleePhy relay listening on ws://0.0.0.0:${PORT}  (db: ${DB_PATH})`);
});

module.exports = { server, wss };
