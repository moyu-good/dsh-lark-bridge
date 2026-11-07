/**
 * The model-to-human question flow as a Feishu card.
 *
 * dsh's `ctx.userQuestions` seam pauses a tool call until a human answers;
 * the UI side is a single registered provider. This module is that provider
 * for the bridge: the model's `ask_user_question` becomes an interactive
 * Feishu card, the human's click or typed text resolves the pending promise,
 * and the structured answer rides back into the agent loop as the tool result
 * — the exact round trip the Web UI's question composer performs.
 *
 * The card is CardKit JSON 2.0, because only 2.0 has a form container: that is
 * what lets one click both choose and submit, and what carries the free-text
 * answer back as `action.formValue`. Every answerable question is its own
 * `form` (they cannot nest and cannot sit inside a column), so a batch of
 * questions is a batch of independent forms, each settling on its own and
 * leaving a receipt behind.
 *
 * Untrusted model text (question/detail/option labels) rides `plain_text`
 * elements only — never markdown — so nothing it writes can inject card
 * markup or a link.
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

/**
 * The host's `user-questions/request` waterfall, as 0.1.5 declares it.
 *
 * Earlier harness versions exposed a `ctx.userQuestions.registerProvider`
 * registry; 0.1.5 replaced it with a Cordis waterfall where a listener claims
 * the request by returning an answer and delegates through `next()`. The
 * request/answer payloads are unchanged, so the bridge's provider plugs
 * straight in.
 */
export interface HostUserQuestionRequest {
  readonly questions: readonly HostQuestion[]
  /** The exact live calling agent, when the request came from a tool call. */
  readonly agent?: { readonly session: { readonly id: string } }
  readonly signal?: AbortSignal
}

/**
 * The transport surface the question provider needs.
 *
 * `updateCard` is optional because a test double that does not model the API
 * must still satisfy the port: without it the card simply stays clickable and
 * no receipt replaces the answered question.
 */
export interface QuestionPort extends OutboundPort {
  /** Replace a sent card's content in place. */
  updateCard?(messageId: string, card: object): Promise<void>
}

/**
 * Every answerable control on a question card is a form-submit button, so a
 * click is the whole interaction and the typed text rides along with it.
 *
 * Its identity travels in the element `name`, which CardKit requires to be
 * card-globally unique and always echoes back as `action.name` — unlike
 * `behaviors.value`, which a form submission is not guaranteed to surface.
 * The name encodes an 8-hex token for the whole request plus the question
 * index and the control kind:
 *
 * - `q<token>f<i>` — the question's form container
 * - `q<token>a<i>` — its free-text input
 * - `q<token>o<i>_<j>` — option `j` of question `i`
 * - `q<token>t<i>` — submit the typed text alone
 * - `q<token>s<i>` — skip the question
 */
const CONTROL = /^q([0-9a-f]{8})([faots])(\d+)(?:_(\d+))?$/

/** The control a card-action name identifies. */
interface ControlRef {
  readonly token: string
  /** `f` form, `a` input, `o` option, `t` text-only submit, `s` skip. */
  readonly kind: string
  /** Question index within the request. */
  readonly index: number
  /** Option index, for kind `o`. */
  readonly option?: number
}

/**
 * Parse one element name back into the control it identifies.
 * @param name - the `action.name` a form submission carries.
 * @returns the typed control, or undefined for a name this plugin did not write.
 */
function controlRef(name: string | undefined): ControlRef | undefined {
  if (name === undefined) return undefined
  const match = CONTROL.exec(name)
  if (match === null) return undefined
  const [, token, kind, index, option] = match
  if (token === undefined || kind === undefined || index === undefined) return undefined
  return {
    token,
    kind,
    index: Number(index),
    ...option === undefined ? {} : { option: Number(option) },
  }
}

/** How much of a question's detail an option card may carry. */
const QUESTION_DETAIL_MAX_CHARS = 400

/** How long an option label may be before it is cut, so a card stays readable. */
const OPTION_LABEL_MAX_CHARS = 40

/** How many option buttons share one row before wrapping. */
const OPTIONS_PER_ROW = 3

/** The input's ceiling; CardKit caps `max_length` at 1000. */
const ANSWER_MAX_CHARS = 1000

/** Bound one untrusted string so it cannot inflate a card payload. */
function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** A `plain_text` element: the only text form untrusted model output may take. */
function plainText(content: string): object {
  return { tag: 'plain_text', content }
}

