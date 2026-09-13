# 设计卡：上游跟进——Agent Teams 与 artifact file actions（dsh-lark-bridge）

> 状态：现行设计（W-10 研究班产出）· 2026-09-09 建档（维护方 W-10）
> 结论先行：Agent Teams 以 4 个 `team/*` 会话事件落在 Team Lead Session 的 journal 上，桥现有的 `session/event` 订阅能原样收到，复用 subagent-card 的「事件累计 + 卡片重渲染」模式即可；artifact file actions 的 `present` 工具发出 `deliverables/presented` 事件，桥可直接喂给现有 send_file 管道实现「交付文件自动进飞书」。两案均为小补丁，硬前置是把运行时从 0.1.1-rc.2 时代 bundle 升到 0.1.5-alpha.2。

## 1. 目的与非目标

**目的**：跟进上游 deepseek-harness master（release dsh-v0.1.5-alpha.2）：
- **W-10a**：Team 活动（花名册/共享任务板/信箱流量）在飞书聊天可见；
- **W-10b**：`present` 声明的交付文件自动经 send_file 管道送达聊天。

**非目标**：
- 不做 Team 控制进聊天（spawn/审批/task 编辑）——web 端已有 client-ui-agent-team 的 TeamAction UI，聊天只读展示；
- 不做 `workspaceDesktop()`/`reveal` 桌面动作联动——那是 web/桌面特有，飞书聊天无对应物；
- 不跟进 Mermaid 预览（上游已 revert：58956c1a8a，勿抄）；
- PR#3846（2b521b31f1，mcp pagination cycles 修复）与桥无交集，升级时顺带受益，无桥侧动作。

## 2. 上游事实（origin/master@b2e3b2a012 实测，带 commit 号）

### 2.1 Agent Teams（63187de80f "release: publish experimental Agent Teams packages"，merge 16953f2b8e / PR#3884）

- **5 个公开实验包**（`packages/experimental/`，均 0.1.5-alpha.2；experimental 组私有为默认，这五个是唯一 opt-in 发布例外）：

| 包名 | 角色 |
|---|---|
| `@deepseek-ai/dsh-experimental-agent-team` | 核心：花名册/持久信箱/共享任务板，ctx key `ctx.agentTeams` |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 工具面（9 个 team 工具） |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | Web 端 TeamAction UI |
| `@deepseek-ai/dsh-experimental-agent-team-profile` / `-web-profile` | profile/web 装配层 |

- **会话事件**（`agent-team/src/types.ts` 对 `SessionEventMap` 的扩展；journal.ts:9 定界可变事件集，全部存在 **Team Lead Session** journal）：

| 事件 | data 形状 |
|---|---|
| `team/member` | `{ version: 2, teamId, member: TeamMemberSnapshot }`；Snapshot = `{ id: SessionId, name, description, provider, context: 'fresh'\|'fork', phase: 'provisioning'\|'active'\|'failed', error? }` |
| `team/task` | `{ version: 2, teamId, task: TeamTaskSnapshot }`；Snapshot = `{ id, revision, subject, description, status: 'pending'\|'in_progress'\|'completed'\|'deleted', ownerId?, blockedBy[], writeScopes[] }` |
| `team/message/queued` | `{ version: 2, teamId, message: TeamMessageSnapshot }`；Snapshot = `{ id, senderId, senderName, targetId, content: ContentBlock[] }` |
| `team/message/delivered` | `{ version: 2, teamId, messageId, targetId }` |

- **身份语义**：`TeamId` = 根 SessionId 品牌（types.ts TeamId()）；队员是**持久 Session**，与 dsh-subagent 的 child 是并行机制、互不复用。信箱投递在队员侧表现为 `user/message`，其 `source.kind === 'team-message'`（mailbox.ts:70,242）。
- **工具面**（tool-agent-team/src/index.ts）：`spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`。
- 浏览器侧另有投影 `TeamView { members: TeamMemberView[], tasks: TeamTaskView[] }`（含运行时 status/ownerName/ready 富化）——只服务 web UI；桥不复用它，自己从 4 个事件累计即可（同 todo/goal 先例）。

### 2.2 artifact file actions（merge 9b308c9568 / PR#3819，branch feat/artifact-file-actions）

