'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8811;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-pollcheck-${Date.now()}.db`);
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}
async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-pollcheck-${label}-`));
  const errors = [];
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win, dir, errors };
}

async function openChatWith(win, username) {
  await win.fill('#search', username);
  await win.press('#search', 'Enter');
  await win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
}

async function createPoll(win, question, options, opts) {
  await win.click('#btn-attach');
  await win.waitForSelector('#attach-menu', { timeout: 8000 });
  await win.click('[data-attach="poll"]');
  await win.waitForSelector('#poll-backdrop:not([hidden])', { timeout: 8000 });
  await win.fill('#poll-question', question);
  const inputs = await win.$$('#poll-options input');
  for (let i = 0; i < options.length; i += 1) {
    if (i >= inputs.length) { await win.click('#btn-poll-add'); }
  }
  const all = await win.$$('#poll-options input');
  for (let i = 0; i < options.length; i += 1) await all[i].fill(options[i]);
  if (opts && opts.multiple) await win.check('#poll-multiple');
  if (opts && opts.anon === false) await win.uncheck('#poll-anon');
  await win.click('#btn-poll-create');
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_ADMINS: 'pidoras' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const u = await launch('u');
  const v = await launch('v');
  const s = Math.random().toString(36).slice(2, 6);
  const peer = `pollpeer_${s}`;
  await signIn(u.win, URL, { username: `polltester_${s}` });
  await signIn(v.win, URL, { username: peer });

  await step('the poll composer opens from the attach menu', async () => {
    await openChatWith(u.win, peer);
    await openChatWith(v.win, `polltester_${s}`);
    await u.win.click('#btn-attach');
    await u.win.waitForSelector('#attach-menu', { timeout: 8000 });
    await u.win.click('[data-attach="poll"]');
    await u.win.waitForSelector('#poll-backdrop:not([hidden])', { timeout: 8000 });
    const n = await u.win.$$eval('#poll-options input', (e) => e.length);
    assert.strictEqual(n, 2, `expected two starter options, got ${n}`);
    await u.win.click('#btn-poll-close');
  });

  await step('a poll with too few options is refused with an error', async () => {
    await u.win.click('#btn-attach');
    await u.win.waitForSelector('#attach-menu', { timeout: 8000 });
    await u.win.click('[data-attach="poll"]');
    await u.win.waitForSelector('#poll-backdrop:not([hidden])', { timeout: 8000 });
    await u.win.fill('#poll-question', 'Обед?');
    const inputs = await u.win.$$('#poll-options input');
    await inputs[0].fill('Пицца');
    await u.win.click('#btn-poll-create');
    await u.win.waitForSelector('#poll-error:not([hidden])', { timeout: 8000 });
    const text = await u.win.textContent('#poll-error');
    assert.ok(/минимум/i.test(text), `error was ${text}`);
    await u.win.click('#btn-poll-close');
  });

  await step('the sender sees a poll card with the question and options', async () => {
    await createPoll(u.win, 'Куда поедем?', ['Море', 'Горы']);
    await u.win.waitForSelector('#messages .poll', { timeout: 8000 });
    const q = await u.win.textContent('#messages .poll .poll-question');
    assert.strictEqual(q.trim(), 'Куда поедем?');
    const n = await u.win.$$eval('#messages .poll .poll-option', (e) => e.length);
    assert.strictEqual(n, 2, `expected two options, got ${n}`);
  });

  await step('the poll reaches the peer as the same card', async () => {
    await v.win.waitForSelector('#messages .poll', { timeout: 10000 });
    const q = await v.win.textContent('#messages .poll .poll-question');
    assert.strictEqual(q.trim(), 'Куда поедем?');
  });

  await step('the poll is not shown as a raw text bubble', async () => {
    const leaks = await v.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => (e.textContent || '').includes('"poll"')).length);
    assert.strictEqual(leaks, 0, 'the poll payload must not appear as a text bubble');
  });

  await step('the peer votes and the tally updates on both devices', async () => {
    await v.win.click('#messages .poll .poll-option[data-option="1"]');
    await v.win.waitForFunction(
      () => document.querySelector('#messages .poll .poll-option[data-option="1"] .poll-option-count').textContent.trim() === '1',
      null, { timeout: 8000 }
    );
    await u.win.waitForFunction(
      () => document.querySelector('#messages .poll .poll-option[data-option="1"] .poll-option-count').textContent.trim() === '1',
      null, { timeout: 10000 }
    );
    const foot = await u.win.textContent('#messages .poll .poll-foot');
    assert.ok(/1 голос/.test(foot), `foot was ${foot}`);
  });

  await step('the vote is not shown as its own bubble', async () => {
    const votes = await u.win.$$eval('#messages .msg', (els) =>
      els.filter((e) => (e.textContent || '').includes('"pv"')).length);
    assert.strictEqual(votes, 0, 'a vote must not appear as a text bubble');
  });

  await step('tapping the same option again withdraws the vote', async () => {
    await v.win.click('#messages .poll .poll-option[data-option="1"]');
    await u.win.waitForFunction(
      () => document.querySelector('#messages .poll .poll-foot').textContent.trim().startsWith('0 '),
      null, { timeout: 10000 }
    );
  });

  await step('a multiple-choice poll keeps more than one selection', async () => {
    await createPoll(v.win, 'Что взять?', ['Палатку', 'Еду'], { multiple: true });
    await v.win.waitForSelector('#messages .poll:last-of-type', { timeout: 8000 });
    const poll = (await v.win.$$('#messages .poll')).at(-1);
    await poll.$eval('.poll-option[data-option="0"]', (b) => b.click());
    await poll.$eval('.poll-option[data-option="1"]', (b) => b.click());
    await u.win.waitForFunction(() => {
      const cards = document.querySelectorAll('#messages .poll');
      const card = cards[cards.length - 1];
      return card.querySelectorAll('.poll-option.chosen').length === 2;
    }, null, { timeout: 10000 });
  });

  await step('a single-choice poll replaces the previous selection', async () => {
    await createPoll(u.win, 'Чай или кофе?', ['Чай', 'Кофе']);
    const poll = (await u.win.$$('#messages .poll')).at(-1);
    await poll.$eval('.poll-option[data-option="0"]', (b) => b.click());
    await poll.$eval('.poll-option[data-option="1"]', (b) => b.click());
    await u.win.waitForFunction(() => {
      const cards = document.querySelectorAll('#messages .poll');
      const card = cards[cards.length - 1];
      const chosen = card.querySelectorAll('.poll-option.chosen');
      return chosen.length === 1 && chosen[0].dataset.option === '1';
    }, null, { timeout: 8000 });
  });

  await step('no uncaught errors in either renderer', async () => {
    assert.deepStrictEqual(u.errors, [], 'tester renderer errors');
    assert.deepStrictEqual(v.errors, [], 'peer renderer errors');
  });

  await u.app.close();
  await v.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} poll UI checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
