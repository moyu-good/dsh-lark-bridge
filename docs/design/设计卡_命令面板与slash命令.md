# 设计卡：飞书命令面板与 slash 命令子系统（dsh-lark-bridge）

> 状态：现行设计 · 覆盖 commit 0de955b → 189ab92 · 2026-08-23 建档
> 本文是「功能设计卡」系列第一篇。新功能落地时按此模板在 `docs/design/` 同步建档。

## 1. 目的与非目标

**目的**：把 dsh host 的核心能力以文本 slash 命令 + 飞书卡片的形式暴露到聊天，做到「PC 上有的，聊天里也能用」。分两类：
- **透传型**：host 已有实现，桥只做转发与结果包装（`/compact` `/goal` `/permission` `/plan`）
- **自建型**：host 有能力但无聊天入口，桥基于 Host* 契约自己实现 UI 与交互（`/skills` `/model` `/ws` `/plugins` `/sessions` `/tools` `/jobs` `/schedules` `/feedback` `/context` `/audit` `/preset` `/config` `/help` `/stop`）

**非目标**：
- 不做安装/卸载类变更操作（`/plugins` 定位只读——loader 树 boot 时固定，聊天里改会谎报运行态；装/卸留在 CLI）
- 不做 web UI 复刻（web-app bundle 的 plugin-inventory 包不在 chat profile 组合树里，桥自读 loader 是正确路线）

## 2. 架构与数据流

```
飞书消息/卡片回调
   │ (LarkChannel 长连接)
   ▼
bridge.ts handleMessage()            ← 消息主入口
   ├─ 斜杠命令？──是→ runCommandLine() ──┬─ 透传型 → host.commands.execute()
   │                                    └─ 自建型 → Host* 契约读取 → 文本/卡片回复
   ├─ 审批卡按钮？→ approvalActionValue() → HostApprovalRequest 决议
   └─ 普通消息 → chatUserMessage() 归一化 → composeAgent() → agent.followup()
                                            （cot.ts 负责 reasoning→思考卡）
```

关键文件职责：
| 文件 | 职责 |
|---|---|
| `src/host.ts` | 全部 `Host*` 契约（桥对 dsh 的最小依赖面） |
| `src/commands.ts` | 命令常量 + 各命令 runner + runCommandLine 分发 |
| `src/slash-panel.ts` | 面板同步（channel 常量命令 + agent scope 命令 reconcile） |
| `src/i18n.ts` | 双语描述（COMMAND_DESCRIPTIONS） |
| `src/cot.ts` | 思考链渲染（reasoning-chunks → 飞书过程卡） |

## 3. 契约设计（新增一个自建命令的完整清单）

新增命令必须同步 **7 处**（漏一处就是「代码对了但用户看不见」）：

1. `src/commands.ts`：`export const X_COMMAND = 'x'` + `runXCommand()` + `runCommandLine` 分支
2. `src/i18n.ts`：`COMMAND_DESCRIPTIONS` 双语条目
3. helpText 拼接处加一行
4. `src/slash-panel.ts`：desired 列表加命令名（否则面板不显示——9be9317 教训）
5. 若需读 host 能力：`src/host.ts` 加 `HostX` 最小契约（镜像上游子集，不超集）
6. `scripts/verify-dsh-contract.mjs`：确认上游无漂移（跑通才许 commit）
7. `tests/commands.spec.ts`：describe 块 + fake 注入

### 契约扩展模式（以 /model 的 saveSelection 为例）
- host 契约方法一律**可选**（`saveSelection?(selection)`）：老版本 host 未实现时桥侧显式检测 `undefined` 给出明确报错，而不是 TypeError
- 桥配置 pin 死 provider/model 时拒绝切换（configModel pin 检测）——否则配置会在下一个 agent 启动时覆盖切换，静默失效
- tsconfig 开了 `exactOptionalPropertyTypes`：传可能为 undefined 的字段必须条件展开 `{ ...(x === undefined ? {} : { provider: x }) }`

## 4. 失败路径（每条都有真实事故背书）

| 失败场景 | 表现 | 防线 |
|---|---|---|
| 只改 i18n+helpText 不改 panel desired | 命令存在但面板看不见 | 7 处清单第 4 条 |
| 重启后无人发消息 | 新命令永远不上面板 | boot 时先同步 channel 常量命令；transport 未就绪则 15s 退避重试 3 次（189ab92） |
| 旧 lib 进程收到消息 | 把面板 reconcile 回旧清单（实测删掉过 /skills /model /ws） | 改 src 后必须 `npm run build` + profile `pnpm install` 刷新 file: 快照（技能铁则） |
| fake mock 数 undefined 参数错位 | 单测假失败 | runCommandLine 位置参数已 22 个——新测试用局部 helper 封装，别手抄 |
| 上游契约漂移 | 运行时 undefined 函数 | 每次 commit 前 `verify-dsh-contract.mjs` |

## 5. 测试三层（与 eval-live 配方联动）

1. **mock 单测**（vitest）：逻辑分支覆盖，fake 注入 Host*
2. **契约 43 项**（plugin-contract-test.mjs）：命令面完整性
3. **真链路冒烟**（smoke-live.mjs）：systemd active + dump-config 插件树 + 飞书面板 API 实查
4. **真模型 eval**（eval-live.sh）：headless 进程级单任务断言——测试即需求来源（E2 /permission 回复增强由此发现）

## 6. 变更记录

- 2026-08-23 测试修复：/plugins 用例缺 loader 注入长期带红（189ab92 起）——测试 harness 新增 `loader` 服务注入点（await + entries），用例显式喂 fake 条目，289/291→289 全绿

- 0de955b /skills（277 tests）→ 3dc7b42 /model（saveSelection seam + pin 检测）→ 1bdf63a /ws（registry.list）→ 9be9317 面板补齐 → 75f3305 /permission 后果说明 → 189ab92 boot 面板重试
