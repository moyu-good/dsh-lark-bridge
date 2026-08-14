# dsh-lark-bridge

[English](README.md) | 中文

DeepSeek Harness 的飞书/Lark IM 机器人渠道插件。每个会话（单聊或群聊）驱动一个独立的 DSH Agent；助手的推理与工具调用以平台原生的思考过程呈现，最终答案单独发送，宿主的审批问题变成交互卡片，按钮点击即作答。

传输层使用 `@larksuite/channel`，WebSocket 长连接，无需公网回调地址。

## 能力

- **每个会话一个 Agent**。`sessionScope` 决定粒度：整个会话（`chat`）、单个话题（`chat-thread`，并行话题互不覆盖上下文）、或共享会话里的单个发送者（`chat-sender`）。session id 跨重启稳定，进程重启后自动恢复已存会话。
- **两种输出模式**：`cot` 用平台原生思考过程（推理流进思考区、工具调用带图标、结果以代码块呈现），`stream` 每轮一张打字机卡片，供旧客户端使用。
- **审批卡片**：宿主的审批问题变成带「允许一次 / 拒绝」按钮的交互卡片，点击即结算，卡片改写为决定结果，记录操作人。
- **扫码注册**：未配置凭证时启动即打印二维码，扫码经官方流程创建应用（含事件订阅），凭证经宿主 `settings` 服务持久化。
- **斜杠命令**：`/stop` 停止当前轮次，`/help` 列出可用命令；`syncSlashCommands` 把可用命令同步到机器人 `/` 面板。
- **图片可选开启**（`attachImages`）：下载后提交到宿主附件存储，随消息进入模型；未开启时模型也会知道用户发了图。
- **会话归属**：通过宿主 `workspaceRegistry` 把聊天会话归入工作区，不在 GUI 里成为孤儿。
- **权限收窄**：`senderAllowlist` / `groupAllowlist` / `approvers` 三个名单默认全空——平台应用可见范围已经是第一道边界，本插件只做收窄，不重复设闸。
- **极致适配 dsh**：全部通过宿主服务窄契约（`agents` / `agentPresets` / `agentDefaultModel` / `settings` / `workspaceRegistry` / `loader` / `invariants` / `approval`）工作，插件自包含，不依赖宿主源码。

## 环境要求

- Node `^22.19.0 || >=24.0.0`，pnpm 11.7。
- 一个 DeepSeek Harness 部署（`dsh` 0.1.0-rc.6 或更新）。`@deepseek-ai/cordis`（`^4.0.1`）是 peer 依赖，由宿主提供。
- 飞书或 Lark 租户。应用本身可以由首次启动的扫码流程创建。
- `cot` 输出要求客户端能渲染思考过程：PC 7.70、移动端 7.74。更旧的客户端用 `output: 'stream'`。

## 快速开始

```sh
npx @deepseek-ai/dsh plugin --profile web add --allow-build=dsh-lark-bridge github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web
```

控制台会打印一个二维码。用飞书扫它，应用即创建完成，渠道无需重启即建连。在 Settings → Models 里填 DeepSeek API key，然后私聊机器人或在群里 @ 它。

已经在用 `dsh`？把两处 `npx @deepseek-ai/` 前缀去掉即可。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `appId`、`appSecret` | 首次启动扫码注册 | 飞书/Lark 应用凭证。 |
| `domain` | 飞书 | 开放平台域名；Lark 用 `https://open.larksuite.com`。 |
| `cwd` | 宿主进程 cwd | 会话 Agent 的绝对工作目录。 |
| `provider`、`model` | 宿主 `agentDefaultModel` | 会话 Agent 的模型路由。 |
| `preset` | roster 默认 | 部署组合了 roster 时，会话 Agent 加入的 preset。 |
| `sessionScope` | `chat` | `chat`（整个会话共用一个）/ `chat-thread`（每个话题各自一个）/ `chat-sender`（共享会话里每人一个）。 |
| `output` | `cot` | `cot`（原生思考过程 + markdown 答案）或 `stream`（每轮一张打字机卡片）。 |
| `showProcess` | `true` | 展示 Agent 的推理与工具调用；关闭则只发答案。 |
| `hideProcessWhenDone` | `false` | 运行结束后让平台收起该过程（仅 `cot`）。 |
| `attachImages` | `false` | 是否把图片传给模型。仅用于确实支持图片的路由。 |
| `syncSlashCommands` | `true` | 把会话可用的命令注册到机器人上，用户打 `/` 即可看到菜单。 |
| `denyTools` | `['ask_user_question', 'exit_plan_mode']` | 会话 Agent 不可调用的工具。默认值是人类交互工具——答案到不了本渠道。 |
| `requireMention` | `true` | 群聊中仅在被 @ 时响应。 |
| `senderAllowlist` | `[]` | 允许私聊的 open id；留空则服务应用可用范围内的任何人。 |
| `groupAllowlist` | `[]` | 非空时仅服务这些 `oc_…` 群会话；空=任意群。 |
| `approvers` | `[]` | 允许作答审批的 open id；空=能驱动该会话的人都可以。 |

凭证按三层解析，后者覆盖前者：组合 patch 里的入口配置（通常写成 `!!js process.env.FEISHU_APP_ID`）→ settings 文档的插件段 → 首次启动的扫码注册。

## 已知限制

- 配置在启动时读取一次，改动需要重启。
- 长连接中断期间到达的事件不重放（传输层无游标）。
- 飞书 app 需要把事件订阅方式设为**长连接**（自建应用），webhook 模式收不到事件。

## 开发

```sh
pnpm install
pnpm run build    # tsc + tsdown
pnpm test         # vitest
node plugin-contract-test.mjs   # 独立契约测试（不依赖 dsh 构建链）
```

仓库自包含：仅依赖已发布的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@larksuite/channel` 编译，从不需要宿主源码检出。

## 许可

BSD-3-Clause。架构启发自 [dsh-lark](https://github.com/Roy-oss1/dsh-lark)（同为 BSD-3-Clause）。
