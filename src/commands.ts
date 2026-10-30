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
import type { AuditStats, HostAgent, HostAgentPresets, HostCommands, HostDefaultModel, HostJobs, HostLoaderEntry, HostMessageFeedback, HostSessionPersistence, HostSessionQuery, HostSkills, HostTokenMeter, HostWorkspaceRegistry, ScheduleEntry,
  HostTools,} from './host.ts'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DEFAULT_LIMITS } from './config.ts'
import type { BusyPolicy, Limits, ResolvedConfig } from './config.ts'
import { describeCommand, helpHeading } from './i18n.ts'
import type { SyncCommandContext } from './sync/bot-command.ts'
import { runBotCommand } from './sync/bot-command.ts'
import { fetchDeepseekBalance, formatBalanceReply } from './balance.ts'
import { USER_GUIDE } from './user-guide.ts'
import { writeRestartRequest } from './restart-notice.ts'

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
 * chat. Exported for tests to stub.
 *
 * The delay is carried by the CHILD, not by a timer here: this process is
 * about to be killed, so a `setTimeout` in it would die with the reply still
 * in flight. That means each platform needs its own way to wait, and the one
 * this used to hardcode — `/bin/sh -c 'sleep 2.5 && …'` — does not exist on
 * Windows at all. `spawn('/bin/sh', …)` there fails with ENOENT before the
 * command ever runs, so `/restart` could never work on Windows no matter what
 * `restartCommand` was configured to. PowerShell is the Windows equivalent
 * that is always present (5.1 ships with the OS), and `Start-Sleep` is its
 * `sleep`.
 */
export let scheduleRestart = (shell: string): void => {
  void import('node:child_process').then(({ spawn }) => {
    const windows = process.platform === 'win32'
    const file = windows ? 'powershell.exe' : '/bin/sh'
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-Command', `Start-Sleep -Milliseconds 2500; ${shell}`]
      : ['-c', `sleep 2.5 && ${shell}`]
    spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: windows }).unref()
  })
}

/** Test seam: replace the restart scheduler. Returns the previous one. */
export function setRestartScheduler(fn: (shell: string) => void): (shell: string) => void {
  const prev = scheduleRestart
  scheduleRestart = fn
  return prev
}

/**
 * Records the chat that asked for a restart so the next boot can report when
 * the service came back (src/restart-notice.ts). Exported for tests to stub.
 */
export let recordRestartRequest = (chatId: string): boolean => writeRestartRequest(chatId)

/** Test seam: replace the restart recorder. Returns the previous one. */
export function setRestartRequestRecorder(fn: (chatId: string) => boolean): (chatId: string) => boolean {
  const prev = recordRestartRequest
  recordRestartRequest = fn
  return prev
}

/** List what this chat accepts. Not a host command: the list is per surface. */
export const HELP_COMMAND = 'help'

/** Switch the agent's preset (standard / code / minimal / cordis). */
export const PRESET_COMMAND = 'preset'

/** List this chat's stored sessions. */
export const SESSIONS_COMMAND = 'sessions'

/** Start a fresh session for this conversation; `/clear` is an alias. */
export const NEW_COMMAND = 'new'

/** Bridge dual-end status, settings, and plugin sync. */
export const BOT_COMMAND = 'bot'

/** Query the DeepSeek platform balance the deployment bills through. */
export const BALANCE_COMMAND = 'balance'

/** The full user guide, in chat. */
export const MANUAL_COMMAND = 'manual'

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

