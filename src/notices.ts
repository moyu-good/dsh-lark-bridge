/**
 * Low-frequency session events rendered as one-off chat lines.
 *
 * The remaining events dsh logs that a chat user benefits from hearing are
 * small and one-shot: a subagent child opening, a scheduled task being
 * created or deleted, a DeepSeek search firing, and a model-call retry. Each
 * maps to a single short line — no card, no state — so the chat stays a
 * readable stream. `session/title` is deliberately NOT rendered: the Web UI
 * uses it for its session list, and a messaging chat has no list surface.
 * @module dsh-lark-bridge/notices
 */

import { DEFAULT_LIMITS } from './config.ts'
import { shortStamp, upcomingPhrase } from './clock.ts'

/** The `subagent/descriptor` payload fields this module renders. */
export interface SubagentNotice {
  readonly mode: 'one-shot' | 'continuable'
  readonly label?: string
}

/** A subagent child opening line. */
export function subagentLine(descriptor: SubagentNotice): string {
  const kind = descriptor.mode === 'continuable' ? '可续子任务' : '子任务'
  const label = descriptor.label === undefined ? '' : `「${descriptor.label}」`
  return `🧑💻 ${kind}${label} 已启动`
}

/**
 * Every rule kind the host scheduler accepts.
 *
 * Duplicated as a string union rather than imported from `host.ts` so this
 * module keeps its "no plugin dependencies" shape (it is the rendering layer
 * for notices, and `host.ts` is the type layer for services). The three
 * historical kinds are what `schedule/change` carries; the three wall-clock
 * kinds exist only on a durable record.
 */
export type ScheduleRuleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron'

/** The schedule fields this module renders. */
export interface ScheduleView {
  readonly kind?: ScheduleRuleKind
  readonly title?: string
  readonly prompt?: string
  readonly everySeconds?: number
  readonly time?: string
  readonly timeZone?: string
  readonly weekdays?: readonly number[]
  readonly expression?: string
  /** The next target instant, ISO-8601. */
  readonly scheduledAt?: string
}

/** The `schedule/change` payload fields this module renders. */
export interface ScheduleNotice extends ScheduleView {
  readonly operation: 'create' | 'delete' | 'dispatch'
}

/** ISO weekday numbers as the two-character labels a Chinese reader expects. */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/**
 * Render one interval in the unit a person would say it in.
 *
 * Seconds are the scheduler's unit and nobody's reading unit: `每 1800 秒`
 * makes the reader divide, and the answer — 30 minutes — is exactly what they
 * wanted. The remainder is kept only when it is not zero, so a clean hour does
 * not read as `1 小时 0 分钟`.
 * @param seconds - the fixed interval.
 * @returns the phrase, or '' when the interval is missing or unusable.
 */
export function intervalPhrase(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.round((seconds % 3600) / 60)
    return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`
  }
  const days = Math.floor(seconds / 86_400)
  const hours = Math.round((seconds % 86_400) / 3600)
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`
}

/**
 * Render the recurring rule of one task as a phrase: `每 30 分钟`, `每天
 * 09:00`, `每周一、三 09:00`, `cron <表达式>`, `定点 11-06 09:00`.
 *
 * This is the answer to "when does this thing run", which the bridge used to
 * answer with the raw kind and a `undefined` interval for anything newer than
 * the three historical kinds. A wall-clock rule is shown in its own zone's
 * wall time — that is what the reader scheduled — and the zone is appended
 * only when it differs from this machine's, so the common case stays short.
 * @param view - the record fields to describe.
 * @returns the phrase, or '' when the record states no rule at all.
 */
export function scheduleRuleLabel(view: ScheduleView): string {
  switch (view.kind) {
    case 'after':
      return '延时一次'
    case 'at':
      return '定点一次'
    case 'every': {
      const interval = intervalPhrase(view.everySeconds)
      return interval === '' ? '周期' : `每 ${interval}`
    }
    case 'daily':
      return view.time === undefined ? '每天' : `每天 ${view.time.slice(0, 5)}`
    case 'weekly': {
      const days = (view.weekdays ?? []).map(day => WEEKDAY_LABELS[day - 1] ?? String(day)).join('、')
      const at = view.time === undefined ? '' : ` ${view.time.slice(0, 5)}`
      return days === '' ? `每周${at}` : `每周${days}${at}`
    }
    case 'cron':
      return view.expression === undefined ? 'cron' : `cron \`${view.expression}\``
    default:
      return ''
  }
}