- **新 scoped 工具 `present`**（`packages/fs/tool-present`）：模型写盘产出后调用，声明最终交付物；校验文件存在且为 regular file，`maxFiles` 默认 8；成功后发出会话事件
  **`deliverables/presented`**：`{ turn, callId: ToolCallId, files: PresentedFile[] }`，`PresentedFile = { path, description? }`（types.ts SessionEventMap 注释：来自成功的 final present 结果，**含嵌套调用**）。
- **关键语义**：文件**留在源路径**，不拷贝不快照（feature note 2026-09-09-present-filesystem-access / 2026-09-08-present-workspace-source-files）；web 端经 session-controller 打开/展示。
- **session-controller**（src/index.ts diff）：新增 `workspaceDesktop(): { name, available, fileManager: 'finder'|'explorer'|'directory'|null }`；`SessionOpenWorkspacePathRequest` 增 `action?: 'reveal'`（走 `revealNativePath`）。
- **客户端 ui-deliverables**：新增 `PresentedFileCard.tsx`（+85 行）、`present-open.ts`（client/host 两份）、`presented.ts`。

## 3. 桥侧现状（接驳点盘点）

- `ctx.on('session/event')`（bridge.ts:1565）是唯一事件入口，todo/goal/workflow/compaction/subagent 各分支皆为 precedent；`host.ts:316` 的 `HostSessionEvent` 是结构副本（桥故意不 import 宿主包），`scripts/verify-dsh-contract.mjs` 直读 upstream raw 做漂移门。
- **team 事件的落点天然可达**：4 个 team 事件存在 Team Lead Session = 绑定聊天的根会话，`bySession` 必有 binding；队员 Session 不绑定聊天，其事件桥本就收不到，也无需求（队员侧流量经 queued/delivered 事件在 lead journal 可见）。
- **subagent 卡片模式**（subagent-card.ts + bridge.ts:1678-1686）：per-chat tracker 累计 + 全量重渲染。注意 bridge.ts:1685 现为每次 `send` 新卡——模块注释宣称的 `updateCard` 就地更新（outbound.ts:152 有该能力，approval 卡已用，bridge.ts:1282）**尚未接通**到 subagent 卡；W-10a 顺手补上，否则 team 卡会刷屏。
- **send_file 管道**（files.ts）：`SendFileCapability.deliverBySession(sessionId, { path, caption })` 已是「路径→飞书附件」成熟通道；出站有 `outbound.allowedFileDirs` 白名单防线。
- **收文件管道**（images.ts `collectImages` + bridge.ts:1214）：非图片资源已落 workspace——与 present 方向相反、互补无冲突。
- **版本基线**：运行中 bundle 为 0.1.1-rc.2 时代（本机仓 master 落后 origin 3204 提交），`team/*` 与 `deliverables/presented` 在旧运行时**不存在**——升级是硬前置。

## 4. 桥侧适配设计

### W-10a Agent Teams 飞书渲染

**新增 `src/team-card.ts`**（仿 subagent-card.ts，纯函数可单测）：
- `TeamCardState { members: Map<SessionId, TeamMemberSnapshot>, tasks: Map<TeamTaskId, TeamTaskSnapshot>, mail: { queued: number; delivered: number }, messageId?: string }`
- `applyTeamEvent(state, event)`：member/task 均为全量快照，直接覆盖（task `status === 'deleted'` 时移除条目）；delivered 只递增计数。
- `render(state)`：飞书卡「🧭 舰队面板」（header template 建议 teal）：花名册行（phase 图标 × **name** · provider · context）、任务板行（status 图标 × subject · ownerId→name 映射）、信箱行（queued/delivered 计数）。

**修改 `src/host.ts`**：`HostSessionEvent` 结构副本扩 4 个 team 事件 data 类型 + `isTeamMemberEvent` / `isTeamTaskEvent` / `isTeamMessageQueuedEvent` / `isTeamMessageDeliveredEvent` 守卫（按 `event.type` 串判别，可选字段模式——旧运行时守卫恒 false，自动静默零行为变化）。

**修改 `src/bridge.ts`**：`session/event` 处理器 workflow 块之后加 team 分支：per-chat `teamTrackers: Map<chatId, TeamCardState>` → `applyTeamEvent` → **1.5s debounce 合并重渲染**（`team/task` 的 revision 每变更 +1，事件可能密集）→ 接通 `updateCard` 就地更新（binding 记 messageId），turn/end flush 一次终态。工具调用提示复用 `createCallPresenter` 泛化路径（team 工具未定义 `presentCall` 时回落工具名，零新代码）。行数上限保护：卡体超约 30 行折叠为计数行，防飞书限频。

