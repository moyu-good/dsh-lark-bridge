<p align="center">
  <img src="https://img.shields.io/badge/dsh--lark--bridge-0.2.0-blueviolet" alt="version">
  <img src="https://img.shields.io/badge/coverage-153%20tests-green" alt="tests">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>把 DeepSeek Harness 的编码智能搬进飞书</b><br/>
  <i>Run a full coding agent inside Feishu/Lark — with native thinking process,
  approval cards, slash commands, and live reactions.</i>
</p>

<p align="center">
  <a href="README.zh.md">中文</a> · <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#configuration">Configuration</a> · <a href="#development">Development</a>
</p>

---

## 这是什么？

`dsh-lark-bridge` 是一个 **飞书/Lark 即时通讯机器人通道**，让 DeepSeek Harness 的编码代理直接在聊天里工作：

- 每条会话（私聊 / 群聊）驱动一个独立的 dsh agent
- **思考过程实时可见** —— 用飞书原生的"思考中"消息渲染 reasoning，不再黑盒
- **审批卡片** —— 需要确认的操作变成可点击的卡片（允许一次 / 拒绝）
- **reaction 反馈** —— 收到 `OK` → 思考 `THINKING` → 完成 `DONE` / 失败 `ERROR`，一眼看清状态
- 走 WebSocket 长连接，**不需要公网回调地址**

本质是"嫁接"：飞书只是载体，真正干活的还是 DeepSeek Harness 本体。模型组以 dsh 为基准 —— DeepSeek API 有思考链，飞书就必须显示思考链，功能不减。

## ✨ Features

| | |
|---|---|
| 🧠 **原生思考过程** | `cot` 模式下，模型的 reasoning 渲染为飞书原生"思考中"消息，工具调用带图标、结果以代码块展示；旧客户端可用 `stream` 打字机卡片 |
| ✅ **Live Reaction** | 每条消息实时反馈：收到 `OK` → 思考 `THINKING` → 完成 `DONE`（失败 `ERROR`），状态互替不堆叠，可配置 |
| 🗂️ **一会话一 Agent** | `sessionScope` 控制粒度：整个 chat / 话题 thread / 单 sender；会话持久化，重启后恢复 |
| 📋 **审批卡片** | host 的审批问题渲染为「允许一次 / 拒绝」按钮卡片，点击即决策，卡片回写决策人与结果 |
| 🔑 **扫码注册** | 首次启动打印二维码，扫码自动创建飞书应用（含事件订阅），凭据持久化 |
| ⚡ **Slash 面板** | `/stop` 取消当前任务、`/help` 帮助；`syncSlashCommands` 把命令同步到 bot 的 `/` 面板 |
| 🌐 **Bilingual commands** | Slash panel and `/help` descriptions follow the platform: English on Lark (international), Chinese on Feishu (domestic); `locale` overrides |
| 🖼️ **图片输入（可选）** | `attachImages` 下载聊天图片进 host 附件库，随模型请求发送 |
| 🏷️ **Workspace 分组** | 聊天会话自动挂到 host workspace，不流落到 Ungrouped |
| 🔒 **授权窄化** | `senderAllowlist` / `groupAllowlist` / `approvers` 可在 app 可见范围内进一步收窄 |
| 🧩 **深度 dsh 适配** | 所有能力走 host 服务契约：`agents` / `agentPresets` / `agentDefaultModel` / `settings` / `workspaceRegistry` / `loader` / `invariants` / `approval`，包自包含，无需 host 源码 |

## 🚀 Quick Start

```sh
npx @deepseek-ai/dsh plugin --profile web add --allow-build=dsh-lark-bridge github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web
```

控制台打印二维码 → 用飞书扫码创建应用 → 在 Settings → Models 填入 DeepSeek API Key → 私聊 bot 或群里 @ 它。

> 已经在用 `dsh`？去掉 `npx @deepseek-ai/` 前缀即可。

## ⚙️ Configuration

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR registration | Feishu/Lark app credentials |
| `domain` | Feishu | Open-platform domain; Lark: `https://open.larksuite.com` |
| `cwd` | host process cwd | Absolute workspace directory for chat agents |
| `provider`, `model` | host `agentDefaultModel` | Model routing for chat agents |
| `preset` | roster default | Agent preset chat agents join |
| `sessionScope` | `chat` | `chat` / `chat-thread` / `chat-sender` |
| `output` | `cot` | `cot` (native thinking process) or `stream` (typewriter card) |
| `showProcess` | `true` | Show reasoning and tool calls |
| `reactionFeedback` | `true` | Live reaction feedback (OK → THINKING → DONE/ERROR) |
| `hideProcessWhenDone` | `false` | Hide finished process (`cot` only) |
| `attachImages` | `false` | Pass chat images to the model |
| `syncSlashCommands` | `true` | Publish commands to bot's `/` panel |
| `locale` | `auto` | Command description language: `auto` (Lark→en, Feishu→zh) / `zh` / `en` |
| `denyTools` | `['ask_user_question', 'exit_plan_mode']` | Tools chat agents may not call |
| `requireMention` | `true` | In groups, only respond when @-mentioned |
| `senderAllowlist` | `[]` | Open ids allowed to DM |
| `groupAllowlist` | `[]` | Only these `oc_…` group chats when non-empty |
| `approvers` | `[]` | Open ids allowed to answer approvals |

凭据三层解析，后者优先：bundle patch 配置 → settings 文档插件区 → 首次扫码注册。

## 🧭 架构

```
Feishu / Lark  ── WebSocket 长连接 ──►  dsh-lark-bridge  ── host 服务契约 ──►  DeepSeek Harness
   (聊天/审批/图片)                         │                                        │
                                          ▼                                        ▼
                                   reaction 状态机                        agents / sessions / tools
                                   cot / stream 渲染器                     approval / workspace / settings
```

## 🛠️ Development

```sh
pnpm install
pnpm run build    # tsc + tsdown
pnpm test         # vitest (153 tests)
node plugin-contract-test.mjs   # standalone contract tests (32/32)
```

仓库自包含：只依赖发布的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@larksuite/channel`，不需要 host 源码。

## 📋 Known limitations

- 配置启动时读取一次，修改需重启
- 长连接断开期间的事件不重放（transport 无 cursor）
- 飞书应用必须使用**长连接**事件订阅（自建应用）；webhook 模式收不到事件

## 📄 License

BSD-3-Clause. Architecture inspired by [dsh-lark](https://github.com/Roy-oss1/dsh-lark) (also BSD-3-Clause).