/**
 * The name to show for one task: its own title, else the prompt's first line.
 *
 * A title is required by the host's current `schedule_create`, so a task the
 * model made has one. Records written before titles existed, and every
 * historical `schedule/change` create, do not — and a list that shows nothing
 * but a 120-character prompt excerpt is what made the old panel unreadable.
 * @param view - the record.
 * @param limit - code points kept from the prompt's first line.
 * @returns the display name, or '' when the record is empty.
 */
export function scheduleName(view: ScheduleView, limit = 40): string {
  const title = view.title?.trim()
  if (title !== undefined && title !== '') return title
  const prompt = (view.prompt ?? '').trim()
  if (prompt === '') return ''
  const firstLine = prompt.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  return [...firstLine].length > limit ? `${[...firstLine].slice(0, limit).join('')}…` : firstLine
}

/**
 * Render one task's next target: `下次 09:57（还有 27 分钟）`.
 *
 * An instant is what the record stores; "how long from now" is what a reader
 * decides with. Both, in that order, because the absolute one is what they
 * compare against a clock and the relative one is what tells them whether to
 * wait.
 * @param view - the record, carrying `scheduledAt` when the host reported it.
 * @param now - the reference instant.
 * @returns the phrase, or '' when there is no target.
 */
export function scheduleNextLabel(view: ScheduleView, now: number): string {
  const at = view.scheduledAt === undefined ? Number.NaN : Date.parse(view.scheduledAt)
  if (!Number.isFinite(at)) return ''
  const short = shortStamp(at, now)
  const gap = upcomingPhrase(at - now)
  return gap === '' ? `下次 ${short}` : `下次 ${short}（还有 ${gap}）`
}

/** A schedule mutation line. `dispatch` renders through {@link scheduleDispatchLine}. */
export function scheduleLine(notice: ScheduleNotice): string | undefined {
  switch (notice.operation) {
    case 'create': {
      const rule = scheduleRuleLabel(notice)
      const name = scheduleName(notice)
      const subject = name === '' ? '定时任务' : `「${name}」`
      return rule === '' ? `⏰ 已创建定时任务${subject}` : `⏰ 已创建定时任务${subject}：${rule}`
    }
    case 'delete':
      return '⏰ 定时任务已删除'
    case 'dispatch':
      return undefined
  }
}

/**
 * The line posted when a scheduled task actually fires.
 *
 * Delivery used to be silent: the host appends the prompt to the session as a
 * user-role message, and the chat saw a block of instructions arrive from
 * nobody. A reader could not tell "the agent decided to do this" from "a timer
 * decided to do this", and the recurring tasks that fire every half hour read
 * as the human repeatedly asking. One line names the task, its rule and its
 * origin, which is the difference between a scheduled check and a stranger
 * shouting into the conversation.
 *
 * It stays one line on purpose: the task's own output follows immediately, and
 * a card here would push that output off the screen for no new information.
 * @param view - the task that fired.
 * @returns the line.
 */
export function scheduleDispatchLine(view: ScheduleView): string {
  const name = scheduleName(view)
  const rule = scheduleRuleLabel(view)
  const subject = name === '' ? '定时任务' : `定时任务「${name}」`
  return rule === '' ? `⏰ ${subject} 触发` : `⏰ ${subject} · ${rule}`
}

/** A DeepSeek search firing line. */
export function webSearchLine(): string {
  return '🔍 正在搜索网络…'
}

/** A live subagent settlement line (`subagent/end`). */
export function subagentEndLine(info: {
  readonly id: string
  readonly provider: string
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens'
}): string {
  const mark = info.stopReason === 'completed' ? '✅' : info.stopReason === 'aborted' ? '⏹️' : info.stopReason === 'error' ? '❌' : '⛔'
  const detail = info.stopReason === 'max-tokens'
    ? '（达到 token 上限）'
    : info.stopReason === 'error'
      ? '（失败）'
      : info.stopReason === 'aborted'
        ? '（已中止）'
        : ''
  return `${mark} 子任务结束${detail} [${info.id}]`
}


/**
 * The tail of a job's output, normalised for chat.
 *
 * The END of a run is where the answer lands — the head is usually setup noise
 * and progress spam — so a long output is cut from the FRONT and says how much
 * it dropped, rather than being truncated from the back into uselessness.
 */
export function outputTail(output: string | undefined, limit: number = DEFAULT_LIMITS.jobTailChars): string {
  if (output === undefined) return ''
  const trimmed = output
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (trimmed === '') return ''
  if (trimmed.length <= limit) return trimmed
  const dropped = trimmed.length - limit
  return `…（前 ${dropped} 字省略）\n${trimmed.slice(-limit)}`
}

