#!/usr/bin/env bash
# Multi-profile instance manager for dsh + dsh-lark-bridge.
#
# Every dsh profile is fully isolated (own cordis.patch.yml, sessions, model
# routing), so several bridges can run side by side — a chat profile serving
# one Feishu app, a web profile serving the browser dashboard, more chat
# profiles for other apps/tenants. This script starts, stops, and reports
# them without the instances tripping over each other.
#
# Usage:
#   bash scripts/multi-profile.sh status                 # list every instance
#   bash scripts/multi-profile.sh start chat             # start the chat instance
#   bash scripts/multi-profile.sh start chat web         # start several at once
#   bash scripts/multi-profile.sh stop chat              # stop one (safe: refuses mid-turn)
#   bash scripts/multi-profile.sh stop chat --force      # stop even mid-turn
#   bash scripts/multi-profile.sh restart chat           # safe-restart one
#   bash scripts/multi-profile.sh logs chat              # tail one instance's log
#
# Logs live at /home/user/.dsh/logs/<profile>.log (plain tail-friendly files).

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/run-dsh-web.sh"
LOG_BASE="/home/user/.dsh/logs"
COMMAND="${1:-status}"
shift || true
FORCE=""
PROFILES=()

for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    *) PROFILES+=("$arg") ;;
  esac
done

mkdir -p "$LOG_BASE"

# Map a profile name to its process match pattern and running pids.
find_pids() {
  local profile="$1"
  case "$profile" in
    web)  pgrep -f "apps/cli/lib/bin.js web" || true ;;
    chat) pgrep -f "apps/cli/lib/bin.js --profile chat" || true ;;
    *)    pgrep -f "apps/cli/lib/bin.js --profile $profile" || true ;;
  esac
}

profile_running() {
  [[ -n "$(find_pids "$1")" ]]
}

start_one() {
  local profile="$1"
  if profile_running "$profile"; then
    echo "multi-profile: $profile already running (pid $(find_pids "$profile" | tr '\n' ' '))"
    return 0
  fi
  echo "multi-profile: starting $profile (log: $LOG_BASE/$profile.log)"
  nohup bash "$RUN" "$profile" >> "$LOG_BASE/$profile.log" 2>&1 &
  disown
  sleep 1
  if profile_running "$profile"; then
    echo "multi-profile: $profile up (pid $(find_pids "$profile" | tr '\n' ' '))"
  else
    echo "multi-profile: $profile failed to start — check $LOG_BASE/$profile.log"
  fi
}

stop_one() {
  local profile="$1"
  if ! profile_running "$profile"; then
    echo "multi-profile: $profile not running."
    return 0
  fi
  if [[ -n "$FORCE" ]]; then
    echo "multi-profile: force-stopping $profile."
    for pid in $(find_pids "$profile"); do kill "$pid" 2>/dev/null || true; done
    pkill -f "run-dsh-web.sh $profile" 2>/dev/null || true
  else
    bash "$ROOT/safe-restart.sh" --profile "$profile" || {
      echo "multi-profile: $profile refused — a session is mid-turn (use --force to override)."
      return 3
    }
  fi
  echo "multi-profile: $profile stopped."
}

status() {
  echo "=== dsh-lark-bridge instances ==="
  local any=0
  for profile in web chat; do
    if profile_running "$profile"; then
      local pids="$(find_pids "$profile" | tr '\n' ' ')"
      local started="$(ps -o lstart= -p "${pids%% *}" 2>/dev/null | awk '{print $2, $3, $4}')"
      echo "  $profile  RUNNING  pid(s): $pids  since: $started"
      any=1
    else
      echo "  $profile  stopped"
    fi
  done
  # Any other named profile.
  for dir in /home/user/.dsh/profiles/*/; do
    local name="$(basename "$dir")"
    [[ "$name" = "web" || "$name" = "chat" || "$name" = "node_modules" ]] && continue
    if profile_running "$name"; then
      echo "  $name  RUNNING  pid(s): $(find_pids "$name" | tr '\n' ' ')"
      any=1
    else
      echo "  $name  stopped"
    fi
  done
  [[ "$any" -eq 0 ]] && echo "  (no instances running)"
  return 0
}

case "$COMMAND" in
  status)
    status
    ;;
  start)
    [[ ${#PROFILES[@]} -eq 0 ]] && { echo "usage: multi-profile.sh start <profile...>"; exit 1; }
    for p in "${PROFILES[@]}"; do start_one "$p"; done
    ;;
  stop)
    [[ ${#PROFILES[@]} -eq 0 ]] && { echo "usage: multi-profile.sh stop <profile...> [--force]"; exit 1; }
    for p in "${PROFILES[@]}"; do stop_one "$p"; done
    ;;
  restart)
    [[ ${#PROFILES[@]} -eq 0 ]] && { echo "usage: multi-profile.sh restart <profile...> [--force]"; exit 1; }
    for p in "${PROFILES[@]}"; do stop_one "$p"; start_one "$p"; done
    ;;
  logs)
    [[ ${#PROFILES[@]} -eq 0 ]] && { echo "usage: multi-profile.sh logs <profile>"; exit 1; }
    tail -f "$LOG_BASE/${PROFILES[0]}.log"
    ;;
  *)
    echo "usage: multi-profile.sh {status|start|stop|restart|logs} [profile...] [--force]"
    exit 1
    ;;
esac
