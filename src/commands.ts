/**
 * Slash commands in a chat. A line beginning with `/` is a control, not a
 * prompt: the host runs it WITHOUT a model turn, so routing it here is what
 * keeps a `/clear` from reaching the model as prose for it to improvise on.
 *
 * Two commands are the channel's own rather than the host's. `/stop` cancels
 * the running turn — cancellation is an agent method, not a registered command
 * — and `/help` lists what this chat accepts, which no host command provides.
 * @module dsh-lark-bridge/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuditStats, HostAgent, HostAgentPresets, HostCommands, HostDefaultModel, HostJobs, HostLoaderEntry, HostMessageFeedback, HostSessionPersistence, HostSessionQuery, HostSkills, HostTokenMeter, HostWorkspaceRegistry, ScheduleEntry } from './host.ts'
import type { ResolvedConfig } from './config.ts'
import { describeCommand, helpHeading } from './i18n.ts'

/** Cancel the running turn. Not a host command: cancellation is an agent method. */
export const STOP_COMMAND = 'stop'

/**
 * Restart the host process from the chat. Only registered when the deployment
 * configures {@link Config.restartCommand} — restarting a process is a
 * deployment concern (systemd unit name, container runtime, process manager),
 * so the bridge ships the command shape and the deployment supplies the how.
 * The command runs detached after a short delay: the reply must reach the
 * chat before the process that would send it goes away.
 */
export const RESTART_COMMAND = 'restart'

/**
 * Fires the configured restart shell in a detached child that outlives this
 * process, after a delay long enough for the command's reply to reach the
 * chat. Exported for tests to stub; production always spawns `/bin/sh`.
 */
export let scheduleRestart = (shell: string): void => {
  void import('node:child_process').then(({ spawn }) => {
    spawn('/bin/sh', ['-c', `sleep 2.5 && ${shell}`], { detached: true, stdio: 'ignore' }).unref()
  })
}

/** Test seam: replace the restart scheduler. Returns the previous one. */
export function setRestartScheduler(fn: (shell: string) => void): (shell: string) => void {
  const prev = scheduleRestart
  scheduleRestart = fn
  return prev
}

/** List what this chat accepts. Not a host command: the list is per surface. */
export const HELP_COMMAND = 'help'

/** Switch the agent's preset (standard / code / minimal / cordis). */
export const PRESET_COMMAND = 'preset'

/** List this chat's stored sessions. */
export const SESSIONS_COMMAND = 'sessions'

/** View or toggle the chat's denied tools at runtime. */
export const TOOLS_COMMAND = 'tools'

/** List the chat's active schedules (reminders). */
export const SCHEDULES_COMMAND = 'schedules'

/** List this session's background jobs. */
export const JOBS_COMMAND = 'jobs'

/** Rate the chat's most recent assistant answer. */
export const FEEDBACK_COMMAND = 'feedback'

/** Show the session's current context pressure. */
export const CONTEXT_COMMAND = 'context'

/** Show the session's operation audit summary. */
export const AUDIT_COMMAND = 'audit'

/** List / inspect the workspace's discoverable skills. */
export const SKILLS_COMMAND = 'skills'

/** Show the chat bridge's live configuration. */
export const CONFIG_COMMAND = 'config'

/** View or switch the deployment's default model. */
export const MODEL_COMMAND = 'model'

/** List the registry's workspaces (the chat surfaces of `workspaceRegistry`). */
export const WS_COMMAND = 'ws'

/** List the deployed plugin tree with live status (the chat face of the web inventory). */
export const PLUGINS_COMMAND = 'plugins'

/** The session id prefix this channel owns. */
const SESSION_PREFIX = 'feishu-'

/** The four shipped preset ids, for the listing and for argument validation. */
export const SHIPPED_PRESET_IDS = ['standard', 'code', 'minimal', 'cordis'] as const

/** Human names for the shipped presets, matching the deployment's preset.yml. */
export const PRESET_NAMES: Record<string, string> = {
  standard: '标准模式',
  code: 'PTC 模式',
  minimal: '极简模式',
  cordis: '创造模式',
}

/** Display names for presets not in the shipped set fall back to the id. */
export function presetDisplayName(preset: { readonly id: string; readonly name?: string }): string {
  return preset.name ?? PRESET_NAMES[preset.id] ?? preset.id
}


/** The cause recorded when a chat cancels its own turn. */
const CANCEL_CAUSE = 'user'

/** Leading slash plus the command name, the only part this module parses. */
const COMMAND_LINE = /^\/([a-zA-Z][\w-]*)/

/**
 * The command one line names, if it names one.
 * @param text - the message text exactly as received.
 * @returns the lowercase name without its slash, or undefined for prose.
 */
export function commandName(text: string): string | undefined {
  return COMMAND_LINE.exec(text.trimStart())?.[1]?.toLowerCase()
}

/**
 * Whether one inbound line addresses the channel as a command.
 * @param text - the message text exactly as received.
 * @returns whether it opens with a slash and names something.
 */
export function isCommandLine(text: string): boolean {
  return commandName(text) !== undefined
}

/** What a command line did, for the chat to report. */
export interface CommandOutcome {
  /** Text to send back, empty when the command's own events already tell the story. */
  readonly reply: string
  /** Whether the line resolved at all; an unresolved one is a typo worth naming. */
  readonly resolved: boolean
}

/**
 * Render the help listing for one agent's available commands.
 * @param commands - the host command runtime, when composed.
 * @param agent - the agent whose scope decides what is available.
 * @returns the markdown listing.
 */
