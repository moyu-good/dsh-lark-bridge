<p align="center">
  <img src="icon.svg" width="56" alt="dsh-lark-bridge">
</p>

<h1 align="center">dsh-lark-bridge</h1>

<p align="center">
  <b>在飞书里跟一个能干活的编码 agent 说话。</b><br/>
  它跑在你自己机器上，动你的真实代码，思考过程全程可见。<br/>
  一条命令装好，扫码即用 —— 不需要公网地址，不需要服务器。
</p>

<p align="center">
  <a href="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml"><img src="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@moyu-good/dsh-lark-bridge"><img src="https://img.shields.io/npm/v/@moyu-good/dsh-lark-bridge?label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#-60-秒上手">快速开始</a> ·
  <a href="#-它是干什么的">它是干什么的</a> ·
  <a href="#-faq">FAQ</a>
</p>

---

## 🤔 它是干什么的

**给谁用** —— 手边就一台电脑、平时在飞书上派活、又想让 AI 直接动自己机器上真实文件的人。不用服务器，不用运维，不用公网地址。

**它替掉的是什么** —— 「打开 IDE → 描述需求 → 看它改 → 切回聊天汇报」这一圈。现在这一圈变成飞书里的一句话。

**为什么不直接用别的桥** —— 多数飞书 agent 桥给你一个会回消息的 bot；这个给你一个带终端、带审批闸门、带会话记忆的 agent。而且它跟你的 DSH Desktop 共用同一套会话库——在聊天里开干的活，打开桌面端还在。

## 🧭 它怎么运作

![架构：飞书消息经 WebSocket 长连接进入本机桥，驱动每个会话一个 dsh agent，再把过程与结果送回飞书](docs/assets/architecture.png)

- **进来** —— 消息走 WebSocket 长连接。没有回调地址，没有反向代理，没有公网 IP。
- **中间** —— 桥把每个聊天（私聊或群）映射成自己的 `dsh` agent，agent 读写的是你真实的工作目录。
- **回去** —— 思考过程、审批请求、执行结果，都以飞书原生消息的形态回到聊天里。
- **共享** —— `web` 与 `desktop` 两种运行形态共用一套 `~/.dsh` 会话库。

![端级仲裁：云端台账按端记账，只有一个是 ACTIVE，另一个待命](docs/assets/arbitration.png)

云端台账按端（`deviceId` + `form` + `profile`）记账，保证每个端只有一个实例在回话，活跃的那个掉线就自动改选。两种形态读写的是同一批会话，所以交接不丢对话。

## ✨ 三件别的桥大多做不到的事

### 装在自己机器上，几分钟搞定，不需要公网

一条 `pnpm dlx` 命令装好插件并起宿主，扫码就是全部的凭据流程。传输是出站的 WebSocket 长连接——没有任何东西需要从公网打进来。

### 它想什么，你看得见

reasoning 渲染成飞书原生的「思考中」消息。工具调用带图标进来，结果默认显示前 10 行、1600 字（`limits` 可调），完整输出留在会话记录里。每轮结束时固定一行收束——用了几次工具、花了多久。不需要凭感觉相信。跑到一半插话，你说的那句话也会落进思考区，就排在它让 Agent 改方向的那一步前面。

### 长任务不是「发完就等」

跑到一半再发消息，按 `busyPolicy` 走：`queue` 排队等下一轮；`steer` 在下一个 step 边界接管方向，**不丢掉已经做完的工作**；`inject` 只补上下文、不唤醒驱动器。危险操作变成审批卡片。打开 `autoResumeGoals` 后，重启时 goal 会自己接着跑。

## 🚀 60 秒上手

