/**
 * 用户「引用一条消息」再发话时，被引用的那条要一起进模型。
 *
 * 2026-10-30 的现场：用户引用了一条消息说「就像刚刚这种情况」，而桥只把
 * `parent_id` 丢了——模型收到的是孤零零的五个字，只能猜「这种情况」指什么，
 * 人却以为它当然看得见。飞书的引用不在正文里，得拿 `im.v1.message.get` 另取。
 */

import { describe, expect, it, vi } from 'vitest'
import { quotedPrefix } from '../src/bridge.ts'
import type { HostUserMessage } from '../src/host.ts'
import { fakeMessage, mountChannel } from './harness.ts'

/** 入站处理是 fire-and-forget，等它把消息交给模型。 */
const PATIENCE = { timeout: 5_000, interval: 20 } as const

/** 一条 user message 的纯文本，按内容块拼起来。 */
function textOf(message: HostUserMessage): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

describe('quotedPrefix', () => {
  it('带发送者名字，并围出边界', () => {
    const text = quotedPrefix(fakeMessage({ content: '把第三段改成被动语态', senderName: '张三' }))
    expect(text).toContain('[引用 · 张三]')
    expect(text).toContain('把第三段改成被动语态')
    expect(text).toContain('[/引用]')
  })

  it('没东西可引用时返回空串', () => {
    expect(quotedPrefix(undefined)).toBe('')
  })

  it('长引用截断，不让它挤掉真正的问题', () => {
    const text = quotedPrefix(fakeMessage({ content: 'x'.repeat(20_000) }))
    expect(text.length).toBeLessThan(8_000)
    expect(text).toContain('已截断')
    // The budget is the deployment's: a tighter one cuts sooner.
    const tight = quotedPrefix(fakeMessage({ content: 'x'.repeat(500) }), 100)
    expect(tight).toContain('已截断')
    expect(tight.length).toBeLessThan(200)
  })
})

describe('引用回复', () => {
  it('被引用的正文进到模型看到的那条消息里', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.quotedById.set('om_quoted_1', fakeMessage({
        messageId: 'om_quoted_1',
        senderName: '张三',
        content: '把第三段改成被动语态',
      }))
      await harness.fake.emitMessage(fakeMessage({
        messageId: 'om_reply_1',
        replyToMessageId: 'om_quoted_1',
        content: '就像刚刚这种情况，改一下',
      }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalled()
      }, PATIENCE)
      const text = textOf(harness.agents.created[0]!.agent.followup.mock.calls[0]![0]!)
      expect(text).toContain('把第三段改成被动语态')
      expect(text).toContain('就像刚刚这种情况，改一下')
      // 引用在前，用户这次说的话在后：顺序反了模型会先读到结论再去猜上文。
      expect(text.indexOf('把第三段改成被动语态')).toBeLessThan(text.indexOf('就像刚刚这种情况'))
    } finally {
      await harness.dispose()
    }
  })

  it('取不到被引用那条时，用户自己说的话照样送达', async () => {
    const harness = await mountChannel()
    try {
      await harness.fake.emitMessage(fakeMessage({
        messageId: 'om_reply_2',
        replyToMessageId: 'om_gone',
        content: '这个再改改',
      }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalled()
      }, PATIENCE)
      const text = textOf(harness.agents.created[0]!.agent.followup.mock.calls[0]![0]!)
      expect(text).toContain('这个再改改')
      expect(text).not.toContain('[引用')
    } finally {
      await harness.dispose()
    }
  })

  it('话题群里 parent_id 指向话题根，不当引用', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.quotedById.set('om_topic_root', fakeMessage({
        messageId: 'om_topic_root',
        content: '（话题根消息）',
      }))
      await harness.fake.emitMessage(fakeMessage({
        messageId: 'om_topic_reply',
        replyToMessageId: 'om_topic_root',
        threadId: 'om_topic_root',
        content: '这条是话题里的普通发言',
      }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalled()
      }, PATIENCE)
      const text = textOf(harness.agents.created[0]!.agent.followup.mock.calls[0]![0]!)
      expect(text).not.toContain('（话题根消息）')
      expect(harness.fake.fetched).not.toContain('om_topic_root')
    } finally {
      await harness.dispose()
    }
  })
})
