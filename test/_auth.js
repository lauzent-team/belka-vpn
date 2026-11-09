'use strict';

/**
 * Shared sign-in helper for the UI suites.
 *
 * Sign-in is a username and a password, so a suite creates its account by
 * filling the form and pressing the button, exactly as a person would. The
 * phone flow still exists but its button is disabled, so it is not exercised
 * from here.
 */

let seq = 0;

/** A unique, valid E.164 number, for the phone flow. */
function nextPhone() {
  seq += 1;
  const stamp = String(Date.now()).slice(-6);
  const tail = String(seq).padStart(2, '0');
  return '+7999' + stamp + tail;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_PASSWORD = 'sleephy-test-1234';

/** Create an account with a username and a password, and reach the main screen. */
async function signIn(win, serverUrl, { username, password = DEFAULT_PASSWORD } = {}) {
  await win.fill('#server-url', serverUrl);
  await win.click('.auth-tab[data-tab="register"]');
  await win.fill('#auth-username', username);
  await win.fill('#auth-password', password);
  await win.fill('#auth-confirm', password);
  await win.click('#btn-auth');
  await win.waitForSelector('#screen-main.active', { timeout: 20000 });
  return { username, password };
}

/** Sign in to an existing account. */
async function logIn(win, serverUrl, { username, password = DEFAULT_PASSWORD } = {}) {
  await win.fill('#server-url', serverUrl);
  await win.click('.auth-tab[data-tab="login"]');
  await win.fill('#auth-username', username);
  await win.fill('#auth-password', password);
  await win.click('#btn-auth');
  await win.waitForSelector('#screen-main.active', { timeout: 20000 });
  return { username };
}

/** Sign in through the phone flow, which the disabled button does not reach. */
async function signInWithPhone(win, serverUrl, { phone, username } = {}) {
  const number = phone || nextPhone();
  await win.fill('#server-url', serverUrl);
  await win.evaluate(() => document.getElementById('btn-phone-signin').disabled = false);
  await win.click('#btn-phone-signin');
  await win.fill('#auth-phone', number);
  await win.click('#btn-phone');
  await win.waitForSelector('#form-code:not([hidden])', { timeout: 20000 });
  // The code arrives in the reply in dev mode and the UI writes it in.
  await win.waitForFunction(
    () => (document.getElementById('auth-code').value || '').length === 6,
    { timeout: 10000 }
  );
  await win.click('#btn-code');
  await win.waitForSelector('#screen-main.active', { timeout: 20000 });
  if (username) await claimUsername(win, username);
  return { phone: number };
}

/** Rename the account through the profile, the way a person would. */
async function claimUsername(win, username) {
  await win.click('#btn-my-profile');
  await win.waitForSelector('#profile-backdrop:not([hidden])', { timeout: 8000 });
  await win.waitForSelector('#username-block:not([hidden])', { timeout: 8000 });
  await win.fill('#username-input', username);
  await win.click('#btn-username-save');
  await win.waitForFunction(
    (u) => document.getElementById('me-name').textContent === u,
    username,
    { timeout: 15000 }
  );
  // Saving re-renders the profile, which can reopen the overlay just after the
  // close click. Keep closing until it stays hidden.
  for (let i = 0; i < 10; i++) {
    if (await win.isHidden('#profile-backdrop')) break;
    await win.click('#btn-profile-close');
    await sleep(200);
  }
  await win.waitForSelector('#profile-backdrop', { state: 'hidden', timeout: 8000 });
  await sleep(150);
}

/** Set the account password from Privacy settings, as a person would. */
async function setAccountPassword(win, password) {
  await win.click('#btn-settings');
  await win.waitForSelector('#settings-backdrop:not([hidden])', { timeout: 8000 });
  await win.click('.settings-nav-item[data-pane="privacy"]');
  await win.waitForSelector('.settings-pane[data-pane="privacy"].active', { timeout: 8000 });
  await win.click('#btn-set-password');
  await win.waitForSelector('#form-password:not([hidden])', { timeout: 8000 });
  await win.fill('#set-password-input', password);
  await win.fill('#set-password-confirm', password);
  await win.click('#form-password button[type="submit"]');
  await win.waitForSelector('#form-password', { state: 'hidden', timeout: 15000 });
  await win.click('#btn-settings-close');
  await sleep(150);
}

module.exports = { nextPhone, signIn, logIn, signInWithPhone, claimUsername, setAccountPassword, DEFAULT_PASSWORD };
