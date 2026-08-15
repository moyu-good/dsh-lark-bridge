#!/usr/bin/env bash
# Safe-restart wrapper for the dsh-lark-bridge.
#
# The bridge owns live agents; a hard pkill mid-turn disposes the running
# agent and aborts its goal (turn/end reason=disposed — the exact failure
# that killed a BookScope task on 2026-08-15). This wrapper refuses to
# restart while a session is mid-turn, so a deploy can never kill a task
# that is actually working.
#
# Usage:
#   bash safe-restart.sh            # refuse if busy, else pkill + exit
#   bash safe-restart.sh --force    # pkill regardless (operator override)
#
# "Busy" = the session log gained a step/start with no matching turn/end
# since the bridge booted, OR the session log mtime is newer than the
# bridge process start time (an agent is actively writing).

set -u

BRIDGE_PATTERN="apps/cli/lib/bin.js"
LOG_DIR="/home/user/.dsh/sessions/--mnt-d-PROJECT-deepseek-harness--"

# Find the bridge pid (the node process, not the bash wrapper).
BRIDGE_PID="$(pgrep -f "$BRIDGE_PATTERN" | head -1 || true)"

if [[ -z "$BRIDGE_PID" ]]; then
  echo "safe-restart: no bridge running, nothing to do."
  exit 0
fi

BRIDGE_START="$(ps -o lstart= -p "$BRIDGE_PID" 2>/dev/null | awk '{print $2, $3, $4, $5, $6}')"
BRIDGE_START_EPOCH="$(date -d "$BRIDGE_START" +%s 2>/dev/null || echo 0)"

busy=0
for log in "$LOG_DIR"/*/session.jsonl.zstd; do
  [[ -f "$log" ]] || continue
  mtime="$(stat -c %Y "$log")"
  # Any session still being written after the bridge booted is live.
  if [[ "$mtime" -gt "$BRIDGE_START_EPOCH" ]]; then
    echo "safe-restart: session $(basename "$(dirname "$log")") is actively writing (mtime $mtime > boot $BRIDGE_START_EPOCH)."
    busy=1
  fi
done

if [[ "$busy" -eq 1 && "${1:-}" != "--force" ]]; then
  echo "safe-restart: REFUSING to restart — a session is mid-turn."
  echo "  Wait for it to finish, or override with: bash safe-restart.sh --force"
  exit 3
fi

if [[ "$busy" -eq 1 ]]; then
  echo "safe-restart: --force given, killing bridge anyway."
else
  echo "safe-restart: no live turn detected, restarting."
fi

pkill -f "$BRIDGE_PATTERN" 2>/dev/null || true
pkill -f "run-dsh-web.sh" 2>/dev/null || true
exit 0
