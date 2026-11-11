'use strict';

/**
 * Checks that tearing a socket down while it is still connecting cannot crash
 * the main process.
 *
 * `ws` reports an aborted handshake by emitting an `error` on the socket. The
 * client used to call `removeAllListeners()` and then `close()` on a socket in
 * CONNECTING state: `close()` aborts the handshake, the `error` had nobody
 * listening, and Electron's main process died with an uncaught exception —
 * "WebSocket was closed before the connection was established". This happened
 * on every launch and every quit.
 *
 * Run with: node test/socket-teardown.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { SleePhyClient } = require('../src/lib/client');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-teardown-${label}-`));
}

async function main() {
  // An uncaught exception here would take down the whole process, exactly as it
  // took down the Electron main process. Record it instead of dying, so the
  // remaining checks still run and the failure is reported clearly.
  const crashes = [];
  process.on('uncaughtException', (err) => crashes.push(err));

  await step('closing a connecting socket does not crash the process', async () => {
    const client = new SleePhyClient({ userDataDir: tmpDir('a'), onEvent: () => {} });
    // Nothing listens on port 9, so the socket stays in CONNECTING and the
    // handshake never completes.
    client.connect('ws://127.0.0.1:9');
    client.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(crashes.length, 0,
      `uncaught exception: ${crashes.map((e) => e.message).join('; ')}`);
  });

  await step('reconnecting to a new address mid-handshake does not crash', async () => {
    const client = new SleePhyClient({ userDataDir: tmpDir('b'), onEvent: () => {} });
    client.connect('ws://127.0.0.1:9');
    // A second connect to a different address tears the first socket down.
    client.connect('ws://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(crashes.length, 0,
      `uncaught exception: ${crashes.map((e) => e.message).join('; ')}`);
  });

  await step('quitting right after launch does not crash', async () => {
    const client = new SleePhyClient({ userDataDir: tmpDir('c'), onEvent: () => {} });
    client.connect('ws://127.0.0.1:9');
    client.disconnect();
    client.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(crashes.length, 0,
      `uncaught exception: ${crashes.map((e) => e.message).join('; ')}`);
  });

  await step('a live socket still connects and closes cleanly', async () => {
    const { spawn } = require('child_process');
    const PORT = 8794;
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: {
        ...process.env,
        SLEEPHY_PORT: String(PORT),
        SLEEPHY_DB: path.join(os.tmpdir(), `sleephy-teardown-live-${Date.now()}.db`),
        SLEEPHY_DEV_CODES: '1'
      },
      stdio: ['ignore', 'ignore', 'inherit']
    });
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const events = [];
      const client = new SleePhyClient({ userDataDir: tmpDir('d'), onEvent: (e) => events.push(e) });
      await client.connect(`ws://127.0.0.1:${PORT}`);
      assert.strictEqual(client.status().online, true, 'expected an online connection');
      client.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(crashes.length, 0,
        `uncaught exception: ${crashes.map((e) => e.message).join('; ')}`);
    } finally {
      server.kill('SIGKILL');
    }
  });

  process.removeAllListeners('uncaughtException');
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} socket teardown checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
