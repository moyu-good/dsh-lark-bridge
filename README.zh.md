<p align="center">
  <img src="https://img.shields.io/badge/dsh--lark--bridge-0.2.0-blueviolet" alt="version">
  <img src="https://img.shields.io/badge/coverage-153%20tests-green" alt="tests">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>把 DeepSeek Harness 的编码智能搬进飞书</b><br/>
  <i>在飞书/Lark 里跑完整的编码代理——原生思考过程、审批卡片、Slash 命令、实时 reaction。</i>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="#快速开始">快速开始</a> · <a href="#能力">能力</a> · <a href="#配置">配置</a> · <a href="#开发">开发</a>
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

## ✨ 能力

| | |
|---|---|
| 🧠 **原生思考过程** | `cot` 模式下，模型的 reasoning 渲染为飞书原生"思考中"消息，工具调用带图标、结果以代码块展示；旧客户端可用 `stream` 打字机卡片 |
| ✅ **Live Reaction** | 每条消息实时反馈：收到 `OK` → 思考 `THINKING` → 完成 `DONE`（失败 `ERROR`），状态互替不堆叠，可配置 |
| 🗂️ **一会话一 Agent** | `sessionScope` 控制粒度：整个 chat / 话题 thread / 单 sender；会话持久化，重启后恢复 |
| 📋 **审批卡片** | host 的审批问题渲染为「允许一次 / 拒绝」按钮卡片，点击即决策，卡片回写决策人与结果 |
| 🔑 **扫码注册** | 首次启动打印二维码，扫码自动创建飞书应用（含事件订阅），凭据持久化 |
| ⚡ **Slash 面板** | `/stop` 取消当前任务、`/help` 帮助；`syncSlashCommands` 把命令同步到 bot 的 `/` 面板 |
| 🖼️ **图片输入（可选）** | `attachImages` 下载聊天图片进 host 附件库，随模型请求发送 |
| 🏷️ **Workspace 分组** | 聊天会话自动挂到 host workspace，不流落到 Ungrouped |
| 🔒 **授权窄化** | `senderAllowlist` / `groupAllowlist` / `approvers` 可在 app 可见范围内进一步收窄 |
| 🧩 **深度 dsh 适配** | 所有能力走 host 服务契约：`agents` / `agentPresets` / `agentDefaultModel` / `settings` / `workspaceRegistry` / `loader` / `invariants` / `approval`，包自包含，无需 host 源码 |

## 🚀 快速开始

```sh
npx @deepseek-ai/dsh plugin --profile web add --allow-build=dsh-lark-bridge github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web
```

控制台打印二维码 → 用飞书扫码创建应用 → 在 Settings → Models 填入 DeepSeek API Key → 私聊 bot 或群里 @ 它。

> 已经在用 `dsh`？去掉 `npx @deepseek-ai/` 前缀即可。

## ⚙️ 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `appId`、`appSecret` | 首次启动扫码注册 | 飞书/Lark 应用凭证 |
| `domain` | 飞书 | 开放平台域名；Lark 用 `https://open.larksuite.com` |
| `cwd` | 宿主进程 cwd | 会话 Agent 的绝对工作目录 |
| `provider`、`model` | 宿主 `agentDefaultModel` | 会话 Agent 的模型路由 |
| `preset` | roster 默认 | 部署组合了 roster 时，会话 Agent 加入的 preset |
| `sessionScope` | `chat` | `chat`（整个会话共用一个）/ `chat-thread`（每个话题各自一个）/ `chat-sender`（共享会话里每人一个） |
| `output` | `cot` | `cot`（原生思考过程 + markdown 答案）或 `stream`（每轮一张打字机卡片） |
| `showProcess` | `true` | 展示 Agent 的推理与工具调用；关闭则只发答案 |
| `reactionFeedback` | `true` | 实时 reaction 反馈（OK → THINKING → DONE/ERROR） |
| `hideProcessWhenDone` | `false` | 运行结束后让平台收起该过程（仅 `cot`） |
| `attachImages` | `false` | 是否把图片传给模型。仅用于确实支持图片的路由 |
| `syncSlashCommands` | `true` | 把会话可用的命令注册到机器人 `/` 面板 |
| `denyTools` | `['ask_user_question', 'exit_plan_mode']` | 会话 Agent 不可调用的工具。默认值是人类交互工具 |
| `requireMention` | `true` | 群聊中仅在被 @ 时响应 |
| `senderAllowlist` | `[]` | 允许私聊的 open id；留空则服务应用可用范围内的任何人 |
| `groupAllowlist` | `[]` | 非空时仅服务这些 `oc_…` 群会话；空=任意群 |
| `approvers` | `[]` | 允许作答审批的 open id；空=能驱动该会话的人都可以 |

凭据三层解析，后者覆盖前者：bundle patch 配置 → settings 文档插件区 → 首次扫码注册。

## 🧭 架构

```
飞书 / Lark  ── WebSocket 长连接 ──►  dsh-lark-bridge  ── host 服务契约 ──►  DeepSeek Harness
   (聊天/审批/图片)                         │                                        │
                                          ▼                                        ▼
                                   reaction 状态机                        agents / sessions / tools
                                   cot / stream 渲染器                     approval / workspace / settings
```

## 🛠️ 开发

```sh
pnpm install
pnpm run build    # tsc + tsdown
pnpm test         # vitest (237 tests)
node plugin-contract-test.mjs   # 独立契约测试（32/32）
```

仓库自包含：仅依赖已发布的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@larksuite/channel` 编译，从不需要宿主源码检出。

## 🚀 部署与多实例

单个实例：

```sh
bash run-dsh-web.sh chat          # 启动 chat profile（嘟嘟嘟）
bash safe-restart.sh              # 安全重启（活跃会话会拒绝，--force 覆盖）
bash safe-restart.sh --profile chat   # 只重启 chat 实例
```

多个 profile 可同时运行（彼此完全隔离：各自的 cordis.patch.yml、会话目录、模型路由）——一个跑飞书 app，另一个跑 web 控制台，互不干扰：

```sh
bash scripts/multi-profile.sh status             # 查看所有实例
bash scripts/multi-profile.sh start chat web     # 启动多个实例
bash scripts/multi-profile.sh stop chat          # 安全停止一个（活跃会话会拒绝）
bash scripts/multi-profile.sh stop chat --force  # 强制停止
bash scripts/multi-profile.sh restart chat       # 重启一个
bash scripts/multi-profile.sh logs chat          # 跟踪某个实例的日志
```

实例日志在 `/home/user/.dsh/logs/<profile>.log`。

## 📋 已知限制

- 通道级配置（appId/appSecret/requireMention/白名单）由 transport 持有，改动需重启；其余配置编辑 profile 的 `cordis.patch.yml` 后由 dsh 的 Config-only HMR 自动生效（`/config` 可查看当前生效值）
- 长连接中断期间到达的事件不重放（传输层无游标；出站发送由 replay 队列兜底）
- 飞书 app 需要把事件订阅方式设为**长连接**（自建应用），webhook 模式收不到事件

## 📄 许可

BSD-3-Clause。架构启发自 [dsh-lark](https://github.com/Roy-oss1/dsh-lark)（同为 BSD-3-Clause）。
