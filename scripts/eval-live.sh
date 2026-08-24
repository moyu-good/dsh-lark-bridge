#!/usr/bin/env bash
# dsh 桥 PC 版能力补齐——真实模型 eval 套件（headless 进程级，非 mock）。
# 用法: OPENCODE_GO_API_KEY=... bash scripts/eval-live.sh
# 产出: 每项 PASS/FAIL + 模型回答原文；退出码 0 = 全过。
#
# eval 发现的需求（2026-08-22）：
#   E1 headless/无审批通道环境里 terminal 被 sandbox 拒绝 → eval 需显式
#      danger-full-access + defaultPreset；飞书桥有审批卡不受影响。
#   E1b(08-24)：headless 还需 agent-presets(default:standard) 编入 patch，
#   否则模型面零工具（terminal 全家不可用，模型回退 bash 但 eval 断言失败）。
#   （后续发现继续追加在这里）
# 路径约定（2026-08-23）：DSH_HARNESS_CLI 必填；凭证走环境变量，不写死任何机器。
set -u
# 部署层注入路径，脚本本身不持有本机绝对路径（开发行为红线：公私分离）
DSH="${DSH_HARNESS_CLI:?export DSH_HARNESS_CLI=/path/to/dsh-cli-entry.js first}"
PATCH="${DSH_EVAL_PATCH:-/tmp/dsh-eval-patch.yml}"
: "${OPENCODE_GO_API_KEY:?export OPENCODE_GO_API_KEY first}"
pass=0; fail=0

run_eval() {
  local name="$1" expect="$2" prompt="$3"
  local out
  out=$(cd "$(dirname "$DSH")" && timeout 240 node "$DSH" --profile headless --patch "$PATCH" "$prompt" 2>&1)
  # E1b(2026-08-24)：取全文匹配——模型多行回复(围栏等)曾被 tail -1 截断误判
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