/**
 * The `/help` listing, in the bridge's resolved language.
 * @param commands - the host command runtime, when composed.
 * @param agent - the agent whose scope decides what is available.
 * @param locale - the resolved display language.
 * @returns the markdown listing.
 */
export function helpText(commands: HostCommands | undefined, agent: HostAgent, locale: 'zh' | 'en' = 'zh', config?: ResolvedConfig): string {
  const own = [
    `\`/${STOP_COMMAND}\` — ${describeCommand(STOP_COMMAND, locale, 'Stop the current task')}`,
    // Listed only when the deployment wired a restart command, matching the panel.
    ...(config?.restartCommand ? [`\`/${RESTART_COMMAND}\` — ${describeCommand(RESTART_COMMAND, locale, 'Restart the host process')}`] : []),
    `\`/${PRESET_COMMAND}\` — ${describeCommand(PRESET_COMMAND, locale, 'View or switch mode')}`,
    `\`/${SESSIONS_COMMAND}\` — ${describeCommand(SESSIONS_COMMAND, locale, 'View session history')}`,
    `\`/${TOOLS_COMMAND}\` — ${describeCommand(TOOLS_COMMAND, locale, 'View, deny, or allow tools')}`,
    `\`/${SCHEDULES_COMMAND}\` — ${describeCommand(SCHEDULES_COMMAND, locale, 'View scheduled reminders')}`,
    `\`/${JOBS_COMMAND}\` — ${describeCommand(JOBS_COMMAND, locale, 'View background jobs')}`,
    `\`/${CONTEXT_COMMAND}\` — ${describeCommand(CONTEXT_COMMAND, locale, 'View context pressure')}`,
    `\`/${SKILLS_COMMAND}\` — ${describeCommand(SKILLS_COMMAND, locale, 'List / inspect discoverable skills')}`,
    `\`/${MODEL_COMMAND}\` — ${describeCommand(MODEL_COMMAND, locale, 'View or switch the default model')}`,
    `\`/${WS_COMMAND}\` — ${describeCommand(WS_COMMAND, locale, 'List registered workspaces')}`,
    `\`/${PLUGINS_COMMAND}\` — ${describeCommand(PLUGINS_COMMAND, locale, 'List deployed plugins and status')}`,
    `\`/${AUDIT_COMMAND}\` — ${describeCommand(AUDIT_COMMAND, locale, 'View operation audit')}`,
    `\`/${CONFIG_COMMAND}\` — ${describeCommand(CONFIG_COMMAND, locale, 'View current configuration')}`,
    `\`/${HELP_COMMAND}\` — ${describeCommand(HELP_COMMAND, locale, 'Show available commands')}`,
  ]
  const hosted = (commands?.list(agent) ?? [])
    .map(descriptor => `\`/${descriptor.name}\` — ${describeCommand(descriptor.name, locale, descriptor.description)}`)
  return [helpHeading(locale), ...hosted, ...own].join('\n')
}

/**
 * Run one command line for a chat's agent.
 *
 * `/stop`, `/preset`, and `/help` are answered here; everything else goes to
 * the host runtime, whose `undefined` means the name never resolved — reported
 * as such with the listing, because silently feeding a typo to the model is
 * how `/stop` became a message the bot ignored.
 * @param line - the complete line, leading slash included.
 * @param agent - the chat's agent.
 * @param commands - the host command runtime, when composed.
 * @param signal - cancellation for the host execution.
 * @param presets - the agent-preset roster, when composed (for `/preset`).
 * @param persistence - the session store, when composed (for `/sessions`).
 * @param chatId - the conversation facet key this chat's sessions belong to.
 * @param deniedTools - the live denied-tool set (for `/tools`).
 * @param schedules - live schedule registry by session id (for `/schedules`).
 * @param audits - live audit counters by session id (for `/audit`).
 * @param config - the bridge's live configuration (for `/config`).
 * @param sessionPresets - per-session preset choices (for `/preset` persistence).
 * @returns what to report to the chat.
 */