/**
 * A background job's terminal line (from the registry's `settled` event).
 *
 * Naming only the command tells the reader nothing they did not already know
 * when it started — the answer is the job's OUTPUT. The caller reads the
 * retained tail off the ring and hands it in here.
 */
/**
 * A one-line form of a job label. `tool-bash` labels carry the command line
 * verbatim — often several lines — and a notice that opens with all of it
 * buries the one line a reader needs.
 */
function labelLine(label: string, limit = 80): string {
  const lines = label.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const first = lines[0] ?? ''
  if (first === '') return ''
  // Count in code points, not UTF-16 units: slicing mid-astral-character
  // leaves a lone surrogate, which renders as a replacement glyph.
  const chars = Array.from(first)
  const clipped = chars.length > limit ? chars.slice(0, limit).join('') : first
  return lines.length > 1 || chars.length > limit ? `${clipped}…` : clipped
}

/**
 * How long the job ran, for the completion notice. The snapshot carries only
 * `startedAt`, so the caller passes the milliseconds it measured at
 * settlement — the one number a reader always wants and never had.
 */
function durationLine(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return ''
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `（耗时 ${seconds} 秒）`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `（耗时 ${minutes} 分 ${seconds % 60} 秒）`
  return `（耗时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分）`
}

export function jobDoneLine(job: {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly durationMs?: number
  readonly output?: string
}, tailChars: number = DEFAULT_LIMITS.jobTailChars): string {
  const mark = job.status === 'completed' ? '✅' : job.status === 'killed' ? '⏹️' : '❌'
  const detail = job.detail === undefined || job.detail === '' ? '' : `（${job.detail}）`
  const label = labelLine(job.label)
  const took = durationLine(job.durationMs)
  const head = `${mark} 后台任务完成：${label === '' ? job.kind : label}${detail}${took} [${job.id}]`
  const tail = outputTail(job.output, tailChars)
  return tail === '' ? head : `${head}\n\`\`\`\n${tail}\n\`\`\``
}

/**
 * A model-call retry line. Transient upstream failures self-heal through the
 * retry policy in the vast majority of cases — announcing the first retry
 * only taught users to expect noise on every hiccup. The chat stays silent
 * while retries are in flight (the turn either completes or ends with an
 * error event either way); we speak up only at the LAST attempt, when the
 * next failure would actually kill the turn — the moment a human may want
 * to look at the route.
 */
export function retryLine(retry: { readonly retry: number; readonly maxRetries?: number }): string | undefined {
  if (retry.maxRetries === undefined || retry.retry !== retry.maxRetries) return undefined
  return `⚠️ 模型调用连续失败，正在进行最后一次重试（第 ${retry.retry}/${retry.maxRetries} 次）；若仍失败本轮将终止。`
}

/**
 * What the shadowed records were, counted by source.
 *
 * A compaction event only carries sequence numbers, so the line used to say
 * "trimmed 1 message" and leave the reader guessing which one. The bridge
 * resolves those numbers against the session log and hands the counts here;
 * "1 条工具输出" answers the question the bare count raised.
 */
export interface ShadowedBreakdown {
  /** The human's own prompts. */
  readonly user: number
  /** The assistant's replies. */
  readonly assistant: number
  /** Tool invocations (the call, not its output). */
  readonly toolCall: number
  /** Tool outputs — usually the bulk of what a prune removes. */
  readonly toolResult: number
  /** Anything else: step markers, goal changes, other bookkeeping. */
  readonly other: number
}

/** "2 条你的提问、3 条工具输出" — only the non-zero kinds, in a fixed order. */
function breakdownPhrase(breakdown: ShadowedBreakdown | undefined): string {
  if (breakdown === undefined) return ''
  const parts: string[] = []
  if (breakdown.user > 0) parts.push(`${num(breakdown.user)} 条你的提问`)
  if (breakdown.assistant > 0) parts.push(`${num(breakdown.assistant)} 条我的回复`)
  if (breakdown.toolCall > 0) parts.push(`${num(breakdown.toolCall)} 条工具调用`)
  if (breakdown.toolResult > 0) parts.push(`${num(breakdown.toolResult)} 条工具输出`)
  if (breakdown.other > 0) parts.push(`${num(breakdown.other)} 条其它记录`)
  return parts.length === 0 ? '' : `（${parts.join('、')}）`
}

/** 压缩之后还剩多少上下文可用。 */
export interface CompactionUsage {
  /** 压缩完成时的当前总占用（token）。 */
  readonly total: number
  /** 这一路的上下文窗口；拿不到就不提"还剩多少"。 */
  readonly window?: number | undefined
}

