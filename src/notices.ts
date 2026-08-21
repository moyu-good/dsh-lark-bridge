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

/** A background job's terminal line (from `JobRegistry.onJobDone`). */
export function jobDoneLine(job: {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
}): string {
  const mark = job.status === 'completed' ? '✅' : job.status === 'killed' ? '⏹️' : '❌'
  const detail = job.detail === undefined || job.detail === '' ? '' : `（${job.detail}）`
  return `${mark} 后台任务完成：${job.label}${detail} [${job.id}]`
}

/** A model-call retry line; only the first retry of a failure is announced. */
export function retryLine(retry: { readonly retry: number; readonly maxRetries?: number }): string | undefined {
  if (retry.retry !== 1) return undefined
  const cap = retry.maxRetries === undefined ? '' : `（最多 ${retry.maxRetries} 次）`
  return `⚠️ 模型调用失败，正在重试${cap}…`
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

/**
 * A proactive token-pressure warning: the session's context has climbed past
 * the compaction advice threshold. Unlike the compaction notices (which fire
 * after the fact), this is a heads-up the bridge polls for while a long task
 * is running, so the chat hears about pressure before the model degrades.
 * @param total - current measured total tokens.
 * @param surface - the session-surface portion of the total.
 * @param threshold - the configured warning threshold.
 * @returns the markdown line for the chat.
 */
export function tokenPressureLine(data: {
  readonly total: number
  readonly surface: number
  readonly threshold: number
}): string {
  const total = data.total.toLocaleString('zh-CN')
  const surface = data.surface.toLocaleString('zh-CN')
  return `⚠️ 上下文压力偏高（当前约 ${total} tokens / 会话表面 ${surface}）\n已超过 ${data.threshold.toLocaleString('zh-CN')} tokens 的建议压缩线。长任务建议先 \`/compact\` 压缩，或让 agent 收尾当前阶段。`
}
