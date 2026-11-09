'use strict';

/**
 * Shared sign-in helper for the UI suites.
 *
 * Sign-in is by phone number and a one-time code; the relay returns the code in
 * its reply when SLEEPHY_DEV_CODES=1, and the renderer fills the field with it.
 * The username is chosen afterwards, in the profile, exactly as a person would.
 */

let seq = 0;

/** A unique, valid E.164 number. */
function nextPhone() {
  seq += 1;
  const stamp = String(Date.now()).slice(-6);
  const tail = String(seq).padStart(2, '0');
  return '+7999' + stamp + tail;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sign in (creating the account on a new number) and reach the main screen. */
async function signInWithPhone(win, serverUrl, { phone, username } = {}) {
  const number = phone || nextPhone();
  await win.fill('#server-url', serverUrl);
  await win.fill('#auth-phone', number);
  await win.click('#btn-auth');
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

module.exports = { nextPhone, signInWithPhone, claimUsername, setAccountPassword };
