# 深度调研 · 主线笔记（dsh 插件生态移植飞书 + 竞品 + 社区流量）

> 2026-08-21 · hermes 主线 · 与 3 个子 Agent 并行（飞书AI平台 / dsh生态全貌 / 冷启动方法）
> 本文件 = 主线程独立调研的关键事实，子 Agent 报告回来后再整合为最终报告。

## 一、飞书 AI 平台全景（2026-03-19 发布会后）

飞书 2026-03-19 发布会：全面转型 AI Agent 原生平台，三大核心：aily / 妙搭 / 多维表格 Agent。

**产品矩阵（飞书官网 2026-04-23 文章确认）：**

| 产品 | 适合 | 特点 |
|---|---|---|
| aily 智能伙伴 | 员工个人 | 1人1个，专属提效（写文档/查资料/总结） |
| **妙搭 OpenClaw** | **个人/极客** | **开源架构、接入开源社区插件生态、自由定制** ← 关键 |
| aily 自定义智能体 | 团队/组织 | 管理员搭建、记忆隔离、中心化凭证、可管控可回滚 |

**妙搭 OpenClaw 细节**（腾讯新闻/网易 2026-03-19 报道）：
- 飞书官方开放 OpenClaw 插件生态
- 飞书开源官方 OpenClaw 插件：以用户身份操作云文档、多维表格、日程
- 定位「轻量化 AI 助手的专属数字分身」：能动手、会思考、有记忆，一键启用
- 面向「技术爱好者/极客想深度折腾」

**对 dsh 的含义**：
- 飞书官方集成的是 **OpenClaw**（另一套 agent 生态，TS/JS 插件 + SKILL.md），**不是 dsh**
- dsh（DeepSeek Harness）= DeepSeek AI 官方开源 agent harness，**64k+ stars**，MIT，核心「一切皆插件」（Cordis 内核）
- dsh 和 OpenClaw 共享「SKILL.md 生态」概念 → **SKILL.md 是跨框架的通用技能格式**（关键洞察）
- 所以「把 dsh 插件生态移植飞书」≠ 搭飞书 OpenClaw 便车；而是自建桥暴露 dsh 生态（我们已做 /skills），可借鉴 OpenClaw 飞书玩法

## 二、竞品活跃度（gh api 实测 2026-08-21）

| 竞品 | star | 最近提交 | 活跃度 |
|---|---|---|---|
| omdsh-dev/dsh-lark | 41 | 2026-08-19（0.0.7 release + sessions） | 中（停 2 天） |
| bihangchi9-creator/dsh-lark-bridge | 35 | **2026-08-21（attachments 图片文件 + /allow /disallow /whoami）** | **高（今天还在发）** |
| imetn/dsh-lark-bridge | 7 | 2026-08-14（license + 一键接入） | 低（死 7 天） |
| moyu-good（我们） | 1 | 2026-08-21（/skills + CLI） | 高 |

bihangchi9 今天在做 attachments（图片/文件下载进会话）+ 群管理命令（/allow /disallow /whoami）——值得学。

## 三、P006 旧报告要点（2026-08-20，云鹊桥）

- GitHub topic:dsh-plugin ≈ **8,770 仓库**；飞书桥接 feishu≈70 / lark≈50 → **红海**
- 目录站：dshfind.com · dshbase.com · dsh-plugin.org · awesome-dsh-plugin(★956) · dsh-plugins-store
- 直接竞品：xmanrui/dsh-im(73★ 多平台) · omdsh-dev/dsh-lark(38★) · AX1202/ax-feishu-bridge(34★ Pi+DSH) · zhuiyueya/dsh-im-gateway(30★) · PlutoKeating/dsh-lark-bot(24★) · PGZXB/dsh-feishu(14★) ...
- 我们差异化：全生命周期可视 + 断点续跑 + 决策留痕（竞品空白）
- 风险：多平台聚合（dsh-im）覆盖面更广，应深耕飞书原生体验

## 四、已落地进展（本轮）

1. bin CLI `dsh-lark-bridge start`（一键引导，cb3d0fe）
2. 社区文件 6 件套 + Discussions 开启（0009109）
3. README 升级（6255c0d）
4. **`/skills` 命令**：飞书里列出/查看 dsh skill 生态（0de955b，277 测试）

## 五、待子 Agent 补全

- [ ] 飞书 aily 自定义智能体能否编程/执行代码/上传 skill（子Agent1）
- [ ] dsh skill 体系 body 结构、MCP 注册细节（子Agent2）
- [ ] 冷启动 30 天计划（子Agent3）
- [ ] 目录站流量排名（子Agent3）
