import { describe, expect, it } from 'vitest'
import { createGoalRenderer } from '../src/goal.ts'

/** A minimal fake goal port recording sends and updates. */
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

/** Extract the header title from a rendered card. */
function headerTitle(card: object): string {
  return ((card as { header?: { title?: { content?: string } } }).header?.title?.content) ?? ''
}

/** Extract the first lark_md line. */
function firstLine(card: object): string {
  const elements = (card as { elements?: { text?: { content?: string } }[] }).elements ?? []
  return elements.find(e => e.text?.content !== undefined)?.text?.content ?? ''
}

describe('goal renderer', () => {
  it('sends a card on the first snapshot with the phase in the header', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', {
      operation: 'create',
      goal: { objective: '完成论文初稿', phase: 'active', maxGoalRounds: 10 },
    })

    expect(port.sent).toHaveLength(1)
    expect(port.sent[0]!.chatId).toBe('oc_chat_1')
    expect(headerTitle(port.sent[0]!.card)).toContain('进行中')
    expect(firstLine(port.sent[0]!.card)).toContain('完成论文初稿')
    expect(firstLine(port.sent[0]!.card)).toContain('轮次上限：10')
  })

  it('updates the card in place on later snapshots', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', {
      operation: 'create',
      goal: { objective: '目标A', phase: 'active' },
    })
    expect(port.sent).toHaveLength(1)

    await renderer.handle('ses_1', 'oc_chat_1', {
      operation: 'edit',
      goal: { objective: '目标A', phase: 'complete' },
    })

    expect(port.sent).toHaveLength(1)
    expect(port.updated).toHaveLength(1)
    expect(port.updated[0]!.messageId).toBe('om_1')
    expect(headerTitle(port.updated[0]!.card)).toContain('已完成')
  })

  it('shows the blocked reason when a goal is blocked', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', {
      operation: 'block',
      goal: { objective: '目标B', phase: 'blocked', blockedReason: { code: 'missing-key', message: '缺少 API key' } },
    })

    expect(headerTitle(port.sent[0]!.card)).toContain('受阻')
    expect(firstLine(port.sent[0]!.card)).toContain('缺少 API key')
  })

  it('ignores a clear operation that carries no snapshot', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', { operation: 'clear' })

    expect(port.sent).toHaveLength(0)
    expect(port.updated).toHaveLength(0)
  })

  it('re-anchors to a new chat when the session moves', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', { operation: 'create', goal: { objective: 'a', phase: 'active' } })
    await renderer.handle('ses_1', 'oc_chat_2', { operation: 'edit', goal: { objective: 'a', phase: 'paused' } })

    expect(port.sent).toHaveLength(2)
    expect(port.sent[1]!.chatId).toBe('oc_chat_2')
    expect(port.updated).toHaveLength(0)
  })

  it('adds pause/clear buttons to an active goal and carries the session id', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', { operation: 'create', goal: { objective: 'a', phase: 'active' } })

    const card = port.sent[0]!.card as { elements?: { tag?: string; actions?: { text?: { content?: string }; value?: object }[] }[] }
    const action = card.elements?.find(e => e.tag === 'action')
    expect(action).toBeDefined()
    const texts = action!.actions!.map(a => a.text?.content)
    expect(texts).toContain('⏸️ 暂停')
    expect(texts).toContain('⏹ 清除')
    expect(texts).not.toContain('▶️ 继续')
    const values = action!.actions!.map(a => a.value)
    expect(values.every(v => (v as { sessionId?: string }).sessionId === 'ses_1')).toBe(true)
  })

  it('shows resume instead of pause for a paused goal', async () => {
    const port = fakePort()
    const renderer = createGoalRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', { operation: 'create', goal: { objective: 'a', phase: 'paused' } })

    const card = port.sent[0]!.card as { elements?: { tag?: string; actions?: { text?: { content?: string } }[] }[] }
    const action = card.elements?.find(e => e.tag === 'action')
    const texts = action!.actions!.map(a => a.text?.content)
    expect(texts).toContain('▶️ 继续')
    expect(texts).not.toContain('⏸️ 暂停')
  })
})
