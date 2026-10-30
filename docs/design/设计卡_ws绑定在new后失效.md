# 设计卡：`/ws use` 的绑定在 `/new` 之后失效（dsh-lark-bridge）

> 状态：现行设计 · 2026-10-30 建档 · CHENJIAMIAN

## 1. 目的与非目标

**目的**：让 `/ws use <目录>` 的绑定真的活过 `/new`——新会话从绑定的项目目录开始。

**起因**（2026-10-30 真实反馈）：飞书里发 `/ws use <项目目录>`，机器人回「📁 本会话已绑定到 …」，接着发 `/new`，新会话却还在默认目录。用户的原话是「工作区还是变回了默认」。

实测对得上：`~/.dsh/sessions/` 下只有 `--D-Desktop--`，没有 `--D-Desktop-某个项目--`；`/new` 生成的新会话落在 `--D-Desktop--` 里。

**非目标**：

- 不改「切换只对下一个会话生效」的语义。正在跑的会话不会被挪目录——把文件从工作中的 agent 脚下搬走比让人发一次 `/new` 更糟。
- 不动绑定文件的格式与位置（`$DSH_HOME/dsh-lark-bridge/chat-workspaces.json`）。
- 不引入新依赖。

## 2. 架构与数据流

绑定按 **chat** 记，但创建会话的那一层（`SessionLadder.create`）只拿到 **sessionId**——chat 不在它的契约里。所以桥在每次入站消息、acquire 之前，先把「这个会话该去的目录」预置进 `pendingSessionCwd`，key 用 `sessionIdFor(conversationKey(...))`，也就是会话的**基础 id**。

`/new` 走的是另一条路：它调 `sessions.rotate(msg)`，内部用 `rotatedSessionId(base)` 造一个**旋转 id**：

```
基础 id：  feishu-oc_6d68927924a38ae3c68ade61401fb9ce
旋转 id：  feishu-oc_6d68927924a38ae3c68ade61401fb9ce:rmvupuy5427ca
                └── 基础 id ──┘                              └ :r + base36 时间戳 + 4 位随机
```

`create` 拿到的是旋转 id，去 `pendingSessionCwd` 查——查不到（表里只有基础 id），于是回落到部署 cwd。**绑定写对了、读错了**，症状就是「提示已绑定，新会话还在老地方」。

```
/ws use <dir>
  → bindChatCwd(chatId, dir)                       写 chat-workspaces.json
  下一次入站（/new）
  → pendingSessionCwd.set(基础 id, chatCwd(chatId))
  → sessions.rotate() → ladder.create(旋转 id)
  → create 查表：get(旋转 id) 落空 ❌ → 回落 cwd
```

## 3. 契约设计

- 新增 `baseSessionIdOf(sessionId)`：`rotatedSessionId` 的逆运算，剥掉 `/:r[0-9a-z]+$/`；不带后缀的 id 原样返回。**旋转 id 的格式由 `session-rotation.ts` 独占**，反解也放在同一处，两边一起改才不会漂。
- `create` 的查表顺序：精确 id → 基础 id → 部署 cwd；两个 key 都消费掉，避免残留。
- 保留精确 id 优先：将来若有「一个 chat 多个并发会话」的形态，精确 key 仍然先命中。

## 4. 失败路径

| 失败 | 表现 | 处理 |
|---|---|---|
| 绑定目录被删 | `/ws use` 时 `statSync` 报不是目录 | 回「目录不存在或不是目录」，绑定不动 |
| 绑定文件损坏 | 读成空表 | 回落部署 cwd（既有行为，`readChatWorkspaces` 已容错） |
| `/new` 时当前任务还在跑 | 拒绝轮换 | 回「先 /stop 或等它结束」，绑定不受影响 |
| 旋转 id 反解失败（格式改了） | 新会话又落回部署目录 | `tests/ws-bind.spec.ts` 的往返用例会红 |

## 5. 测试三层

- **单测**：`tests/ws-bind.spec.ts` 两条纯函数用例——`baseSessionIdOf(rotatedSessionId(base)) === base`；不带后缀的 id 原样返回（含 `session-<uuid>` 形态）。
- **集成（harness）**：同一文件一条端到端用例——挂载生产插件，发 `/ws use <临时目录>` 等回执，再发 `/new`，断言第二个 `agents.create` 的 `meta.cwd` 是绑定目录、且 `sessionId` 带 `:r`。**去掉修复后这条会红**，红出来的正是用户看到的现象（cwd 是部署目录）。
- **smoke-live**：本机 `dsh --profile lark` 上发 `/ws use` → `/new`，看 `~/.dsh/sessions/` 下是否出现以项目路径命名的目录。

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-30 | 建档；`session-rotation.ts` 新增 `baseSessionIdOf`；`bridge.ts` 的 `create` 加基础 id 回退；新增 `tests/ws-bind.spec.ts`（3 条）；`sync-test-count.mjs` 修 Windows 路径与漏更新的计数格式；README 中英计数同步为 609 / 63 |