/**
 * 压缩提示的第二行：压完占了多少、还剩多少。
 *
 * 第一行说的是"释放了多少"，但那是个过程量——读者真正要判断的是"现在还能不能
 * 继续干"。只报释放量会出现"释放了 48,810，但总量仍有 200,000"这种看了更慌的
 * 情况；把当前占用与窗口一起给出，才有决策价值。
 * @param usage - 压缩后的占用与窗口；`undefined` 时整行省略。
 * @returns 以换行开头的一行，或空串。
 */
function usageLine(usage: CompactionUsage | undefined): string {
  if (usage === undefined) return ''
  if (usage.window === undefined) return `\n压缩后占用约 ${num(usage.total)} tokens`
  const left = Math.max(0, usage.window - usage.total)
  const percent = Math.round((left / usage.window) * 100)
  return `\n压缩后占用约 ${num(usage.total)} / ${num(usage.window)}，还剩约 ${num(left)} 可用（${percent}%）`
}

/**
 * A compaction summary line: what replaced the old history, and at what cost.
 *
 * The summary text itself is deliberately NOT rendered. It is a model-written
 * digest — often in English, always full of goal ids and paths — and pasting
 * its first 200 characters made the notice read like a debug dump (the
 * 2026-11-04 complaint). The chat only needs to know that history was folded,
 * how much it was worth, and which kinds of records went into it.
 *
 * @param data - the `compaction/summary` payload.
 * @param breakdown - what the shadowed seqs were, when the caller resolved them.
 * @param usage - post-compaction occupancy and window, when the caller measured it.
 * @returns the markdown line for the chat.
 */
export function compactionSummaryLine(data: {
  readonly shadowedSeqs?: readonly number[]
  readonly shadowedTokenCount: number
}, breakdown?: ShadowedBreakdown, usage?: CompactionUsage): string {
  const count = data.shadowedSeqs?.length ?? 0
  const detail = breakdownPhrase(breakdown)
  const head = count === 0
    ? `📦 上下文压缩完成：释放约 ${num(data.shadowedTokenCount)} tokens`
    : `📦 上下文压缩完成：${num(count)} 条较早消息${detail}已换成摘要，释放约 ${num(data.shadowedTokenCount)} tokens`
  return `${head}${usageLine(usage)}`
}

/**
 * A prune line: old history was trimmed without a model call.
 * @param data - the `compaction/prune` payload.
 * @param breakdown - what the shadowed seqs were, when the caller resolved them.
 * @param usage - post-prune occupancy and window, when the caller measured it.
 * @returns the markdown line for the chat.
 */
export function compactionPruneLine(data: {
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}, breakdown?: ShadowedBreakdown, usage?: CompactionUsage): string {
  const head = `🗑️ 已修剪 ${num(data.shadowedSeqs.length)} 条旧消息${breakdownPhrase(breakdown)}，释放约 ${num(data.shadowedTokenCount)} tokens`
  return `${head}${usageLine(usage)}`
}

/** 千分位，中文数字习惯。 */
function num(value: number): string {
  return value.toLocaleString('zh-CN')
}

/**
 * 上下文占用的预警文案。
 *
 * 原来写的是「总量 X tokens / 会话表面 Y」——「会话表面」是宿主字段
 * `surfaceTokens` 的直译，读者从中看不出它指的是"你俩聊过的内容"，更看不出
 * 总量与它之间的差额是工具说明这类常驻开销。差额恰恰是关键：真正超线时，
 * 压历史能降的是前半段，压不掉的是后半段。
 *
 * 差额曾被称为「固定开销」，这个说法是错的，2026-11-05 被当场问住：差额是
 * 系统提示 + 工具定义，两者都会变——MCP 工具挂载/卸载、技能目录增减、
 * goal 状态、工作目录都会改它，而且宿主是按字符估 token，不是精确分词。
 * 现在如实说"不是固定值"，并列出会改变它的东西，免得读者以为桥在乱报数。
 * @param data - 当前总量、其中的聊天内容、以及预警线。
 * @returns 发到聊天里的那一段。
 */
