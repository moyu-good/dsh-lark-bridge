# 设计卡：`/restart` 在 Windows 上无效（dsh-lark-bridge）

> 状态：现行设计 · 2026-10-30 建档 · CHENJIAMIAN

## 1. 目的与非目标

**目的**：让 `/restart` 在 Windows 上真的能重启宿主进程。

**起因**（2026-10-30 真实反馈）：飞书里发斜杠命令想重载，命令「无效」。查下来 `scheduleRestart` 把解释器写死成 `/bin/sh`：

```ts
spawn('/bin/sh', ['-c', `sleep 2.5 && ${shell}`], { detached: true, stdio: 'ignore' }).unref()
```

Windows 没有 `/bin/sh`，`spawn` 直接 `ENOENT`，命令根本没跑起来。后果：**无论 `restartCommand` 配成什么，`/restart` 在 Windows 上都永远无效**——不是配置问题，是代码问题。

旁证：在 Windows 上跑全量测试时，`tests/commands.spec.ts` 会抛一条 unhandled error `spawn /bin/sh ENOENT`——就是这个写死的解释器。

**非目标**：

- 不改 `/restart` 的语义（仍然是「配置了 `restartCommand` 才注册」）。
- 不替部署决定怎么重启（systemd / 计划任务 / 托盘 / 容器，各机不同）。
- 不引入新依赖。

## 2. 架构与数据流

原实现把「延迟」交给 shell（`sleep 2.5 && …`），这是必须的：**父进程马上要被杀掉**，如果用父进程的 `setTimeout` 扛延迟，回复还没送到飞书，定时器就随进程一起没了。

所以延迟只能由**子进程**承担，而每个平台的「等待」工具不同：

| 平台 | 解释器 | 等待 | 为什么 |
|---|---|---|---|
| POSIX | `/bin/sh` | `sleep 2.5` | 一定有 |
| Windows | `powershell.exe` | `Start-Sleep -Milliseconds 2500` | 5.1 随系统自带，`timeout` 在没有控制台时会报「输入重定向错误」，`ping` 是脏办法 |

数据流不变：

```
/restart（已配 restartCommand）
  → scheduleRestart(shell)
  → spawn(平台解释器, [延迟, shell], { detached, stdio:'ignore', windowsHide })
  → 2.5s 后父进程被杀、子进程继续
  → 子进程执行 shell 重启宿主
```

## 3. 契约设计

- `scheduleRestart` 在**调用时**读 `process.platform`（不是模块加载时），测试因此可以在同一模块实例上覆盖两种平台。
- Windows 分支带 `windowsHide: true`：计划任务和托盘场景下不该闪一个黑框。
- `detached: true` + `stdio: 'ignore'` + `unref()` 三者缺一不可，否则子进程会跟着父进程一起死。
- 配置项 `restartCommand` 的语义随之明确：**这段命令按平台解释器语法执行**——POSIX 是 `sh`，Windows 是 PowerShell。写进 README 配置表。

## 4. 失败路径

| 失败 | 表现 | 处理 |
|---|---|---|
| 解释器不存在 | `spawn` 抛 ENOENT | Windows 用 `powershell.exe`（系统自带）；POSIX 用 `/bin/sh`（POSIX 保证有） |
| `restartCommand` 没配 | 回「⚠️ 未配置 restartCommand」 | 保持原行为，这是部署选择 |
| 命令语法不对 | 子进程里报错，聊天收不到回执 | 文档写明「按平台解释器语法写」；本机配的是 PowerShell 语法 |
| 子进程起来了但没重启成功 | 宿主原地不动 | `restart-notice.ts` 的「已恢复」回执不会到达，聊天侧表现为静默——需要部署自己的日志兜底 |

## 5. 测试三层

- **mock 单测**：新增 `tests/restart-spawn.spec.ts`，`vi.mock('node:child_process')` 拦下真实 spawn，断言：
  - POSIX 分支 `file === '/bin/sh'` 且参数含 `sleep 2.5`；
  - Windows 分支 `file === 'powershell.exe'`（**明确断言不是 `/bin/sh`**）、参数含 `Start-Sleep`、`windowsHide: true`；
  - 两个分支都是 `detached: true`。
- **plugin-contract**：未新增（不改宿主接口）。
- **smoke-live**：配好 `restartCommand` 后发 `/restart`，看 `restart.log` 与宿主新 PID。

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-30 | 建档；`scheduleRestart` 拆出 Windows 分支（PowerShell + `Start-Sleep`）；2 条单测；README 配置表补 `restartCommand` 一行（中英） |
