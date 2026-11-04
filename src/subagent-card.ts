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
  /** Last few distinct output lines (oldest first). The delivery block quotes
   * the tail of this, so one child reports WHAT it produced, not just that it
   * finished. Bounded — a child is not a transcript. */
  recent: string[]
  /** How many activity samples have been folded into {@link lastActivity}. */
  chunks: number
  /** Epoch ms when it settled. */
  endedAt?: number
  /**
   * 收尾原因原文（`stopReason`）。
   *
   * 只标一个 ❌ 回答不了「为什么失败」——读者还得去翻会话记录。把原文留下来，
   * 失败行就能直接说清楚是超时、是拒绝、还是子代理自己抛的错。
   */
  stopReason?: string
  /**
   * 失败或截断时的那句话。
   *
   * 取自子代理最后一条助手消息或报错的工具结果：这是「它卡在哪」的直接证据，
   * 比 `stopReason` 的枚举字面量有用得多。
   */
  failureDetail?: string
  /**
   * 工具调用次数。
   *
   * 面板原来只报「N 条动作」，那是个把工具调用和发言混在一起的口径，
   * 读不出「它到底干了多少活」。分开数，进度感才有来源。
   */
  toolCalls: number
  /** 已经发出的助手消息条数，代表这一路产出了多少段文字。 */
  messages: number
  /**
   * 显式进度（`8/23` 这种），从子代理自己的话里认出来。
   *
   * 认不出来是常态——子代理不一定用「x/y」的口吻报进度——所以它只是补充，
   * 不是必需。认出来了就比「已跑 6 分钟」有用得多。
   */
  progress?: { readonly done: number; readonly total: number }
}

export interface SubagentCardState {
  readonly entries: Map<string, SubagentEntry>
  /** The message ID of the sent card, for updateCard calls. */
  messageId?: string
  /**
   * 已经冻结的历史卡片 id（按发送顺序）。
   *
   * 面板被后来的消息挤远之后，`/panel` 会发一张新卡接管实时更新。旧卡不能
   * 就那么晾着——它还停在「3 在跑」的旧画面上，读者分不清哪张是活的。所以
   * 旧卡先被改写成快照（写清「15:58 的快照」），再彻底停止更新。
   * 不删是因为传输层没有撤回能力，而且快照本身也有用：能看出那一刻的状态。
   */
  frozenIds: string[]
  /** Epoch ms of the last in-place card update (throttling). */
  updatedAt?: number
  /**
   * Whether a send/update is in flight.
   *
   * The panel is the ONLY place a child's progress is visible once the chat
   * stops echoing each step, so two concurrent writes that both read the same
   * pre-update state must not race: the later one would overwrite the earlier
   * with a stale render, and Feishu would see duplicate updates in one window.
   */
  sending?: boolean
  /** An update requested while one was in flight; sent once it settles. */
  pending?: boolean
  /**
   * Consecutive failed updates.
   *
   * The card is the sole channel now, so a silent stall means the reader sees
   * a frozen panel and no way to know it stopped moving. Counting lets the
   * caller say so out loud instead of failing quietly.
   */
  failures?: number
}

export function createTracker(): SubagentCardState {
  return { entries: new Map(), frozenIds: [] }
}

/** Longest activity snippet kept per child — one card line, not a transcript. */
export const ACTIVITY_MAX = 68

/** How many distinct lines a child's delivery block remembers (and quotes ≤3). */
export const RECENT_MAX = 5

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
    recent: [],
    chunks: 0,
    toolCalls: 0,
    messages: 0,
  }
  state.entries.set(id, entry)
  return entry
}

/**
 * 从一句话里认出 `8/23`、`12 / 40`、`已完成 3/7` 这样的进度。
 *
 * 只在两部分都像「小数目」时才认，避免把 `2026/11` 这样的日期、`8/23 区`
 * 之外的比例数字（比如 URL、版本号、分数）误当进度。取最后出现的那一个，
 * 因为子代理通常把最新进度放在句末。
 * @param text - 子代理的一句话。
 * @returns 认出来的进度，认不出时为 undefined。
 */