/** One question's settled answer, as the receipt renders it. */
interface Settlement {
  readonly selected: readonly string[]
  readonly custom?: string
  /** `HH:mm` the human answered — the receipt says when, not when it is redrawn. */
  readonly at: string
}

/** What one question's answer reads as on a settled card. */
function receiptLine(settlement: Settlement): string {
  const picked = settlement.selected.join('、')
  if (settlement.custom !== undefined && settlement.custom !== '') {
    return picked === '' ? settlement.custom : `${picked} · ${settlement.custom}`
  }
  return picked === '' ? '已跳过' : picked
}

/** `HH:mm` in the host's own zone — the receipt says when it was answered. */
function clockNow(): string {
  return new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Render the consequence notes that sit above a question's buttons.
 *
 * CardKit buttons carry a single plain-text line, so an option's `description`
 * cannot ride its button; it is listed here instead, one row per described
 * option, in the same order as the buttons below. Options without a
 * description contribute nothing — an empty row would only cost height.
 * @param question - the question being rendered.
 * @returns one row per described option.
 */
function optionNotes(question: HostQuestion): object[] {
  const rows: object[] = []
  for (const option of question.options ?? []) {
    if (option.description === undefined || option.description === '') continue
    rows.push({
      tag: 'div',
      text: plainText(`${bound(option.label, OPTION_LABEL_MAX_CHARS)} —— ${bound(option.description, QUESTION_DETAIL_MAX_CHARS)}`),
    })
  }
  return rows
}

/** One row of option-submit buttons. */
function optionRow(question: HostQuestion, token: string, index: number, from: number): object {
  const options = question.options ?? []
  const buttons = options.slice(from, from + OPTIONS_PER_ROW).map((option, offset) => ({
    tag: 'button',
    name: `q${token}o${index}_${from + offset}`,
    form_action_type: 'submit',
    type: from + offset === 0 ? 'primary' : 'default',
    text: plainText(bound(option.label, OPTION_LABEL_MAX_CHARS)),
  }))
  return {
    tag: 'column_set',
    horizontal_spacing: 'small',
    columns: buttons.map(button => ({
      tag: 'column',
      width: 'auto',
      elements: [button],
    })),
  }
}

/**
 * Render one question as a self-contained form.
 *
 * The typed answer is the escape hatch beside the options, never a competing
 * mode: submitting an option carries whatever text was typed along with it,
 * and 「提交文字」 exists only for the case where no option fits. 「跳过」 is a
 * real skip — an empty `selected` and no `custom` — which the host reads as
 * "proceed on your judgement", not as a cancellation.
 * @param question - the question to render.
 * @param token - the request token every element name starts with.
 * @param index - the question's position in the request.
 * @returns the form container, preceded by its question and context rows.
 */
function questionForm(question: HostQuestion, token: string, index: number): object[] {
  const elements: object[] = []
  elements.push({ tag: 'div', text: plainText(bound(question.question, QUESTION_DETAIL_MAX_CHARS)) })
  if (question.header !== undefined && question.header !== '') {
    elements.push({ tag: 'div', text: plainText(`分组 · ${bound(question.header, 80)}`) })
  }
  if (question.detail !== undefined && question.detail !== '') {
    elements.push({ tag: 'div', text: plainText(bound(question.detail, QUESTION_DETAIL_MAX_CHARS)) })
  }
  elements.push(...optionNotes(question))

  const options = question.options ?? []
  const rows: object[] = []
  for (let from = 0; from < options.length; from += OPTIONS_PER_ROW) {
    rows.push(optionRow(question, token, index, from))
  }

  const form: object[] = [
    {
      tag: 'input',
      name: `q${token}a${index}`,
      input_type: 'multiline_text',
      rows: 2,
      auto_resize: true,
      max_rows: 6,
      max_length: ANSWER_MAX_CHARS,
      // Must stay false: a required field makes the front end reject an
      // option click with "有必填项未填写" and the callback never fires.
      required: false,
      placeholder: plainText(options.length === 0 ? '请输入你的回答' : '或者直接告诉我（可留空）'),
    },
    ...rows,
    {
      tag: 'column_set',
      horizontal_align: 'right',
      horizontal_spacing: 'small',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            name: `q${token}t${index}`,
            form_action_type: 'submit',
            type: 'default',
            text: plainText('提交文字'),
          }],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            name: `q${token}s${index}`,
            form_action_type: 'submit',
            type: 'default',
            text: plainText('跳过'),
          }],
        },
      ],
    },
  ]

  elements.push({
    tag: 'form',
    name: `q${token}f${index}`,
    direction: 'vertical',
    vertical_spacing: 'small',
    elements: form,
  })
  return elements
}

