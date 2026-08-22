#!/usr/bin/env bash
# dsh 桥 PC 版能力补齐——真实模型 eval 套件（headless 进程级，非 mock）。
# 用法: OPENCODE_GO_API_KEY=... bash scripts/eval-live.sh
# 产出: 每项 PASS/FAIL + 模型回答原文；退出码 0 = 全过。
#
# eval 发现的需求（2026-08-22）：
#   E1 headless/无审批通道环境里 terminal 被 sandbox 拒绝 → eval 需显式
#      danger-full-access + defaultPreset；飞书桥有审批卡不受影响。
#   （后续发现继续追加在这里）
set -u
DSH=[HARNESS_DIR]/apps/cli/lib/bin.js
PATCH=/tmp/dsh-eval-patch.yml
: "${OPENCODE_GO_API_KEY:?export OPENCODE_GO_API_KEY first}"
pass=0; fail=0

run_eval() {
  local name="$1" expect="$2" prompt="$3"
  local out
  out=$(cd [HARNESS_DIR] && timeout 240 node "$DSH" --profile headless --patch "$PATCH" "$prompt" 2>&1 | tail -1)
  if [[ "$out" == *"$expect"* ]]; then
    echo "✅ $name → \"$out\""
    pass=$((pass+1))
  else
    echo "❌ $name — 期望含「$expect」，实际: \"$out\""
    fail=$((fail+1))
  fi
}

echo "== Code Mode (run_code) =="
run_eval "run_code 算术" "350" "Use run_code to compute 17*23-41 and reply with just the number, nothing else."

echo "== terminal 工具 =="
run_eval "terminal_open+send 回显" "bridge-eval-ok" \
  "Open a terminal session with terminal_open, send 'echo bridge-eval-ok' with terminal_send, read the output with terminal_read, then reply with just the output text."

echo "== fs/bash 基线 =="
run_eval "bash 算术基线" "7" "Run 'expr 3 + 4' in the shell and reply with just the number."

echo "== MCP 客户端（部署层注释态，桥侧无 eval 载体——跳过）=="

echo ""
echo "结果: $pass 通过 / $fail 失败"
exit $((fail > 0))
