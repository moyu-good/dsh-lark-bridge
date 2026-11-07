import { describe, expect, it } from 'vitest'
import { createQuestionProvider } from '../src/questions.ts'

/** Any object tree node carrying a `tag`, as the tests walk a card. */
interface CardNode {
  tag?: string
  name?: string
  text?: { content?: string }
  required?: boolean
  form_action_type?: string
  elements?: CardNode[]
  columns?: { elements?: CardNode[] }[]
  body?: { elements: CardNode[] }
  schema?: string
  header?: { title?: { content?: string } }
}

/** A minimal fake port recording sends and in-place card updates. */
function fakePort() {
  const sent: { chatId: string; card: object }[] = []
  const updated: { messageId: string; card: object }[] = []
  return {
    sent,
    updated,
    async send(chatId: string, input: { card: object }) {
      sent.push({ chatId, card: input.card })
      return { messageId: `om_${sent.length}` }
    },
    async updateCard(messageId: string, card: object) {
      updated.push({ messageId, card })
    },
  }
}

/** Yield one microtask so an awaited send inside ask() settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Every node in a card, depth first. */
function walk(node: CardNode, out: CardNode[] = []): CardNode[] {
  out.push(node)
  for (const child of node.elements ?? []) walk(child, out)
  for (const column of node.columns ?? []) {
    for (const child of column.elements ?? []) walk(child, out)
  }
  for (const child of node.body?.elements ?? []) walk(child, out)
  return out
}

/** The card body of the only send so far. */
function cardOf(port: ReturnType<typeof fakePort>, index = 0): CardNode {
  return port.sent[index]!.card as CardNode
}

/** Every button on a card. */
function buttons(card: CardNode): CardNode[] {
  return walk(card).filter(node => node.tag === 'button')
}

/** Every form on a card. */
function forms(card: CardNode): CardNode[] {
  return walk(card).filter(node => node.tag === 'form')
}

/** The request token encoded in the first control name on a card. */
function tokenOf(card: CardNode): string {
  const name = buttons(card)[0]?.name
  if (name === undefined) throw new Error('card has no button to read a token from')
  const token = /^q([0-9a-f]{8})/.exec(name)?.[1]
  if (token === undefined) throw new Error(`unexpected control name ${name}`)
  return token
}

/** A card-action event as a form submission produces it. */
function submit(name: string, formValue?: Record<string, unknown>) {
  return { action: { name, tag: 'button', formValue } } as never
}