export async function runCommandLine(
  line: string,
  agent: HostAgent,
  commands: HostCommands | undefined,
  signal: AbortSignal,
  presets: HostAgentPresets | undefined = undefined,
  persistence: HostSessionPersistence | undefined = undefined,
  chatId: string | undefined = undefined,
  deniedTools: ReadonlySet<string> | undefined = undefined,
  schedules: ReadonlyMap<string, ReadonlyMap<string, ScheduleEntry>> | undefined = undefined,
  audits: ReadonlyMap<string, AuditStats> | undefined = undefined,
  config: ResolvedConfig | undefined = undefined,
  sessionPresets: Map<string, string> | undefined = undefined,
  sessionQuery: HostSessionQuery | undefined = undefined,
  jobs: HostJobs | undefined = undefined,
  feedback: HostMessageFeedback | undefined = undefined,
  lastAssistantMessageId: string | undefined = undefined,
  tokenMeter: HostTokenMeter | undefined = undefined,
  skills: HostSkills | undefined = undefined,
  defaultModel: HostDefaultModel | undefined = undefined,
  configModel: { readonly provider?: string; readonly model?: string } | undefined = undefined,
  workspaces: HostWorkspaceRegistry | undefined = undefined,
  currentCwd: string | undefined = undefined,
  loaderEntries: readonly HostLoaderEntry[] | undefined = undefined,
): Promise<CommandOutcome> {
  const trimmed = line.trimStart()
  const name = commandName(trimmed) ?? ''
  if (name === STOP_COMMAND) {
    agent.cancel(CANCEL_CAUSE)
    return { reply: '⏹ 已停止当前任务。', resolved: true }
  }
  if (name === RESTART_COMMAND) {
    const shell = config?.restartCommand
    if (shell === undefined || shell === '') {
      return { reply: '⚠️ 未配置 restartCommand，/restart 不可用。', resolved: true }
    }
    // Detached + delayed: the reply below must reach the chat before this
    // process dies, so the restart fires from a child that outlives us.
    scheduleRestart(shell)
    return { reply: '🔁 重启已排程，服务将在数秒后重启并自动恢复。', resolved: true }
  }
  if (name === PRESET_COMMAND) {
    return runPresetCommand(trimmed, agent, presets, sessionPresets)
  }
  if (name === SESSIONS_COMMAND) {
    const query = trimmed.slice(1 + SESSIONS_COMMAND.length).trim()
    return runSessionsCommand(agent, persistence, chatId, query, sessionQuery)
  }
  if (name === JOBS_COMMAND) {
    return runJobsCommand(agent, jobs)
  }
  if (name === FEEDBACK_COMMAND) {
    return runFeedbackCommand(trimmed, agent, feedback, lastAssistantMessageId)
  }
  if (name === CONTEXT_COMMAND) {
    return runContextCommand(agent, tokenMeter)
  }
  if (name === TOOLS_COMMAND) {
    return runToolsCommand(trimmed, deniedTools)
  }
  if (name === SCHEDULES_COMMAND) {
    return runSchedulesCommand(agent, schedules)
  }
  if (name === AUDIT_COMMAND) {
    return runAuditCommand(agent, audits)
  }
  if (name === SKILLS_COMMAND) {
    return runSkillsCommand(trimmed, skills)
  }
  if (name === MODEL_COMMAND) {
    return runModelCommand(trimmed, defaultModel, configModel, config?.modelCatalog)
  }
  if (name === WS_COMMAND) {
    return runWsCommand(workspaces, currentCwd)
  }
  if (name === PLUGINS_COMMAND) {
    return runPluginsCommand(loaderEntries)
  }
  if (name === CONFIG_COMMAND) {
    return runConfigCommand(config)
  }
  if (name === HELP_COMMAND) {
    return { reply: helpText(commands, agent, config?.locale ?? 'zh', config), resolved: true }
  }
  if (commands === undefined) {
    return { reply: `⚠️ 本部署没有组合命令运行时，\`/${name}\` 无法执行。`, resolved: false }
  }
  const execution = await commands.execute(agent, trimmed, signal)
  if (execution === undefined) {
    return { reply: `⚠️ 未知命令 \`/${name}\`。\n\n${helpText(commands, agent, config?.locale ?? 'zh')}`, resolved: false }
  }
  const { result } = execution
  if (result.kind === 'error') return { reply: `⚠️ \`/${name}\` 执行失败：${result.text}`, resolved: true }
  // /permission's bare host reply ("preset <name>") says what changed but not
  // what it means downstream: the terminal family refuses to spawn under
  // workspace-write without an approval channel, so the switch is exactly the
  // difference between terminal tools working and failing in this chat. The
  // bridge appends that consequence — the one thing a chat user cannot see.
  if (name === 'permission' && result.kind === 'success' && typeof result.text === 'string') {
    if (result.text.includes('danger-full-access')) {
      return { reply: `${result.text}\n\n💡 已放开沙箱：terminal_* 等需要完整执行环境的工具现在可用（审批不再逐次询问）。`, resolved: true }
    }
    if (result.text.includes('workspace-write')) {
      return { reply: `${result.text}\n\n💡 已收紧到工作区写入：terminal_* 工具在此模式下会被拒绝（无审批通道时）。需要持久终端请再切 \`/permission danger-full-access\`。`, resolved: true }
    }
  }
  // A command whose own session events carry the story needs no echo.
  return { reply: result.text ?? '', resolved: true }
}

/** The agent's scoped Cordis context, when the host agent exposes one. */
function agentScope(agent: HostAgent): Context | undefined {
  return (agent as { ctx?: Context }).ctx
}

/**
 * Handle `/sessions`: list the stored sessions that belong to this chat.
 * @param agent - the chat's agent (marks the current session).
 * @param persistence - the session store, when composed.
 * @param chatId - the conversation facet key; undefined lists nothing.
 * @returns the reply for the chat.
 */
