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
import type { HostAgent, HostAgentPresets, HostCommands, HostSessionPersistence, ScheduleEntry } from './host.ts'

/** Cancel the running turn. Not a host command: cancellation is an agent method. */
export const STOP_COMMAND = 'stop'

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
export function helpText(commands: HostCommands | undefined, agent: HostAgent): string {
  const own = [
    `\`/${STOP_COMMAND}\` — 停止当前任务`,
    `\`/${PRESET_COMMAND}\` — 查看/切换模式（标准/PTC/极简/创造）`,
    `\`/${SESSIONS_COMMAND}\` — 查看本聊天的会话历史`,
    `\`/${TOOLS_COMMAND}\` — 查看/禁用/恢复工具`,
    `\`/${SCHEDULES_COMMAND}\` — 查看本聊天的定时提醒`,
    `\`/${HELP_COMMAND}\` — 显示这条帮助`,
  ]
  const hosted = (commands?.list(agent) ?? [])
    .map(descriptor => `\`/${descriptor.name}\` — ${descriptor.description}`)
  return ['**可用命令**', ...hosted, ...own].join('\n')
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
): Promise<CommandOutcome> {
  const trimmed = line.trimStart()
  const name = commandName(trimmed) ?? ''
  if (name === STOP_COMMAND) {
    agent.cancel(CANCEL_CAUSE)
    return { reply: '⏹ 已停止当前任务。', resolved: true }
  }
  if (name === PRESET_COMMAND) {
    return runPresetCommand(trimmed, agent, presets)
  }
  if (name === SESSIONS_COMMAND) {
    return runSessionsCommand(agent, persistence, chatId)
  }
  if (name === TOOLS_COMMAND) {
    return runToolsCommand(trimmed, deniedTools)
  }
  if (name === SCHEDULES_COMMAND) {
    return runSchedulesCommand(agent, schedules)
  }
  if (name === HELP_COMMAND) {
    return { reply: helpText(commands, agent), resolved: true }
  }
  if (commands === undefined) {
    return { reply: `⚠️ 本部署没有组合命令运行时，\`/${name}\` 无法执行。`, resolved: false }
  }
  const execution = await commands.execute(agent, trimmed, signal)
  if (execution === undefined) {
    return { reply: `⚠️ 未知命令 \`/${name}\`。\n\n${helpText(commands, agent)}`, resolved: false }
  }
  const { result } = execution
  if (result.kind === 'error') return { reply: `⚠️ \`/${name}\` 执行失败：${result.text}`, resolved: true }
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
): Promise<CommandOutcome> {
  if (persistence === undefined) {
    return { reply: `⚠️ 本部署没有组合会话存储，\`/${SESSIONS_COMMAND}\` 不可用。`, resolved: false }
  }
  if (chatId === undefined) {
    return { reply: '⚠️ 无法确定当前聊天。', resolved: false }
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
 * Handle `/schedules`: list the chat's active reminders.
 * @param agent - the chat's agent (its session id keys the registry).
 * @param schedules - live schedule registry by session id.
 * @returns the reply for the chat.
 */
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
