<p align="center">
  <img src="https://img.shields.io/badge/dsh--lark--bridge-0.3.1-blueviolet" alt="version">
  <img src="https://img.shields.io/badge/tests-260-green" alt="tests">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>把 DeepSeek Harness 的编码智能搬进飞书</b><br/>
  <i>原生思考过程、审批卡片、实时 goal/todo 卡片、子代理 fan-out、双语 slash 面板——不需要公网回调地址。</i>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="#快速开始">快速开始</a> · <a href="#能力">能力</a> · <a href="#斜杠命令">斜杠命令</a> · <a href="#配置">配置</a> · <a href="#架构">架构</a> · <a href="#开发">开发</a>
</p>

---

## 这是什么？

`dsh-lark-bridge` 是一个 **飞书/Lark 即时通讯机器人通道**，让 DeepSeek Harness 的编码代理直接在聊天里工作：

- 每条会话（私聊 / 群聊）驱动一个独立的 dsh agent
- **思考过程实时可见** —— 用飞书原生的"思考中"消息渲染 reasoning，工具调用带图标、结果以代码块展示，不再黑盒
- **审批卡片** —— 需要确认的操作变成可点击的卡片（允许一次 / 拒绝），卡片回写决策人与结果
- **实时卡片流** —— goal 阶段变化、todo 快照、子代理 fan-out、上下文压缩结果，都在聊天里实时可见
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
| 🎯 **Goal 卡片** | goal 阶段（active/paused/blocked/complete）变化实时更新聊天卡片；`autoResumeGoals` 让重启后活跃 goal 自动恢复 |
| ✅ **Todo 卡片** | `todo_write` 快照实时更新聊天卡片，长任务不再静默 |
| 🧑💻 **子代理 fan-out** | workflow 运行以文本流呈现：run 开始、子代理开启/结束、run 结束 |
| 📦 **压缩透明化** | "正在压缩…" → 摘要文本 + 释放 token 数；修剪报告删除条数 |
| ⏰ **定时提醒** | `schedule_create/list/delete` 工具 + `/schedules` 视图（需在 dsh profile 组合 `@deepseek-ai/dsh-schedule`；桥已实现完整监听与渲染） |
| 🔍 **会话历史检索** | `/sessions <关键词>` 对本聊天已存历史做全文检索并展示摘要 |
| ⚙️ **后台任务通知** | `run_in_background` 任务与直接子代理结束时在聊天里播报结果 |
| ⚡ **完整 Slash 面板** | `/stop /help /preset /sessions /tools /schedules /audit /config` + 宿主命令（`goal`、`plan`、`compact`、`feedback`、`permission`） |
| 🌐 **双语命令** | slash 面板与 `/help` 的描述按平台自动选语言：Lark（国际版）英文、飞书（国内版）中文；`locale` 可强制指定 |
| 🖼️ **图片输入（可选）** | `attachImages` 下载聊天图片进 host 附件库，随模型请求发送 |
| 📎 **文件发送** | Agent 的 `send_file` 带 caption 直接投递到聊天 |
| 🔑 **扫码注册** | 首次启动打印二维码，扫码自动创建飞书应用（含事件订阅），凭据持久化 |
| 🔒 **授权窄化** | `senderAllowlist` / `groupAllowlist` / `approvers` 可在 app 可见范围内进一步收窄 |
| 🧩 **深度 dsh 适配** | 所有能力走 host 服务契约：`agents` / `agentPresets` / `agentDefaultModel` / `settings` / `workspaceRegistry` / `loader` / `invariants` / `approval` / `goals`，包自包含，无需 host 源码 |

## 🚀 快速开始

```sh
npx @deepseek-ai/dsh plugin --profile web add github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web
```

控制台打印二维码 → 用飞书扫码创建应用 → 在 Settings → Models 填入 DeepSeek API Key → 私聊 bot 或群里 @ 它。

> 已经在用 `dsh`？去掉 `npx @deepseek-ai/` 前缀即可。

**无需构建**：包已提交编译产物（`lib/` 进仓库），安装即用。`prepare` 钩子仅在编译产物缺失时（例如源码 clone 且无产物）自动重建。

## 💬 斜杠命令