export function tokenPressureLine(data: {
  readonly total: number
  readonly surface: number
  readonly threshold: number
  /** 三段拆分，拿到时就报细分——差额里哪一块在变才看得见。 */
  readonly breakdown?: ContextBreakdown | undefined
}): string {
  const other = data.total - data.surface
  const head = `⚠️ 上下文偏重了：一共约 ${num(data.total)} token，其中聊天内容 ${num(data.surface)}`
  const split = data.breakdown === undefined
    ? '（系统提示 + 工具说明）'
    : `：系统提示约 ${num(data.breakdown.systemTokens)}、工具说明约 ${num(data.breakdown.toolsTokens)}`
  const body = other > 0
    ? `，其余 ${num(other)} 是聊天之外的开销${split}。\n`
      + '这部分不是固定值：挂载了哪些工具、有哪些技能可用、当前目标，都会改变它。\n'
      + `已超过 ${num(data.threshold)} 的建议压缩线。`
    : `\n已超过 ${num(data.threshold)} 的建议压缩线。`
  const advice = other > 0
    ? '/compact 只压得动聊天内容；要降那一半，只能少挂工具（换极简模式、关掉不用的 MCP）。想看明细发 `/context`。'
    : '长任务建议先 `/compact` 压缩，或让 agent 收尾当前阶段。'
  return `${head}${body}${advice}`
}

/** 上下文占用的构成，来自宿主的 `contextBreakdown` 投影。 */
export interface ContextBreakdown {
  /** 存活消息（一轮轮对话本身）。 */
  readonly messageTokens: number
  /** 系统提示。 */
  readonly systemTokens: number
  /** 工具定义。 */
  readonly toolsTokens: number
}

/** 一个工具在上下文里占的 token，按宿主的估算公式拆出来的。 */
export interface ToolCost {
  readonly name: string
  readonly tokens: number
}

/**
 * `/context` 的回复：占用多少，以及占在哪。
 *
 * 一行总数对"要不要压缩"够用，对"压了有没有用"不够：一台挂满 MCP 的机器，
 * 工具说明就能占掉小一半，这时压历史是白费力气。所以有分组就摊开说。
 * @param data - 总量、聊天内容、可选的三段拆分，以及可选的逐工具占用。
 * @returns 回复正文（markdown）。
 */
export function contextPressureLine(data: {
  readonly total: number
  readonly surface: number
  readonly breakdown?: ContextBreakdown | undefined
  /** 逐工具占用；拿到时把「工具说明」那行摊开成明细。 */
  readonly toolCosts?: readonly ToolCost[] | undefined
  /** 明细最多列几个工具；`Infinity` 表示全列（`/context all`）。 */
  readonly toolLimit?: number | undefined
}): string {
  const rows = [`上下文占用：合计约 ${num(data.total)} token`]
  if (data.breakdown === undefined) {
    rows.push(`· 其中聊天内容约 ${num(data.surface)}`)
  } else {
    rows.push(`· 聊天内容约 ${num(data.breakdown.messageTokens)}`)
    rows.push(`· 系统提示约 ${num(data.breakdown.systemTokens)}`)
    rows.push(`· 工具说明约 ${num(data.breakdown.toolsTokens)}`)
  }
  if (data.toolCosts !== undefined && data.toolCosts.length > 0) {
    // 没有三段拆分时明细也能单独成立：标题补一行，缩进仍归它自己。
    if (data.breakdown === undefined) rows.push('· 工具明细：')
    rows.push(...toolCostRows(data.toolCosts, data.toolLimit ?? 8))
  }
  if (data.total > 600_000) {
    rows.push('', '⚠️ 已经很重了：除了 `/compact`，更有效的是减负——换极简模式、或关掉不常用的 MCP 服务，工具说明这才降得下来。')
  } else if (data.total > 120_000) {
    rows.push('', '⚠️ 偏高，长任务建议先 `/compact` 压缩历史。')
  } else if (data.total > 60_000) {
    rows.push('', '📈 在长，超过 12 万后建议压缩。')
  }
  return rows.join('\n')
}

/**
 * 工具说明的明细：按占用降序列出，被截断时交代余量。
 *
 * 默认只列 top N 是有意的——`/context` 平时是给"关哪个"做决定的，不是把一百
 * 多个工具全抄一遍。但余量必须显式给出，否则读者会以为明细之和就是总数；
 * 再给一条"看全部"的出口，因为"到底装了些什么"是另一类问题（2026-11-05 追问）。
 * @param costs - 已按占用降序排好的逐工具占用。
 * @param limit - 最多列几个工具；`Infinity` 全列。
 * @returns 缩进两格的明细行。
 */
function toolCostRows(costs: readonly ToolCost[], limit: number): string[] {
  const shown = costs.slice(0, limit)
  const rest = costs.slice(limit)
  const rows = shown.map(cost => `  · ${cost.name} 约 ${num(cost.tokens)}`)
  if (rest.length > 0) {
    const sum = rest.reduce((total, cost) => total + cost.tokens, 0)
    rows.push(`  · 其余 ${num(rest.length)} 个工具 约 ${num(sum)}`)
    rows.push(`  · 要看全部 ${num(costs.length)} 个：发 \`/context all\``)
  }
  return rows
}
