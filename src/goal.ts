/**
 * The model's current goal as a live Feishu card.
 *
 * dsh's goal tools mutate the session's goal and append a `goal/change`
 * snapshot event (whole-value replace: the newest snapshot is the current
 * goal). This module renders those snapshots as one goal card per session:
 * the first change sends the card, later changes update it in place, and a
 * cleared goal (no snapshot) settles the card with a neutral header. The Web
 * UI renders the same projection in its sidebar; the chat card is the
 * equivalent surface for a messaging client.
 * @module dsh-lark-bridge/goal
 */

import type { OutboundPort } from './outbound.ts'

/** The transport surface the goal renderer needs: send + updateCard. */
export interface GoalPort extends OutboundPort {
  /** Replace a sent card's content in place. */
  updateCard(messageId: string, card: object): Promise<void>
}

/** One goal snapshot as the host session carries it. */
export interface HostGoal {
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly blockedReason?: { readonly code?: string; readonly message?: string }
  readonly maxGoalRounds?: number
}

/** The `goal/change` payload the bridge consumes. */
export interface HostGoalChange {
  readonly operation: string
  readonly goal?: HostGoal
}

/** Emoji and label per lifecycle phase. */
const PHASE_META: Record<HostGoal['phase'], { readonly emoji: string; readonly label: string }> = {
  active: { emoji: '🎯', label: '进行中' },
  paused: { emoji: '⏸️', label: '已暂停' },
  blocked: { emoji: '🚧', label: '受阻' },
  complete: { emoji: '✅', label: '已完成' },
}

/** Bound one untrusted line so it cannot inflate a card payload. */
function boundLine(text: string): string {
  return text.length <= 160 ? text : `${text.slice(0, 159)}…`
}

/**
 * Build the goal card for one snapshot.
 * @param goal - the current goal snapshot.
 * @returns a Feishu card object for `send({ card })` / `updateCard`.
 */
function goalCard(goal: HostGoal): object {
  const meta = PHASE_META[goal.phase]
  const lines: string[] = [`**目标** ${boundLine(goal.objective)}`, `${meta.emoji} ${meta.label}`]
  if (goal.phase === 'blocked' && goal.blockedReason?.message !== undefined && goal.blockedReason.message !== '') {
    lines.push(`原因：${boundLine(goal.blockedReason.message)}`)
  }
  if (goal.maxGoalRounds !== undefined) {
    lines.push(`轮次上限：${goal.maxGoalRounds}`)
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'turquoise', title: { tag: 'plain_text', content: `${meta.emoji} 目标 ${meta.label}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    ],
  }
}

/** One chat's live goal card. */
interface PendingGoalCard {
  readonly chatId: string
  messageId: string
}

/**
 * The bridge's goal renderer: first snapshot sends a card, later snapshots
 * update it in place, and a clear (operation `clear`) leaves the last card
 * untouched — the goal is gone, so there is nothing to update.
 * @param port - the transport used to send and update cards.
 * @returns the renderer and its failure report hook.
 */
export function createGoalRenderer(
  port: GoalPort,
  reportSendFailure: (error: unknown) => void,
): {
  handle(sessionId: string, chatId: string, change: HostGoalChange): Promise<void>
  dispose(): void
} {
  const cards = new Map<string, PendingGoalCard>()

  const sendOrUpdate = async (sessionId: string, chatId: string, goal: HostGoal): Promise<void> => {
    const existing = cards.get(sessionId)
    const card = goalCard(goal)
    if (existing === undefined || existing.chatId !== chatId) {
      try {
        const sent = await port.send(chatId, { card })
        cards.set(sessionId, { chatId, messageId: sent.messageId })
      } catch (error) {
        reportSendFailure(error)
      }
      return
    }
    try {
      await port.updateCard(existing.messageId, card)
    } catch (error) {
      reportSendFailure(error)
    }
  }

  return {
    async handle(sessionId, chatId, change) {
      // A clear operation carries no snapshot: the goal is gone, keep the
      // last card as the historical record.
      if (change.goal === undefined) return
      await sendOrUpdate(sessionId, chatId, change.goal)
    },
    dispose() {
      cards.clear()
    },
  }
}
