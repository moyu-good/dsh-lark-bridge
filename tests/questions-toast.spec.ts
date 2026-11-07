/**
 * The question card's click response is a behaviour contract with Feishu:
 * the card callback carries `{ toast: { type, content } }`, and the SDK
 * forwards whatever the handler returns VERBATIM (its `CardActionResponse` is
 * `Record<string, unknown>`). A bare string type-checks and then renders
 * nothing, so the clicker gets no feedback at all — this pins the object
 * shape, not the source that produces it.
 */

import { describe, expect, it } from 'vitest'
import { createQuestionProvider } from '../src/questions.ts'

/** Any object tree node carrying a `tag`, as the tests walk a card. */
interface CardNode {
  tag?: string
  name?: string
  elements?: CardNode[]
  columns?: { elements?: CardNode[] }[]
  body?: { elements?: CardNode[] }
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

/** Yield one microtask so the awaited send inside ask() settles. */
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

/** A card-action event as a form submission produces it. */
function submit(name: string) {
  return { action: { name, tag: 'button' } } as never
}

describe('question card click response', () => {
  it('carries the SDK toast object, not a bare string', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))
    const promise = provider.ask({
      questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A 方案' }, { label: 'B 方案' }] }],
      agent: { session: { id: 'ses_1' } },
    })
    await tick()
    const card = port.sent[0]!.card as CardNode
    const option = walk(card).find(node => node.tag === 'button' && node.name?.includes('o0_0'))
    expect(option?.name).toBeDefined()

    const response = handleCardAction(submit(option!.name!)) as { toast: unknown }

    // Exactly what the SDK documents (`dist/index.d.mts`):
    // `{ toast: { type: 'success' | 'info' | 'error' | 'warning' | 'loading',
    //            content: string } }`.
    expect(response).toEqual({ toast: { type: 'success', content: '回答已提交' } })
    // Spelled out separately: the failing shape this guards against is a
    // STRING toast, which the platform drops silently.
    expect(typeof response.toast).toBe('object')
    expect(JSON.parse(JSON.stringify(response))).toEqual({
      toast: { type: 'success', content: '回答已提交' },
    })

    // Settle the pending ask so the test leaks no promise.
    await promise
  })

  it('keeps the toast an object while questions remain unanswered', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port, () => ({ chatId: 'oc_chat_1' }))
    const promise = provider.ask({
      questions: [
        { id: 'q1', question: '第一个？', options: [{ label: '是' }] },
        { id: 'q2', question: '第二个？', options: [{ label: '否' }] },
      ],
      agent: { session: { id: 'ses_1' } },
    })
    await tick()
    const card = port.sent[0]!.card as CardNode
    const option = walk(card).find(node => node.tag === 'button' && node.name?.includes('o0_0'))

    const response = handleCardAction(submit(option!.name!)) as { toast: { type: string; content: string } }

    expect(typeof response.toast).toBe('object')
    expect(response.toast.type).toBe('success')
    expect(response.toast.content).toContain('还有 1 个问题')

    // Settle the batch so the test leaks no promise.
    const second = walk(card).find(node => node.tag === 'button' && node.name?.includes('o1_0'))
    handleCardAction(submit(second!.name!))
    await promise
  })
})
