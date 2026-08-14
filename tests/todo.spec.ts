import { describe, expect, it } from 'vitest'
import { createTodoRenderer } from '../src/todo.ts'

/** A minimal fake todo port recording sends and updates. */
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

describe('todo renderer', () => {
  it('sends a card on the first snapshot with progress in the header', async () => {
    const port = fakePort()
    const renderer = createTodoRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', [
      { content: '调研', status: 'in_progress' },
      { content: '实现', status: 'pending' },
      { content: '测试', status: 'completed' },
    ])

    expect(port.sent).toHaveLength(1)
    expect(port.sent[0]!.chatId).toBe('oc_chat_1')
    expect(headerTitle(port.sent[0]!.card)).toContain('1/3')
    expect(firstLine(port.sent[0]!.card)).toContain('1/3 完成')
  })

  it('updates the card in place on later snapshots', async () => {
    const port = fakePort()
    const renderer = createTodoRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', [{ content: 'a', status: 'pending' }])
    expect(port.sent).toHaveLength(1)

    await renderer.handle('ses_1', 'oc_chat_1', [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])

    expect(port.sent).toHaveLength(1) // no second send
    expect(port.updated).toHaveLength(1)
    expect(port.updated[0]!.messageId).toBe('om_1')
    expect(headerTitle(port.updated[0]!.card)).toContain('1/2')
  })

  it('re-anchors to a new chat when the session moves', async () => {
    const port = fakePort()
    const renderer = createTodoRenderer(port as never, () => {})

    await renderer.handle('ses_1', 'oc_chat_1', [{ content: 'a', status: 'pending' }])
    await renderer.handle('ses_1', 'oc_chat_2', [{ content: 'a', status: 'in_progress' }])

    expect(port.sent).toHaveLength(2)
    expect(port.sent[1]!.chatId).toBe('oc_chat_2')
    expect(port.updated).toHaveLength(0)
  })

  it('recovers from a failed first send on the next snapshot', async () => {
    let failFirst = true
    const port = {
      sent: [] as { chatId: string; card: object }[],
      updated: [] as { messageId: string; card: object }[],
      async send(chatId: string, input: { card: object }) {
        if (failFirst) {
          failFirst = false
          throw new Error('transport down')
        }
        this.sent.push({ chatId, card: input.card })
        return { messageId: `om_${this.sent.length}` }
      },
      async updateCard(messageId: string, card: object) {
        this.updated.push({ messageId, card })
      },
    }
    const failures: unknown[] = []
    const renderer = createTodoRenderer(port as never, (e) => { failures.push(e) })

    await renderer.handle('ses_1', 'oc_chat_1', [{ content: 'a', status: 'pending' }])
    expect(failures).toHaveLength(1)
    expect(port.sent).toHaveLength(0)

    await renderer.handle('ses_1', 'oc_chat_1', [{ content: 'a', status: 'completed' }])
    expect(port.sent).toHaveLength(1)
    expect(headerTitle(port.sent[0]!.card)).toContain('1/1')
  })
})