describe('user-questions provider', () => {
  it('renders each question as its own CardKit 2.0 form', async () => {
    const port = fakePort()
    const { provider } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))
    const controller = new AbortController()

    const promise = provider.ask({
      questions: [
        {
          id: 'q1',
          question: '选哪个方案？',
          options: [
            { label: 'A 方案', description: '快但粗糙' },
            { label: 'B 方案', description: '慢但稳' },
          ],
        },
        { id: 'q2', question: '自由输入点什么' },
      ],
      agent: { session: { id: 'ses_1' } },
      signal: controller.signal,
    })

    expect(port.sent).toHaveLength(1)
    const card = cardOf(port)
    expect(card.schema).toBe('2.0')
    // A batch of questions is a batch of independent forms: they cannot nest.
    expect(forms(card)).toHaveLength(2)
    for (const form of forms(card)) expect(form.name).toMatch(/^q[0-9a-f]{8}f\d+$/)

    const token = tokenOf(card)
    const names = buttons(card).map(button => button.name)
    expect(names).toContain(`q${token}o0_0`)
    expect(names).toContain(`q${token}o0_1`)
    // Text-only submit and skip exist per question, options or not.
    expect(names).toContain(`q${token}t0`)
    expect(names).toContain(`q${token}s0`)
    expect(names).toContain(`q${token}t1`)
    expect(names).toContain(`q${token}s1`)

    // The input must stay optional, or a click on an option is rejected
    // front-end with "有必填项未填写" and never reaches the callback.
    const input = walk(card).find(node => node.tag === 'input')
    expect(input?.required).toBe(false)
    expect(input?.name).toBe(`q${token}a0`)

    // Consequences are listed as rows, since a CardKit button is one line.
    const texts = walk(card).map(node => node.text?.content ?? '')
    expect(texts.some(text => text.includes('A 方案 —— 快但粗糙'))).toBe(true)

    await tick()
    controller.abort()
    await promise
  })

  it('answers a question when its option button is clicked', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A 方案' }, { label: 'B 方案' }] }],
      agent: { session: { id: 'ses_1' } },
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    const response = handleCardAction(submit(`q${token}o0_1`))

    expect(response).toEqual({ toast: { type: 'success', content: '回答已提交' } })
    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B 方案'] }] })
  })

  it('carries typed text alongside the chosen option', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A 方案' }] }],
      agent: { session: { id: 'ses_1' } },
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    handleCardAction(submit(`q${token}o0_0`, { [`q${token}a0`]: '  顺手把缓存也清了  ' }))

    await expect(promise).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['A 方案'], custom: '顺手把缓存也清了' }],
    })
  })

  it('answers with typed text alone', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '继续吗？' }],
      agent: { session: { id: 'ses_1' } },
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    handleCardAction(submit(`q${token}t0`, { [`q${token}a0`]: '别删配置文件' }))

    await expect(promise).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '别删配置文件' }],
    })
  })

  it('refuses an empty text-only submit without settling the question', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '继续吗？' }],
      agent: { session: { id: 'ses_1' } },
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    expect(handleCardAction(submit(`q${token}t0`, { [`q${token}a0`]: '   ' })))
      .toEqual({ toast: { type: 'warning', content: '还没有输入内容' } })
    expect(handleCardAction(submit(`q${token}t0`)))
      .toEqual({ toast: { type: 'warning', content: '还没有输入内容' } })

    // Still answerable: the skip resolves it.
    handleCardAction(submit(`q${token}s0`))
    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('treats a skip as an explicit answer, distinct from cancellation', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }],
      agent: { session: { id: 'ses_1' } },
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    handleCardAction(submit(`q${token}s0`))

    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('settles a batch only once every question is answered', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    let resolved = false
    const promise = provider.ask({
      questions: [
        { id: 'q1', question: '第一个？', options: [{ label: '是' }] },
        { id: 'q2', question: '第二个？', options: [{ label: '否' }] },
      ],
      agent: { session: { id: 'ses_1' } },
    }).then((answer) => {
      resolved = true
      return answer
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    expect(handleCardAction(submit(`q${token}o1_0`)))
      .toEqual({ toast: { type: 'success', content: '已回答，还有 1 个问题' } })
    await tick()
    expect(resolved).toBe(false)

    handleCardAction(submit(`q${token}o0_0`))
    await expect(promise).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['是'] },
        { id: 'q2', selected: ['否'] },
      ],
    })
  })

  it('replaces the answered question with a receipt, leaving the rest live', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))

    const promise = provider.ask({
      questions: [
        { id: 'q1', question: '第一个？', options: [{ label: '是' }] },
        { id: 'q2', question: '第二个？', options: [{ label: '否' }] },
      ],
      agent: { session: { id: 'ses_1' } },
    })
    const token = tokenOf(cardOf(port))
    // ask() registers the pending request after its send settles, so a click
    // can only be delivered once that turn of the microtask queue is done.
    await tick()

    handleCardAction(submit(`q${token}o0_0`))
    await tick()

    expect(port.updated).toHaveLength(1)
    expect(port.updated[0]!.messageId).toBe('om_1')
    const partial = port.updated[0]!.card as CardNode
    // The answered question became a line of record; the other form survives.
    expect(forms(partial)).toHaveLength(1)
    expect(forms(partial)[0]!.name).toBe(`q${token}f1`)
    expect(walk(partial).some(node => (node.text?.content ?? '').includes('✅ 第一个？'))).toBe(true)

    handleCardAction(submit(`q${token}o1_0`))
    await tick()

    // The final card is a receipt with no live form left.
    expect(port.updated).toHaveLength(2)
    const final = port.updated[1]!.card as CardNode
    expect(forms(final)).toHaveLength(0)
    expect(final.header?.title?.content).toBe('已回答')

    await promise
  })

  it('ignores control names this plugin did not write', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))
    const controller = new AbortController()
    const promise = provider.ask({
      questions: [{ id: 'q1', question: '继续吗？' }],
      agent: { session: { id: 'ses_1' } },
      signal: controller.signal,
    })

    expect(handleCardAction(submit('Button_lvkepfu3'))).toBeUndefined()
    expect(handleCardAction(submit('qdeadbeefo0_0'))).toBeUndefined()

    await tick()
    controller.abort()
    await promise
  })

  it('fails closed when the session has no binding', async () => {
    const port = fakePort()
    const { provider } = createQuestionProvider(port, () => undefined)

    const answer = await provider.ask({
      questions: [{ id: 'q1', question: '哪个？' }],
      agent: { session: { id: 'ses_unknown' } },
    })

    expect(port.sent).toHaveLength(0)
    expect(answer.answers).toEqual([{ id: 'q1', selected: [], custom: '[会话不可用]' }])
  })

  it('aborts resolve with a cancelled answer when the signal fires', async () => {
    const port = fakePort()
    const { provider } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))
    const controller = new AbortController()

    const promise = provider.ask({
      questions: [{ id: 'q1', question: '哪个？', options: [{ label: 'A' }] }],
      agent: { session: { id: 'ses_1' } },
      signal: controller.signal,
    })

    await tick()
    controller.abort()
    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '[已取消]' }] })
  })
})