| 命令 | 说明 |
|---|---|
| `/stop` | 取消当前任务 |
| `/help` | 显示本列表 |
| `/preset` | 查看/切换 agent 模式（standard / code / minimal / cordis） |
| `/sessions` | 查看本聊天的会话历史 |
| `/tools` | 运行时查看/禁用/恢复工具 |
| `/schedules` | 查看本聊天的定时提醒 |
| `/audit` | 本会话的操作审计摘要 |
| `/config` | 查看桥的当前配置 |
| `/goal` | 查看/设置目标（宿主命令） |
| `/plan` | 进入/退出计划模式（宿主命令） |
| `/compact` | 压缩较早对话历史（宿主命令） |
| `/feedback` | 提交本次会话反馈（宿主命令） |
| `/permission` | 切换权限模式（宿主命令） |

面板描述自动双语：平台域名为 `open.larksuite.com`（国际版 Lark）显示**英文**，`open.feishu.cn`（国内版飞书）显示**中文**；`locale: zh|en` 可强制指定。

## 与其他飞书/Lark 桥对比

| 能力 | **dsh-lark-bridge** | xmanrui/dsh-im | omdsh-dev/dsh-lark | AX1202/ax-feishu-bridge |
|---|---|---|---|---|
| 定位 | 深度 Harness 通道 | 多平台网关 | 扫码即用 | Pi + DSH 双桥 |
| 原生思考过程（飞书 CoT） | ✅ | — | — | — |
| 审批卡片 + 决策人留痕 | ✅ | — | — | 远程批准 |
| 实时 goal/todo 卡片 | ✅ | — | — | — |
| 工作流展开 + 阶段/日志行 | ✅ | — | — | — |
| 压缩透明化 | ✅ | — | — | — |
| 重启后 goal 自动续跑 | ✅ | — | 崩溃安全网 | — |
| 双语斜杠面板同步 | ✅ | — | — | 面板按钮 |

## ⚙️ 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `appId`、`appSecret` | 首次启动扫码注册 | 飞书/Lark 应用凭证 |
| `domain` | 飞书 | 开放平台域名；Lark 用 `https://open.larksuite.com` |
| `locale` | `auto` | 命令描述语言：`auto`（Lark→英文，飞书→中文）/ `zh` / `en` |
| `cwd` | 宿主进程 cwd | 会话 Agent 的绝对工作目录 |
| `provider`、`model` | 宿主 `agentDefaultModel` | 会话 Agent 的模型路由 |
| `preset` | roster 默认 | 部署组合了 roster 时，会话 Agent 加入的 preset |
| `sessionScope` | `chat` | `chat`（整个会话共用一个）/ `chat-thread`（每个话题各自一个）/ `chat-sender`（共享会话里每人一个） |
| `output` | `cot` | `cot`（原生思考过程 + markdown 答案）或 `stream`（每轮一张打字机卡片） |
| `showProcess` | `true` | 展示 Agent 的推理与工具调用；关闭则只发答案 |
| `reactionFeedback` | `true` | 实时 reaction 反馈（OK → THINKING → DONE/ERROR） |
| `hideProcessWhenDone` | `false` | 运行结束后让平台收起该过程（仅 `cot`） |
| `attachImages` | `false` | 是否把图片传给模型。仅用于确实支持图片的路由 |
| `syncSlashCommands` | `true` | 把会话可用的命令注册到机器人 `/` 面板（幂等 reconcile：创建缺失、移除过期、刷新漂移描述） |
| `autoResumeGoals` | `false` | 重启后会话回来时自动 re-arm 活跃 goal，部署不再静默杀死进行中的任务 |
| `approvalReminderMs` | `0` | 审批卡此毫秒数未处理时发提醒（0 = 关闭） |
| `denyTools` | `[]` | 会话 Agent 不可调用的工具 |
| `requireMention` | `true` | 群聊中仅在被 @ 时响应 |
| `senderAllowlist` | `[]` | 允许私聊的 open id；留空则服务应用可用范围内的任何人 |
| `groupAllowlist` | `[]` | 非空时仅服务这些 `oc_…` 群会话；空=任意群 |
| `approvers` | `[]` | 允许作答审批的 open id；空=能驱动该会话的人都可以 |
| `outbound.allowedFileDirs` | 未配置 → 文件发送禁用 | `send_file` 允许读取**本地路径**的目录。发送生成的产物（HTML 报告、截图、文档）必须配置。示例：`outbound: { allowedFileDirs: ['/home/user/work'] }` |

> ⚠️ **文件发送默认拒绝。** 不配 `outbound.allowedFileDirs` 时，`send_file` 传本地路径会报 `local file source requires outbound.allowedFileDirs to be configured`——Agent 看起来发了，实际没送达。URL 和原始 buffer 始终可用。

