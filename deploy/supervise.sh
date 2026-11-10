#!/usr/bin/env bash
#
# Supervise the SleePhy relay: keep it listening, and restart it the moment it
# exits. A single instance is enforced with a lock file, so running this twice
# (a new shell, a cron tick, a manual start) never starts a second relay.
#
#   SLEEPHY_PORT       port to listen on            (default 12000)
#   SLEEPHY_DB         sqlite database path         (default server/sleephy.db)
#   SLEEPHY_DOWNLOADS  directory holding the page   (default dist)
#   SLEEPHY_LOG        log file                     (default .runtime/relay.log)
#   SLEEPHY_RESTART_MS pause before a restart       (default 2000)
#
# Run it detached so it outlives the shell that started it:
#   setsid nohup /workspace/project/deploy/supervise.sh >/dev/null 2>&1 < /dev/null &
#
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export SLEEPHY_PORT="${SLEEPHY_PORT:-12000}"
export SLEEPHY_DB="${SLEEPHY_DB:-$ROOT/server/sleephy.db}"
export SLEEPHY_DOWNLOADS="${SLEEPHY_DOWNLOADS:-$ROOT/dist}"
LOG="${SLEEPHY_LOG:-$ROOT/.runtime/relay.log}"
RESTART_MS="${SLEEPHY_RESTART_MS:-2000}"
MAX_LOG_BYTES=$((10 * 1024 * 1024))

mkdir -p "$(dirname "$LOG")" "$ROOT/.runtime"
LOCK="$ROOT/.runtime/relay.lock"

# Only one supervisor may run. The lock is held for the life of the process and
# released by the kernel even on SIGKILL, so a crashed run never wedges the port.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[supervise] another supervisor already holds $LOCK; exiting" >> "$LOG"
  exit 0
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

rotate() {
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1"
    log "log rotated (previous kept as $LOG.1)"
  fi
}

log "supervisor starting: port=$SLEEPHY_PORT db=$SLEEPHY_DB downloads=$SLEEPHY_DOWNLOADS"

while true; do
  rotate
  node "$ROOT/server/index.js" >> "$LOG" 2>&1
  code=$?
  log "relay exited (code $code); restarting in ${RESTART_MS}ms"
  sleep "$(awk "BEGIN{print $RESTART_MS/1000}")"
done
