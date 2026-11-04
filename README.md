# Belka VPN

A modern, animated desktop VPN client. Dark theme, mint/coral state accents,
and a per-user key model — every user enters their **own** VPN key, so no
credential is ever shared or shipped inside the app.

![state](build/icon.png)

## Features

- Connect / disconnect state machine with animated transitions
- Pulsing ring + spinner while connecting; checkmark badge when protected
- Live session timer (`CONNECTED FOR` / `LAST SESSION`)
- Server picker (slide-down dropdown), quick-connect cards, protocol picker
- Kill-switch toggle with a sliding knob
- Per-user key entry (stored locally, `0600`, never bundled)

## Run locally

```bash
npm install
npm start
```

## Build a Windows `.exe`

The Windows installer must be built **on Windows** (Electron cannot
cross-compile it from Linux). Two options:

### Option A — build on your own Windows PC

```bash
npm install
npm run dist
# → dist/Belka VPN Setup <version>.exe   (NSIS installer)
```

### Option B — let GitHub build it (no Windows PC needed)

A workflow at `.github/workflows/build.yml` builds the installer on a free
`windows-latest` runner.

1. Push this repo to GitHub.
2. Go to **Actions → Build Belka VPN → Run workflow**.
3. Download the `BelkaVPN-windows-installer` artifact when it finishes.
4. To publish a public download, push a tag: `git tag v0.1.0 && git push --tags`.
   The `.exe` is attached to the GitHub Release automatically.

## Enabling the VPN engine

The UI and packaging are complete. To make "Connect" establish a real tunnel,
bundle the engine binary in `bin/`:

- **WireGuard (Windows):** place `wireguard.exe` (from the official WireGuard
  for Windows client) plus `wintun.dll` in `bin/`. The app calls
  `/installtunnelservice` with the user's saved config and needs elevation.
- **VLESS / xray-core:** place the xray-core binary in `bin/` and extend
  `main.js` to launch it with the user's subscription config.

Without an engine present, the app runs and animates correctly; connect
returns a clear message instead of failing silently.

## Project layout

```
main.js              Electron main process — window, config storage, engine control
preload.js           Secure IPC bridge (contextIsolation on)
src/index.html       UI markup
src/styles.css       Theme + animations
src/renderer.js      State machine, timer, dropdowns, toggle
build/icon.*         App icon (squirrel logo)
.github/workflows/   Windows .exe build pipeline
```

## Security notes

- `contextIsolation` is on; `nodeIntegration` is off.
- User keys are stored in the app's `userData` dir with `0600` permissions.
- Keys are never embedded in the build or committed to the repo.