async function runSessionsCommand(
  agent: HostAgent,
  persistence: HostSessionPersistence | undefined,
  chatId: string | undefined,
  query = '',
  sessionQuery: HostSessionQuery | undefined = undefined,
): Promise<CommandOutcome> {
  if (chatId === undefined) {
    return { reply: '⚠️ 无法确定当前聊天。', resolved: false }
  }
  // Full-text search path: /sessions <keyword> consults the optional
  // sessionQuery seam when composed; without it the keyword cannot be honored.
  // Search does not depend on the header store, so it runs before the
  // persistence availability check below.
  if (query !== '') {
    if (sessionQuery === undefined) {
      return {
        reply: `⚠️ 本部署没有组合全文检索，\`/${SESSIONS_COMMAND} <关键词>\` 不可用；不带关键词可查看历史列表。`,
        resolved: false,
      }
    }
    const page = await sessionQuery.searchSessions({ query, limit: 8 })
    const owned = page.items.filter(hit => hit.session.id.startsWith(`${SESSION_PREFIX}${chatId}`))
    if (owned.length === 0) {
      return { reply: `**会话检索**\n没有找到与「${query}」匹配的本聊天记录。`, resolved: true }
    }
    const rows = owned.map(hit => {
      const when = hit.session.createdAt === undefined
        ? ''
        : `${new Date(hit.session.createdAt).toLocaleString('zh-CN', { hour12: false })} `
      const mark = hit.session.id === agent.session.id ? ' ← 当前' : ''
      const snippet = hit.bestMatch.snippet.length <= 60 ? hit.bestMatch.snippet : `${hit.bestMatch.snippet.slice(0, 59)}…`
      return `· ${when}${mark}「${snippet}」`
    })
    return { reply: `**会话检索**（${owned.length} 条匹配）\n${rows.join('\n')}`, resolved: true }
  }
  if (persistence === undefined) {
    return { reply: `⚠️ 本部署没有组合会话存储，\`/${SESSIONS_COMMAND}\` 不可用。`, resolved: false }
  }
  const headers = await persistence.list()
  // A session belongs to this chat when its id is `feishu-<chatId>` (whole
  // chat scope) or starts with `feishu-<chatId>:` (thread or sender facet).
  const owned = headers
    .filter(header => header.id.startsWith(`${SESSION_PREFIX}${chatId}`))
    .sort((a, b) => b.createdAt - a.createdAt)
  if (owned.length === 0) {
    return { reply: '**会话历史**\n还没有本聊天的已保存会话。', resolved: true }
  }
  const rows = owned.map(header => {
    const when = new Date(header.createdAt).toLocaleString('zh-CN', { hour12: false })
    const mark = header.id === agent.session.id ? ' ← 当前' : ''
    const facet = header.id.slice(`${SESSION_PREFIX}${chatId}`.length).replace(/^:/, '')
    const note = facet === '' ? '' : `（${facet === header.id ? '其他' : facet}）`
    return `· ${when}${mark}${note}`
  })
  return { reply: `**会话历史**（${owned.length} 个）\n${rows.join('\n')}\n\n发消息即继续最近的会话；\`/new\` 开新会话。`, resolved: true }
}

/**
 * Handle `/config`: show the bridge's live configuration, credentials redacted.
 * @param config - the bridge's resolved configuration.
 * @returns the reply for the chat.
 */
function runConfigCommand(config: ResolvedConfig | undefined): CommandOutcome {
  if (config === undefined) {
    return { reply: `⚠️ 本部署没有提供配置快照，\`/${CONFIG_COMMAND}\` 不可用。`, resolved: false }
  }
  const on = (value: boolean): string => (value ? '开' : '关')
  const rows = [
    config.provider !== undefined || config.model !== undefined
      ? `· 模型：${config.provider ?? '默认'} / ${config.model ?? '默认'}`
      : '· 模型：宿主默认',
    config.preset !== undefined ? `· 模式：${config.preset}` : '· 模式：agent-presets 默认',
    `· 语言：${config.locale === 'en' ? 'English' : '简体中文'}`,
    `· 输出：${config.output === 'cot' ? '思考过程（cot）' : '流式卡片'}`,
    `· 会话维度：${config.sessionScope}`,
    `· 显示过程：${on(config.showProcess)}${config.hideProcessWhenDone ? '（完成后隐藏）' : ''}`,
    `· 图片传递：${on(config.attachImages)}`,
    `· 首次引导：${on(config.onboarding)}`,
    `· 同步面板：${on(config.syncSlashCommands)}`,
    `· 群内@才回应：${on(config.requireMention)}`,
    `· 反应反馈：${on(config.reactionFeedback)}`,
    `· 自动恢复目标：${on(config.autoResumeGoals)}`,
    `· 审批提醒：${config.approvalReminderMs > 0 ? `${config.approvalReminderMs / 1000}s` : '关'}`,
    config.denyTools.length > 0 ? `· 禁用工具：${config.denyTools.join(', ')}` : '· 禁用工具：无',
    config.senderAllowlist.length > 0 ? `· 发送者白名单：${config.senderAllowlist.join(', ')}` : '· 发送者白名单：开放',
    config.groupAllowlist.length > 0 ? `· 群白名单：${config.groupAllowlist.join(', ')}` : '· 群白名单：开放',
    config.approvers.length > 0 ? `· 审批人：${config.approvers.join(', ')}` : '· 审批人：对话可答',
  ]
  return {
    reply: `**当前配置**\n${rows.join('\n')}\n\n改配置：编辑 profile 的 cordis.patch.yml，保存后 HMR 自动生效（无需重启桥）。`,
    resolved: true,
  }
}

/**
 * Handle `/audit`: show the session's operation counters.
 * @param agent - the chat's agent (its session id keys the counters).
 * @param audits - live audit counters by session id.
 * @returns the reply for the chat.
 */
