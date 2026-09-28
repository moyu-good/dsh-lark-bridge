# dsh 升级 SOP

> 立此文档的起因：2026-09-28 升级 dsh 0.1.5-rc.2 → 0.1.7-rc.2，升级后生产 bot
> 会话无法创建（`presets.standingKeyFor is not a function`），且升级当时无任何验证环节。

## 一、版本口径（2026-09-28 定）

**rc 可以跟，但每次升级必须跑契约验证 + 测试，且要有版本记录。**

- 不拒绝 rc：软件不能抱着老版本不动
- 但 rc 意味着 API 可能变，必须用验证兜住
- 稳定版与 rc 版**都走同一套验证流程**（rc 的风险靠验证消化，不靠"不升"规避）

## 二、标准流程（五步，缺一不可）

升级 dsh 前，在 `dsh-lark-bridge` 目录依次执行：

```bash
# 步骤 1｜升级前先跑门禁，拿到基线
npm run contract-drift      # 对照上游 master 检查契约签名

# 步骤 2｜切换 dsh 版本
#   修改 run-dsh-web.sh 里的两个路径指向新版本（apps/cli/lib/bin.js + node_modules）

# 步骤 3｜类型检查（最便宜的 API 变更探测器）
npm run typecheck           # 桥接镜像的 host.ts 若对不上，这里会报

# 步骤 4｜全量测试
npm test                    # 431 项；覆盖会话创建、命令、后台任务通知等

# 步骤 5｜重建 + 重启 + 真实验证
npm run build
systemctl restart <桥接服务>
#   ★ 必须真的发一条飞书消息给生产 bot，确认会话能建、能回复
```

## 三、验证的三道闸门

| 闸门 | 命令 | 抓什么 |
|---|---|---|
| 契约漂移 | `npm run contract-drift` | 上游签名增删改（按已知清单 + 镜像项反向校验） |
| 类型检查 | `npm run typecheck` | 桥接 `src/host.ts` 镜像与真实 API 不匹配 |
| 行为测试 | `npm test` | 会话创建、斜杠命令、任务通知等真实路径 |

**外加人工闸门**：发一条真实消息。**服务 `systemctl is-active` 返回 active 不代表能用**——
2026-09-28 事故中服务是 active 的，但一创建会话就抛异常。

## 四、事故复盘：为什么这次没兜住

三处 0.1.7 不兼容，**门禁一处都没抓到**：

| 变更 | 性质 | 为什么门禁漏了 |
|---|---|---|
| `presets.standingKeyFor` → `acquireScope` | API 改名 + 返回值变化（返回可释放租约） | agent-preset 包**不在门禁校验名单里** |
| `jobs.onJobDone` → `jobs.events.subscribe` | **API 整体移除**，改事件订阅 | jobs 校验项写的是旧签名 |
| `jobs.list` 参数/返回类型变化 | `Agent`→`SessionId`、`JobSnapshot`→`JobView` | 同上 |

**根本教训**：门禁只校验"**已知清单**"里的签名。**上游增删整个 API 面时，静态清单抓不到。**

对策 = 新增 `scripts/audit-host-contract.mjs`（**反向排查**）：
把桥接 `src/host.ts` 里镜像的每一个方法**逐个拿去 0.1.7 里找**，找不到就报。
清单式的查"上游有没有 A"，反向的查"我依赖的每一个还在不在"。两者互补。

```bash
node scripts/audit-host-contract.mjs   # 需 DSH_HOME 或默认定位 0.1.7 目录
```

## 五、版本台账

升级后在 `docs/dsh版本台账.md` 追加一行（版本、日期、变更点、验证结果）。
**没有台账的升级等于没有升级记录**——下次出问题无从比对。

## 六、沉淀纪律

- 每次升级踩到的坑，**当场**写进 `docs/开发经验.md`（不是事后回忆）
- 新增的契约校验项，**当场**加进 `scripts/verify-dsh-contract.mjs`
- 测试 mock 与真实 API 同步更新（这次三处 mock 用旧 API，导致测试假绿/假红）

## 七、已知遗留

- `tests/midturn-followup.spec.ts` 全量跑时偶发超时（3 次跑 1 次失败；单独跑必过）。
  与本次升级无关，属测试稳定性问题，待独立处理。
- `HostSettings.register` 在 0.1.7 中已无对应实现（旧 `SettingsProvider` 服务被拆成
  `SettingsForms` + `dsh-api-settings-controller`；`SettingsProvider` 类型已从上游消失）。
  **实测结论（2026-09-28）：无影响。** `src/runtime.ts:347` 读 `ctx.get('settings')`，
  本部署该服务为 `undefined`，整段（含 `register` 调用）被跳过——启动日志无
  `settings registration failed`。该段代码本身即按"服务可能不存在"设计，并有 try/catch 兜底。
  **故不改，仅登记。** 若未来部署提供了 `settings` 服务，此处会降级（丢配置持久化）而非崩溃。
- 仓库 CRLF 问题：`git diff` 显示 32 文件全改（实为行尾符差异），需统一换行符配置，
  否则后续所有代码审阅都无法辨别真实改动。
