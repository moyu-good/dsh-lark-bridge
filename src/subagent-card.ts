/**
 * Tracks subagent children for one chat session and renders them as a single
 * updatable Feishu interactive card. One card shows ALL live children; each
 * status change re-renders the card in place.
 * @module dsh-lark-bridge/subagent-card
 */

export interface SubagentEntry {
  readonly id: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
  status: 'running' | 'completed' | 'aborted' | 'error' | 'max-tokens'
}

export interface SubagentCardState {
  readonly entries: Map<string, SubagentEntry>
  /** The message ID of the sent card, for updateCard calls. */
  messageId?: string
}

export function createTracker(): SubagentCardState {
  return { entries: new Map() }
}

export function addEntry(state: SubagentCardState, id: string, descriptor: { mode: string; label?: string }): void {
  state.entries.set(id, {
    id,
    label: descriptor.label ?? `child-${state.entries.size + 1}`,
    mode: descriptor.mode === 'continuable' ? 'continuable' : 'one-shot',
    status: 'running',
  })
}

export function settleEntry(state: SubagentCardState, id: string, stopReason: string): void {
  const e = state.entries.get(id)
  if (!e) return
  if (stopReason === 'completed') e.status = 'completed'
  else if (stopReason === 'aborted') e.status = 'aborted'
  else if (stopReason === 'max-tokens') e.status = 'max-tokens'
  else e.status = 'error'
}

function statusMark(s: string): string {
  switch (s) {
    case 'completed': return '✅'
    case 'aborted': return '⏹️'
    case 'error': return '❌'
    case 'max-tokens': return '⛔'
    default: return '⏳'
  }
}

export function render(state: SubagentCardState): object {
  const rows: string[] = []
  for (const [, e] of state.entries) {
    const mark = statusMark(e.status)
    rows.push(` ${mark} **${e.label}** — ${e.status}`)
  }
  const body = rows.length > 0 ? rows.join('\n') : '（无子任务）'
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: '🧑‍💻 多代理执行面板' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
    ],
  }
}