export function parseProgress(text: string): { done: number; total: number } | undefined {
  // 数字前面不能紧挨字母或数字：`v1/2` 是版本号，`-1/2` 是分数，都不是进度。
  const matches = [...text.matchAll(/(?<![A-Za-z0-9._-])(\d{1,4})\s*\/\s*(\d{1,4})(?![\d:.])/g)]
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const done = Number(matches[index]![1])
    const total = Number(matches[index]![2])
    // 分母为 0 或 1 的不是进度；分子超过分母的多半是日期或版本号。
    if (total < 2 || done > total) continue
    // `1/2` 这种小分子小分母太容易是分数或「二分之一」的说法，只有在句子
    // 明确带进度语气时才认。
    if (total <= 2 && !/已完成|已处理|进度|完成|处理/.test(text)) continue
    return { done, total }
  }
  return undefined
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
  kind: 'tool' | 'message' = 'tool',
): SubagentEntry | undefined {
  const entry = state.entries.get(id)
  if (entry === undefined) return undefined
  if (kind === 'tool') entry.toolCalls += 1
  else entry.messages += 1
  const clipped = clipActivity(text)
  if (clipped !== '') {
    entry.lastActivity = clipped
    // Consecutive duplicates are the same sentence still streaming — only a new
    // line is worth quoting in the delivery block.
    if (entry.recent[entry.recent.length - 1] !== clipped) {
      entry.recent.push(clipped)
      if (entry.recent.length > RECENT_MAX) entry.recent.splice(0, entry.recent.length - RECENT_MAX)
    }
    const progress = parseProgress(clipped)
    // 进度只增不减：子代理换个话题说别的数字时，不该把已经报到的进度抹掉。
    if (progress !== undefined && (entry.progress === undefined || progress.done >= entry.progress.done)) {
      entry.progress = progress
    }
  }
  entry.chunks += 1
  entry.lastAt = now
  return entry
}

export function settleEntry(
  state: SubagentCardState,
  id: string,
  stopReason: string,
  now: number = Date.now(),
  failureDetail?: string,
): SubagentEntry | undefined {
  const e = state.entries.get(id)
  if (!e) return undefined
  if (stopReason === 'completed') e.status = 'completed'
  else if (stopReason === 'aborted') e.status = 'aborted'
  else if (stopReason === 'max-tokens') e.status = 'max-tokens'
  else e.status = 'error'
  e.endedAt = now
  e.stopReason = stopReason
  if (failureDetail !== undefined && failureDetail.trim() !== '') {
    e.failureDetail = clipActivity(failureDetail, FAILURE_MAX)
  }
  return e
}

/** 失败原因最多留多少字：够说清是什么错，又不至于把卡片撑爆。 */
export const FAILURE_MAX = 100

/**
 * 从结束事件里捞出「它最后说了什么」，作为失败原因。
 *
 * `SubagentEndData.lastAssistantMessage` 是子代理最后一轮助手消息的原始内容
 * 块数组；失败时这段文字通常就是错误原文或它卡住的地方。取不到就退回
 * `stopReason` 的枚举字面量——有总比只标一个 ❌ 强。
 * @param info - `subagent/end` 的载荷。
 * @returns 可以直接写进面板的一行话；没有任何线索时为空串。
 */
export function failureText(info: {
  readonly stopReason?: string
  readonly lastAssistantMessage?: readonly unknown[]
}): string {
  const blocks = info.lastAssistantMessage
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('\n')
      .trim()
    if (text !== '') {
      return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
    }
  }
  return ''
}

/**
 * 一个子代理多久没动静就算「疑似卡住」。
 *
 * 子代理跑长工具（构建、批量抓取）时安静几分钟是正常的，所以这个阈值不能
 * 太小；但也不能太大，否则面板对「真卡死」的反应比人还慢。两分钟是折中：
 * 大多数工具调用都在这个时间内回来，超过它值得被标出来。
 */
