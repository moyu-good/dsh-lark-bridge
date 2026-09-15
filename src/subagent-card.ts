/**
 * Tracks subagent children for one chat session and renders them as a single
 * updatable Feishu interactive card. One card shows ALL live children; each
 * status change re-renders the card in place.
 *
 * 2026-09-15 — live content. Before this, the card only ever showed
 * `label — status`, and in practice it never appeared at all: the bridge built
 * it from `subagent/descriptor`, which 0.1.5 appends **into the child's own
 * session** (`subagent-in-process-driver/src/index.ts` attachDescriptorAppend),
 * so a parent-session subscriber never sees it. What the parent session does
 * receive is `subagent/catalog` (`subagent/src/catalog.ts` establishCatalogChild
 * → `parent.append`), carrying `childId / childCreatedAt / mode / label`.
 * This module is keyed by that `childId`, and carries the child's latest
 * observed activity so a reader can tell what a subagent is doing without
 * leaving the chat.
 * @module dsh-lark-bridge/subagent-card
 */

export type SubagentStatus = 'running' | 'completed' | 'aborted' | 'error' | 'max-tokens'

export interface SubagentEntry {
  /** The child's session id (`subagent/catalog.childId`). */
  readonly id: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
  status: SubagentStatus
  /** Epoch ms when the child was first seen. */
  readonly startedAt: number
  /** Epoch ms of the last activity we observed for this child. */
  lastAt?: number
  /** Short「最近在做的事」— the child's own latest output snippet. */
  lastActivity?: string
  /** How many activity samples have been folded into {@link lastActivity}. */
  chunks: number
  /** Epoch ms when it settled. */
  endedAt?: number
}

export interface SubagentCardState {
  readonly entries: Map<string, SubagentEntry>
  /** The message ID of the sent card, for updateCard calls. */
  messageId?: string
  /** Epoch ms of the last in-place card update (throttling). */
  updatedAt?: number
}

export function createTracker(): SubagentCardState {
  return { entries: new Map() }
}

/** Longest activity snippet kept per child — one card line, not a transcript. */
export const ACTIVITY_MAX = 68

/** Collapse whitespace and clip, so one line stays one line on a phone. */
export function clipActivity(text: string, max: number = ACTIVITY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Register (or refresh) one child. Idempotent: `subagent/catalog` may be
 * re-delivered on replay/reconnect, and re-adding must not spawn a second row.
 */
export function addEntry(
  state: SubagentCardState,
  id: string,
  descriptor: { mode?: string; label?: string },
  now: number = Date.now(),
): SubagentEntry {
  const existing = state.entries.get(id)
  if (existing !== undefined) {
    return existing
  }
  const entry: SubagentEntry = {
    id,
    label: descriptor.label ?? `子代理 ${state.entries.size + 1}`,
    mode: descriptor.mode === 'continuable' ? 'continuable' : 'one-shot',
    status: 'running',
    startedAt: now,
    chunks: 0,
  }
  state.entries.set(id, entry)
  return entry
}

/**
 * Fold one observed activity sample into a child's row. Returns the entry, or
 * undefined when the id is unknown (an unattributable frame must not invent a
 * row — see the attribution rule in bridge.ts).
 */
export function markActivity(
  state: SubagentCardState,
  id: string,
  text: string,
  now: number = Date.now(),
): SubagentEntry | undefined {
  const entry = state.entries.get(id)
  if (entry === undefined) return undefined
  const clipped = clipActivity(text)
  if (clipped !== '') entry.lastActivity = clipped
  entry.chunks += 1
  entry.lastAt = now
  return entry
}

export function settleEntry(
  state: SubagentCardState,
  id: string,
  stopReason: string,
  now: number = Date.now(),
): SubagentEntry | undefined {
  const e = state.entries.get(id)
  if (!e) return undefined
  if (stopReason === 'completed') e.status = 'completed'
  else if (stopReason === 'aborted') e.status = 'aborted'
  else if (stopReason === 'max-tokens') e.status = 'max-tokens'
  else e.status = 'error'
  e.endedAt = now
  return e
}

/** Children still running — the window an unattributable frame may fall into. */
export function runningEntries(state: SubagentCardState): SubagentEntry[] {
  return [...state.entries.values()].filter(e => e.status === 'running')
}

/** Settle every still-running one-shot child once the spawning turn is over.
 *
 * One-shot children are driven inside the tool call that spawned them, so a
 * parent `turn/end` means they can no longer progress. `continuable` children
 * survive between turns by design — their status is left alone.
 */
export function settleRunningOneShots(state: SubagentCardState, now: number = Date.now()): number {
  let n = 0
  for (const e of state.entries.values()) {
    if (e.status !== 'running' || e.mode !== 'one-shot') continue
    e.status = 'completed'
    e.endedAt = now
    n += 1
  }
  return n
}

function statusMark(s: SubagentStatus): string {
  switch (s) {
    case 'completed': return '✅'
    case 'aborted': return '⏹️'
    case 'error': return '❌'
    case 'max-tokens': return '⛔'
    default: return '⏳'
  }
}

function statusText(s: SubagentStatus): string {
  switch (s) {
    case 'completed': return '完成'
    case 'aborted': return '已中止'
    case 'error': return '出错'
    case 'max-tokens': return '超长截断'
    default: return '进行中'
  }
}

export function elapsedText(from: number, to: number): string {
  const sec = Math.max(0, Math.round((to - from) / 1000))
  if (sec < 60) return `${sec}秒`
  const m = Math.floor(sec / 60), s = sec % 60
  if (m < 60) return s === 0 ? `${m}分` : `${m}分${s}秒`
  const h = Math.floor(m / 60)
  return `${h}小时${m % 60}分`
}

export function render(state: SubagentCardState, now: number = Date.now()): object {
  const rows: string[] = []
  for (const [, e] of state.entries) {
    const mark = statusMark(e.status)
    const end = e.endedAt ?? now
    const line = ` ${mark} **${e.label}** · ${statusText(e.status)} · ${elapsedText(e.startedAt, end)}`
    rows.push(e.lastActivity === undefined ? line : `${line}\n　　↳ ${e.lastActivity}`)
  }
  const running = runningEntries(state).length
  const body = rows.length > 0 ? rows.join('\n') : '（无子任务）'
  const total = state.entries.size
  const summary = total === 0 ? '' : `\n\n${total - running} 结束 / ${running} 进行中`
  return {
    config: { wide_screen_mode: true },
    header: {
      template: running > 0 ? 'purple' : 'grey',
      title: { tag: 'plain_text', content: `🧑‍💻 多代理执行面板（${running} 进行中）` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body + summary } },
    ],
  }
}