凭据三层解析，后者覆盖前者：bundle patch 配置 → settings 文档插件区 → 首次扫码注册。

## 🔐 应用必需权限

**新创建**的飞书应用，面板和消息功能需要以下权限上线。扫码注册流程会自动授予；**手动创建的应用**必须在开发者后台 → 权限管理 开通，然后**创建版本并发布**（最后发布之后新加的权限，API 不认，必须随新版本上线）：

| 权限 | 用途 |
|---|---|
| `application:app_slash_command`（read + write） | 斜杠命令面板——缺它时 `syncSlashPanel` 报 `99991672`，`/` 列表永远为空 |
| `im:message` | 发送与接收消息 |
| `im:message:readonly` | 读取消息内容 |
| `im:message.receive_v1` 事件 | 接收消息事件（事件与回调 → 长连接） |
| `im:resource` | 上传/发送图片和文件 |
| `im:chat:read` | 群信息（群聊场景） |
| `im:message.reactions:read` / `write_only` | 实时 reaction 反馈 |

用 API 直接调试——后台显示的是**已勾选**，API 显示的是**线上版本**实际带走的：

```sh
# 1. 拿 token
curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" | jq -r .tenant_access_token
# 2. 斜杠命令列表（同步后应能看到命令）
curl -s "https://open.feishu.cn/open-apis/application/v7/app_slash_commands?page_size=50" \
  -H "Authorization: Bearer $TOKEN"
# 3. 线上版本 scopes（确认 application:app_slash_command 在里面）
curl -s "https://open.feishu.cn/open-apis/application/v6/applications/$APP_ID/app_versions?lang=zh_cn" \
  -H "Authorization: Bearer $TOKEN"
```

面板同步在会话 create/resume 时触发——开通权限后，给 bot 发一条消息即可触发。

## 🧭 架构

```
飞书 / Lark  ── WebSocket 长连接 ──►  dsh-lark-bridge（dsh 进程内的 feishu-channel 插件）
   (聊天/审批/图片)                         │
                                           ▼
                     host 服务契约: agents / sessions / tools / approval /
                     goal / workspace / settings / commands
                                           │
                                           ▼
                                      DeepSeek Harness 本体
```

桥运行在 **dsh 进程内部**，是 `feishu-channel` 插件——不是独立服务器。`npx @deepseek-ai/dsh web`（或 `--profile chat`）启动 dsh 并组合本插件；插件打开 WebSocket 长连接并从那里驱动一切。任意启动器（shell 脚本、systemd、supervisor）都可以托管它，不依赖任何其他 agent 框架。

## 🛠️ 开发

```sh
pnpm install
pnpm run build    # clean + tsc + tsdown（产物进 lib/，已提交仓库）
pnpm test         # vitest（260 tests）
node plugin-contract-test.mjs   # 独立契约测试
```

仓库自包含：仅依赖已发布的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@larksuite/channel`，从不需要宿主源码检出。

**打包说明**（为什么 `lib/` 进仓库）：
- git 依赖安装（`github:user/repo`）不会跑构建；没有已提交的 `lib/` 时插件启动即崩（`ERR_MODULE_NOT_FOUND`）——已通过提交编译产物修复
- `prepare` 钩子是源码 clone 的安全网：`lib/` 存在时立即退出，仅在真正缺失时重建
- `build` 先清空 `lib/`（tsdown 自身 `clean: false`，因为它的 entry 在输出目录内）

## 📋 已知限制

- 通道级配置（appId/appSecret/requireMention/白名单）由 transport 持有，改动需重启；其余配置编辑 profile 的 `cordis.patch.yml` 后由 dsh 的 Config-only HMR 自动生效（`/config` 可查看当前生效值）
- 长连接中断期间到达的事件不重放（传输层无游标；出站发送由 replay 队列兜底）
- 飞书 app 需要把事件订阅方式设为**长连接**（自建应用），webhook 模式收不到事件
- `schedule_create/list/delete` 工具需要在 dsh profile 里组合 `@deepseek-ai/dsh-schedule`（桥已监听 `schedule/change` 并渲染 `/schedules`；工具是模型侧的另一半）

## 📄 许可

BSD-3-Clause。架构启发自 [dsh-lark](https://github.com/Roy-oss1/dsh-lark)（同为 BSD-3-Clause）。
