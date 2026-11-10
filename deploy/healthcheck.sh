#!/usr/bin/env bash
#
# One-shot health check for the SleePhy relay. Start the supervisor if nothing
# answers on the port. Safe to run from cron every minute: the supervisor's own
# lock makes a duplicate start a no-op.
#
#   /workspace/project/deploy/healthcheck.sh
#
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SLEEPHY_PORT:-12000}"
URL="http://127.0.0.1:${PORT}/health"
LOG="${SLEEPHY_LOG:-$ROOT/.runtime/relay.log}"

if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
  exit 0
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health check failed for $URL; (re)starting supervisor" >> "$LOG"
setsid nohup "$ROOT/deploy/supervise.sh" >>"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true
exit 0
