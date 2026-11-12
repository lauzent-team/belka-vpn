'use strict';

/**
 * The relay must refuse abuse. This runs a real relay with deliberately small
 * limits and drives it with real clients, so the checks are against the wire
 * behaviour a stranger would see, not against the limiter in isolation
 * (test/ratelimit.js covers the pure logic).
 *
 * Each check gets its own relay: the limits live in the relay's memory, so a
 * shared process would let one check spend another's budget. A unique port per
 * check keeps them from colliding too.
 *
 * Run with: node test/ratelimit-relay.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

let portSeq = 8833;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn a relay with the given rate env, run `fn(url, clients)`, then stop it. */
async function withRelay(rateEnv, fn) {
  const port = portSeq++;
  const url = `ws://127.0.0.1:${port}`;
  const db = path.join(os.tmpdir(), `sleephy-rl-${port}-${Date.now()}.db`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(port), SLEEPHY_DB: db, ...rateEnv },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);
  const clients = [];
  try {
    await fn(url, clients);
  } finally {
    for (const c of clients) { try { c.disconnect(); } catch { /* already gone */ } }
    server.kill('SIGTERM');
    await wait(300);
    for (const f of [db, db + '-wal', db + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  }
}

function newClient(clients) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-rl-c-'));
  const c = new SleePhyClient({ userDataDir: dir });
  clients.push(c);
  return c;
}

async function main() {
  const suffix = Math.random().toString(36).slice(2, 7);

  await step('a burst of registrations from one address is refused', async () => {
    await withRelay({ SLEEPHY_RATE_REGISTER: '2' }, async (url, clients) => {
      const a = newClient(clients); await a.connect(url);
      await a.register({ username: `rl_a_${suffix}`, password: 'password-1234' });
      const b = newClient(clients); await b.connect(url);
      await b.register({ username: `rl_b_${suffix}`, password: 'password-1234' });
      const c = newClient(clients); await c.connect(url);
      let refused = null;
      try { await c.register({ username: `rl_c_${suffix}`, password: 'password-1234' }); }
      catch (e) { refused = e; }
      assert.ok(refused, 'the third registration must be refused');
      assert.ok(/Слишком много/.test(refused.message), `expected a rate-limit message, got: ${refused.message}`);
      assert.ok(Number.isFinite(refused.retryAfterMs) && refused.retryAfterMs > 0,
        `the error must carry retryAfterMs, got: ${refused.retryAfterMs}`);
    });
  });

  await step('password guessing against one account is refused', async () => {
    await withRelay({ SLEEPHY_RATE_LOGIN: '2', SLEEPHY_RATE_LOGIN_IP: '50' }, async (url, clients) => {
      const victim = `rl_v_${suffix}`;
      const setup = newClient(clients); await setup.connect(url);
      await setup.register({ username: victim, password: 'password-1234' });
      setup.disconnect();

      const messages = [];
      for (let i = 1; i <= 3; i++) {
        const g = newClient(clients); await g.connect(url);
        try { await g.login({ username: victim, password: 'wrong-' + i + '111' }); }
        catch (e) { messages.push(e.message); }
        g.disconnect();
      }
      assert.ok(/Wrong username or password/.test(messages[0]), `first guess: ${messages[0]}`);
      assert.ok(/Wrong username or password/.test(messages[1]), `second guess: ${messages[1]}`);
      assert.ok(/Слишком много/.test(messages[2]), `third guess must be limited: ${messages[2]}`);
    });
  });

  await step('a message flood is refused but a normal pace is not', async () => {
    await withRelay({ SLEEPHY_RATE_SEND: '3' }, async (url, clients) => {
      const flooder = newClient(clients); await flooder.connect(url);
      const name = `rl_f_${suffix}`;
      await flooder.register({ username: name, password: 'password-1234' });
      await flooder.sendMessage({ to: name, text: 'one' });
      await flooder.sendMessage({ to: name, text: 'two' });
      await flooder.sendMessage({ to: name, text: 'three' });
      let refused = null;
      try { await flooder.sendMessage({ to: name, text: 'four' }); }
      catch (e) { refused = e; }
      assert.ok(refused && /Слишком много/.test(refused.message),
        `the fourth send in the window must be refused, got: ${refused && refused.message}`);
    });
  });

  await step('the send limit is per account, not per address', async () => {
    await withRelay({ SLEEPHY_RATE_SEND: '3' }, async (url, clients) => {
      const a = newClient(clients); await a.connect(url);
      await a.register({ username: `rl_x_${suffix}`, password: 'password-1234' });
      for (let i = 0; i < 3; i++) await a.sendMessage({ to: `rl_x_${suffix}`, text: 'hi ' + i });

      const b = newClient(clients); await b.connect(url);
      await b.register({ username: `rl_y_${suffix}`, password: 'password-1234' });
      await b.sendMessage({ to: `rl_y_${suffix}`, text: 'hi' });
    });
  });

  await step('the limiter can be turned off for a local relay', async () => {
    await withRelay({ SLEEPHY_RATE_LIMIT: 'off', SLEEPHY_RATE_REGISTER: '1' }, async (url, clients) => {
      for (let i = 0; i < 4; i++) {
        const c = newClient(clients); await c.connect(url);
        await c.register({ username: `rl_off_${suffix}_${i}`, password: 'password-1234' });
        c.disconnect();
      }
    });
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