/** 一张回复最多列几个工作区／会话，多出来的只说数量。 */
const WS_ROWS_MAX = 20
const SESSION_ROWS_MAX = 20

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
  /**
   * An interactive Feishu card to send alongside (or instead of, when the
   * reply is empty) the text — the account-switcher uses it so switching is
   * two taps instead of a typed name.
   */
  readonly card?: object
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
export function helpText(
  commands: HostCommands | undefined,
  agent: HostAgent,
  locale: 'zh' | 'en' = 'zh',
  config?: ResolvedConfig,
  feedback?: HostMessageFeedback,
): string {
  const own = [
    `\`/${STOP_COMMAND}\` — ${describeCommand(STOP_COMMAND, locale, 'Stop the current task')}`,
    // Listed only when the deployment wired a restart command, matching the panel.
    ...(config?.restartCommand ? [`\`/${RESTART_COMMAND}\` — ${describeCommand(RESTART_COMMAND, locale, 'Restart the host process')}`] : []),
    `\`/${NEW_COMMAND}\` — ${describeCommand(NEW_COMMAND, locale, 'Start a new session')}`,
    `\`/${PRESET_COMMAND}\` — ${describeCommand(PRESET_COMMAND, locale, 'View or switch mode')}`,
    `\`/${SESSIONS_COMMAND}\` — ${describeCommand(SESSIONS_COMMAND, locale, 'View session history')}`,
    `\`/${TOOLS_COMMAND}\` — ${describeCommand(TOOLS_COMMAND, locale, 'View, deny, or allow tools')}`,
    `\`/${SCHEDULES_COMMAND}\` — ${describeCommand(SCHEDULES_COMMAND, locale, 'View scheduled reminders')}`,
    `\`/${JOBS_COMMAND}\` — ${describeCommand(JOBS_COMMAND, locale, 'View background jobs')}`,
    `\`/${CONTEXT_COMMAND}\` — ${describeCommand(CONTEXT_COMMAND, locale, 'View context pressure')}`,
    `\`/${SKILLS_COMMAND}\` — ${describeCommand(SKILLS_COMMAND, locale, 'List / inspect discoverable skills')}`,
    `\`/${MODEL_COMMAND}\` — ${describeCommand(MODEL_COMMAND, locale, 'View or switch the default model')}`,
    `\`/${BOT_COMMAND}\` — ${describeCommand(BOT_COMMAND, locale, 'Bridge dual-end status, settings, plugin sync')}`,
    `\`/${BALANCE_COMMAND}\` — ${describeCommand(BALANCE_COMMAND, locale, 'DeepSeek API balance')}`,
    // Only when the deployment composed the feedback service: listing a
    // command that answers with "not available" teaches the reader to
    // distrust the listing.
    ...(feedback === undefined ? [] : [`\`/${FEEDBACK_COMMAND}\` — ${describeCommand(FEEDBACK_COMMAND, locale, 'Record feedback about this session')}`]),
    `\`/${MANUAL_COMMAND}\` — ${describeCommand(MANUAL_COMMAND, locale, 'The full user guide')}`,
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
  sync: SyncCommandContext | undefined = undefined,
  tools: HostTools | undefined = undefined,
  toolScope: unknown = undefined,
  /** Whether `currentCwd` came from the chat's own binding (for `/ws`). */
  cwdBound = false,
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
    // This process cannot report its own return; leave the requesting chat on
    // disk and the next boot posts the "restored" line (src/restart-notice.ts).
    const noted = chatId === undefined || recordRestartRequest(chatId)
    return {
      reply: '🔁 正在重启：预计 2 分钟内恢复；恢复后我会在这里报一声。'
        + (noted ? '' : '\n⚠️ 注意：恢复回执未能写入磁盘（可能收不到那条「已恢复」）。'),
      resolved: true,
    }
  }
  if (name === PRESET_COMMAND) {
    return runPresetCommand(trimmed, agent, presets, sessionPresets)
  }
  if (name === SESSIONS_COMMAND) {
    const query = trimmed.slice(1 + SESSIONS_COMMAND.length).trim()
    return runSessionsCommand(agent, persistence, chatId, query, sessionQuery, config?.limits ?? DEFAULT_LIMITS)
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
    return runToolsCommand(trimmed, deniedTools, tools, toolScope)
  }
  if (name === SCHEDULES_COMMAND) {
    return runSchedulesCommand(agent, schedules, config?.limits ?? DEFAULT_LIMITS)
  }
  if (name === AUDIT_COMMAND) {
    return runAuditCommand(agent, audits)
  }
  if (name === SKILLS_COMMAND) {
    return runSkillsCommand(trimmed, skills, config?.limits ?? DEFAULT_LIMITS)
  }
  if (name === BOT_COMMAND) {
    if (sync === undefined) {
      return { reply: '⚠️ 本部署未启用双端同步（缺少 sync 上下文）。', resolved: false }
    }
    return runBotCommand(trimmed, sync)
  }
  if (name === MANUAL_COMMAND) {
    return { reply: USER_GUIDE, resolved: true }
  }
  if (name === BALANCE_COMMAND) {
    // The key that matters is the one the harness bills through, which the
    // deployment exports into this process (web 端的启动脚本 on the web side).
    const key = process.env.DEEPSEEK_API_KEY
    if (key === undefined || key === '') {
      return {
        reply: '⚠️ 本端环境没有 `DEEPSEEK_API_KEY`，查不了余额。web 端由启动脚本导出；desktop 端看应用自身的 provider 配置。',
        resolved: true,
      }
    }
    try {
      const result = await fetchDeepseekBalance(key)
      return { reply: formatBalanceReply(result), resolved: true }
    } catch (error) {
      return { reply: `⚠️ 余额查询失败：${error instanceof Error ? error.message : String(error)}`, resolved: true }
    }
  }
  if (name === MODEL_COMMAND) {
    return runModelCommand(trimmed, defaultModel, configModel, config?.modelCatalog)
  }
  if (name === WS_COMMAND) {
    return runWsCommand(workspaces, currentCwd, cwdBound)
  }
  if (name === PLUGINS_COMMAND) {
    return runPluginsCommand(loaderEntries)
  }
  if (name === CONFIG_COMMAND) {
    return runConfigCommand(config)
  }
  if (name === HELP_COMMAND) {
    return { reply: helpText(commands, agent, config?.locale ?? 'zh', config, feedback), resolved: true }
  }
  if (commands === undefined) {
    return { reply: `⚠️ 本部署没有组合命令运行时，\`/${name}\` 无法执行。`, resolved: false }
  }
  // dsh 0.1.5 的 execute 是四参 (agent, line, submittedAttachments, signal)：
  // 附件槽不给空数组会把 signal 挤进附件位、signal 位留 undefined，
  // 核心读 `signal.aborted` 即崩（症状：每条斜杠命令都报"无法启动会话"）。
  // 桥不随命令提交附件（飞书图片走 notes 注入），恒传空。
  //
  // ★arity 护栏（issue #2 的建议，2026-10-20）：上游把 `images` 槽位插到
  // `signal` 之前那一次，正是"传参错位 → 静默崩"而不是"响亮地崩"。
  // 硬传四个参数在老版本（三参）上会同样错位——所以这里按宿主实际声明的
  // 形参个数调用，而不是写死形状：多一个就传四参，少一个就传三参。
  // 判据不是 `execute.length`（它只数到第一个默认值之前，宿主给 signal
  // 写了默认值时它会少报一个）——判据是**三参与四参都能对上**的形状：
  // 传出去的第三参是空的数组，同时把 signal 代理进去，于是
  // 两种宿主都拿到各自要的那个槽位。下面的实现就是这个形状。
  //
  // ★★ 未知形状必须响亮（2026-10-20，御史复核的反例）：原先写成
  // `length === 3 ? 三参 : 四参`——凡是不等于 3 的形状都落四参臂。
  // 实测：`length===2`（宿主给 signal 写了默认值时，JS 的 length 只数到
  // 第一个默认值之前）会落四参臂，signal 槽收到 `[]`、真 signal 留
  // undefined，**issue #2 的同一个失败类原样回来**
  // （`TypeError: signal.throwIfAborted is not a function`）。
  // 所以未知形状不猜：记一条告警，并按最可能正确的四参调用，
  // 但让漂移在日志里留痕，而不是无声地错位。
  const execute = commands.execute as unknown as (
    ...args: unknown[]
  ) => Promise<Awaited<ReturnType<HostCommands['execute']>>>
  // The attachments slot and the signal slot are told apart by position, so
  // the argument that goes in the third place has to satisfy both readings
  // at once. It is an empty array (what a four-argument host wants there)
  // that also carries the signal's methods (what a three-argument host
  // wants there), so one call works for either shape.
  //
  // Why not read the arity and pick a shape: a host that gives `signal` a
  // default value reports a length of 3 while still having the
  // attachments slot, and picking the three-argument shape for it puts
  // the signal where the attachments belong. That is the same failure
  // issue #2 reported, except silent: the host uses its default signal
  // and the bridge loses the abort. Reading the arity cannot tell that
  // shape from a host that never had an attachments slot.
  //
  // Why not always pass four: a three-argument host would then read the
  // attachments array as its signal.
  // A proxy, not a copied object: the signal's members live on its
  // prototype, so copying them by assignment yields an empty object. The
  // proxy reads as an empty array (length 0, no entries) and forwards the
  // signal's own members to the real signal.
  const attachmentsSlot = new Proxy([] as unknown[], {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      const member = (signal as unknown as Record<PropertyKey, unknown>)[property]
      return typeof member === 'function' ? member.bind(signal) : member
    },
  })
  const execution = await execute.call(commands, agent, trimmed, attachmentsSlot, signal)
  if (execution === undefined) {
    return { reply: `⚠️ 未知命令 \`/${name}\`。\n\n${helpText(commands, agent, config?.locale ?? 'zh', config, feedback)}`, resolved: false }
  }
  const { result } = execution
  // /compact answers in terse English lines ("Compacted 8 history items
  // (~12,345 tokens).", failures included) — translate the cases a chat meets
  // and keep the numbers, ahead of the generic error echo below.
  if (name === 'compact' && typeof result.text === 'string') {
    if (result.kind === 'success') {
      const compacted = /^Compacted (\d+) history items \(~([\d,]+) tokens\)\.$/.exec(result.text)
      if (compacted !== null) {
        const tokens = Number(compacted[2]!.replace(/,/g, ''))
        return {
          reply: `📦 压缩完成：${compacted[1]} 条较早历史已换成摘要（释放约 ${tokens.toLocaleString('zh-CN')} tokens）。`,
          resolved: true,
        }
      }
      if (result.text.startsWith('No compactable history')) {
        return { reply: '📦 现在没有可压缩的历史（还没积累到可压缩的量，或刚好没有合适的切点）。', resolved: true }
      }
    } else if (result.text.includes('not idle') || result.text.includes('already has an active')) {
      return { reply: '⏳ 现在压不了：会话正在跑任务，或已有一次压缩在进行。等它空闲后再发 `/compact`。', resolved: true }
    } else if (result.text.includes('cancelled')) {
      return { reply: '⏹ 压缩已取消。', resolved: true }
    }
  }
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
  limits: Limits = DEFAULT_LIMITS,
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
    const owned = page.items.filter(hit => hit.header.id.startsWith(`${SESSION_PREFIX}${chatId}`))
    if (owned.length === 0) {
      return { reply: `**会话检索**\n没有找到与「${query}」匹配的本聊天记录。`, resolved: true }
    }
    const rows = owned.map(hit => {
      const when = hit.header.createdAt === undefined
        ? ''
        : `${new Date(hit.header.createdAt).toLocaleString('zh-CN', { hour12: false })} `
      const mark = hit.header.id === agent.session.id ? ' ← 当前' : ''
      const wide = limits.searchSnippetChars
      const snippet = hit.bestMatch.snippet.length <= wide ? hit.bestMatch.snippet : `${hit.bestMatch.snippet.slice(0, wide - 1)}…`
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
    .filter(header => header.header.id.startsWith(`${SESSION_PREFIX}${chatId}`))
    .sort((a, b) => b.header.createdAt - a.header.createdAt)
  if (owned.length === 0) {
    return { reply: '**会话历史**\n还没有本聊天的已保存会话。', resolved: true }
  }
  // 一个用了几个月的聊天能有上百个会话；列全会把一张回复撑爆，也把最近的
  // 那几个挤走。取最近的 N 个，并说清还剩多少。
  const shownHeaders = owned.slice(0, SESSION_ROWS_MAX)
  const rows = shownHeaders.map(header => {
    const when = new Date(header.header.createdAt).toLocaleString('zh-CN', { hour12: false })
    const mark = header.header.id === agent.session.id ? ' ← 当前' : ''
    const facet = header.header.id.slice(`${SESSION_PREFIX}${chatId}`.length).replace(/^:/, '')
    // A rotation suffix (`:r<stamp><rand>`) is an internal id, not a name a
    // reader can use — label it, and keep anything else verbatim.
    const label = facet === '' ? '' : facet === header.header.id ? '其他' : /^r[0-9a-z]+$/.test(facet) ? '新会话' : facet
    const note = label === '' ? '' : `（${label}）`
    return `· ${when}${mark}${note}`
  })
  const more = owned.length > shownHeaders.length
    ? `\n…还有 ${owned.length - shownHeaders.length} 个更早的未列出（只显示最近 ${SESSION_ROWS_MAX} 个）。`
    : ''
  return { reply: `**会话历史**（${owned.length} 个）\n${rows.join('\n')}${more}\n\n发消息即继续最近的会话；\`/new\` 开新会话。`, resolved: true }
}

/** How `/config` names each `busyPolicy`, for a reader who does not know the enum. */
const BUSY_POLICY_LABELS: Record<BusyPolicy, string> = {
  queue: '排队（queue）',
  steer: '中途插话（steer）',
  inject: '上下文注入（inject）',
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
    `· 忙时策略：${BUSY_POLICY_LABELS[config.busyPolicy]}`,
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
  // The engine checks ownership against a bare session-id string; passing the
  // agent itself matched nothing, so the list only ever showed unowned jobs.
  const snapshots = jobs.list(agent.session.id)
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
  limits: Limits = DEFAULT_LIMITS,
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
    const body = skill.content.trim()
    const preview = body.length > limits.skillPreviewChars
      ? `${body.slice(0, limits.skillPreviewChars)}\n…（截断）`
      : body
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
 * The comparison key two directory strings must share to mean the same place.
 *
 * A workspace record stores the canonical (realpath) path; a chat binding
 * stores whatever the operator typed. `D:\Desktop\x`, `d:\desktop\x\` and
 * `D:\DESKTO~1\x` all name one directory, and plain string equality calls them
 * three. Normalising (absolute → platform case rules → no trailing separator)
 * is what makes them meet.
 *
 * The key is then hashed rather than returned raw: literal directory paths are
 * exactly what this repository's private-value form (`{{SECRET_…}}`, filled at
 * build time) exists to keep out of committed output, and a build that inlines
 * a comparison path would leak the operator's layout. The digest of a
 * normalised path is all the comparison needs.
 * @param dir - a directory string from the registry or from a chat binding.
 * @returns an opaque key that is equal for two spellings of one directory.
 */
function workspaceKey(dir: string): string {
  const normal = resolve(dir)
  // Windows and macOS are case-insensitive by default, Linux is not; a mapping
  // that folded case everywhere would conflate two real Linux directories.
  const folded = process.platform === 'win32' || process.platform === 'darwin'
    ? normal.toLowerCase()
    : normal
  return createHash('sha256').update(folded).digest('hex')
}

/**
 * Handle `/ws`: list the registry's workspaces with the chat's current
 * workspace marked. Read-only — unlike the PC UI there is nothing to switch
 * here; the listing shows what exists and where new chats land. The registry
 * is optional: a deployment without it (no workspace plugin composed) gets a
 * clear refusal instead of a fake answer.
 *
 * `currentCwd` is the directory this chat's next session will start in — the
 * chat's own binding when it has one, else the deployment cwd — NOT the
 * deployment cwd alone. The two differ whenever `/ws use <dir>` ran: `/new`
 * lands in the binding, so marking the deployment cwd as 「当前」 told the chat
 * a directory it had left, and the closing line sent readers to edit
 * cordis.patch.yml for a directory a binding would override anyway.
 *
 * The comparison is against the workspace record's canonical (realpath) path,
 * so a binding written with different letter case, 8.3 short form, a junction
 * or a trailing fence must still match. JS string equality misses all of
 * those; hashing the canonical key is what catches them, and it keeps the
 * comparison in this project's private `{{SECRET_…}}` form — no literal
 * directory name survives in the bundle.
 * @param workspaces - the host workspace-registry service, when composed.
 * @param currentCwd - the directory this chat's next session starts in.
 * @param bound - true when `currentCwd` came from the chat's own binding.
 * @returns the reply for the chat.
 */
function runWsCommand(
  workspaces: HostWorkspaceRegistry | undefined,
  currentCwd: string | undefined,
  bound = false,
): CommandOutcome {
  if (workspaces?.list === undefined) {
    return { reply: `⚠️ 本部署没有组合 workspace 插件，\`/${WS_COMMAND}\` 不可用。`, resolved: false }
  }
  // Why the canonical key and not the raw string: see the doc comment above.
  const wanted = currentCwd === undefined ? undefined : workspaceKey(currentCwd)
  const all = workspaces.list()
  const shown = all.slice(0, WS_ROWS_MAX)
  const rows = shown.map(w => {
    const mark = wanted !== undefined && workspaceKey(w.path) === wanted ? ' ← 当前' : ''
    const title = w.id === w.path || !w.id ? '' : `（${w.id}）`
    return `· \`${w.path}\`${title}${mark}`
  })
  if (rows.length === 0) {
    return {
      reply: `**工作区**：注册表为空。新会话将使用${bound ? '本群绑定的目录' : '部署目录'}${currentCwd === undefined ? '' : ` \`${currentCwd}\``}（首次使用时自动注册）。`,
      resolved: true,
    }
  }
  // The tail names the authority that actually decides, so nobody is sent to
  // edit a config value a binding already outranks.
  const tail = currentCwd === undefined
    ? ''
    : `\n\n新会话工作目录：\`${currentCwd}\`（${bound ? '由本群绑定 /ws use 决定' : '由部署配置 cwd 决定；改目录请编辑 cordis.patch.yml 后重启'}）。`
  // 一个长期使用的部署会攒出几十个工作区，而一张回复有载荷上限：列全了要么
  // 被平台截断（用户看到「命令没反应」），要么把真正要看的「← 当前」挤到看不
  // 见的地方。列前 N 个，并说清还剩多少、去哪儿看全。
  const more = all.length > shown.length
    ? `\n…还有 ${all.length - shown.length} 个未列出（` + '`/' + WS_COMMAND + '`' + ` 只显示前 ${WS_ROWS_MAX} 个）。`
    : ''
  return { reply: `**已注册的工作区**（${all.length} 个）\n${rows.join('\n')}${more}${tail}`, resolved: true }
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
      return { reply: `**可选模型**（当前：${current}${effort}）\n${rows}\n\n切换：\`/${MODEL_COMMAND} <编号>\`（例如 \`/${MODEL_COMMAND} 1\`）`, resolved: true }
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
  limits: Limits = DEFAULT_LIMITS,
): CommandOutcome {
  const promptChars = limits.schedulePromptChars
  if (schedules === undefined) {
    return { reply: `⚠️ 本部署没有启用定时提醒，\`/${SCHEDULES_COMMAND}\` 不可用。`, resolved: false }
  }
  const entries = schedules.get(agent.session.id)
  if (entries === undefined || entries.size === 0) {
    return { reply: '**定时提醒**\n当前没有活跃的提醒。让 agent 设一个（例如"10 分钟后提醒我"）后再看。', resolved: true }
  }
  const rows = [...entries.values()].map(entry => {
    const kind = entry.kind === 'after' ? '延时' : entry.kind === 'at' ? '定点' : `周期(${entry.everySeconds ?? '?'}s)`
    const prompt = entry.prompt.length > promptChars ? `${entry.prompt.slice(0, limits.schedulePromptChars)}…` : entry.prompt
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
/**
 * The tools visible in a scope, as the reader sees them.
 *
 * The seam is optional: a deployment that does not compose the listing
 * shows the deny list alone, which is still an answer. A host that throws
 * while enumerating is another deployment's problem, and the reader should
 * not lose the deny list over it.
 * @param tools - the tools service, when the deployment composes one.
 * @param scope - the viewing scope; omitted views the global layer.
 * @returns the visible tools, or undefined when the seam is absent.
 */
function toolInventory(
  tools: HostTools | undefined,
  scope: unknown,
): readonly { readonly name: string; readonly description?: string }[] | undefined {
  if (tools === undefined || typeof tools.schemas !== 'function') return undefined
  try {
    const listed = tools.schemas(scope)
    if (!Array.isArray(listed)) return undefined
    return listed
      .filter(entry => entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')
      .map(entry => ({
        name: (entry as { name: string }).name,
        ...typeof (entry as { description?: unknown }).description === 'string'
          ? { description: (entry as { description: string }).description }
          : {},
      }))
  } catch {
    return undefined
  }
}

/**
 * The MCP servers a tool list shows, read off the host's namespace.
 *
 * The host registers an MCP server's tools as `mcp__<server>__<tool>`, so
 * the servers are already in the names — no separate registry to ask for.
 * @param tools - the visible tools, or undefined when the seam is absent.
 * @returns the server names, sorted, without duplicates.
 */
function mcpServerNames(
  tools: readonly { readonly name: string }[] | undefined,
): string[] {
  if (tools === undefined) return []
  const servers = new Set<string>()
  for (const tool of tools) {
    const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(tool.name)
    if (match !== null) servers.add(match[1]!)
  }
  return [...servers].sort()
}

function runToolsCommand(
  line: string,
  deniedTools: ReadonlySet<string> | undefined,
  tools: HostTools | undefined = undefined,
  toolScope: unknown = undefined,
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
  const deniedBody = listed.length === 0
    ? '当前没有禁用的工具。'
    : `当前禁用（${listed.length}）：\n${listed.map(t => `· \`${t}\``).join('\n')}`
  // What the machine can do, not only what someone switched off: a reader
  // asking "what can this deployment do" has no other way to find out.
  const inventory = toolInventory(tools, toolScope)
  // "What can this machine do" is answered by the tools it still has: a tool
  // someone switched off is not available, and listing it beside the ones
  // that are answers a different question than the reader asked.
  const available = inventory === undefined
    ? undefined
    : inventory.filter(t => !deniedTools.has(t.name))
  const availableBody = available === undefined
    ? ''
    : available.length === 0
      ? '\n当前作用域里没有可用的工具。'
      : `\n可用（${available.length}）：\n${available.map(t => `· \`${t.name}\`${t.description === undefined || t.description === '' ? '' : ` — ${t.description}`}`).join('\n')}`
  // The MCP servers this deployment talks to, read off the tool names the
  // host namespaces them under (`mcp__<server>__<tool>`). A deployment that
  // connects a server otherwise shows nothing about it in the chat.
  const mcpServers = mcpServerNames(available)
  const mcpBody = mcpServers.length === 0
    ? ''
    : `\nMCP 服务器（${mcpServers.length}）：${mcpServers.map(s => `\`${s}\``).join('、')}`
  return {
    reply: `**工具开关**\n${deniedBody}${availableBody}${mcpBody}\n\n用法：\`/${TOOLS_COMMAND} deny <name>\` 禁用、\`/${TOOLS_COMMAND} allow <name>\` 恢复。`,
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
  // The roster the deployment actually composes is the authority on which
  // modes exist; the shipped list is only a fallback for a deployment that
  // cannot list them. A host that ships a mode the bridge's list does not
  // know would otherwise be rejected by name.
  const available = await presets.list().catch(() => [])
  const knownIds = available.length > 0
    ? available.map(p => p.id)
    : [...SHIPPED_PRESET_IDS]
  if (!knownIds.includes(wanted)) {
    const known = knownIds.join('、')
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