### W-10b artifact → send_file 联动

**修改 `src/host.ts`**：增 `deliverables/presented` data 类型 + `isPresentedEvent` 守卫（同可选字段模式）。

**修改 `src/bridge.ts`**：新分支：
1. **按 `callId` 去重**（per-session `Set<callId>`，事件语义本是一次 final 结果一发，此处防御嵌套/重放）；
2. 逐 file 调 `deliverBySession(sessionId, { path, caption: description ?? '交付文件 · turn N' })`——完整复用 files.ts 管道（存在性校验白名单上传一条龙）；
3. **安全门**：路径先过 `outbound.allowedFileDirs`（present 的 path 本经 workspace 解析，但防线复用不豁免）；
4. **防双发**：同 turn 内 `send_file` 已发同一路径（记录 `(turn, path)` 小 LRU）则跳过；两工具并存，模型任选，桥只保证不重复送达；
5. **失败降级**：deliverBySession 失败 → 发一条 markdown「⚠️ 交付文件 `<path>` 未能送达：<原因>」，不自动重试（重试语义归模型重调 present）。

**修改 `src/config.ts`**：增 `presentBridge: boolean`（默认 true）总开关；不新增 slash 命令（纯事件驱动）。

### 合同门扩展（两案共用）

`scripts/verify-dsh-contract.mjs` 的 FILES 表增两项 checks：
- `packages/experimental/agent-team/src/types.ts`：4 个 `team/*` 事件形状正则（`version: 2` + 快照字段名）；
- `packages/fs/tool-present/src/types.ts`：`'deliverables/presented'` 与 `files: PresentedFile[]` 存在性。

## 5. 失败路径

1. **实验包 API 漂移**：experimental README 原文明示 "contracts can change and carry no support promise" → 合同门正则前置拦，升级 CI 红即停，不裸升。
2. **刷屏/限频事故**：task revision 风暴 → debounce + updateCard 就地更新 + 行数折叠，三重防线。
3. **旧运行时半坏**：守卫恒 false，事件分支整体静默——不存在"收到一半形状"的中间态。
4. **路径越权**：present 的 path 来自模型输出 → allowedFileDirs 白名单前置，拒绝即降级文本提示。
5. **双通道双发**（present + send_file 同文件）→ `(turn, path)` LRU 去重。

## 6. 测试三层

- **mock 单测**：team-card 纯函数（合成事件序列 → 卡快照 golden，含 deleted/failed/error 分支）；全部新守卫真伪样本；W-10b 的 callId 去重与 (turn,path) 去重。
- **plugin-contract**：既有 43 项全绿（host.ts 扩展不得破坏）；`verify-dsh-contract.mjs` 新 checks 通过。
- **smoke-live**：真链路绑定聊天 → 指令 lead spawn 一队员 + 建一任务 → 「舰队面板」卡出现且就地更新（消息 ID 不变）；让模型 present 一文件 → 聊天收到**恰一个**附件。

## 7. 工作量估计与实现顺序

| 优先级 | 项 | 内容 | 估计 |
|---|---|---|---|
| P0 前置 | 运行时升级 | harness bundle 0.1.1-rc.2 → 0.1.5-alpha.2 + 全量回归 + contract-drift 复跑（独立可先行） | 1 人日 |
| P1 | W-10b | host 守卫 ~20 行 + bridge 联动 ~40 行 + config 1 flag + tests ~100 行 | 0.5 人日 |
| P2 | W-10a | team-card.ts 新建 ~120 行 + host 4 守卫 ~60 行 + bridge 分支/节流/updateCard ~50 行 + tests ~150 行 | 1–1.5 人日 |

**顺序**：P0 升级 → W-10b（小、独立、直接复用 files.ts，先拿价值）→ W-10a（事件多、需调节流）。Mermaid 预览不跟进（上游已 revert）；PR#3846 无桥侧动作。

## 8. 变更记录

- 2026-09-09 维护方（W-10 研究班）建档：上游事实全部核于 origin/master@b2e3b2a012（commit 号见文内）；两案均按「嫁接桥」铁则设计为结构副本 + 可选守卫，旧运行时零行为变化。
