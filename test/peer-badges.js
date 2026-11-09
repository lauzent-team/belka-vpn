'use strict';

/**
 * A peer's checkmark and badge picture must survive a re-entry.
 *
 * Field report: "on re-entry the other person loses the checkmark and the
 * picture". The profile cache lives in memory, so a fresh launch starts empty.
 * Re-entering only restores it if the relay re-sends each peer's profile with
 * the chat list — which it must, because a badge is usually granted while the
 * viewer is offline.
 *
 * Run with: node test/peer-badges.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8799;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-peers-${Date.now()}.db`);
const PASSWORD = 'password-1234';
const ADMIN = 'peer_admin';

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function device(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-peers-${label}-`));
  return { dir, client: new SleePhyClient({ userDataDir: dir, onEvent: () => {} }) };
}

// A 1x1 PNG, small enough to pass every size cap.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: ADMIN },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const probe = () => {
      const ws = new WebSocket(URL);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => {
        if (Date.now() - t0 > 8000) return reject(new Error('server did not start'));
        setTimeout(probe, 150);
      });
    };
    probe();
  });

  const admin = device('admin');
  const friend = device('friend');
  const viewer = device('viewer');

  await admin.client.connect(URL);
  await admin.client.register({ username: ADMIN, password: PASSWORD });
  await friend.client.connect(URL);
  await friend.client.register({ username: 'peer_friend', password: PASSWORD });
  await viewer.client.connect(URL);
  await viewer.client.register({ username: 'peer_viewer', password: PASSWORD });

  // The friend writes to the viewer, so both sides get a chat row.
  await friend.client.sendMessage({ to: 'peer_viewer', text: 'hi' });
  await wait(200);

  await step('the friend sets a profile picture', async () => {
    const profile = await friend.client.saveProfile({ avatarImage: PNG });
    assert.strictEqual(profile.avatarImage, PNG);
  });

  await step('the admin verifies the friend and gives a badge picture', async () => {
    await admin.client.adminAction({ action: 'verify', username: 'peer_friend' });
    await admin.client.adminAction({ action: 'badge', username: 'peer_friend', image: PNG });
    const p = await viewer.client.getProfile('peer_friend');
    assert.strictEqual(p.profile.verified, true);
    assert.strictEqual(p.profile.badgeImage, PNG);
  });

  await step('re-entry restores the peer badge and picture from the chat list', async () => {
    // A fresh launch: same device, empty in-memory profile cache. The viewer
    // never sees the admin's grant live, so the chat list must carry it.
    const again = new SleePhyClient({ userDataDir: viewer.dir, onEvent: () => {} });
    await again.connect(URL);
    await again.unlock(PASSWORD).catch(() => {});
    const chats = await again.listChats();
    const row = chats.find((c) => c.peer === 'peer_friend');
    assert.ok(row, 'the friend should have a chat row');
    assert.ok(row.profile, 'the chat row must carry the peer profile');
    assert.strictEqual(row.profile.verified, true, 'the checkmark must survive re-entry');
    assert.strictEqual(row.profile.badgeImage, PNG, 'the badge picture must survive re-entry');
    assert.strictEqual(row.profile.avatarImage, PNG, 'the profile picture must survive re-entry');
    again.disconnect();
  });

  server.kill('SIGTERM');
  await wait(200);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} peer-badge checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