function runAuditCommand(
  agent: HostAgent,
  audits: ReadonlyMap<string, AuditStats> | undefined,
): CommandOutcome {
  if (audits === undefined) {
    return { reply: `⚠️ 本部署没有启用审计统计，\`/${AUDIT_COMMAND}\` 不可用。`, resolved: false }
  }
  const stats = audits.get(agent.session.id)
  if (stats === undefined) {
    return { reply: '**操作审计**\n本会话尚无操作记录（进程内统计从桥启动后开始）。', resolved: true }
  }
  const since = new Date(stats.startedAt).toLocaleString('zh-CN', { hour12: false })
  const errorRate = stats.turns > 0 ? `${Math.round((stats.turnErrors / stats.turns) * 100)}%` : '0%'
  const rows = [
    `· 轮次：${stats.turns}（出错 ${stats.turnErrors}，${errorRate}）`,
    `· 步骤：${stats.steps}`,
    `· 工具调用：${stats.toolCalls}`,
    `· 上下文压缩：${stats.compactions}`,
    `· 模型重试：${stats.retries}`,
    `· 子代理：${stats.subagents}`,
    `· 工作流：${stats.workflows}`,
    `· 定时提醒：${stats.schedules}`,
  ]
  return { reply: `**操作审计**（自 ${since} 起）\n${rows.join('\n')}`, resolved: true }
}

/**
 * Handle `/schedules`: list the chat's active reminders.
 * @param agent - the chat's agent (its session id keys the registry).
 * @param schedules - live schedule registry by session id.
 * @returns the reply for the chat.
 */
/**
 * Handle `/jobs`: list this session's background jobs, active first.
 * @param agent - the chat's agent (fences job ownership).
 * @param jobs - the background-job registry, when composed.
 * @returns the reply for the chat.
 */
