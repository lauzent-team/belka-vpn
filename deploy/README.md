# Keeping the SleePhy relay alive

The relay is the single host that does three jobs at once: it carries the
encrypted messages, answers `/health`, and hands out the download page and the
installer. If it stops, the public link answers `502 Bad Gateway`.

This folder holds everything needed to keep it running. Nothing here is required
to build the app — it is purely about uptime.

## Why the relay died before

Processes started inside a chat session are children of that session. When the
session ends, they are killed. Files on disk survive (`server/sleephy.db`,
`dist/`, `/workspace/relay-data/` all outlived earlier sessions); processes do
not. That is why the link worked while a session was open and returned `502`
later.

The fix is to (a) start the relay detached from any session, (b) restart it if it
exits, and (c) start it again when a new session begins.

## What is here

| File | What it does |
| --- | --- |
| `supervise.sh` | Runs the relay in a loop, restarting it the moment it exits. A lock file keeps exactly one supervisor running, so it is safe to launch twice. Rotates the log at 10 MB. |
| `healthcheck.sh` | One-shot check of `/health`. If nothing answers, it starts the supervisor. Safe to run repeatedly; a duplicate start is a no-op. |
| `sleephy-relay.service` | A systemd unit for a real server, where the OS itself can supervise the relay. Not used in the sandbox (no working systemd here). |

## Day-to-day use in the sandbox

Start (or verify) it in one line:

```bash
/workspace/project/deploy/healthcheck.sh
```

That is all. It is already wired into `~/.bashrc`, so opening any new shell
brings the relay back if it is down. To stop it on purpose:

```bash
pkill -f supervise.sh; pkill -f server/index.js
```

Watch it:

```bash
tail -f /workspace/project/.runtime/relay.log
curl -s http://127.0.0.1:12000/health
```

## Settings

All optional, read from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SLEEPHY_PORT` | `12000` | Port to listen on. `12000` is the public one. |
| `SLEEPHY_DB` | `server/sleephy.db` | Where accounts and messages are stored. |
| `SLEEPHY_DOWNLOADS` | `dist` | Directory holding the page and the installer. |
| `SLEEPHY_LOG` | `.runtime/relay.log` | Log file. |
| `SLEEPHY_RESTART_MS` | `2000` | Pause before a restart. |

## On a real server (the durable answer)

A sandbox is not a home for a live service: the environment can be torn down at
any time, and no amount of local supervision survives that. On a machine that
stays up, use systemd:

```bash
sudo useradd --system --home /opt/sleephy sleephy
sudo mkdir -p /opt/sleephy && sudo cp -r . /opt/sleephy/   # code + dist/
sudo cp deploy/sleephy-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sleephy-relay
sudo systemctl status sleephy-relay
```

`Restart=always` makes systemd itself the supervisor, and `enable` starts the
relay on every boot. Then put a TLS reverse proxy (Caddy or nginx) in front of
port `12000` so the `wss://` address in the installer keeps working.

## The honest limit

Nothing running inside this sandbox is permanent. The supervisor, the health
check and the shell hook keep the link alive for as long as the environment
exists, and bring it back quickly after a restart. For a link that never depends
on this environment, publish the installer (a GitHub Release is the easy route)
and run the relay on a host you control.
