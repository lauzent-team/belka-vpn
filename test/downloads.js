'use strict';

/**
 * The relay also serves the download page and the built installer, so the host
 * people reach the relay on is the same one they download the app from.
 *
 * Only two shapes of name are ever read from disk: index.html and a
 * SleePhy-Setup-*.exe. These checks drive the real relay with a throwaway
 * download directory and confirm the page, the installer, and the refusals.
 *
 * Run with: node test/downloads.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 8806;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `sleephy-dl-${Date.now()}.db`);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sleephy-dl-'));
const EXE = 'SleePhy-Setup-9.9.9.exe';
const EXE_BYTES = Buffer.from('MZ fake installer payload');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS', name); }
  catch (err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path_) {
  const res = await fetch(BASE + path_);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  fs.writeFileSync(path.join(DIR, 'index.html'), '<!doctype html><title>SleePhy</title>');
  fs.writeFileSync(path.join(DIR, EXE), EXE_BYTES);
  fs.writeFileSync(path.join(DIR, 'secret.txt'), 'should never be served');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, SLEEPHY_PORT: String(PORT), SLEEPHY_DB: DB, SLEEPHY_DOWNLOADS: DIR },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await wait(1200);

  await step('the root serves the download page', async () => {
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.body.toString(), /SleePhy/);
  });

  await step('the installer is served as a download', async () => {
    const r = await get('/' + EXE);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.ok(r.body.equals(EXE_BYTES), 'the bytes must match the file exactly');
  });

  await step('health still answers', async () => {
    const r = await get('/health');
    assert.strictEqual(r.status, 200);
    assert.match(r.body.toString(), /sleephy-relay/);
  });

  await step('other files are not served', async () => {
    assert.strictEqual((await get('/secret.txt')).status, 404);
    assert.strictEqual((await get('/server-default.json')).status, 404);
    assert.strictEqual((await get('/sleephy.db')).status, 404);
  });

  await step('path traversal is refused', async () => {
    assert.strictEqual((await get('/../server/index.js')).status, 404);
    assert.strictEqual((await get('/..%2fserver%2findex.js')).status, 404);
    assert.strictEqual((await get('/SleePhy-Setup-9.9.9.exe/../../secret.txt')).status, 404);
  });

  await step('a missing installer is a clean 404', async () => {
    assert.strictEqual((await get('/SleePhy-Setup-0.0.0.exe')).status, 404);
  });

  server.kill();
  fs.rmSync(DIR, { recursive: true, force: true });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} download checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
