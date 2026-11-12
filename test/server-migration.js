'use strict';

/**
 * Regression checks for the two faults that left an upgraded app stuck offline
 * on the sign-in screen:
 *
 *   1. Switching the server while a socket is still connecting used to tear the
 *      socket down with removeAllListeners() and then close() it, and `ws` then
 *      emitted `error` with no listener attached. In a build with no
 *      uncaughtException guard that killed the main process; the sign-in button
 *      stayed on "Signing in…" and the connection dot stayed grey.
 *   2. A remembered server address outlived the build that shipped it. A build
 *      whose default was a development sandbox host left that host saved in
 *      sleephy-server.json, so upgrading kept pointing at a dead host instead of
 *      the relay the new build bundles.
 *
 * Run with: node test/server-migration.js
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-${label}-`));
}

function makeClient(label, onEvent = () => {}) {
  return new SleePhyClient({ userDataDir: tmpDir(label), onEvent });
}

async function main() {
  // 1. A live socket, torn down while a new address is dialled, must not raise
  //    an uncaught error. The socket here is deliberately left CONNECTING: that
  //    is the state in which close() aborts the handshake and emits `error`.
  await step('switching server mid-connect does not raise an uncaught error', async () => {
    let uncaught = null;
    const onUncaught = (err) => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      const client = makeClient('switch');
      // 10.255.255.1 is a black hole: the TCP connect hangs, so the socket sits
      // in CONNECTING and never opens.
      client.connect('wss://10.255.255.1:443').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      client.connect('ws://127.0.0.1:9').catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      client.disconnect();
      assert.strictEqual(uncaught, null, `uncaught error: ${uncaught && uncaught.message}`);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  // 2. A remembered address from the retired sandbox must be ignored, so the
  //    bundled default is used instead.
  await step('a saved sandbox address is ignored in favour of the default', async () => {
    const dir = tmpDir('legacy');
    fs.writeFileSync(path.join(dir, 'sleephy-server.json'),
      JSON.stringify({ server: 'wss://work-1-nlsuqltmbmxzltac.prod-runtime.all-hands.dev' }));
    const client = new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
    assert.ok(!/prod-runtime\.all-hands\.dev/.test(client.serverUrl),
      `still pointed at the dead sandbox: ${client.serverUrl}`);
    // The bundled default is what should win. Run from the repo that is
    // server-default.json; in a build it is the relay the installer ships with.
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-default.json'), 'utf8')).server;
    assert.strictEqual(client.serverUrl, bundled,
      'expected the bundled default once the dead sandbox address is ignored');
  });

  // 3. A legitimate saved address still wins, so the fix does not strand users
  //    who deliberately chose their own relay.
  await step('a normal saved address is still honoured', async () => {
    const dir = tmpDir('custom');
    fs.writeFileSync(path.join(dir, 'sleephy-server.json'),
      JSON.stringify({ server: 'wss://relay.example.com' }));
    const client = new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
    assert.strictEqual(client.serverUrl, 'wss://relay.example.com');
  });

  // 4. Connecting to the dead sandbox address must never be persisted, or the
  //    next launch would read it back.
  await step('a sandbox address is never written to the saved-server file', async () => {
    const dir = tmpDir('nowrite');
    const client = new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
    client.writeServerUrl('wss://work-1-nlsuqltmbmxzltac.prod-runtime.all-hands.dev');
    const saved = fs.existsSync(path.join(dir, 'sleephy-server.json'))
      ? fs.readFileSync(path.join(dir, 'sleephy-server.json'), 'utf8') : '';
    assert.ok(!/prod-runtime\.all-hands\.dev/.test(saved), `dead host was persisted: ${saved}`);
  });

  // 5. A saved loopback address is a development leftover. In an installed
  //    build there is no relay on the user's machine, so it must be ignored and
  //    the bundled default used instead — otherwise the profile, which survives
  //    an uninstall, pins every later install to a dead local port.
  await step('a saved loopback address is ignored inside an installed build', async () => {
    const { execFileSync } = require('child_process');
    const script = `
      const os=require('os'),path=require('path'),fs=require('fs');
      const { SleePhyClient } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'client.js'))});
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sleephy-pkgloop-'));
      fs.writeFileSync(path.join(dir,'sleephy-server.json'), JSON.stringify({server:'ws://127.0.0.1:8787'}));
      const c=new SleePhyClient({userDataDir:dir,onEvent:()=>{}});
      process.stdout.write(String(c.serverUrl));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, SLEEPHY_PACKAGED: '1' }, encoding: 'utf8'
    }).trim();
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-default.json'), 'utf8')).server;
    assert.strictEqual(out, bundled, `packaged app kept a loopback address: ${out}`);
  });

  // 6. Running from source must still honour loopback, or `npm run server` +
  //    `npm start` could no longer talk to a relay on this machine.
  await step('a loopback address still works when running from source', async () => {
    const dir = tmpDir('devloop');
    fs.writeFileSync(path.join(dir, 'sleephy-server.json'),
      JSON.stringify({ server: 'ws://127.0.0.1:8787' }));
    const client = new SleePhyClient({ userDataDir: dir, onEvent: () => {} });
    assert.strictEqual(client.serverUrl, 'ws://127.0.0.1:8787',
      'a development relay on loopback must stay reachable');
  });

  // 7. SLEEPHY_SERVER is read before anything else and lives in the Windows
  //    registry, so it survives deleting the profile — the one thing "delete the
  //    app data" cannot clear. A packaged build must refuse a loopback value
  //    there too, or the app stays pinned to a dead local port.
  await step('a loopback SLEEPHY_SERVER is ignored inside an installed build', async () => {
    const { execFileSync } = require('child_process');
    const script = `
      const os=require('os'),path=require('path'),fs=require('fs');
      const { SleePhyClient } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'client.js'))});
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sleephy-envloop-'));
      const c=new SleePhyClient({userDataDir:dir,onEvent:()=>{}});
      process.stdout.write(String(c.serverUrl));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, SLEEPHY_PACKAGED: '1', SLEEPHY_SERVER: 'ws://127.0.0.1:8787' },
      encoding: 'utf8'
    }).trim();
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-default.json'), 'utf8')).server;
    assert.strictEqual(out, bundled, `packaged app honoured a loopback env var: ${out}`);
  });

  // 8. A real remote address in SLEEPHY_SERVER must still win, so an operator
  //    can point an installed build at their own relay.
  await step('a remote SLEEPHY_SERVER still overrides the bundled default', async () => {
    const { execFileSync } = require('child_process');
    const script = `
      const os=require('os'),path=require('path'),fs=require('fs');
      const { SleePhyClient } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'client.js'))});
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sleephy-envok-'));
      const c=new SleePhyClient({userDataDir:dir,onEvent:()=>{}});
      process.stdout.write(String(c.serverUrl));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, SLEEPHY_PACKAGED: '1', SLEEPHY_SERVER: 'wss://relay.example.com' },
      encoding: 'utf8'
    }).trim();
    assert.strictEqual(out, 'wss://relay.example.com', `env override was lost: ${out}`);
  });

  // 9. The sign-in form ships no address of its own, so a submit that lands
  //    before the window reads its status cannot dial a placeholder.
  await step('the sign-in form carries no hardcoded server address', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const field = html.match(/id="server-url"[^>]*/);
    assert.ok(field, 'the server field should exist');
    assert.ok(!/value="ws:\/\/127\.0\.0\.1/.test(field[0]),
      `the form still hardcodes a loopback address: ${field[0]}`);
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} server-migration checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
