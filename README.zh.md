<p align="center">
  <a href="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml"><img src="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-293%20passing-brightgreen" alt="tests">
  <a href="https://dshbase.com/zh/plugins/moyu-good-dsh-lark-bridge/"><img src="https://img.shields.io/badge/dshbase-verified-blue" alt="dshbase verified"></a>
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>把 DeepSeek Harness 的编码智能搬进飞书</b><br/>
  <i>原生思考过程 · 审批卡片 · 实时 goal/todo 卡片 · 子代理 fan-out · 双语 slash 面板——不需要公网回调地址。</i>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#-60-秒上手">快速开始</a> ·
  <a href="#-能力">能力</a> ·
  <a href="#-围绕它做开发">二次开发</a> ·
  <a href="#-faq">FAQ</a>
</p>

---

## 🤔 这是什么？

`dsh-lark-bridge` 是一个 **飞书/Lark 即时通讯机器人通道**，让 DeepSeek Harness 的编码代理直接在聊天里工作。每条会话（私聊 / 群聊）驱动一个独立的 dsh agent，桌面版能看到的过程，聊天里全部可见：

- 🧠 **思考过程实时可见** —— 用飞书原生的「思考中」消息渲染 reasoning，工具调用带图标、结果以代码块展示，不再黑盒
- ✅ **审批卡片** —— 需要确认的操作变成可点击卡片（允许一次 / 拒绝），决策人与结果回写留痕
- 🎯 **实时 goal/todo 卡片** —— 长任务在聊天里实时更新而不是静默消失；重启后 goal 自动续跑
- 🔌 **WebSocket 长连接** —— 不需要公网回调地址，不需要反向代理
- 🔄 **双端同步** — bot 设置与插件清单在 `web` profile 与 Desktop 2.0.0 桌面端之间保持一致（`/bot sync-plugins`）

本质是「嫁接」：飞书只是载体，真正干活的还是 DeepSeek Harness 本体。

## 🚀 60 秒上手