function runJobsCommand(
  agent: HostAgent,
  jobs: HostJobs | undefined,
): CommandOutcome {
  if (jobs === undefined) {
    return { reply: `⚠️ 本部署没有组合后台任务运行时，\`/${JOBS_COMMAND}\` 不可用。`, resolved: false }
  }
  const snapshots = jobs.list(agent)
  if (snapshots.length === 0) {
    return {
      reply: `**后台任务**\n当前没有任务。让 agent 用 \`run_in_background\` 起一个（如"后台跑构建，完成后告诉我"）。`,
      resolved: true,
    }
  }
  const row = (job: { readonly id: string; readonly label: string; readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'; readonly detail?: string; readonly startedAt: number }): string => {
    const mark = job.status === 'running' ? '🔵' : job.status === 'stopping' ? '⏸️' : job.status === 'completed' ? '✅' : job.status === 'killed' ? '⏹️' : '❌'
    const detail = job.detail === undefined ? '' : `（${job.detail}）`
    const when = new Date(job.startedAt).toLocaleTimeString('zh-CN', { hour12: false })
    return `· ${mark} ${job.label}${detail} [${job.id}] ${when}`
  }
  const active = snapshots.filter(s => s.status === 'running' || s.status === 'stopping')
  const done = snapshots.filter(s => s.status !== 'running' && s.status !== 'stopping')
  const lines = [...active.map(row), ...done.map(row)]
  return { reply: `**后台任务**（${snapshots.length} 个，${active.length} 活动）\n${lines.join('\n')}`, resolved: true }
}

/**
 * Handle `/skills [name]`: list the workspace's discoverable skills, or show
 * one skill's body when named. This is the Feishu surface of the dsh skill
 * ecosystem — a chat user can see what skills are installed and peek at one
 * without leaving the conversation.
 * @param line - the trimmed command line.
 * @param skills - the host skill registry, when composed.
 * @returns the reply for the chat.
 */
async function runSkillsCommand(
  line: string,
  skills: HostSkills | undefined,
): Promise<CommandOutcome> {
  if (skills === undefined) {
    return { reply: `⚠️ 本部署没有组合 skill 注册表，\`/${SKILLS_COMMAND}\` 不可用。`, resolved: false }
  }
  const query = line.slice(1 + SKILLS_COMMAND.length).trim()
  if (query.length > 0) {
    const skill = await skills.get(query)
    if (skill === undefined) {
      return {
        reply: `⚠️ 找不到 skill \`${query}\`。用 \`/${SKILLS_COMMAND}\` 查看全部可用 skill。`,
        resolved: true,
      }
    }
    const body = skill.body.trim()
    const preview = body.length > 800 ? `${body.slice(0, 800)}\n…（截断）` : body
    return { reply: `**Skill · ${query}**\n\n${preview}`, resolved: true }
  }
  const summaries = await skills.list()
  if (summaries.length === 0) {
    return {
      reply: `**可用的 skills**\n当前工作区没有发现 skill。部署方可以注入 skill provider（如 \`@deepseek-ai/dsh-skill-filesystem\`）。`,
      resolved: true,
    }
  }
  const row = (s: { readonly name: string; readonly description: string; readonly source?: string }): string =>
    `· \`${s.name}\` — ${s.description}${s.source === undefined ? '' : `（${s.source}）`}`
  const lines = summaries.map(row)
  return { reply: `**可用的 skills**（${summaries.length} 个）\n${lines.join('\n')}\n\n查看某个：\`/${SKILLS_COMMAND} <name>\``, resolved: true }
}

/**
 * Handle `/plugins`: list the deployed Loader tree with live status — the chat
 * face of the web Settings' read-only inventory. The bridge reads the same
 * Cordis loader entries the web's pluginInventory remote projects, so the two
 * surfaces agree by construction. Read-only: installing or removing plugins
 * stays a CLI operation (`dsh plugin add/remove`), because the loader tree is
 * fixed at boot and mutating it from chat would lie about what is running.
 * @param loaderEntries - the host context's loader entries, when reachable.
 * @returns the reply for the chat.
 */
function runPluginsCommand(loaderEntries: readonly HostLoaderEntry[] | undefined): CommandOutcome {
  if (loaderEntries === undefined) {
    return { reply: `⚠️ 本部署拿不到插件清单（loader 不可达）。安装/卸载请用宿主 CLI：\`dsh plugin --profile <name> add <package>\`。`, resolved: false }
  }
  // Fiber states mirror the const enum (0 pending, 2 active, others failed/unloading);
  // app-boot keeps the same mirrors because the runtime object does not exist.
  const FIBER_ACTIVE = 2
  const rows = loaderEntries
    .filter(entry => entry.options.name !== undefined)
    .map(entry => {
      const name = entry.options.name ?? ''
      if (entry.disabled) return `· ${name} — ⏸ 已禁用`
      if (entry.fiber === undefined) return `· ${name} — ⚠ 未挂载`
      if (entry.fiber.state === FIBER_ACTIVE) return `· ${name}`
      return `· ${name} — ❌ 异常(state=${entry.fiber.state})`
    })
  if (rows.length === 0) {
    return { reply: '**已部署插件**：（清单为空）', resolved: true }
  }
  const active = rows.filter(row => !row.includes('—')).length
  return {
    reply: `**已部署插件**（${active}/${rows.length} 运行中）\n${rows.join('\n')}\n\n安装新插件请在部署机执行 \`dsh plugin --profile <name> add <npm包或github:repo>\`，重启后生效。`,
    resolved: true,
  }
}

/**
 * Handle `/ws`: list the registry's workspaces with the chat's current
 * workspace marked. Read-only — the chat drives one configured cwd, so unlike
 * the PC UI there is nothing to switch here; the listing shows what exists and
 * where new chats land. The registry is optional: a deployment without it (no
 * workspace plugin composed) gets a clear refusal instead of a fake answer.
 * @param workspaces - the host workspace-registry service, when composed.
 * @param currentCwd - the deployment's chat cwd (the directory new sessions use).
 * @returns the reply for the chat.
 */
function runWsCommand(
  workspaces: HostWorkspaceRegistry | undefined,
  currentCwd: string | undefined,
): CommandOutcome {
  if (workspaces?.list === undefined) {
    return { reply: `⚠️ 本部署没有组合 workspace 插件，\`/${WS_COMMAND}\` 不可用。`, resolved: false }
  }
  const rows = workspaces.list().map(w => {
    const mark = currentCwd !== undefined && w.path === currentCwd ? ' ← 当前' : ''
    const title = w.id === w.path || !w.id ? '' : `（${w.id}）`
    return `· \`${w.path}\`${title}${mark}`
  })
  if (rows.length === 0) {
    return {
      reply: `**工作区**：注册表为空。新会话将使用部署目录${currentCwd === undefined ? '' : ` \`${currentCwd}\``}（首次使用时自动注册）。`,
      resolved: true,
    }
  }
  const tail = currentCwd === undefined
    ? ''
    : `\n\n新会话工作目录：\`${currentCwd}\`（由部署配置 \`cwd\` 决定；改目录请编辑 cordis.patch.yml 后重启）。`
  return { reply: `**已注册的工作区**\n${rows.join('\n')}${tail}`, resolved: true }
}

/**
 * Handle `/model [provider/model]`: show the current default model, or switch
 * it. The switch goes through the host `agentDefaultModel.saveSelection` seam,
 * so a deployment with a settings provider persists the choice across
 * restarts; without one, the change is process-local. A deployment that pins
 * `provider`/`model` in the bridge config overrides everything — switching is
 * refused there because the config would win on the next agent anyway.
 * @param line - the trimmed command line.
 * @param defaultModel - the host agent-default-model service, when composed.
 * @param configModel - the bridge config's own provider/model override, when set.
 * @returns the reply for the chat.
 */
async function runModelCommand(
  line: string,
  defaultModel: HostDefaultModel | undefined,
  configModel: { readonly provider?: string; readonly model?: string } | undefined,
  catalog: ReadonlyArray<string> | undefined,
): Promise<CommandOutcome> {
  if (configModel?.provider !== undefined || configModel?.model !== undefined) {
    // Config values are initial defaults, not locks — /model can override them.
    // The new selection persists via agentDefaultModel and wins on next agent.
  }
  if (defaultModel === undefined) {
    return { reply: `⚠️ 本部署没有组合 agent-default-model 服务，\`/${MODEL_COMMAND}\` 不可用。`, resolved: false }
  }
  const arg = line.slice(1 + MODEL_COMMAND.length).trim()
  if (arg.length === 0) {
    const cur = defaultModel.currentSelection()
    const current = `${cur.provider}/${cur.model}`
    const effort = 'reasoningEffort' in cur && typeof cur.reasoningEffort === 'string' ? `（推理强度 ${cur.reasoningEffort}）` : ''
    if (catalog && catalog.length > 0) {
      const rows = catalog.map((m, i) => {
        const mark = m === cur.model || `${cur.provider}/${m}` === current ? ' ← 当前' : ''
        return `${i + 1}. ${m}${mark}`
      }).join('\n')
      return { reply: `**可选模型**（当前：${current}${effort}）\n${rows}\n\n回复编号即可切换`, resolved: true }
    }
    return {
      reply: `**当前默认模型**：\`${current}\`${effort}\n\n切换：\`/${MODEL_COMMAND} <provider>/<model>\``,
      resolved: true,
    }
  }
  // Catalog numeric selection
  if (catalog && catalog.length > 0 && /^\d+$/.test(arg)) {
    const idx = parseInt(arg, 10) - 1
    if (idx < 0 || idx >= catalog.length) {
      return { reply: `⚠️ 编号超范围（1-${catalog.length}）。`, resolved: false }
    }
    const sel: string = catalog[idx] ?? ""
    const sl = sel.indexOf('/')
    const sp = sl > 0 ? sel.slice(0, sl).trim() : configModel?.provider ?? ''
    const sm = sl > 0 ? sel.slice(sl + 1).trim() : sel
    if (defaultModel.saveSelection === undefined) {
      return { reply: '⚠️ 无 settings 层。', resolved: false }
    }
    await defaultModel.saveSelection({ provider: sp, model: sm })
    return { reply: `✅ 已切换为 **${sel}**`, resolved: true }
  }
  const slash = arg.indexOf('/')
  if (slash <= 0 || slash === arg.length - 1) {
    return { reply: `⚠️ 格式：\`/${MODEL_COMMAND} <provider>/<model>\`，例如 \`/${MODEL_COMMAND} deepseek-official/deepseek-v4\`。`, resolved: false }
  }
  const provider = arg.slice(0, slash).trim()
  const model = arg.slice(slash + 1).trim()
  if (defaultModel.saveSelection === undefined) {
    return {
      reply: `⚠️ 本部署没有 settings 持久化层，切换无法保存。请在部署配置（cordis.patch.yml 的 agent-default-model）里改。`,
      resolved: false,
    }
  }
  try {
    await defaultModel.saveSelection({ provider, model })
    return {
      reply: `✅ 默认模型已切换为 \`${provider}/${model}\`。对之后**新建**的会话生效；进行中的会话保持原模型（发 \`/new\` 开新会话即用新模型）。`,
      resolved: true,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { reply: `⚠️ 切换失败：${detail}`, resolved: true }
  }
}

/**
 * Handle `/feedback <positive|negative> [note]`: rate the chat's most recent
 * assistant answer through the host message-feedback seam.
 * @param line - the trimmed command line.
 * @param agent - the chat's agent (owns the session being rated).
 * @param feedback - the message-feedback service, when composed.
 * @param lastAssistantMessageId - the most recent assistant message id, or
 *   undefined when the session has produced no answer yet.
 * @returns the reply for the chat.
 */
async function runFeedbackCommand(
  line: string,
  agent: HostAgent,
  feedback: HostMessageFeedback | undefined,
  lastAssistantMessageId: string | undefined,
): Promise<CommandOutcome> {
  if (feedback === undefined) {
    return { reply: `⚠️ 本部署没有组合反馈服务，` + '`' + `/${FEEDBACK_COMMAND}` + '`' + ` 不可用。`, resolved: false }
  }
  if (lastAssistantMessageId === undefined) {
    return { reply: '⚠️ 还没有可评分的回答。先让 agent 回答一条，再给这条回答评分。', resolved: false }
  }
  const args = line.slice(`/${FEEDBACK_COMMAND}`.length).trim().split(/\s+/).filter(a => a !== '')
  const rating = args[0]?.toLowerCase()
  if (rating !== 'positive' && rating !== 'negative') {
    return {
      reply: `用法：` + '`' + `/${FEEDBACK_COMMAND} positive|negative [备注]` + '`' + `（给上一条回答评分）。`,
      resolved: false,
    }
  }
  const note = args.slice(1).join(' ').trim()
  const result = await feedback.put({
    sessionId: agent.session.id,
    messageId: lastAssistantMessageId,
    rating,
    ...note === '' ? {} : { note },
    ifVersion: null,
  })
  if (!result.ok) {
    const code = result.error?.code ?? 'unknown'
    return { reply: `⚠️ 评分未记录（${code}）。可能是这条回答已被清空或会话已归档。`, resolved: false }
  }
  return {
    reply: `✅ 已记录本次评分（${rating === 'positive' ? '👍 正面' : '👎 负面'}）${note === '' ? '' : `：${note}`}`,
    resolved: true,
  }
}

/**
 * Handle `/context`: show the session's current context token pressure.
 * @param agent - the chat's agent (owns the measured session).
 * @param tokenMeter - the token-meter service, when composed.
 * @returns the reply for the chat.
 */
function runContextCommand(
  agent: HostAgent,
  tokenMeter: HostTokenMeter | undefined,
): CommandOutcome {
  if (tokenMeter === undefined) {
    return { reply: `⚠️ 本部署没有组合 token 计量服务，` + '`' + `/${CONTEXT_COMMAND}` + '`' + ` 不可用。`, resolved: false }
  }
  const measure = tokenMeter.measure(agent.session)
  const total = measure.totalTokens.toLocaleString('zh-CN')
  const surface = measure.surfaceTokens.toLocaleString('zh-CN')
  const hint = measure.totalTokens > 120_000
    ? '\n⚠️ 上下文已偏高，长任务建议先 `/compact` 压缩。'
    : measure.totalTokens > 60_000
      ? '\n📈 上下文正在增长，超过 12 万 tokens 后建议压缩。'
      : ''
  return { reply: `**上下文压力**\n当前约 ${total} tokens（会话表面 ${surface}）${hint}`, resolved: true }
}

function runSchedulesCommand(
  agent: HostAgent,
  schedules: ReadonlyMap<string, ReadonlyMap<string, ScheduleEntry>> | undefined,
): CommandOutcome {
  if (schedules === undefined) {
    return { reply: `⚠️ 本部署没有启用定时提醒，\`/${SCHEDULES_COMMAND}\` 不可用。`, resolved: false }
  }
  const entries = schedules.get(agent.session.id)
  if (entries === undefined || entries.size === 0) {
    return { reply: '**定时提醒**\n当前没有活跃的提醒。让 agent 设一个（例如"10 分钟后提醒我"）后再看。', resolved: true }
  }
  const rows = [...entries.values()].map(entry => {
    const kind = entry.kind === 'after' ? '延时' : entry.kind === 'at' ? '定点' : `周期(${entry.everySeconds ?? '?'}s)`
    const prompt = entry.prompt.length > 40 ? `${entry.prompt.slice(0, 40)}…` : entry.prompt
    return `· [${kind}] ${prompt}`
  })
  return { reply: `**定时提醒**（${entries.size} 个活跃）\n${rows.join('\n')}`, resolved: true }
}

/**
 * Handle `/tools`, `/tools deny <name>`, and `/tools allow <name>`.
 * @param line - the trimmed command line.
 * @param deniedTools - the live denied-tool set, when the bridge shares one.
 * @returns the reply for the chat.
 */
function runToolsCommand(
  line: string,
  deniedTools: ReadonlySet<string> | undefined,
): CommandOutcome {
  const args = line.slice(`/${TOOLS_COMMAND}`.length).trim().split(/\s+/).filter(a => a !== '')
  if (deniedTools === undefined) {
    return { reply: `⚠️ 本部署没有运行时工具开关，\`/${TOOLS_COMMAND}\` 不可用。`, resolved: false }
  }
  const action = args[0]?.toLowerCase()
  const tool = args[1]?.toLowerCase()
  if (action === 'deny' && tool !== undefined) {
    if (deniedTools.has(tool)) return { reply: `\`${tool}\` 已在禁用列表。`, resolved: true }
    ;(deniedTools as Set<string>).add(tool)
    return { reply: `⛔ 已禁用 \`${tool}\`。下次调用即被拦截。`, resolved: true }
  }
  if (action === 'allow' && tool !== undefined) {
    if (!deniedTools.has(tool)) return { reply: `\`${tool}\` 不在禁用列表。`, resolved: true }
    ;(deniedTools as Set<string>).delete(tool)
    return { reply: `✅ 已允许 \`${tool}\`。`, resolved: true }
  }
  const listed = [...deniedTools]
  const body = listed.length === 0
    ? '当前没有禁用的工具。'
    : `当前禁用（${listed.length}）：\n${listed.map(t => `· \`${t}\``).join('\n')}`
  return {
    reply: `**工具开关**\n${body}\n\n用法：\`/${TOOLS_COMMAND} deny <name>\` 禁用、\`/${TOOLS_COMMAND} allow <name>\` 恢复。`,
    resolved: true,
  }
}

