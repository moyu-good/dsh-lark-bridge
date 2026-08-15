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
#   bash safe-restart.sh                    # refuse if busy, else kill the chat instance
#   bash safe-restart.sh --force            # kill regardless (operator override)
#   bash safe-restart.sh [--force] --profile <name>   # target ONE profile's instance
#   bash safe-restart.sh [--force] all      # every running instance
#
# "Busy" = the session log gained a step/start with no matching turn/end
# since the bridge booted, OR the session log mtime is newer than the
# bridge process start time (an agent is actively writing).

set -u

BRIDGE_PATTERN="apps/cli/lib/bin.js"
LOG_DIR="/home/user/.dsh/sessions/--mnt-d-PROJECT-deepseek-harness--"
FORCE=""
PROFILE=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --profile) ;;
    --profile=*) PROFILE="${arg#*=}" ;;
    all) PROFILE="all" ;;
    *) PROFILE="$arg" ;;
  esac
done

# Match one profile's instance: bin.js web runs the default web profile,
# bin.js --profile <name> runs a named one. Default (no args) keeps the
# legacy behaviour: every running instance.
case "$PROFILE" in
  ""|all) MATCH="apps/cli/lib/bin.js" ;;
  web)    MATCH="apps/cli/lib/bin.js web" ;;
  chat)   MATCH="apps/cli/lib/bin.js --profile chat" ;;
  *)      MATCH="apps/cli/lib/bin.js --profile $PROFILE" ;;
esac

# Find the bridge pid(s) (the node process, not the bash wrapper).
mapfile -t BRIDGE_PIDS < <(pgrep -f "$MATCH" || true)

if [[ ${#BRIDGE_PIDS[@]} -eq 0 ]]; then
  echo "safe-restart: no bridge running${PROFILE:+ for profile '$PROFILE'}, nothing to do."
  exit 0
fi

echo "safe-restart: found ${#BRIDGE_PIDS[@]} instance(s) (${BRIDGE_PIDS[*]})${PROFILE:+ for profile '$PROFILE'}."

busy=0
for BRIDGE_PID in "${BRIDGE_PIDS[@]}"; do
  BRIDGE_START="$(ps -o lstart= -p "$BRIDGE_PID" 2>/dev/null | awk '{print $2, $3, $4, $5, $6}')"
  BRIDGE_START_EPOCH="$(date -d "$BRIDGE_START" +%s 2>/dev/null || echo 0)"

  for log in "$LOG_DIR"/*/session.jsonl.zstd; do
    [[ -f "$log" ]] || continue
    mtime="$(stat -c %Y "$log")"
    # Any session still being written after the bridge booted is live.
    if [[ "$mtime" -gt "$BRIDGE_START_EPOCH" ]]; then
      echo "safe-restart: session $(basename "$(dirname "$log")") is actively writing (mtime $mtime > boot $BRIDGE_START_EPOCH)."
      busy=1
    fi
  done
done

if [[ "$busy" -eq 1 && "$FORCE" != "--force" ]]; then
  echo "safe-restart: REFUSING to restart — a session is mid-turn."
  echo "  Wait for it to finish, or override with: bash safe-restart.sh --force"
  exit 3
fi

if [[ "$busy" -eq 1 ]]; then
  echo "safe-restart: --force given, killing bridge anyway."
else
  echo "safe-restart: no live turn detected, restarting."
fi

for BRIDGE_PID in "${BRIDGE_PIDS[@]}"; do
  kill "$BRIDGE_PID" 2>/dev/null || true
done
pkill -f "run-dsh-web.sh" 2>/dev/null || true
exit 0