/** What one question's row reads as once it is settled. */
function receiptRow(question: HostQuestion, settlement: Settlement): object {
  return {
    tag: 'div',
    text: plainText(`✅ ${bound(question.question, QUESTION_DETAIL_MAX_CHARS)}\n${receiptLine(settlement)} · ${settlement.at}`),
  }
}

/**
 * Build the whole card for one request, from whatever is settled so far.
 *
 * Rebuilding the card is what makes the receipt work: an answered question
 * becomes a line of record while the remaining forms stay live. It does mean
 * a partial submission resets text typed into a sibling form, which is the
 * price of CardKit updating a card whole rather than per element.
 * @param questions - the request's questions.
 * @param token - the request token every element name starts with.
 * @param settled - answers recorded so far, keyed by question id.
 * @param done - whether every question is settled.
 * @returns a Feishu card object for `send({ card })` / `updateCard`.
 */
function questionCard(
  questions: readonly HostQuestion[],
  token: string,
  settled: ReadonlyMap<string, Settlement>,
  done: boolean,
): object {
  const elements: object[] = []
  questions.forEach((question, index) => {
    // A batch of questions stacks several forms; without a rule between them
    // the last control of one reads as belonging to the next question.
    if (index > 0) elements.push({ tag: 'hr' })
    const settlement = settled.get(question.id)
    if (settlement === undefined) elements.push(...questionForm(question, token, index))
    else elements.push(receiptRow(question, settlement))
  })
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      template: done ? 'green' : 'blue',
      title: plainText(done ? '已回答' : '需要你的回答'),
    },
    body: { elements },
  }
}

/** One question card awaiting its controls to be used. */
interface PendingQuestion {
  readonly chatId: string
  /** The sent card, needed to replace it with its receipt; absent when the send reported no id. */
  readonly messageId?: string
  readonly questions: readonly HostQuestion[]
  readonly resolve: (answer: HostQuestionAnswer) => void
  /** Answers recorded so far, keyed by question id. */
  readonly settled: Map<string, Settlement>
}

/**
 * Read the typed answer out of a form submission.
 *
 * A question form holds exactly one input, so the sole submitted value is the
 * answer text whatever the input's name turned out to be.
 * @param formValue - `action.formValue` as the channel SDK hands it over.
 * @returns the trimmed text, or '' when nothing was typed.
 */
function typedAnswer(formValue: Record<string, unknown> | undefined): string {
  if (formValue === undefined) return ''
  for (const value of Object.values(formValue)) {
    if (typeof value === 'string') return value.trim()
  }
  return ''
}

/**
 * The card-callback response Feishu shows the clicking user.
 *
 * `CardActionResponse` is `Record<string, unknown>` — the SDK forwards it
 * verbatim and validates nothing — so this is the only place the toast shape
 * can be pinned. Feishu expects `toast` to be an OBJECT (`{ type, content }`);
 * a bare string passes the type checker and is then dropped by the platform,
 * leaving the click with no feedback at all.
 */
type QuestionToastResponse = CardActionResponse & {
  toast: {
    type: 'success' | 'info' | 'error' | 'warning' | 'loading'
    content: string
  }
}

/**
 * The bridge's user-questions provider: render questions as Feishu cards and
 * resolve them as their controls are used.
 * @param port - the transport used to send and update cards.
 * @param chatFor - resolve the chat a session's question belongs to; keyed by
 *   the agent's session id (the host seam validates the caller is the exact
 *   live root before it reaches us).
 * @returns the provider and its card-action handler.
 */