export const STALL_MS = 120_000

/**
 * 一行「做过多少事」的纵深，避免每个子代理看起来都一样厚。
 * @param entry - 一个子代理。
 * @returns 形如 `已做 42 步 · 3 段发言`；刚开始时为空串。
 */
export function volumeText(entry: SubagentEntry): string {
  const parts: string[] = []
  if (entry.toolCalls > 0) parts.push(`${entry.toolCalls} 步`)
  if (entry.messages > 0) parts.push(`${entry.messages} 段发言`)
  return parts.length === 0 ? '' : `已做 ${parts.join(' · ')}`
}

/**
 * The one-message summary a finished child posts.
 *
 * The panel row already answers「还在跑吗」; this answers「它到底做出了什么」,
 * which is the question the reader actually has (and what the old bare
 * `✅ 子任务结束 [id]` line never did). Deliberately bounded to the last few
 * lines — a child is summarised, never replayed.
 */
export function deliveryText(entry: SubagentEntry, now: number = Date.now()): string {
  // 分开报工具调用和发言：原来合成的「N 条动作」把跑了一百次命令、和只说了
  // 三句话的子代理写成同一个数，读不出工作量的区别。
  const work = volumeText(entry)
  const head = `${statusMark(entry.status)}【子代理${statusText(entry.status)}】${entry.label}`
    + ` · ${elapsedText(entry.startedAt, entry.endedAt ?? now)}${work === '' ? '' : ` · ${work}`}`
  // 失败的行第一句就是原因——那比它最后做了什么更该被看见。
  const lines: string[] = [head]
  if (entry.failureDetail !== undefined && (entry.status === 'error' || entry.status === 'max-tokens')) {
    lines.push(`　　⚠️ ${entry.failureDetail}`)
  }
  const tail = entry.recent.slice(-3).map(l => `　　↳ ${l}`)
  return [head, ...lines.slice(1), ...tail].join('\n')
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

/**
 * 面板行的排序键：先按「有多需要你管」，再按时间。
 *
 * 原来按加入顺序排，结果是跑完的压在还在跑的上面——五个子代理里两个还在干，
 * 那两个被挤到最底下，得往下翻才看得见。面板的全部意义是「现在谁在干什么」，
 * 所以进行中必须在上；失败的排更前，因为那是唯一可能需要人介入的。
 */
function sortKey(entry: SubagentEntry): number {
  switch (entry.status) {
    case 'error': return 0
    case 'max-tokens': return 1
    case 'running': return 2
    case 'aborted': return 3
    case 'completed': return 4
  }
}

/**
 * 一行里那串「进度信息」：显式进度 > 心跳 > 时长。
 *
 * 时长只在没有任何进度可报时才当主角——它只说明「跑了多久」，说明不了
 * 「进展如何」，而后者才是读者关心的。
 * @param entry - 一个子代理。
 * @param now - 当前时间。
 * @returns 形如 `▓▓▓░░ 8/23 · 5分12秒`。
 */
function progressLine(entry: SubagentEntry, now: number): string {
  const end = entry.endedAt ?? now
  const elapsed = elapsedText(entry.startedAt, end)
  if (entry.status !== 'running') return elapsed
  if (entry.progress !== undefined) {
    const { done, total } = entry.progress
    return `${progressBar(done, total)} ${done}/${total} · ${elapsed}`
  }
  // 没有显式进度时，用「多久没动静」代替：这是判断卡死的唯一线索。
  if (entry.lastAt !== undefined) {
    const quiet = now - entry.lastAt
    if (quiet >= STALL_MS) return `${elapsed} · ⚠️ 已 ${elapsedText(entry.lastAt, now)}无新动静`
    if (quiet >= 30_000) return `${elapsed} · 最近动作 ${elapsedText(entry.lastAt, now)}前`
  }
  return elapsed
}

/** 五格进度条：一眼看出大概走到哪，不追求精确。 */
export function progressBar(done: number, total: number, width = 5): string {
  if (total <= 0) return ''
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)))
  return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/**
 * 一个子代理在卡片上占的那几行。
 * @param entry - 一个子代理。
 * @param now - 当前时间。
 * @param verbose - 是否展开第二行（最近动作 + 纵深）。
 * @returns Markdown 行数组。
 */
