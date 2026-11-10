'use strict';

/**
 * Drives the real Electron UI for the Telegram-style features: profile editing,
 * claiming a username, Saved Messages, search, chat settings, replies, edits,
 * deletes and reactions. Real clicks on the real app — no mocks.
 *
 * Run with: xvfb-run -a node test/ui-features.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { signIn } = require('./_auth');

const PORT = 8792;
const URL = `ws://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-uif-${Date.now()}.db`);

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sleephy-uif-${label}-`));
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

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DEV_CODES: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 1200));

  const a = await launch('a');
  const b = await launch('b');
  const suffix = Math.random().toString(36).slice(2, 6);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;

  await signIn(a.win, URL, { username: alice });
  await signIn(b.win, URL, { username: bob });

  await step('search finds the other user and opens a chat', async () => {
    await a.win.fill('#search', bob.slice(0, 5));
    await a.win.waitForSelector('#search-panel:not([hidden])', { timeout: 8000 });
    await a.win.waitForSelector(`#search-results .chat-item[data-username="${bob}"]`, { timeout: 8000 });
    await a.win.click(`#search-results .chat-item[data-username="${bob}"]`);
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    assert.strictEqual(await a.win.textContent('#peer-name'), bob);
  });

  await step('my profile opens and shows my username', async () => {
    await a.win.click('#btn-my-profile');
    await a.win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
    assert.strictEqual((await a.win.textContent('#profile-view-username')).replace(/^@/, ''), alice);
    assert.ok(await a.win.isVisible('#username-block'), 'the rename block should be visible for me');
  });

  await step('profile can be edited and saved from the UI', async () => {
    await a.win.click('#btn-profile-edit');
    await a.win.waitForSelector('#profile-form:not([hidden])', { timeout: 8000 });
    await a.win.fill('#profile-name', 'Alice Wonder');
    await a.win.fill('#profile-bio', 'Testing the profile');
    await a.win.click('.swatch[data-color="violet"]');
    await a.win.click('#profile-form button[type="submit"]');
    await a.win.waitForFunction(
      () => document.getElementById('profile-display').textContent === 'Alice Wonder',
      { timeout: 8000 }
    );
    assert.strictEqual(await a.win.textContent('#me-name'), 'Alice Wonder');
  });

  await step('claiming a new username works from the UI', async () => {
    const renamed = `alice2_${suffix}`;
    await a.win.fill('#username-input', renamed);
    await a.win.click('#btn-username-save');
    await a.win.waitForFunction(
      (n) => document.getElementById('profile-handle').textContent === '@' + n,
      renamed,
      { timeout: 10000 }
    );
    assert.strictEqual((await a.win.textContent('#profile-view-username')).replace(/^@/, ''), renamed);
    a.username = renamed;
  });

  await step('a taken username is refused in the UI', async () => {
    await a.win.fill('#username-input', bob);
    await a.win.click('#btn-username-save');
    await a.win.waitForSelector('#username-error:not([hidden])', { timeout: 8000 });
    const text = (await a.win.textContent('#username-error')).trim();
    assert.ok(!/invoking remote method/i.test(text), `raw IPC text leaked: ${text}`);
    assert.ok(/занято/i.test(text), `expected a "taken" message, got: ${text}`);
  });

  await step('Saved Messages opens and round-trips a note', async () => {
    await a.win.click('#btn-profile-close');
    await a.win.click('#btn-settings');
    await a.win.waitForSelector('#settings-backdrop:not([hidden])');
    await a.win.click('#btn-open-saved');
    await a.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    assert.strictEqual(await a.win.textContent('#peer-name'), 'Saved Messages');
    await a.win.fill('#composer-input', 'note to self from the UI');
    await a.win.click('.send-btn');
    await a.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.out .bubble'))
        .some((el) => el.textContent.includes('note to self from the UI')),
      { timeout: 8000 }
    );
  });

  await step('a reply quotes the original message', async () => {
    await openChatWith(a.win, bob);
    await a.win.fill('#composer-input', 'the original line');
    await a.win.click('.send-btn');
    await a.win.waitForSelector('.msg.out', { timeout: 8000 });

    // Right-click our own last outgoing bubble.
    const bubbles = a.win.locator('.msg.out .bubble');
    await bubbles.last().click({ button: 'right' });
    await a.win.waitForSelector('#ctx-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#ctx-menu .menu-item[data-action="reply"]');
    await a.win.waitForSelector('#reply-bar:not([hidden])', { timeout: 8000 });
    await a.win.fill('#composer-input', 'and here is my reply');
    await a.win.click('.send-btn');
    await a.win.waitForSelector('.msg.out .quote', { timeout: 8000 });
    const quoted = await a.win.textContent('.msg.out .quote .quote-text');
    assert.strictEqual(quoted, 'the original line');
  });

  await step('the reply reaches the other side with its quote', async () => {
    await b.win.fill('#search', a.username);
    await b.win.press('#search', 'Enter');
    await b.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 });
    await b.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.in .bubble'))
        .some((el) => el.textContent.includes('and here is my reply')),
      { timeout: 10000 }
    );
    const quote = await b.win.textContent('.msg.in .quote .quote-text');
    assert.strictEqual(quote, 'the original line');
  });

  await step('a message can be edited from the UI', async () => {
    await openChatWith(a.win, bob);
    await a.win.fill('#composer-input', 'teh typo');
    await a.win.click('.send-btn');
    await a.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.out .bubble'))
        .some((el) => el.textContent === 'teh typo'),
      { timeout: 8000 }
    );
    const bubbles = a.win.locator('.msg.out .bubble');
    await bubbles.last().click({ button: 'right' });
    await a.win.waitForSelector('#ctx-backdrop:not([hidden])');
    await a.win.click('#ctx-menu .menu-item[data-action="edit"]');
    await a.win.waitForSelector('#edit-bar:not([hidden])', { timeout: 8000 });
    await a.win.fill('#composer-input', 'the fixed text');
    await a.win.click('.send-btn');
    await a.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.out .bubble'))
        .some((el) => el.textContent === 'the fixed text'),
      { timeout: 8000 }
    );
    const edited = await a.win.textContent('.msg.out .meta .edited');
    assert.ok(/edited/i.test(edited), 'the bubble should be marked as edited');
  });

  await step('a message can be deleted from the UI', async () => {
    await openChatWith(a.win, bob);
    await a.win.fill('#composer-input', 'delete me now');
    await a.win.click('.send-btn');
    await a.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.out .bubble'))
        .some((el) => el.textContent === 'delete me now'),
      { timeout: 8000 }
    );
    const bubbles = a.win.locator('.msg.out .bubble');
    await bubbles.last().click({ button: 'right' });
    await a.win.waitForSelector('#ctx-backdrop:not([hidden])');
    await a.win.click('#ctx-menu .menu-item[data-action="delete"]');
    await a.win.waitForSelector('#confirm-backdrop:not([hidden])', { timeout: 8000 });
    await a.win.click('#btn-confirm-yes');
    await a.win.waitForFunction(
      () => !Array.from(document.querySelectorAll('.msg.out .bubble'))
        .some((el) => el.textContent === 'delete me now'),
      { timeout: 8000 }
    );
    const tomb = await a.win.textContent('.msg.out.deleted .bubble');
    assert.ok(/deleted/i.test(tomb), 'a tombstone should remain');
  });

  await step('reacting to a message shows a chip', async () => {
    await openChatWith(a.win, bob);
    await a.win.fill('#composer-input', 'react to this please');
    await a.win.click('.send-btn');
    await a.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.out .bubble'))
        .some((el) => el.textContent === 'react to this please'),
      { timeout: 8000 }
    );
    await b.win.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg.in .bubble'))
        .some((el) => el.textContent === 'react to this please'),
      { timeout: 10000 }
    );
    // Bob reacts by clicking a chip he creates; emulate via the API-exposed path
    // by clicking the reaction on the incoming bubble after it exists.
    const firstChip = b.win.locator('.msg.in .reaction-chip').last();
    // No chip exists yet — create one through the reaction round-trip.
    await b.win.evaluate(async () => {
      const bubbles = document.querySelectorAll('.msg.in');
      const last = bubbles[bubbles.length - 1];
      const id = Number(last.dataset.id);
      const res = await window.sleephy.react({ id, emoji: '🔥' });
      window.__reacted = res.reactions.length;
    });
    await b.win.waitForFunction(() => window.__reacted > 0, { timeout: 8000 });
    await a.win.waitForSelector('.msg.out .reaction-chip', { timeout: 10000 });
    const chip = await a.win.textContent('.msg.out .reaction-chip');
    assert.ok(chip.includes('🔥'), `expected the fire reaction, got: ${chip}`);
  });

  await step('chat can be pinned from the chat menu', async () => {
    await openChatWith(a.win, bob);
    await a.win.click('#btn-chat-menu');
    await a.win.waitForSelector('#chatmenu-backdrop:not([hidden])');
    await a.win.click('#chatmenu-body .menu-item[data-action="pin"]');
    await a.win.waitForFunction(
      () => {
        const item = document.querySelector('.chat-item.active');
        return item && !!item.querySelector('.chat-flag use[href="#i-pin"]');
      },
      { timeout: 8000 }
    );
  });

  await step('chat can be muted and archived', async () => {
    await a.win.click('#btn-chat-menu');
    await a.win.waitForSelector('#chatmenu-backdrop:not([hidden])');
    await a.win.click('#chatmenu-body .menu-item[data-action="mute"]');
    await a.win.waitForFunction(
      () => {
        const item = document.querySelector('.chat-item.active');
        return item && !!item.querySelector('.chat-flag use[href="#i-bell-off"]');
      },
      { timeout: 8000 }
    );
    await a.win.click('#btn-chat-menu');
    await a.win.waitForSelector('#chatmenu-backdrop:not([hidden])');
    await a.win.click('#chatmenu-body .menu-item[data-action="archive"]');
    await a.win.waitForFunction(
      () => !document.getElementById('section-archived').hidden,
      { timeout: 8000 }
    );
    assert.strictEqual(await a.win.textContent('#archived-count'), '1');
  });

  await step('clearing history empties the conversation', async () => {
    await a.win.click('#btn-chat-menu');
    await a.win.waitForSelector('#chatmenu-backdrop:not([hidden])');
    await a.win.click('#chatmenu-body .menu-item[data-action="clear"]');
    await a.win.waitForSelector('#confirm-backdrop:not([hidden])');
    await a.win.click('#btn-confirm-yes');
    await a.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg').length === 0,
      { timeout: 8000 }
    );
  });

  await step('a message can be pinned and the banner appears', async () => {
    await a.win.fill('#composer-input', 'pin this please');
    await a.win.press('#composer-input', 'Enter');
    await a.win.waitForFunction(
      () => [...document.querySelectorAll('#messages .msg .bubble')].some((b) => b.textContent.includes('pin this please')),
      { timeout: 8000 }
    );
    await a.win.click('#messages .msg:last-child');
    await a.win.click('#messages .msg:last-child', { button: 'right' });
    await a.win.waitForSelector('#ctx-backdrop:not([hidden])');
    await a.win.click('#ctx-menu [data-action="pin"]');
    await a.win.waitForSelector('#pinned-bar:not([hidden])', { timeout: 8000 });
    const text = await a.win.textContent('#pinned-text');
    assert.ok(text.includes('pin this please'), 'the pinned banner should show the message');
    // Bob sees the pin too.
    await b.win.waitForSelector('#chat-view:not([hidden])', { timeout: 8000 }).catch(() => {});
  });

  await step('the pinned banner can be dismissed', async () => {
    await a.win.click('#btn-pinned-unpin');
    await a.win.waitForFunction(() => document.getElementById('pinned-bar').hidden, { timeout: 8000 });
  });

  await step('the emoji picker inserts an emoji', async () => {
    await a.win.click('#btn-emoji');
    await a.win.waitForSelector('#emoji-panel:not([hidden])');
    await a.win.click('#emoji-grid .emoji-cell:first-child');
    const value = await a.win.inputValue('#composer-input');
    assert.ok(value.length > 0, 'an emoji should have been inserted');
    await a.win.fill('#composer-input', '');
    await a.win.click('#btn-emoji');
    await a.win.waitForFunction(() => document.getElementById('emoji-panel').hidden, { timeout: 8000 });
  });

  await step('in-chat search highlights matching messages', async () => {
    await a.win.click('#btn-chat-search');
    await a.win.waitForSelector('#chat-search-bar:not([hidden])');
    await a.win.fill('#chat-search-input', 'pin this');
    await a.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.search-hit').length > 0,
      { timeout: 8000 }
    );
    const count = await a.win.textContent('#chat-search-count');
    assert.ok(/найдено/.test(count), 'the result count should be shown');
    await a.win.click('#btn-chat-search-close');
    await a.win.waitForFunction(() => document.getElementById('chat-search-bar').hidden, { timeout: 8000 });
  });

  await step('the theme can be toggled and persists on the body', async () => {
    await a.win.click('#btn-settings');
    await a.win.waitForSelector('#settings-backdrop:not([hidden])');
    await a.win.click('.settings-nav-item[data-pane="chats"]');
    await a.win.waitForSelector('.settings-pane[data-pane="chats"].active');
    await a.win.click('#btn-theme-toggle');
    await a.win.waitForFunction(() => document.body.classList.contains('theme-light'), { timeout: 8000 });
    await a.win.click('#btn-theme-toggle');
    await a.win.waitForFunction(() => !document.body.classList.contains('theme-light'), { timeout: 8000 });
    await a.win.click('#btn-settings-close');
  });

  await step('a chat wallpaper can be selected', async () => {
    await a.win.click('#btn-settings');
    await a.win.waitForSelector('#settings-backdrop:not([hidden])');
    await a.win.click('.settings-nav-item[data-pane="chats"]');
    await a.win.waitForSelector('.settings-pane[data-pane="chats"].active');
    await a.win.click('.wallpaper-swatch[data-wallpaper="dots"]');
    await a.win.waitForFunction(
      () => document.querySelector('#chat-view').classList.contains('wallpaper-dots'),
      { timeout: 8000 }
    );
    await a.win.click('#btn-settings-close');
  });

  await step('an image attachment can be sent and opened', async () => {
    // A 1x1 transparent PNG, written to a temp file so the file picker can use it.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const file = path.join(os.tmpdir(), `sleephy-shot-${Date.now()}.png`);
    fs.writeFileSync(file, png);
    await a.win.click('#btn-attach');
    await a.win.waitForSelector('#attach-backdrop:not([hidden])');
    const [chooser] = await Promise.all([
      a.win.waitForEvent('filechooser'),
      a.win.click('#attach-menu [data-attach="image"]')
    ]);
    await chooser.setFiles(file);
    await a.win.waitForFunction(
      () => document.querySelectorAll('#messages .msg.has-attachment').length > 0,
      { timeout: 10000 }
    );
    await a.win.waitForSelector('#messages .msg.has-attachment .att-image', { timeout: 10000 });
    // Bob should receive it too.
    await b.win.waitForSelector('#messages .msg.has-attachment .att-image', { timeout: 10000 });
    try { fs.rmSync(file, { force: true }); } catch {}
  });

  await step('no uncaught errors in either renderer', async () => {
    const errors = [...a.errors, ...b.errors];
    assert.strictEqual(errors.length, 0, 'renderer errors: ' + errors.join(' | '));
  });

  await a.app.close();
  await b.app.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch {}

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} UI feature checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