export function createQuestionProvider(
  port: QuestionPort,
  chatFor: (sessionId: string) => { chatId: string; threadId?: string } | undefined,
): {
  provider: { ask(request: HostUserQuestionRequest): Promise<HostQuestionAnswer> }
  handleCardAction(evt: CardActionEvent): CardActionResponse | undefined
} {
  const pending = new Map<string, PendingQuestion>()

  /**
   * Replace a question's card with its current state.
   *
   * Failure here is not worth failing the answer over: the answer is already
   * recorded, and an unchanged card only costs the receipt.
   * @param question - the pending request being re-rendered.
   * @param token - its token.
   * @param done - whether every question is settled.
   */
  const refresh = async (question: PendingQuestion, token: string, done: boolean): Promise<void> => {
    if (question.messageId === undefined || port.updateCard === undefined) return
    try {
      await port.updateCard(
        question.messageId,
        questionCard(question.questions, token, question.settled, done),
      )
    } catch {
      // The card keeps its last state; the answer is unaffected.
    }
  }

  const provider = {
    async ask(request: HostUserQuestionRequest): Promise<HostQuestionAnswer> {
      const token = randomUUID().replace(/-/g, '').slice(0, 8)
      // The host seam guarantees the caller is a live root agent; its session
      // id is the key the bridge keeps for chat routing.
      const sessionId = request.agent?.session.id
      const chat = sessionId === undefined ? undefined : chatFor(sessionId)
      if (chat === undefined) {
        return { answers: request.questions.map(q => ({ id: q.id, selected: [], custom: '[会话不可用]' })) }
      }
      let sent: SendResult
      try {
        sent = await port.send(chat.chatId, {
          card: questionCard(request.questions, token, new Map(), false),
        })
      } catch {
        // With no card in front of a human, fail closed with a structured
        // "could not ask" answer so the model does not hang.
        return { answers: request.questions.map(q => ({ id: q.id, selected: [], custom: '[无法发送问题]' })) }
      }
      return new Promise<HostQuestionAnswer>((resolve) => {
        pending.set(token, {
          chatId: chat.chatId,
          ...sent.messageId === undefined ? {} : { messageId: sent.messageId },
          questions: request.questions,
          resolve,
          settled: new Map(),
        })
        request.signal?.addEventListener('abort', () => {
          const item = pending.get(token)
          if (item === undefined) return
          pending.delete(token)
          item.resolve({ answers: item.questions.map(q => ({ id: q.id, selected: [], custom: '[已取消]' })) })
        }, { once: true })
      })
    },
  }

  /**
   * Record one control's answer and settle the request once every question
   * has one.
   *
   * A skipped question is an answer too: it resolves that question as
   * `selected: []` with no `custom`, which the host reports to the model as
   * "the user explicitly skipped this" rather than as a cancellation.
   * @param evt - the card action event.
   * @param ref - the control the event's element name identified.
   * @param item - the pending request it belongs to.
   * @returns the toast to show the clicker.
   */
  const settle = (
    evt: CardActionEvent,
    ref: ControlRef,
    item: PendingQuestion,
  ): QuestionToastResponse => {
    const question = item.questions[ref.index]
    if (question === undefined || ref.kind === 'f' || ref.kind === 'a') {
      return { toast: { type: 'info', content: '该问题已失效' } }
    }
    const text = typedAnswer(evt.action.formValue)
    const at = clockNow()
    if (ref.kind === 'o') {
      const option = (question.options ?? [])[ref.option ?? -1]
      if (option === undefined) return { toast: { type: 'info', content: '该选项已失效' } }
      item.settled.set(question.id, {
        selected: [option.label],
        ...text === '' ? {} : { custom: text },
        at,
      })
    } else if (ref.kind === 't') {
      if (text === '') return { toast: { type: 'warning', content: '还没有输入内容' } }
      item.settled.set(question.id, { selected: [], custom: text, at })
    } else {
      item.settled.set(question.id, { selected: [], at })
    }

    const done = item.settled.size === item.questions.length
    const remaining = item.questions.length - item.settled.size
    void refresh(item, ref.token, done)
    if (!done) {
      return { toast: { type: 'success', content: `已回答，还有 ${remaining} 个问题` } }
    }
    pending.delete(ref.token)
    item.resolve({
      answers: item.questions.map(q => {
        const settlement = item.settled.get(q.id)
        if (settlement === undefined) return { id: q.id, selected: [] }
        return {
          id: q.id,
          selected: [...settlement.selected],
          ...settlement.custom === undefined ? {} : { custom: settlement.custom },
        }
      }),
    })
    return { toast: { type: 'success', content: '回答已提交' } }
  }

  const handleCardAction = (evt: CardActionEvent): CardActionResponse | undefined => {
    const ref = controlRef(evt.action.name)
    if (ref === undefined) return undefined
    const item = pending.get(ref.token)
    if (item === undefined) return undefined
    return settle(evt, ref, item)
  }

  return { provider, handleCardAction }
}

/** Re-export for the bridge's card-action dispatch. */
export type { CardActionEvent, CardActionResponse }
