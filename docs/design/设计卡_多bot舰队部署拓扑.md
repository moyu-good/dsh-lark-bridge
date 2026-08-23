# 设计卡：多 bot 舰队部署拓扑（斯卡哈 / 股神 / 嘟嘟嘟）

> 状态：现行设计 · 2026-08-23 建档（含当日全部实战定版）
> 本文回答「哪个 bot 用什么模型、走哪条链路、配置改哪里、出事查哪边」。

## 1. 拓扑总览

```
飞书开放平台 (WS 长连接 ×3 独立 app)
  ├─ 斯卡哈 cli_aaf28b… ← dsh-feishu-chat.service
  │     dsh 进程内 feishu-channel 插件 → pi-ai → opencode-go 直连 zen/go/v1
  │     配置：cordis.patch.yml + settings.yaml ｜ 凭证：env-scathach.env（yue 邮箱 key）
  ├─ 股神 cli_a941642a… ← cc-connect-ths.service
  │     cc-connect(Go) → opencode CLI → zen-go/v1 直连
  │     配置：ths.toml + ~/.config/opencode/opencode.json（key=Hermes 本体同款）
  └─ 嘟嘟嘟 cli_a9416248… ← lark-channel-bridge.service
        lark-channel-bridge(node) → codex CLI → 127.0.0.1:8791 代理 → 上游路由
        配置：~/.codex/config.toml ｜ 代理：opencode_go_proxy.py（systemd 常驻，监听 127.0.0.1:8791）
```

**铁律**：三族互不相干。改 A 的配置 B 出问题 = 改错了服务；重启命令各归各（见下表），一条 systemctl 里混入 hermes-gateway 字样会整条被守卫拦截。

| bot | 重启 | 日志 |
|---|---|---|
| 斯卡哈 | `systemctl restart dsh-feishu-chat` | journalctl -u dsh-feishu-chat |
| 股神 | `systemctl restart cc-connect-ths` | journalctl -u cc-connect-ths |
| 嘟嘟嘟 | `systemctl restart lark-channel-bridge` | journalctl -u lark-channel-bridge |

## 2. 模型通道现状（2026-08-23 定版）

| bot | 当前模型 | 通道 | 备注 |
|---|---|---|---|
| 斯卡哈 | ox-alpha-free | dsh pi-ai **openai-completions** 直连 zen/go/v1 | 思考链需 reasoning 流；上游抽风时 reasoning 消失/network_error（8/22-23 实测）|
| 股神 | ox-alpha-free | opencode CLI 直连 zen-go | external_directory 白名单已整树放行 |
| 嘟嘟嘟 | ox-alpha-free（临时）→ 8/28 切回百炼 flash-0817/0731 | codex responses → 8791 OX-SYNTH | cron 2f68bc2c384c 自动切回 |

**额度池区分（关键）**：zen-go 月配额（股神/Hermes 共享，~9/4 重置）≠ 百炼 token-plan 周配额（8/28 17:30 重置）≠ ox 免费层（无月配额但限速+不稳）。一方 429 不代表另一方没量。

## 3. codex ↔ ox 兼容层（8791 代理 OX-SYNTH 分支）

**为什么必须存在**：ox 上游只给 chat/completions；codex v0.146 只认 responses（`wire_api="chat"` 已删除，写了整个 codex 拒载）。中间必须有协议转换——社区同款方案（opencode-cc 等），没有官方直连配置。

OX-SYNTH 行为：仅 `model==ox-alpha-free` 且客户端要流时生效——缓冲上游全量响应→解析重组→合成自洽 SSE（created→in_progress→item.added→part/delta/done→item.done→completed）。解析三重保险：
1. added 包自带数据保留（该上游有时直接在 added 给全量）
2. delta 累计兜底
3. response.completed 的 output 为权威源（若上游给了就采用）

**已知上游 bug（非本地问题，别修代理）**：多轮循环中随机发空 function_call（arguments 空、completed 无 output、output_tokens≈6）→ codex 报 EOF parse 重试。诊断日志 `[ox-synth] EMPTY-ARGS fc!` 已内置。

**验证法**：`cd /tmp && timeout <宽> codex exec --skip-git-repo-check --output-last-message <file> "<任务>"` —— exit=0 且文件非空才算过；裸跑 tail 看不到正文缺失。

## 4. 故障速查表（症状→归属→第一动作）

| 症状 | 归属 | 第一动作 |
|---|---|---|
| `external_directory … auto-rejecting` | 股神 | opencode.json 白名单（整树 *+** 成对），restart cc-connect-ths，双场景实测 |
| 回复空/不回但服务 active | 嘟嘟嘟 | journalctl -u opencode-proxy 看 [ox-synth]；--output-last-message 验证 |
| PI_AI_ERROR: network_error / 思考链消失 | 上游网关抖动 | 探测直连端点定性；桥侧零问题，等恢复或临时切 DeepSeek 官方 provider |
| 429 Monthly usage limit | 对应额度池爆 | 对照 §2 额度池表换道 |
| ws client closed manually | 双实例互踢 | `ps aux \| grep bin.js --profile chat` 数进程，必须=1 |

## 5. 自启动与开机链路

systemd 四服务 enabled（dsh-feishu-chat / cc-connect-ths / lark-channel-bridge / opencode-proxy）；Windows Startup vbs 仅「唤醒 WSL + systemctl start」，对已运行服务幂等，无双开风险。nanobot-gateway 已死（disabled+inactive）。start-bridge.vbs 同款安全。
