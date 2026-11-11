'use strict';

/**
 * Rockets, Premium and gifts over a real relay.
 *
 * The relay is the only authority on money, so these checks are about trust:
 * a client cannot invent a bundle, cannot credit itself, cannot credit twice,
 * cannot gift without paying, and cannot spend more than it holds. The mock
 * provider is used, which settles a top-up immediately, so no real payment is
 * involved.
 *
 * Run with: node test/payments.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SleePhyClient } = require('../src/lib/client');

const PORT = 8826;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-pay-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

function makeClient(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-pay-${label}-`));
  const events = [];
  const client = new SleePhyClient({ userDataDir: dir, onEvent: (e) => events.push(e) });
  return { client, events, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFrom(client, from, type, predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (let i = from; i < client.events.length; i++) {
      const e = client.events[i];
      if (e.type === type && (!predicate || predicate(e))) return e;
    }
    await wait(20);
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      SLEEPHY_PORT: String(PORT),
      SLEEPHY_DB: DB,
      SLEEPHY_PAY_PROVIDER: 'mock',
      // The sign-up grant is off here so the balances below are exact; the
      // grant itself is checked by the UI suite.
      SLEEPHY_WELCOME_ROCKETS: '0'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  const A = makeClient('a');
  const B = makeClient('b');
  for (const x of [A, B]) await x.client.connect(URL);
  await A.client.register({ username: alice, password: 'password-1234' });
  await B.client.register({ username: bob, password: 'password-1234' });

  await step('a fresh wallet is empty and not premium', async () => {
    const w = await A.client.wallet();
    assert.strictEqual(w.balance, 0, 'no Rockets yet');
    assert.strictEqual(w.premium.active, false, 'no subscription');
    assert.ok(Array.isArray(w.bundles) && w.bundles.length, 'bundles are listed');
    assert.ok(w.gifts && w.gifts.rose, 'the gift catalogue came down');
  });

  await step('the bundle prices match the price list', async () => {
    const w = await A.client.wallet();
    const byRockets = Object.fromEntries(w.bundles.map((b) => [b.rockets, b]));
    assert.strictEqual(byRockets[50].priceRub, 44.5, '50 x 0.89');
    assert.strictEqual(byRockets[100].priceRub, 89, '100 x 0.89');
    assert.strictEqual(byRockets[2500].priceRub, 2225, '2500 x 0.89');
  });

  await step('a top-up credits the wallet and is pushed to the account', async () => {
    const from = A.events.length;
    const res = await A.client.payCreate({ kind: 'rockets', rockets: 100 });
    assert.strictEqual(res.status, 'paid', 'mock settles at once');
    assert.strictEqual(res.balance, 100, 'the reply carries the new balance');
    const push = await waitFrom(A, from, 'wallet', (e) => e.balance === 100);
    assert.strictEqual(push.settled, true, 'the push says it settled');
  });

  await step('the balance survives a fresh read', async () => {
    const w = await A.client.wallet();
    assert.strictEqual(w.balance, 100, 'still 100');
  });

  await step('an unknown bundle is refused', async () => {
    await assert.rejects(
      () => A.client.payCreate({ kind: 'rockets', rockets: 999999 }),
      /Неизвестный пакет/,
      'the relay picks the price, so an invented bundle is refused'
    );
    const w = await A.client.wallet();
    assert.strictEqual(w.balance, 100, 'and nothing was credited');
  });

  await step('Premium activates for a month', async () => {
    const res = await A.client.payCreate({ kind: 'premium' });
    assert.strictEqual(res.status, 'paid', 'settled');
    assert.strictEqual(res.premium.active, true, 'active now');
    const left = res.premium.until - Date.now();
    assert.ok(left > 29 * 24 * 60 * 60 * 1000, 'about a month ahead');
    assert.strictEqual(res.balance, 100, 'Rockets are untouched by Premium');
  });

  await step('buying Premium again extends it instead of resetting it', async () => {
    const before = (await A.client.wallet()).premium.until;
    const res = await A.client.payCreate({ kind: 'premium' });
    const added = res.premium.until - before;
    assert.ok(Math.abs(added - 30 * 24 * 60 * 60 * 1000) < 2000, 'a month was added');
  });

  await step('a gift is debited from the sender and sent to the peer', async () => {
    const b = B.events.length;
    const res = await A.client.giftSend({ to: bob, gift: 'teddy' });
    assert.strictEqual(res.balance, 95, '5 Rockets for the teddy');
    // The debit is the relay's job; the gift itself is an ordinary encrypted
    // message the client then sends, exactly as the renderer does.
    await A.client.sendMessage({ to: bob, text: JSON.stringify({ gift: 'teddy' }) });
    const got = await waitFrom(B, b, 'message', (e) => e.from === alice, 4000);
    assert.ok(got.text.includes('teddy'), 'the gift arrived');
  });

  await step('a gift the sender cannot afford is refused', async () => {
    await assert.rejects(
      () => A.client.giftSend({ to: bob, gift: 'crown' }),
      /Недостаточно/,
      'the crown costs 100, the balance is 95'
    );
    const w = await A.client.wallet();
    assert.strictEqual(w.balance, 95, 'nothing was taken');
  });

  await step('a gift to an unknown user is refused', async () => {
    await assert.rejects(
      () => A.client.giftSend({ to: `ghost_${suffix}`, gift: 'rose' }),
      /No such user/
    );
  });

  await step('an unknown gift is refused', async () => {
    await assert.rejects(
      () => A.client.giftSend({ to: bob, gift: 'unicorn' }),
      /Такого подарка нет/
    );
  });

  await step('one account cannot claim another account\'s payment', async () => {
    const res = await A.client.payCreate({ kind: 'rockets', rockets: 50 });
    await assert.rejects(
      () => B.client.payClaim({ id: res.id }),
      /Платёж не найден/,
      'the payment belongs to alice'
    );
  });

  await step('claiming the same payment twice credits only once', async () => {
    const before = (await A.client.wallet()).balance;
    const res = await A.client.payCreate({ kind: 'rockets', rockets: 50 });
    const afterPay = (await A.client.wallet()).balance;
    assert.strictEqual(afterPay, before + 50, 'the first credit landed');
    // A retried claim, e.g. the user reloading the return page, must be a no-op.
    await A.client.payClaim({ id: res.id });
    await A.client.payClaim({ id: res.id });
    const afterClaims = (await A.client.wallet()).balance;
    assert.strictEqual(afterClaims, afterPay, 'no second credit');
  });

  await step('a claim reports the payment status back', async () => {
    const res = await A.client.payCreate({ kind: 'rockets', rockets: 50 });
    const claim = await A.client.payClaim({ id: res.id });
    assert.strictEqual(claim.paymentStatus, 'paid', 'a settled payment reports paid');
    // A second claim still reports paid rather than silently doing nothing.
    const again = await A.client.payClaim({ id: res.id });
    assert.strictEqual(again.paymentStatus, 'paid', 'and stays paid');
  });

  await step('the return page is served and cannot be walked out of', async () => {
    const get = (p) => new Promise((resolve, reject) => {
      const req = require('http').get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      req.on('error', reject);
    });
    const ok = await get('/pay/return?id=abc123');
    assert.strictEqual(ok.status, 200, 'the return page is served');
    assert.match(ok.body, /Оплата принята/, 'and says the payment went through');
    const missing = await get('/pay/return/../../secret');
    assert.strictEqual(missing.status, 404, 'a path that is not the return page is a 404');
  });

  await step('an unauthenticated client gets nothing', async () => {
    const C = makeClient('c');
    await C.client.connect(URL);
    await assert.rejects(() => C.client.wallet(), /Not authenticated/);
    C.client.disconnect();
  });

  await step('Premium shows on the public profile of the subscriber', async () => {
    const { profile } = await B.client.getProfile(alice);
    assert.strictEqual(profile.premium, true, 'alice is marked premium');
    const plain = await A.client.getProfile(bob);
    assert.strictEqual(plain.profile.premium, false, 'bob is not');
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);

  for (const x of [A, B]) x.client.disconnect();
  server.kill();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
