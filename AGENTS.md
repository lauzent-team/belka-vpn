# AGENTS.md — Belka VPN

## What this repo is
Electron desktop VPN client ("Belka VPN"). Dark theme, animated state machine.
Per-user key model: each user enters their own VPN config; nothing is bundled.

## Build / run
- `npm install` then `npm start` (dev).
- Windows installer: `npm run dist` — must run on Windows. Linux build: `npm run dist:linux`.
- CI: `.github/workflows/build.yml` builds the `.exe` on `windows-latest` and
  attaches it to a GitHub Release on `v*` tags.

## Layout
- `main.js` — main process: window, config storage (`userData/config.json`, 0600),
  engine spawn. Engine binaries resolved from `bin/` or `resources/bin`.
- `preload.js` — contextBridge API (`window.belka`).
- `src/index.html|styles.css|renderer.js` — UI, theme, animations, state machine.

## Conventions
- Keep `contextIsolation: true`, `nodeIntegration: false`.
- Never embed user keys/subscriptions in the app or repo.
- The renderer has a browser fallback bridge (localStorage) so the UI can be
  previewed by serving `src/` statically — keep it in sync with `preload.js`.

## Environment notes
- No X display / xvfb in the build sandbox; Electron can't render headlessly
  there. Verify UI by serving `src/` and opening in a browser instead.
- No PIL/cairosvg; icons are generated with pure-Python zlib/struct.
