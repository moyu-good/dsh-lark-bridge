#!/usr/bin/env bash
# dsh 升级验证一键跑：契约门禁 → 类型检查 → 反向排查 → 测试 → 构建。
# 任何一步失败即停，不继续往下走（避免"带着漂移去部署"）。
#
# 用法:
#   scripts/verify-upgrade.sh              # 全量
#   scripts/verify-upgrade.sh --quick      # 跳过测试（改文档/注释时用）
#
# 升级后仍需人工闸门：真的发一条飞书消息确认会话能建。
set -euo pipefail

cd "$(dirname "$0")/.."
QUICK="${1:-}"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "1/5 契约漂移（对照 dsh 上游 master）"
npm run --silent contract-drift || fail "契约漂移门禁未通过"

step "2/5 类型检查（桥接镜像 vs 真实 API）"
npm run --silent typecheck || fail "类型检查未通过"

step "3/5 反向排查（host.ts 镜像项逐个在 0.1.7 里找）"
if [ -n "${DSH_HOME:-}" ] || [ -d "$HOME/../../PROJECT" ]; then
  node scripts/audit-host-contract.mjs || fail "反向排查发现缺失方法"
else
  echo "  跳过：未找到 dsh 安装目录（设 DSH_HOME 启用）"
fi

if [ "$QUICK" != "--quick" ]; then
  step "4/5 全量测试"
  npm test || fail "测试未通过"
else
  echo ""
  echo "  [--quick] 跳过测试"
fi

step "5/5 构建"
npm run --silent build || fail "构建失败"

printf '\n\033[32m✓ 自动闸门全部通过\033[0m\n'
printf '\n\033[33m⚠ 还剩人工闸门：重启服务后，真的发一条飞书消息给生产 bot，\033[0m\n'
printf '\033[33m  确认会话能创建、能回复。`systemctl is-active` 返回 active 不代表能用。\033[0m\n'
