# 设计卡：`/schedules` 重启后查不到（dsh-lark-bridge）

> 状态：现行设计 · 2026-10-30 建档 · CHENJIAMIAN

## 1. 目的与非目标

**目的**：`/schedules` 报告「还活着」的提醒，而不是「本进程见过的」提醒。

**起因**（2026-10-30 真实反馈）：一条每 30 分钟触发的提醒明明还在跑，`/schedules` 却回「当前没有活跃的提醒」。

**根因**：`scheduleRegistry` 是纯内存表，只由 live 的 `schedule/change` 事件喂养。原注释自己就写了这条设计：

> Rebuilt from schedule/change events as they stream in; a restart starts empty (the schedules themselves survive in the session log).

实测对得上：`schedule.json` 里那条提醒 `scheduledAt = 10/30 04:27:35`，而宿主进程 `10:41:25` 才启动——**创建发生在进程启动之前**，新进程永远不会收到它的 `create` 事件。于是出现最糟的组合：提醒照常响，命令说没有。

**非目标**：

- 不接管 schedule 插件的调度与持久化（那是 `@deepseek-ai/dsh-schedule` 的事）。
- 不读 `schedule.json`（插件的私有存储，格式随时会变）。
- 不为了回填把历史事件重新播报到聊天里。

## 2. 架构与数据流

会话日志是唯一可信来源，而且**够得着**：`HostSession` 暴露 `seq`（已提交事件数）和 `eventAt(seq)`（按下标读一条）。

```
首次需要（发 /schedules 时）
  → seedScheduleRegistry(session)
      for seq in 0..session.seq:
          if event is schedule/change: applyScheduleChange(map, data)
      （每个会话只做一次，seededSchedules 记着）
  → 之后照旧由 live 事件增量维护
```

关键是把「更新 registry」抽成 `applyScheduleChange(map, data)` 纯函数，**回填和 live 共用同一套规则**——两份实现就是两份「什么算还在」的定义，早晚会漂。

回填是**静默**的：不调 `replay.send`，否则用户每问一次 `/schedules` 就会被过去所有提醒刷一遍屏。

## 3. 契约设计

- `applyScheduleChange`：`create` 写入、`delete` 删除、`dispatch` 对 `after` 一次性提醒删除、对周期提醒保留。**幂等**——同一事件应用两次结果相同，这是回填与 live 可以交错的前提。
- `seedScheduleRegistry(session)`：每个会话只跑一次（`seededSchedules`）。跑之前若已有 live 事件建立的条目，取出来继续用，再从日志头部重放一遍覆盖——因为幂等，结果仍正确。
- 触发点放在命令分发前（`runCommandLine` 之前），而不是会话建立时：没有命令要问就不必扫日志。

## 4. 失败路径

| 失败 | 表现 | 处理 |
|---|---|---|
| 日志很长 | 回填变慢 | 一次线性扫描 `eventAt`，只在首次发命令时发生；一次会话几千条是内存数组下标，微秒级 |
| `eventAt` 返回 undefined | 跳过一次迭代 | 显式判 `undefined` |
| 同一会话先 live 后回填 | 条目重复或错位 | `applyScheduleChange` 幂等，且回填从日志头重放，最终态与日志一致 |
| 会话被复用/轮换 | 新 session id 重新 seed | `seededSchedules` 按 session id 记，天然隔离 |
| 提醒已被 schedule 插件内部清理 | 日志里仍是 create | 这是已知残留：桥不查插件真值，只重放日志。要更准需接 schedule 服务（未做，见非目标） |

## 5. 测试三层

- **mock 单测**：新增 `tests/schedules-backfill.spec.ts` 两条：
  - 只在日志里、无 live 事件的 create → `/schedules` 能列出来，且显示「1 个活跃」；
  - 日志里 create 后又 delete → 不复活，回「没有活跃的提醒」。
- **plugin-contract**：未新增（不改宿主接口）。
- **smoke-live**：重启宿主后直接发 `/schedules`，应看到重启前创建的那条提醒。

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-30 | 建档；抽出 `applyScheduleChange`；新增 `seedScheduleRegistry` 从会话日志回填；2 条单测 |