**准备**：Node 22.19+ 或 24+、[pnpm](https://pnpm.io/installation)、一个 DeepSeek API Key、手机上有飞书。
**Harness 版本**：dsh `>= 0.2.1-rc.1 < 0.3.0`（`package.json` 里的 `engines.dsh` 就是这么写的）。

```sh
# 1. 把插件装进 dsh profile 并启动
pnpm dlx @deepseek-ai/dsh plugin --profile web add @moyu-good/dsh-lark-bridge \
  && pnpm dlx @deepseek-ai/dsh web

# 2. 控制台打印二维码 → 用飞书扫码
#    （自动创建应用＋事件订阅，凭据持久化）

# 3. 打开 dsh 控制台 → Settings → Models → 填入 DeepSeek API Key

# 4. 私聊机器人，或群里 @ 它。完成。
```

两个坑，都是真的：

- **用 `pnpm`，别用 `npx`。** 在一台机器上记录到的是约 20 秒 vs 约 25 分钟（npm 串行 reify）；≤4 GB 内存的机器上，npm 进程会直接以「JavaScript heap out of memory」死在安装中途。**这是作者的一次观测，本仓没有可复跑的基准**——把这个差距当成「很大」，别当成「正好 20 秒对 25 分钟」。
- **别执行 `npm i -g dsh-lark-bridge`。** npm 上那个裸名字是**别人的无关项目**。本插件叫 **`@moyu-good/dsh-lark-bridge`**。

<details>
<summary>首次安装卡在 <code>protobufjs</code>？—— 两分钟修好</summary>

pnpm 10 默认拦截依赖的构建脚本，未放行时以非零退出码失败并报 `ERR_PNPM_IGNORED_BUILDS`。被拦的是 `protobufjs`（飞书 SDK 的依赖）的 postinstall，它只打印一行版本方案警告：不写文件、不联网。

打开 `<你的home>/.dsh/profiles/web/pnpm-workspace.yaml`，在 `allowBuilds` 下把 `protobufjs` 设为 `false`。安装失败后 pnpm 会在这个文件里留下一行占位，值是字面文本 `set this to true or false`（不是布尔值），要整行替换掉。然后**重跑同一条命令**——安装以非零退出码结束时，插件的 bundles 不会被合并，只改文件不算装完。

`allowBuilds`（pnpm 10.26+）是 pnpm 唯一认的键；`onlyBuiltDependencies` 等旧键在 pnpm 11 已被移除。它写在**安装方** profile 里，不在本包里：批准权属于执行安装的人。

</details>

## 🎯 装完先试这三条

| 命令 | 拿到什么 |
|---|---|
| `/manual` | 八节完整使用说明，直接发到聊天里 |
| `/balance` | DeepSeek 实时余额（分币种、带查询时刻），含当前峰谷档 |
| `/bot devices` | 舰队里有哪些端，此刻是谁在接活 |

日常运维：再跑一次 `pnpm dlx @deepseek-ai/dsh web`（后续命中 pnpm store，很快），或用 systemd / supervisor 托管。包是**预编译**发布的，安装时不编译任何东西。

<details>
<summary>💬 全部能力</summary>

| | |
|---|---|
| 🗂️ **一会话一 Agent** | `sessionScope`：整个 chat / 话题 thread / 单 sender；会话持久化，重启恢复 |
| 🧠 **原生飞书 CoT** | reasoning 渲染为平台原生「思考中」消息；旧客户端退化为打字机卡片 |
| ✅ **Live Reaction** | 收到 `OK` → 思考 `THINKING` → 完成 `DONE`（失败 `ERROR`），状态互替可配置 |
| 📋 **审批卡片＋决策人留痕** | 点击即决策，谁批的写得清清楚楚 |
| 🎯 **goal/todo 实时卡＋自动续跑** | 阶段变化实时进聊天；`autoResumeGoals`（需手动开启）重启后自动恢复 |
| ✋ **任务中插话** | `busyPolicy`：`queue`（默认）排队等下一轮，`steer` 在下一个 step 边界接管方向、不丢已做的工作，`inject` 只作上下文、不唤醒驱动器 |
| 📦 **压缩透明化** | 「正在压缩…」→ 摘要＋释放 token 数；修剪报告删除条数 |
| 🧑‍💻 **子代理 fan-out** | workflow 以文本流呈现：run 开始、子代理开启/结束、run 结束 |
| 👥 **团队面板** | 宿主跑起多 agent 团队时，一张卡片显示成员、共享任务与队内往来消息，就地刷新 |
| 🔍 **会话历史检索** | `/sessions <关键词>` 对本聊天历史全文搜索 |
| 🌐 **多端舰队同步** | `web` 与 `desktop` 两种形态同一套会话库；端级云端仲裁（`deviceId:form:profile`）——不会双回复，活跃端掉线自动改选 |
| 🔄 **账号库交互卡片** | `/bot account` 存/切/忘多个飞书应用凭证，卡片两下切换；共享设置全端生效 |
| 💰 **余额与峰谷感知** | `/balance` 实时查 DeepSeek 余额（分币种、带查询时刻）；提示词内置峰谷时段表，重活自动排半价时段 |
| 🛠️ **飞书原生 agent 工具** | `feishu_notify` 主动发消息、`feishu_drive_*` 用应用云盘当跨设备便签 |
| 🖥️ **面板自愈** | 命令面板由活跃端单写者维护，双语、与实际能力对齐 |
| 🧰 **能力全景** | `/tools` 列出这台机器此刻真能做什么——可见工具与接的 MCP 服务器 |
| 🎙️ **媒体按形态送达** | ogg/opus 录音按语音条、mp4/m4v 视频按视频送达，聊天里直接能播 |
| 🖼️ **图片输入（可选）** | `attachImages` 把聊天图片传给模型 |
| 📎 **文件发送** | Agent 的 `send_file` 带 caption 投递到聊天（本地目录默认拒绝） |
| 🔒 **授权窄化** | `senderAllowlist` / `groupAllowlist` / `approvers` |
| ⏰ **定时提醒** | `/schedules` 视图（模型侧工具需组合 `@deepseek-ai/dsh-schedule`） |
| ⚙️ **后台任务通知** | `run_in_background` 任务结束时播报结果 |
| 🧩 **Skill 生态面板** | `/skills` 列出可用 skills，`/skills <name>` 看详情 |
| 🤖 **模型切换** | `/model <provider>/<model>` 走宿主 `saveSelection`，持久生效 |
| 🖥️ **PC 能力补齐** | 组合 `dsh-terminal*` / `code-runtime-worker-thread` / `dsh-mcp-client` → PTY 终端、Code Mode、外部 MCP |
| 🗺️ **工作区可见** | `/ws` 列出已注册工作区并标记新会话落点 |
| 🔑 **扫码注册** | 首次启动打印二维码，扫码即建应用 |
| 🧩 **外部台账钩子** | `chronicleEndpoint`：每条被受理的**入站用户消息** POST 一次（载荷只有 `source`/`text`/`chatId`；桥自己的回复不入台账） |

</details>

<details>
<summary>⌨️ 斜杠命令</summary>

在聊天里发 `/help` 看实时列表。

| 命令 | 说明 |
|---|---|
| `/stop` | 取消当前任务 |
| `/new` | 新开会话（`/clear` 是同义命令） |
| `/manual` | 完整使用说明（新人从这里开始） |
| `/sessions` | 本聊天会话历史检索 |
| `/balance` | 查 DeepSeek 余额（含当前峰谷档） |
| `/tools` | 运行时查看/禁用/恢复工具 |
| `/skills` | 查看 skills / 某个 skill 详情 |
| `/model` | 查看/切换默认模型 |
| `/config` | 桥的当前配置 |
| `/plugins` | 查看已部署的插件及运行状态 |
| `/ws` | 查看已注册工作区 |
| `/jobs` | 本会话后台任务 |
| `/schedules` | 本聊天定时提醒 |
| `/context` | 当前上下文 token 压力 |
| `/audit` | 本会话操作审计摘要 |
| `/feedback` | 给上一条回答评分 |
| `/preset` | 查看/切换 agent 模式（standard / code / minimal / cordis） |
| `/permission` | 查看/切换权限模式（宿主） |
| `/goal` | 查看/设置目标（宿主） |
| `/plan` | 进入/退出计划模式（宿主） |
| `/compact` | 压缩较早对话历史（宿主） |
| `/bot` | 桥管理：状态/设置/账号/插件同步/设备 |
| `/restart` | 重启服务进程（需部署侧配置） |
| `/help` | 显示本列表 |

**`/bot` 子命令**：`set` / `unset` / `peers` / `sync-plugins` / `account`（save·use·forget，交互卡片）/ `export` / `import` / `devices` / `retire` / `activate` / `name`。

面板描述与 help 文案按平台自动双语；`locale: zh|en` 可强制指定。它不影响 agent 说了什么。

</details>

<details>
<summary>⚙️ 配置速查与必需权限</summary>

| 字段 | 默认 | 含义 |
|---|---|---|
| `appId`、`appSecret` | 首次扫码注册 | 飞书/Lark 应用凭证（可 `/bot set` 进共享设置全端生效） |
| `cwd` | 宿主进程 cwd | 会话 Agent 的工作目录 |
| `provider`、`model` | 宿主默认 | 会话 Agent 的模型路由 |
| `output` | `cot` | 原生思考消息 vs 打字机卡片 |
| `requireMention` | `true` | 群聊仅被 @ 时响应 |
| `outbound.allowedFileDirs` | 未配置=禁用 | `send_file` 允许读取的本地目录 |
| `chronicleEndpoint` | `''` | 可选：每条被受理的入站用户消息 POST 一次 |
| `announceSubagents` | `true` | 派出子代理时在聊天里播报一行 |
| `autoResumeGoals` | `false` | 重启后自动续跑活跃 goal——默认关，要自己打开 |
| `restartCommand` | 未配置 → `/restart` 不可用 | 重启宿主的命令；2.5 秒后在脱离父进程的子进程里执行（POSIX 用 `sh`，Windows 用 PowerShell） |

凭据三层解析（后者覆盖前者）：bundle patch 配置 → settings 文档插件区 → 首次扫码注册。

<details>
<summary>应用必需权限（手动建应用时）</summary>

| 权限 | 用途 |
|---|---|
| `application:app_slash_command`（read + write） | 斜杠面板——缺它同步报 `99991672` |
| `im:message` / `im:message:readonly` | 发送/读取消息 |
| `im:message.receive_v1` 事件 | 接收消息（事件与回调 → 长连接） |
| `im:resource` | 上传图片和文件 |
| `im:chat:read` | 群信息 |
| `im:message.reactions:read` / `write_only` | reaction 反馈 |
| **`drive:drive`**（或云空间读写） | `/bot export --to-feishu`、`feishu_drive_*` 工具、云端仲裁 |

扫码注册自动授予；手动创建的应用加完权限必须**发布新版本**。面板同步在会话 create/resume 时触发——开通后给 bot 发条消息即可。

</details>

</details>

<details>
<summary>📦 换机迁移</summary>

桥自带迁移路径。旧机上：

```text
/bot export include-secrets --to-feishu   # 直传应用自己的飞书云空间
/bot export include-secrets               # 或本地文件，凭证掩码
```

飞书路线零拷贝：文件落在应用自己的云空间（仅本应用可见），新机直接 `/bot import --from-feishu` 拉取。本地文件路线则把打印出的文件拷到新机同路径，按快速开始装好插件后：

```text
/bot import                       # 预览：将写入的设置 + 装包计划 + 提醒
/bot import apply                 # 执行（云端槽位加 --from-feishu）
```

带得走的：共享设置与各 profile 插件清单。永不带走的：peer 心跳、control token、`node_modules`、会话历史。

会话历史在 `~/.dsh`（上游管理）。要带走，**只拷会话目录**：

```text
~/.dsh/sessions/     # 会话本体
~/.dsh/storages/     # 会话投影缓存与工作区索引
```

**不要整目录拷 `~/.dsh`。** `~/.dsh/dsh-lark-bridge/device-state.json` 记着本机的 `deviceId` 与退位标记：拷过去会让新机顶着旧机的身份（两台机器抢同一个聊天），还可能把退位标记一并带走——新机开机后每条消息只回一行提示，不再驱动 agent。

**设备生命周期** —— 每台机器首启生成稳定 `deviceId`，`/bot devices` 看台账。旧机不用手动停：`/bot retire` 即退位（后续消息只回一行提示、不再驱动 agent），`/bot activate` 重新启用。每台在线端每分钟续写心跳；活跃端掉线超时后，端键最小的新鲜端在下一条消息自动当选。`/bot name <可读名>` 给设备起台账显示名。

</details>

<details>
<summary>❓ FAQ</summary>

<details>
<summary>需要公网 IP 或 webhook 吗？</summary>

不需要。传输是 WebSocket 长连接；应用需使用长连接事件订阅方式（自建应用）。

</details>

<details>
<summary>我同时开着 DSH Desktop 和 web 宿主，会双回复吗？</summary>

不会。两者共用一套 `~/.dsh` 会话库，云端仲裁按端（`deviceId` + `form` + `profile`）判定：每个端只有一个实例回复；活跃端掉线超时后，其余端在下一条消息自动竞选接管。`/bot devices` 看谁在接。

</details>

<details>
<summary>支持什么模型？</summary>

你的 dsh 部署能路由的都行——桥与模型无关，`/model` 运行时可切。

</details>

<details>
<summary>Agent 说发了文件但没收到？</summary>

文件发送默认拒绝：先配 `outbound.allowedFileDirs`。URL 和原始 buffer 始终可用。

</details>

<details>
<summary>浏览器直接打开 web 控制台报 401？</summary>

每次启动都会重新生成 token，没有 cookie 的浏览器自然 401。先把启动日志里 `http://127.0.0.1:18787/?token=…` 那整行打开一次——会种下长效 cookie，之后裸地址即可。

</details>

<details>
<summary>重启后斜杠面板空了/少了？</summary>

启动只注册常量命令；完整面板在会话第一条消息时同步（多端舰队里由**活跃端**单写，待命端不抢）。给 bot 发句话即可。仍为空就查 `application:app_slash_command` 权限并发布应用版本。

</details>

<details>
<summary>怎么换绑另一个飞书应用？</summary>

`/bot account save <名字>` 存档当前凭证，之后 `/bot account` 点卡片「使用」即切换，`/restart`（web）或重启 Desktop 生效。支持多套凭证并存。

</details>

<details>
<summary>重启会丢什么？</summary>

会话从日志恢复；权限与模式选择随会话状态保留。活跃 goal 只有在设了 `autoResumeGoals: true` 时才会续跑（默认关）。

</details>

</details>

<details>
<summary>⚠️ 已知限制</summary>

- **Desktop 形态暂缺提问卡。** `hostQuestions` 在 `desktop` 运行形态下没有提供方，提问卡降级；`web` 形态不受影响。
- **传输级配置启动时读一次。** 凭证、`requireMention`、白名单改动需重启；其余配置由 dsh 的 Config-only HMR 自动生效（`/config` 看当前值）。
- **长连接中断期间到达的事件不重放**（传输层无游标）；出站由 replay 队列兜底。
- **`schedule_*` 模型工具** 需要在 profile 里组合 `@deepseek-ai/dsh-schedule`。
- **文件发送默认拒绝** —— 目录必须先写进 `outbound.allowedFileDirs`。
- **同一个 endpoint key 上的两个进程会同时回话。** 仲裁比的是端键（`deviceId` + `form` + `profile`）；同一台机器、同一个 profile 上同时跑 `dsh web` 和裸 CLI，两者算出来是同一个键，彼此都不认为对方是竞争者。一个 profile 只跑一个宿主进程。

</details>

## 🧩 围绕它做开发

三条不变式让这个仓库长期可维护：

1. **嫁接桥，不重集成** —— 桥只做消息归一化；一切能力来自官方 opt-in 的 dsh 插件家族，在你的 profile 里组合即可。桥零改动 = 上游发新功能零升级成本。
2. **一切走宿主服务契约** —— `agents` / `agentPresets` / `approval` / `goals` / `settings`…，只依赖已发布的包，自包含。
3. **凡改动先立设计卡** —— 见 [`docs/design/`](docs/design/README.md)。

仓库地图、分支与 MR 流程、版本与升级策略，都在 **[CONTRIBUTING.md](CONTRIBUTING.md)**。CI 每次 push 都跑这几道门：

```sh
pnpm hygiene                    # 仓库卫生（部署专有词只留在本机）
pnpm test                       # 631 条测试 / 65 个 spec 文件
pnpm contract-test              # 43 条宿主契约检查
pnpm contract-drift             # 对上游 dsh master 的漂移检查
node scripts/check-readme-parity.mjs   # 两份 README 保持同构
```

测试在 `tests/` —— vitest 套件（65 个），含 harness 注入式假件。升级引擎前后各跑一次 `pnpm contract-drift`——桥所镜像的宿主接缝一旦挪位，它会红。

## 🤝 参与

- **[CONTRIBUTING.md](CONTRIBUTING.md)** —— 怎么把改动合进来。
- **[SECURITY.md](SECURITY.md)** —— 怎么报漏洞。**别开公开 issue**。
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** —— 这里的人与人之间怎么相处。
- **Issue 模板** —— [`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE)。填了环境信息的那份回得更快。

已在 9 个目录收录，含 [dshbase（verified）](https://dshbase.com/zh/plugins/moyu-good-dsh-lark-bridge/)。多数目录从 npm 读版本——**以仓库 tag 为准**，安装走 npm（`@moyu-good/dsh-lark-bridge`）或直接装 tag。

## 📄 许可

BSD-3-Clause。架构启发自 [dsh-lark](https://github.com/Roy-oss1/dsh-lark)（同为 BSD-3-Clause）。
