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

/** The `schedule/change` payload fields this module renders. */
export interface ScheduleNotice {
  readonly operation: 'create' | 'delete' | 'dispatch'
  readonly kind?: 'after' | 'at' | 'every'
  readonly prompt?: string
}

/** A human interval label for one schedule kind. */
function scheduleKindLabel(kind: 'after' | 'at' | 'every' | undefined): string {
  switch (kind) {
    case 'after': return '延时'
    case 'at': return '定点'
    case 'every': return '周期'
    default: return ''
  }
}

/** A schedule mutation line. `dispatch` stays silent — it fires on schedule and is noise. */
export function scheduleLine(notice: ScheduleNotice): string | undefined {
  switch (notice.operation) {
    case 'create': {
      const kind = scheduleKindLabel(notice.kind)
      const prompt = notice.prompt === undefined ? '' : `：${notice.prompt.slice(0, 40)}`
      return `⏰ 已创建${kind}任务${prompt}`
    }
    case 'delete':
      return '⏰ 定时任务已删除'
    case 'dispatch':
      return undefined
  }
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

/** Extract the visible text from a compaction summary's content blocks. */
function summaryText(blocks: readonly unknown[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * A compaction summary line: what replaced the old history, and at what cost.
 * @param data - the `compaction/summary` payload.
 * @returns the markdown line for the chat.
 */
export function compactionSummaryLine(data: {
  readonly summary: readonly unknown[]
  readonly shadowedTokenCount: number
}): string {
  const text = summaryText(data.summary).trim()
  const preview = text.length === 0 ? '' : `\n${text.slice(0, 200)}`
  return `📦 上下文压缩完成，释放约 ${data.shadowedTokenCount} tokens${preview}`
}

/**
 * A prune line: old history was trimmed without a model call.
 * @param data - the `compaction/prune` payload.
 * @returns the markdown line for the chat.
 */
export function compactionPruneLine(data: {
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}): string {
  return `🗑️ 已修剪 ${data.shadowedSeqs.length} 条旧消息（释放约 ${data.shadowedTokenCount} tokens）`
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
 * @param data - 当前总量、其中的聊天内容、以及预警线。
 * @returns 发到聊天里的那一段。
 */
export function tokenPressureLine(data: {
  readonly total: number
  readonly surface: number
  readonly threshold: number
}): string {
  const other = data.total - data.surface
  const head = `⚠️ 上下文偏重了：一共约 ${num(data.total)} token，其中聊天内容 ${num(data.surface)}`
  const body = other > 0
    ? `，其余 ${num(other)} 是工具说明等固定开销\n已超过 ${num(data.threshold)} 的建议压缩线。`
    : `\n已超过 ${num(data.threshold)} 的建议压缩线。`
  const advice = other > 0
    ? '/compact 能压掉聊天内容那部分；工具说明是常驻的，压不掉——要压它只能少挂工具（换极简模式、关掉不用的 MCP）。'
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

/**
 * `/context` 的回复：占用多少，以及占在哪。
 *
 * 一行总数对"要不要压缩"够用，对"压了有没有用"不够：一台挂满 MCP 的机器，
 * 工具说明就能占掉小一半，这时压历史是白费力气。所以有分组就摊开说。
 * @param data - 总量、聊天内容、可选的三段拆分。
 * @returns 回复正文（markdown）。
 */
export function contextPressureLine(data: {
  readonly total: number
  readonly surface: number
  readonly breakdown?: ContextBreakdown | undefined
}): string {
  const rows = [`上下文占用：合计约 ${num(data.total)} token`]
  if (data.breakdown === undefined) {
    rows.push(`· 其中聊天内容约 ${num(data.surface)}`)
  } else {
    rows.push(`· 聊天内容约 ${num(data.breakdown.messageTokens)}`)
    rows.push(`· 系统提示约 ${num(data.breakdown.systemTokens)}`)
    rows.push(`· 工具说明约 ${num(data.breakdown.toolsTokens)}`)
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
