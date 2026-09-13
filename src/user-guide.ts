/**
 * The user-facing guide (the `/manual` command's content).
 *
 * Written for the human in the chat, not the operator: what the bot is, how
 * to talk to it, every command with one example line, and the fleet/account/
 * billing facts that prevent support questions. Single source for the chat
 * surface; `docs/用户手册.md` mirrors it for repo readers.
 * @module dsh-lark-bridge/user-guide
 */

export const USER_GUIDE = `**使用说明**

**一、这是什么**
我是跑在 DeepSeek Harness 上的编码智能体，通过本桥接进飞书。同一个飞书应用背后是 web + desktop 双端舰队——**同一时刻只有活跃端回复**（防双回复），另一端待命。

**二、日常怎么用**
- 直接说话就是派活：「帮我看看 X 项目」「跑一下测试」「把这个报告改成英文」。
- 文件、图片直接拖进聊天：发来的文件自动落到工作区；让我发文件给你，我会用 send_file。
- 长任务会先回一句「收到」，过程有思考过程卡片；想中途喊停发 \`/stop\`。
- 我会主动用 feishu_notify 报里程碑和定时任务结果，不用盯屏。
- 网页端：浏览器开 \`http://127.0.0.1:18787\`（开机自启，无需登录——只监听本机回环，能打开就是你自己；跑的是和飞书端同一套会话库）。仓库 \`bin/open-dsh-web.cmd\` 双击直达，可固定到任务栏。

**三、命令速查**
会话控制：\`/stop\` 停止当前任务 · \`/preset\` 切模式（标准/PTC/极简/创造） · \`/plan\` 计划模式 · \`/compact\` 压缩历史 · \`/clear\` 清上下文 · \`/new\` 新会话
观测：\`/context\` token 压力 · \`/audit\` 操作审计 · \`/jobs\` 后台任务 · \`/schedules\` 定时提醒 · \`/sessions\` 会话历史
配置：\`/model\` 看换模型 · \`/tools\` 禁用/恢复工具 · \`/permission <模式>\` 权限（⚠️ 不带参数只显示状态，不是菜单） · \`/config\` 桥配置 · \`/skills\` 技能清单 · \`/ws\` 工作区 · \`/plugins\` 插件
反馈：\`/feedback\` · \`/help\` 命令列表 · \`/manual\` 本说明

**四、钱袋（DeepSeek 计费）**
- \`/balance\` 查余额（含查询时刻和当前峰/谷档）。
- 高峰=北京时间周一至五 9:00–12:00、14:00–18:00，价格翻倍；其余（午休、晚间、周末）半价。批量重活我会优先排进谷价时段。

**五、换飞书账号（两步）**
1. 发 \`/bot account\` → 弹出账号库卡片 → 点目标账号的「✅使用」。
2. 生效：本端发 \`/restart\`；desktop 端重启 DSH Desktop。
存新账号：\`/bot account save <名字>\`；忘了谁在库里：直接发 \`/bot account\` 看卡片。

**六、设备舰队（多机/多端）**
- \`/bot devices\` 全家福：哪台在线、谁是活跃端、云端台账。
- \`/bot activate\` 让**本端**接管应答（原活跃端自动退避）；\`/bot retire\` 本端退位。
- 换机迁移：旧机 \`/bot export include-secrets --to-feishu\` → 新机 \`/bot import --from-feishu apply\` → 旧机 \`/bot retire\`，零拷贝。
- \`/bot name <名字>\` 给设备起可读名；\`/bot peers\` 看在线对端。

**七、故障排查**
- 发消息没反应：先 \`/bot devices\` 看活跃端在不在；活跃端掉线会自动改选，等 3 分钟或手动 \`/bot activate\`。
- 回「活跃端是 XX，本端已退避」：正常，说明另一端在管事；想换到本机就 \`/bot activate\`。
- 命令面板（输入框点 /）和实际不符：面板由活跃端维护，让活跃端重进一次会话即可重同步。
- 卡在等确认：看有没有带按钮的卡片没点；文字列的选项不是菜单，直接发对应命令。
- desktop 端让你手输模型 key：说明共享铺设缺失或 key 轮换了——告诉我重铺一次即可，铺完永久生效。

**八、权限提醒**
当前部署若是 danger-full-access（全自动）：命令直接执行不弹卡，我和你拥有同等文件权限——只在信任的环境这么开。
`

/** Section headings the mirror doc must carry (kept in step with docs/用户手册.md). */
export const USER_GUIDE_SECTIONS = [
  '这是什么',
  '日常怎么用',
  '命令速查',
  '钱袋',
  '换飞书账号',
  '设备舰队',
  '故障排查',
  '权限提醒',
] as const
