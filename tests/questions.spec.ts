import { describe, expect, it } from 'vitest'
import { createQuestionProvider, QUESTION_ACTION } from '../src/questions.ts'

/** A minimal fake port recording sends. */
function fakePort() {
  const sent: { chatId: string; card: object }[] = []
  return {
    sent,
    async send(chatId: string, input: { card: object }) {
      sent.push({ chatId, card: input.card })
      return { messageId: `om_${sent.length}` }
    },
  }
}

/** Yield one microtask so an awaited send inside ask() settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Extract every button value from a rendered card. */
function buttonValues(card: object): unknown[] {
  const elements = (card as { elements?: { actions?: { value: unknown }[] }[] }).elements ?? []
  return elements.flatMap(e => e.actions?.map(a => a.value) ?? [])
}

function clickEvent(id: string, option: string) {
  return {
    action: { value: { kind: QUESTION_ACTION, id, option } },
  } as never
}
describe('user-questions provider', () => {
  it('renders each question with its options as buttons', async () => {
    const port = fakePort()
    const { provider } = createQuestionProvider(port as never, () => ({ chatId: 'oc_chat_1' }))
    const controller = new AbortController()

    const promise = provider.ask({
      questions: [
        { id: 'q1', question: '选哪个方案？', options: [{ label: 'A 方案' }, { label: 'B 方案' }] },
        { id: 'q2', question: '自由输入点什么' },
      ],
      agent: { session: { id: 'ses_1' } },
      signal: controller.signal,
    })

    expect(port.sent).toHaveLength(1)
    expect(port.sent[0]!.chatId).toBe('oc_chat_1')
    const values = buttonValues(port.sent[0]!.card)
    expect(values).toContainEqual({ kind: QUESTION_ACTION, id: expect.any(String), option: 'A 方案' })
    expect(values).toContainEqual({ kind: QUESTION_ACTION, id: expect.any(String), option: 'B 方案' })
    // A question without options still gets a confirm button so it can resolve.
    expect(values).toContainEqual({ kind: QUESTION_ACTION, id: expect.any(String), option: '' })

    // Resolve the pending ask so the test does not leak a promise.
    await tick()
    controller.abort()
    await promise
  })

  it('resolves the ask with the selected option on click', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port as never, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [
        { id: 'q1', question: '选哪个方案？', options: [{ label: 'A 方案' }, { label: 'B 方案' }] },
      ],
      agent: { session: { id: 'ses_1' } },
    })

    const values = buttonValues(port.sent[0]!.card)
    const id = (values[0] as { id: string }).id
    await tick()
    const response = handleCardAction(clickEvent(id, 'B 方案'))

    expect(response).toEqual({ toast: '回答已提交' })
    const answer = await promise
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['B 方案'] }])
  })

  it('answers with custom text for an option-less question confirmed', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port as never, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '继续吗？' }],
      agent: { session: { id: 'ses_1' } },
    })

    const values = buttonValues(port.sent[0]!.card)
    const id = (values[0] as { id: string }).id
    await tick()
    handleCardAction(clickEvent(id, ''))

    const answer = await promise
    expect(answer.answers).toEqual([{ id: 'q1', selected: [], custom: '已确认' }])
  })

  it('fails closed when the session has no binding', async () => {
    const port = fakePort()
    const { provider } = createQuestionProvider(port as never, () => undefined)

    const answer = await provider.ask({
      questions: [{ id: 'q1', question: '哪个？' }],
      agent: { session: { id: 'ses_unknown' } },
    })

    expect(port.sent).toHaveLength(0)
    expect(answer.answers).toEqual([{ id: 'q1', selected: [], custom: '[会话不可用]' }])
  })

  it('aborts resolve with a cancelled answer when the signal fires', async () => {
    const port = fakePort()
    const { provider } = createQuestionProvider(port as never, () => ({ chatId: 'oc_chat_1' }))
    const controller = new AbortController()

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '哪个？', options: [{ label: 'A' }] }],
      agent: { session: { id: 'ses_1' } },
      signal: controller.signal,
    })

    await tick()
    controller.abort()
    const answer = await promise
    expect(answer.answers).toEqual([{ id: 'q1', selected: [], custom: '[已取消]' }])
  })
})