function renderEntry(entry: SubagentEntry, now: number, verbose: boolean): string[] {
  const mark = entry.status === 'running' && entry.lastAt !== undefined && now - entry.lastAt >= STALL_MS
    ? '🟡'
    : statusMark(entry.status)
  const head = ` ${mark} **${entry.label}** · ${statusText(entry.status)} · ${progressLine(entry, now)}`
  const lines = [head]
  // 失败/截断的行永远展开：这是唯一需要人采取行动的信息，折叠掉等于藏起来。
  if (entry.status === 'error' || entry.status === 'max-tokens') {
    if (entry.failureDetail !== undefined) lines.push(`　　⚠️ ${entry.failureDetail}`)
    else if (entry.stopReason !== undefined) lines.push(`　　⚠️ ${entry.stopReason}`)
    else if (entry.lastActivity !== undefined) lines.push(`　　↳ ${entry.lastActivity}`)
    const volume = volumeText(entry)
    if (volume !== '') lines.push(`　　${volume}`)
    return lines
  }
  if (!verbose) return lines
  if (entry.lastActivity !== undefined) lines.push(`　　↳ ${entry.lastActivity}`)
  const volume = volumeText(entry)
  if (volume !== '') lines.push(`　　${volume}`)
  return lines
}

/**
 * 收尾统计。
 *
 * 原来只写「N 结束 / M 进行中」，五个里两个失败扫一眼以为三个都好。失败必须
 * 单独报，它跟「完成」不是一回事。
 * @param state - 面板状态。
 * @returns 形如 `3 完成 · 1 失败 · 2 在跑`。
 */
export function summaryText(state: SubagentCardState): string {
  if (state.entries.size === 0) return ''
  let completed = 0, running = 0, failed = 0, other = 0
  for (const entry of state.entries.values()) {
    if (entry.status === 'completed') completed += 1
    else if (entry.status === 'running') running += 1
    else if (entry.status === 'error' || entry.status === 'max-tokens') failed += 1
    else other += 1
  }
  const parts: string[] = []
  if (completed > 0) parts.push(`${completed} 完成`)
  if (failed > 0) parts.push(`${failed} 失败`)
  if (other > 0) parts.push(`${other} 中止`)
  if (running > 0) parts.push(`${running} 在跑`)
  return parts.join(' · ')
}

/** 超过这个数量，已结束的子代理收进一行，不让面板无限拉长。 */
export const DONE_COLLAPSE_AFTER = 3