**准备**：Node 18+、[pnpm](https://pnpm.io/installation)（推荐，见下方说明）、一个 DeepSeek API Key、手机上有飞书。

```sh
# 1. 把插件装进 dsh profile 并启动（pnpm —— 并行安装，实测约 20 秒）
pnpm dlx @deepseek-ai/dsh plugin --profile web add @moyu-good/dsh-lark-bridge \
  && pnpm dlx @deepseek-ai/dsh web

# 2. 控制台打印二维码 → 用飞书扫码
#    （自动创建应用＋事件订阅，凭据持久化）

# 3. 打开 dsh 控制台 → Settings → Models → 填入 DeepSeek API Key

# 4. 私聊机器人，或群里 @ 它。完成。
```

> [!NOTE]
> **首次 `plugin add` 会失败一次**，报
> `ERR_PNPM_IGNORED_BUILDS ... protobufjs`——pnpm 11 默认拦截 `protobufjs`
> （飞书 SDK 的依赖）的 postinstall，而该脚本只是无害提示。打开
> `<你的home>/.dsh/profiles/web/pnpm-workspace.yaml`，把占位行改成
> `protobufjs: true`，再重跑同一条命令即可。每个 profile 仅需一次。

> [!WARNING]
> **运行上游 dsh CLI 请用 pnpm，不要裸用 npx/npm。** 同机实测：`pnpm dlx`
> 安装 dsh 依赖树（197 个包、约 250 MB）**约 20 秒**（含下载）；而
> `npx`/`npm install` 即使缓存全热也要 **约 25 分钟**（npm 串行 reify），
> 且 ≤4GB 内存机器的 npm 进程会在安装中途
> "JavaScript heap out of memory" 崩溃。必须用 npm 时，请先设
> `NODE_OPTIONS=--max-old-space-size=2048`。
>
> **不要**执行 `npm i -g dsh-lark-bridge`——npm 上这个名字属于另一个无关项目。
> 本插件已发布为 **`@moyu-good/dsh-lark-bridge`**（GitHub 源也能装，但 git
> 源插件会让 pnpm 拦下它的 `prepare` 脚本，需要手动在 profile 的
> `pnpm-workspace.yaml` 的 `allowBuilds` 里放行——registry 包零构建无此坑）。

日常运维：重新运行 `pnpm dlx @deepseek-ai/dsh web`（后续运行命中 pnpm
store，速度很快），或用 systemd/supervisor 托管。
包已提交编译产物（`lib/` 进仓库），**安装即用无需构建**。

## 📦 换机迁移

桥自带迁移路径——旧机上：

```text
/bot export include-secrets --to-feishu   # 直传应用自己的飞书云空间
/bot export include-secrets               # 或本地文件，凭证掩码
```

飞书路线零拷贝：文件落在应用自己的云空间（仅本应用可见），新机直接
`/bot import --from-feishu` 拉取。本地文件路线则把打印出的文件（sync 目录，
如 `~/.dsh/dsh-lark-bridge/migrate.json`）拷到新机同路径，按 Quick Start 装
好插件后：

```text
/bot import                       # 预览：将写入的设置 + 装包计划 + 提醒
/bot import apply                 # 执行（云端槽位加 --from-feishu）
```

带得走的：共享设置与各 profile 插件清单（经上游 CLI 重装，跨平台直接可用）。
永不带走的：peer 心跳、control token、`node_modules`、会话历史——会话在
`~/.dsh`（上游管理），整目录拷贝即可带走。

**设备生命周期**：每台机器首启生成稳定 `deviceId`（`/bot devices` 查看台账：
本机、心跳在线端、云端活跃端、迁移档案）。旧机不用手动停——`/bot retire`
即退位（后续消息只回一行提示、不再驱动 agent；该标记是本机私有状态，永不
同步），`/bot activate` 重新启用——云端通道可用时同时认领活跃槽位，其它
设备在下一条消息自动退避。每台在线机器每分钟向云端台账续写心跳；活跃者
掉线超时后，deviceId 最小的新鲜设备在下一条消息自动当选接管。
`/bot name <可读名>` 给设备起台账显示名。

## ✨ 能力

亮点——别的桥没有的：

| | |
|---|---|
| 🧠 **原生飞书 CoT** | reasoning 渲染为平台原生「思考中」消息；旧客户端退化为打字机卡片 |
| 📋 **审批卡片＋决策人留痕** | 点击即决策，谁批的写得清清楚楚 |
| 🎯 **goal/todo 实时卡＋自动续跑** | 阶段变化实时进聊天；`autoResumeGoals` 重启后自动恢复 |
| 🔍 **会话历史检索** | `/sessions <关键词>` 对本聊天历史全文搜索 |
| 🌐 **双语斜杠面板** | 国际版 Lark 英文、国内版飞书中文，自动切换 |

<details>
<summary><b>全部能力</b></summary>

| | |
|---|---|
| 🗂️ 一会话一 Agent | `sessionScope`：整个 chat / 话题 thread / 单 sender；会话持久化，重启恢复 |
| ✅ Live Reaction | 收到 `OK` → 思考 `THINKING` → 完成 `DONE`（失败 `ERROR`），状态互替可配置 |
| 📦 压缩透明化 | 「正在压缩…」→ 摘要＋释放 token 数；修剪报告删除条数 |
| 🧑💻 子代理 fan-out | workflow 以文本流呈现：run 开始、子代理开启/结束、run 结束 |
| ⏰ 定时提醒 | `/schedules` 视图（模型侧工具需组合 `@deepseek-ai/dsh-schedule`） |
| ⚙️ 后台任务通知 | `run_in_background` 任务与子代理结束时播报结果 |
| 🧩 Skill 生态面板 | `/skills` 列出可用 skills，`/skills <name>` 看详情 |
| 🤖 模型切换 | `/model <provider>/<model>` 走宿主 `saveSelection`，持久生效 |
| 🖥️ PC 能力补齐 | 组合 `dsh-terminal*` / `code-runtime-worker-thread` / `dsh-mcp-client` → PTY 终端、Code Mode、外部 MCP |
| 🗺️ 工作区可见 | `/ws` 列出已注册工作区并标记新会话落点 |
| 🖼️ 图片输入（可选） | `attachImages` 把聊天图片传给模型 |
| 📎 文件发送 | Agent 的 `send_file` 带 caption 投递到聊天（本地目录默认拒绝） |
| 🔑 扫码注册 | 首次启动打印二维码，扫码即建应用 |
| 🔒 授权窄化 | `senderAllowlist` / `groupAllowlist` / `approvers` |
| 🧩 驿传钩子 | `chronicleEndpoint`：每条入站消息 fire-and-forget POST 到外部台账 |
| 🛡️ 深度 dsh 适配 | 全部走宿主服务契约，包自包含，无需宿主源码 |

</details>

### 与其他飞书/Lark 桥对比

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
| 会话检索 + skills/model/ws 面板 | ✅ | — | — | — |

## 💬 斜杠命令

| 命令 | 说明 |
|---|---|
| `/stop` | 取消当前任务 |
| `/help` | 显示本列表 |
| `/preset` | 查看/切换 agent 模式（standard / code / minimal / cordis） |
| `/permission` | 查看/切换权限模式（宿主） |
| `/goal` | 查看/设置目标（宿主） |
| `/plan` | 进入/退出计划模式（宿主） |
| `/compact` | 压缩较早对话历史（宿主） |
| `/sessions` | 本聊天会话历史检索 |
| `/tools` | 运行时查看/禁用/恢复工具 |
| `/skills` | 查看 skills / 某个 skill 详情 |
| `/model` | 查看/切换默认模型 |
| `/ws` | 查看已注册工作区 |
| `/jobs` | 本会话后台任务 |
| `/schedules` | 本聊天定时提醒 |
| `/context` | 当前上下文 token 压力 |
| `/audit` | 本会话操作审计摘要 |
| `/config` | 桥的当前配置 |
| `/feedback` | 给上一条回答评分 |

面板描述按平台自动双语；`locale: zh|en` 可强制指定。

## ⚙️ 配置速查

| 字段 | 默认 | 含义 |
|---|---|---|
| `appId`、`appSecret` | 首次扫码注册 | 飞书/Lark 应用凭证 |
| `cwd` | 宿主进程 cwd | 会话 Agent 的工作目录 |
| `provider`、`model` | 宿主默认 | 会话 Agent 的模型路由 |
| `output` | `cot` | 原生思考消息 vs 打字机卡片 |
| `requireMention` | `true` | 群聊仅被 @ 时响应 |
| `outbound.allowedFileDirs` | 未配置=禁用 | `send_file` 允许读取的本地目录 |
| `chronicleEndpoint` | `''` | 可选的外部全文台账钩子 |

完整字段说明见 [English README Configuration](README.md#️-configuration)。凭据三层解析（后者覆盖前者）：bundle patch 配置 → settings 文档插件区 → 首次扫码注册。

<details>
<summary><b>应用必需权限（手动建应用时）</b></summary>

| 权限 | 用途 |
|---|---|
| `application:app_slash_command`（read + write） | 斜杠面板——缺它同步报 `99991672` |
| `im:message` / `im:message:readonly` | 发送/读取消息 |
| `im:message.receive_v1` 事件 | 接收消息（事件与回调 → 长连接） |
| `im:resource` | 上传图片和文件 |
| `im:chat:read` | 群信息 |
| `im:message.reactions:read` / `write_only` | reaction 反馈 |

扫码注册自动授予；手动创建的应用加完权限必须**发布新版本**。面板同步在会话 create/resume 时触发——开通后给 bot 发条消息即可。

</details>

## 🧭 架构

```
飞书 / Lark ── WebSocket 长连接 ──►  dsh-lark-bridge（dsh 进程内的 feishu-channel 插件）
   (聊天/审批/图片)                       │  host 服务契约:
                                          │  agents / sessions / tools /
                                          ▼  approval / goal / settings
                                    DeepSeek Harness 本体
```

任意启动器均可托管（shell / systemd / supervisor），不依赖任何其他 agent 框架。

## 🧩 围绕它做开发

三条不变式让这个仓库长期可维护：

1. **嫁接桥，不重集成** —— 桥只做消息归一化；一切能力来自官方 opt-in 的 dsh 插件家族，
   在你的 profile 里组合即可。桥零改动 = 上游发新功能零升级成本。
2. **一切走宿主服务契约** —— `agents` / `agentPresets` / `approval` / `goals` / `settings`…，
   只依赖已发布的包，自包含。
3. **凡改动先立设计卡** —— 见 [`docs/design/`](docs/design/README.md)；实现完回填变更记录，
   被阻塞的调研也归档为资产。

**仓库地图**

```
src/
  bridge.ts          消息管线：归一化 → 鉴权 → 确认 → agent 回合 → 渲染
  commands.ts        slash 命令（中英双语 i18n）
  cot.ts outbound.ts 思考过程与答案渲染
  chronicle.ts       外部台账入驿钩子（集成扩展示例）
  config.ts          schema 与默认值
tests/               vitest 套件（293 个），含 harness 注入式假件
scripts/             verify-dsh-contract.mjs —— 对上游 master 的漂移校验
plugin-contract-test.mjs     43 条宿主契约断言
```

**质量门**

```sh
pnpm test                        # 293 单测/集成
node plugin-contract-test.mjs    # 43 条契约断言
node scripts/verify-dsh-contract.mjs   # 对上游 master 的漂移检查
pnpm typecheck && pnpm run build # tsc + tsdown（lib/ 已提交）
```

CI 每次 push / PR 都跑全套，其中漂移检查钉在上游 dsh master——上游改了契约，构建会在用户之前告诉你。

**想加功能？** 先写设计卡（模板在 `docs/design/`），再实现、再回填。如果需求只是「看到消息」，
优先用 `chronicleEndpoint` 钩子而不是改管线——参考 `src/chronicle.ts`。

## 📦 版本与升级策略

双轨制，写明白免得靠猜：

- **预览轨（preview）** — 开发/实验用。跟随上游最新（GitHub releases 含 alpha/rc，或 `master`）和桥的最新能力；这里允许坏。
- **稳定轨（stable）** — 生产部署用。钉 npm `latest` / 最终 rc 线。**生产永不搭载 `alpha`。**

预览轨晋升稳定轨必须过完整质量门禁：
`pnpm test` → `node plugin-contract-test.mjs` → `node scripts/verify-dsh-contract.mjs` → `pnpm typecheck && pnpm run build` → 真链路冒烟。

## ❓ FAQ

<details>
<summary><b>需要公网 IP 或 webhook 吗？</b></summary>
不需要。传输是 WebSocket 长连接；应用需使用长连接事件订阅方式（自建应用）。
</details>

<details>
<summary><b>支持什么模型？</b></summary>
你的 dsh 部署能路由的都行——桥与模型无关，`/model` 运行时可切。
</details>

<details>
<summary><b>Agent 说发了文件但没收到？</b></summary>
文件发送默认拒绝：先配 <code>outbound.allowedFileDirs</code>。URL 和原始 buffer 始终可用。
</details>

<details>
<summary><b>重启后斜杠面板空了/少了？</b></summary>
启动只注册常量命令；完整面板在会话第一条消息时同步。给 bot 发句话即可。仍为空就查
<code>application:app_slash_command</code> 权限并发布应用版本。
</details>

<details>
<summary><b>重启会丢什么？</b></summary>
会话从日志恢复；活跃 goal 自动续跑（<code>autoResumeGoals</code>）；权限与模式选择随会话状态保留。
</details>

## 🌍 生态与收录

- [dshbase.com](https://dshbase.com/plugins/moyu-good-dsh-lark-bridge/) —— 已收录且 **verified**
  （headless L3：安装＋加载＋问答实测）· [中文页](https://dshbase.com/zh/plugins/moyu-good-dsh-lark-bridge/)
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2160) —— 已合并
- [dsh-suite 目录](https://github.com/whyihaveyou/dsh-suite/issues/32) —— 核实通过（orchestration 类）

欢迎 Issue 与 PR——请先立设计卡。

## 📋 已知限制

- 传输级配置（凭证/requireMention/白名单）启动时读取一次，改动需重启；其余配置改 profile 的 `cordis.patch.yml` 后由 Config-only HMR 自动生效（`/config` 可查看当前值）
- 长连接中断期间到达的事件不重放（传输层无游标；出站由 replay 队列兜底）
- `schedule_*` 模型工具需要在 profile 里组合 `@deepseek-ai/dsh-schedule`

## 📄 许可

BSD-3-Clause。架构启发自 [dsh-lark](https://github.com/Roy-oss1/dsh-lark)（同为 BSD-3-Clause）。