/**
 * Handle `/preset` and `/preset <id>`.
 * @param line - the trimmed command line (leading slash preserved).
 * @param agent - the chat's agent.
 * @param presets - the roster, when composed.
 * @returns the reply for the chat.
 */
async function runPresetCommand(
  line: string,
  agent: HostAgent,
  presets: HostAgentPresets | undefined,
  sessionPresets: Map<string, string> | undefined,
): Promise<CommandOutcome> {
  const unlisted = `⚠️ 本部署没有组合 agent-presets 服务，\`/${PRESET_COMMAND}\` 不可用。`
  if (presets === undefined) return { reply: unlisted, resolved: false }
  const scope = agentScope(agent)
  if (scope === undefined) {
    return { reply: '⚠️ 无法访问当前会话的配置上下文。', resolved: false }
  }
  const current = presets.composedPreset(scope)
  const wanted = line.slice(`/${PRESET_COMMAND}`.length).trim().split(/\s+/)[0]?.toLowerCase()
  if (wanted === undefined || wanted === '') {
    const rows = (await presets.list())
      .map(p => {
        const label = presetDisplayName(p)
        const mark = p.id === current ? ' ← 当前' : ''
        const broken = p.broken === undefined ? '' : `（已损坏：${p.broken}）`
        return `· \`${p.id}\` — ${label}${mark}${broken}`
      })
      .join('\n')
    return { reply: `**模式选择**（${current ?? '未加入 preset'}）\n${rows}\n\n切换：\`/${PRESET_COMMAND} <id>\`（新会话才能切换）`, resolved: true }
  }
  if (!SHIPPED_PRESET_IDS.includes(wanted as (typeof SHIPPED_PRESET_IDS)[number])) {
    const known = SHIPPED_PRESET_IDS.join('、')
    return { reply: `⚠️ 未知模式 \`${wanted}\`。可用：${known}。`, resolved: false }
  }
  if (current === wanted) {
    return { reply: `当前已是 ${PRESET_NAMES[wanted] ?? wanted}（\`${wanted}\`）。`, resolved: true }
  }
  try {
    await presets.recompose(scope, wanted)
    // Remember the choice for this session so a resume after /stop (or a
    // bridge restart) composes the same preset instead of the default.
    if (sessionPresets !== undefined) sessionPresets.set(agent.session.id, wanted)
    return {
      reply: `✅ 已切换到 ${PRESET_NAMES[wanted] ?? wanted}（\`${wanted}\`）。当前会话为空白会话，新工具集已生效。`,
      resolved: true,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      reply: `⚠️ 切换失败：${detail}\n\n` + '已进行过对话的会话不能切换模式。发送 `/new` 开一个新会话（新会话使用所选模式）后即可生效。',
      resolved: false,
    }
  }
}