export function render(state: SubagentCardState, now: number = Date.now()): object {
  const all = [...state.entries.values()].sort((a, b) => {
    const byStatus = sortKey(a) - sortKey(b)
    // 同一状态里，跑着的先来的在下面（新起的最可能还没跑起来，反而更值得看），
    // 结束的按结束时间倒序（最近的在上）。
    if (byStatus !== 0) return byStatus
    if (a.status === 'running') return b.startedAt - a.startedAt
    return (b.endedAt ?? 0) - (a.endedAt ?? 0)
  })

  const live = all.filter(e => e.status === 'running' || e.status === 'error' || e.status === 'max-tokens')
  const done = all.filter(e => e.status === 'completed' || e.status === 'aborted')
  // 已经结束的一律收起第二行：它们不再变化，展开只是占地方。只有「刚开始就
  // 结束」的这一类仍然值得看一眼，所以保留最多三条的完整形态。
  const shownDone = done.length <= DONE_COLLAPSE_AFTER ? done : done.slice(0, DONE_COLLAPSE_AFTER)

  // 分隔线和文本块混排，所以类型放宽到「任意卡片元素」；飞书对元素顺序敏感，
  // 这里靠顺序把「在跑 / 已结束 / 统计」分成三段。
  const sections: object[] = []
  if (live.length > 0) {
    const body = live.flatMap(e => renderEntry(e, now, true)).join('\n')
    sections.push({ tag: 'div', text: { tag: 'lark_md', content: body } })
  }
  if (shownDone.length > 0) {
    const body = shownDone.flatMap(e => renderEntry(e, now, false)).join('\n')
    sections.push({ tag: 'hr' })
    sections.push({ tag: 'div', text: { tag: 'lark_md', content: body } })
  }
  if (shownDone.length < done.length) {
    sections.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `　　…另有 ${done.length - shownDone.length} 个已结束的子代理未列出` },
    })
  }
  if (sections.length === 0) {
    sections.push({ tag: 'div', text: { tag: 'lark_md', content: '（无子任务）' } })
  }

  const running = runningEntries(state).length
  const failed = all.filter(e => e.status === 'error' || e.status === 'max-tokens').length
  // 卡住不等于失败：它还在跑，只是很久没动静。用黄而不是红，免得一次正常的
  // 长构建被标成「炸了」；但也不能是正常的紫，那样等于没说。
  const stalled = all.filter(e => e.status === 'running' && e.lastAt !== undefined && now - e.lastAt >= STALL_MS).length
  const summary = summaryText(state)
  if (summary !== '') {
    sections.push({ tag: 'hr' })
    sections.push({ tag: 'div', text: { tag: 'lark_md', content: `**${summary}**` } })
  }
  // 标题就报状态：失败优先于卡住，卡住优先于正常。一个好端端的面板不该和
  // 「有两个炸了」共用同一种颜色。
  const template = failed > 0 ? 'red' : stalled > 0 ? 'orange' : running > 0 ? 'purple' : 'grey'
  const flags: string[] = []
  if (failed > 0) flags.push(`${failed} 失败`)
  if (stalled > 0) flags.push(`${stalled} 疑似卡住`)
  const headline = flags.length === 0
    ? `🧑‍💻 多代理执行面板（${running} 在跑）`
    : `🧑‍💻 多代理执行面板（${running} 在跑 · ${flags.join(' · ')}）`
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: headline },
    },
    elements: sections,
  }
}

/**
 * 把一张已经不再接管的卡片改写成「冻结快照」。
 *
 * `/panel` 之后旧卡停止更新，但它在聊天里还留着。如果就那样放着，它还顶着
 * 「3 在跑」的旧画面，读者分不清哪张卡是活的——这比没有卡更糟。所以给它换
 * 一个说清楚身份和时间的标题，并把配色转灰：不删（传输层没有撤回能力，而且
 * 快照能看出那一刻的状态），但要让人一眼知道「这不是最新的」。
 * @param state - 面板状态（用冻结那一刻的内容渲染）。
 * @param frozenAt - 冻结的时刻，epoch 毫秒。
 * @returns 供 `updateCard` 使用的卡片。
 */
export function renderFrozen(state: SubagentCardState, frozenAt: number): object {
  const body = render(state, frozenAt) as {
    config: unknown
    header: { template: string; title: { tag: string; content: string } }
    elements: object[]
  }
  const summary = summaryText(state)
  const when = new Date(frozenAt).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const banner = `📼 **这是 ${when} 的快照**，已停止更新。发 \`/panel\` 可再要一张最新的。`
  return {
    config: body.config,
    header: {
      // 灰是唯一不会让人误以为「还在动」的颜色。
      template: 'grey',
      title: {
        tag: 'plain_text',
        content: `📼 多代理执行面板 · 历史快照${summary === '' ? '' : `（${summary}）`}`,
      },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: banner } },
      { tag: 'hr' },
      ...body.elements,
    ],
  }
}
