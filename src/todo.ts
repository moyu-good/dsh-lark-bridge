/**
 * The model's todo list as a live Feishu progress card.
 *
 * dsh's `todo_write` tool replaces the whole list on every call and appends a
 * `todo/write` snapshot to the session log. This module renders those
 * snapshots as one progress card per session: the first write sends the card,
 * later writes update it in place, and a cleared or finished list settles it
 * with a summary. The Web UI renders the same projection in its sidebar; the
 * chat card is the equivalent surface for a messaging client.
 * @module dsh-lark-bridge/todo
 */

import type { LarkChannelError, SendResult } from '@larksuite/channel'
import type { OutboundPort } from './outbound.ts'

/** The transport surface the todo renderer needs: send + updateCard. */
export interface TodoPort extends OutboundPort {
  /** Replace a sent card's content in place. */
  updateCard(messageId: string, card: object): Promise<void>
}

/** One todo item as the host session carries it. */
export interface HostTodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The todo snapshot carried by a `todo/write` event. */
export interface HostTodoWrite {
  readonly todos: readonly HostTodoItem[]
}

/** How many of each status the latest snapshot has. */
interface TodoCounts {
  readonly total: number
  readonly done: number
  readonly inProgress: number
}

function counts(todos: readonly HostTodoItem[]): TodoCounts {
  let done = 0
  let inProgress = 0
  for (const item of todos) {
    if (item.status === 'completed') done += 1
    else if (item.status === 'in_progress') inProgress += 1
  }
  return { total: todos.length, done, inProgress }
}

/** Emoji per status, chosen from Feishu's supported reaction/emoji set. */
const STATUS_EMOJI = { pending: '⚪', in_progress: '🔵', completed: '✅' } as const

/** How many todo rows one card may show before collapsing. */
const CARD_TODO_MAX_ROWS = 12

/** Bound one untrusted todo line so it cannot inflate a card payload. */
function boundLine(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`
}

/**
 * Build the progress card for one todo snapshot.
 * @param todos - the latest whole list.
 * @returns a Feishu card object for `send({ card })` / `updateCard`.
 */
function todoCard(todos: readonly HostTodoItem[]): object {
  const { total, done, inProgress } = counts(todos)
  const rows = todos.slice(0, CARD_TODO_MAX_ROWS).map((item) => ({
    tag: 'div' as const,
    text: { tag: 'lark_md' as const, content: `${STATUS_EMOJI[item.status]} ${boundLine(item.content)}` },
  }))
  const overflow = todos.length - rows.length
  const elements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**任务进度** ${done}/${total} 完成${inProgress > 0 ? ` · ${inProgress} 进行中` : ''}`,
      },
    },
    ...rows,
  ]
  if (overflow > 0) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `… 还有 ${overflow} 项` }] })
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `📋 任务进度 ${done}/${total}` } },
    elements,
  }
}

/**
 * One chat's live todo card: the latest snapshot, its card message id, and the
 * channel it was sent to.
 */
interface PendingTodoCard {
  readonly chatId: string
  messageId: string
}

/**
 * The bridge's todo renderer: first snapshot sends a card, later snapshots
 * update it in place, and a session with no pending rows leaves the card with
 * a "done" header.
 * @param port - the transport used to send and update cards.
 * @returns the renderer and its failure report hook.
 */
export function createTodoRenderer(
  port: TodoPort,
  reportSendFailure: (error: unknown) => void,
): {
  handle(sessionId: string, chatId: string, todos: readonly HostTodoItem[]): Promise<void>
  dispose(): void
} {
  const cards = new Map<string, PendingTodoCard>()

  const sendOrUpdate = async (sessionId: string, chatId: string, todos: readonly HostTodoItem[]): Promise<void> => {
    const existing = cards.get(sessionId)
    const card = todoCard(todos)
    if (existing === undefined) {
      try {
        const sent = await port.send(chatId, { card })
        cards.set(sessionId, { chatId, messageId: sent.messageId })
      } catch (error) {
        // A failed first send leaves no card to update; the next snapshot
        // retries the send rather than losing the progress surface.
        reportSendFailure(error)
      }
      return
    }
    // A session that moved to another chat re-anchors the card there.
    if (existing.chatId !== chatId) {
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
    async handle(sessionId, chatId, todos) {
      await sendOrUpdate(sessionId, chatId, todos)
    },
    dispose() {
      cards.clear()
    },
  }
}

/** Re-exported for the bridge's failure-path typing. */
export type { LarkChannelError, SendResult }
