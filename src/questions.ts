/**
 * The model-to-human question flow as a Feishu card.
 *
 * dsh's `ctx.userQuestions` seam pauses a tool call until a human answers;
 * the UI side is a single registered provider. This module is that provider
 * for the bridge: the model's `ask_user_question` becomes an interactive
 * Feishu card (option buttons, or a free-text prompt), the human's click or
 * text resolves the pending promise, and the structured answer rides back
 * into the agent loop as the tool result — the exact round trip the Web UI's
 * question composer performs.
 * @module dsh-lark-bridge/questions
 */

import { randomUUID } from 'node:crypto'
import type {
  CardActionEvent,
  CardActionResponse,
  SendResult,
} from '@larksuite/channel'
import type { OutboundPort } from './outbound.ts'

/** One question, as the host's seam carries it (subset the bridge needs). */
export interface HostQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** The answer shape the host seam expects back. */
export interface HostQuestionAnswer {
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[]
}

/** The subset of the host user-questions seam the bridge consumes. */
export interface HostUserQuestions {
  registerProvider(provider: {
    ask(request: {
      readonly questions: readonly HostQuestion[]
      /** The exact live calling agent, when the request came from a tool call. */
      readonly agent?: { readonly session: { readonly id: string } }
      readonly signal?: AbortSignal
    }): Promise<HostQuestionAnswer>
  }): () => void
}

/** Card-button payload carried by an option selection. */
const QUESTION_ACTION = 'dsh-lark-bridge/question'
interface QuestionActionValue {
  readonly kind: typeof QUESTION_ACTION
  readonly id: string
  readonly option: string
}

/**
 * Narrow an arbitrary card-action value to this plugin's question payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
function questionActionValue(value: unknown): QuestionActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== QUESTION_ACTION) return undefined
  if (typeof record.id !== 'string') return undefined
  if (typeof record.option !== 'string') return undefined
  return { kind: QUESTION_ACTION, id: record.id, option: record.option }
}

/** How much of a question's detail an option card may carry. */
const QUESTION_DETAIL_MAX_CHARS = 400

/** Bound one untrusted detail string so it cannot inflate a card payload. */
function boundDetail(text: string): string {
  return text.length <= QUESTION_DETAIL_MAX_CHARS
    ? text
    : `${text.slice(0, QUESTION_DETAIL_MAX_CHARS - 1)}…`
}

/**
 * Build the interactive question card for one request.
 *
 * Untrusted model text (question/detail/option labels) rides `plain_text`
 * elements so none of it can inject card markup. Option buttons are the
 * selectable surface; a question without options degrades to a single
 * "已读（无选项）" confirmation button so the promise always has a path
 * to resolve.
 * @param questions - the questions to render.
 * @param id - correlation id carried by every button.
 * @returns a Feishu card object for `send({ card })`.
 */
function questionCard(questions: readonly HostQuestion[], id: string): object {
  const elements: object[] = []
  for (const q of questions) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: q.question } })
    if (q.header !== undefined && q.header !== '') {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `分组：${q.header}` }] })
    }
    if (q.detail !== undefined && q.detail !== '') {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: boundDetail(q.detail) } })
    }
    const options = q.options ?? []
    if (options.length === 0) {
      elements.push({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '确认已读' },
          type: 'primary',
          value: { kind: QUESTION_ACTION, id, option: '' },
        }],
      })
    } else {
      elements.push({
        tag: 'action',
        actions: options.slice(0, 6).map((option, index) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: option.label.slice(0, 40) },
          type: index === 0 ? 'primary' : 'default',
          value: { kind: QUESTION_ACTION, id, option: option.label },
        })),
      })
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '需要你的回答' } },
    elements,
  }
}

/** One question card awaiting a button click. */
interface PendingQuestion {
  readonly chatId: string
  readonly resolve: (answer: HostQuestionAnswer) => void
  readonly questions: readonly HostQuestion[]
}

/**
 * The bridge's user-questions provider: render questions as Feishu cards and
 * resolve them on button clicks.
 * @param port - the transport used to send cards.
 * @param chatFor - resolve the chat a session's question belongs to; keyed by
 *   the agent's session id (the host seam validates the caller is the exact
 *   live root before it reaches us).
 * @returns the provider and its card-action handler.
 */
export function createQuestionProvider(
  port: OutboundPort,
  chatFor: (sessionId: string) => { chatId: string; threadId?: string } | undefined,
): {
  provider: { ask(request: {
    readonly questions: readonly HostQuestion[]
    readonly agent?: { readonly session: { readonly id: string } }
    readonly signal?: AbortSignal
  }): Promise<HostQuestionAnswer> }
  handleCardAction(evt: CardActionEvent): CardActionResponse | undefined
} {
  const pending = new Map<string, PendingQuestion>()

  const provider = {
    async ask(request: {
      readonly questions: readonly HostQuestion[]
      readonly agent?: { readonly session: { readonly id: string } }
      readonly signal?: AbortSignal
    }): Promise<HostQuestionAnswer> {
      const id = randomUUID()
      // The host seam guarantees the caller is a live root agent; its session
      // id is the key the bridge keeps for chat routing.
      const sessionId = request.agent?.session.id
      const chat = sessionId === undefined ? undefined : chatFor(sessionId)
      if (chat === undefined) {
        return { answers: request.questions.map(q => ({ id: q.id, selected: [], custom: '[会话不可用]' })) }
      }
      let sent: SendResult
      try {
        sent = await port.send(chat.chatId, { card: questionCard(request.questions, id) })
      } catch (error) {
        // With no card in front of a human, fail closed with a structured
        // "could not ask" answer so the model does not hang.
        return { answers: request.questions.map(q => ({ id: q.id, selected: [], custom: '[无法发送问题]' })) }
      }
      return new Promise<HostQuestionAnswer>((resolve) => {
        pending.set(id, { chatId: chat.chatId, resolve, questions: request.questions })
        request.signal?.addEventListener('abort', () => {
          const item = pending.get(id)
          if (item === undefined) return
          pending.delete(id)
          item.resolve({ answers: item.questions.map(q => ({ id: q.id, selected: [], custom: '[已取消]' })) })
        }, { once: true })
        // Keep the card id reachable after send for the click handler.
        void sent
      })
    },
  }

  const handleCardAction = (evt: CardActionEvent): CardActionResponse | undefined => {
    const value = questionActionValue(evt.action.value)
    if (value === undefined) return undefined
    const item = pending.get(value.id)
    if (item === undefined) return undefined
    pending.delete(value.id)
    const answers = item.questions.map(q => {
      // Option clicks answer by label; the empty option means "confirmed".
      if (value.option === '') return { id: q.id, selected: [], custom: '已确认' }
      const isOption = (q.options ?? []).some(o => o.label === value.option)
      if (!isOption) return { id: q.id, selected: [], custom: value.option }
      return { id: q.id, selected: [value.option] }
    })
    item.resolve({ answers })
    return { toast: '回答已提交' }
  }

  return { provider, handleCardAction }
}

/** Re-export for the bridge's card-action dispatch. */
export type { CardActionEvent, CardActionResponse }
export { QUESTION_ACTION }
