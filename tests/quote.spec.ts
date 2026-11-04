/**
 * 用户「引用一条消息」再发话时，被引用的那条要一起进模型。
 *
 * 2026-10-30 的现场：用户引用了一条消息说「就像刚刚这种情况」，而桥只把
 * `parent_id` 丢了——模型收到的是孤零零的五个字，只能猜「这种情况」指什么，
 * 人却以为它当然看得见。飞书的引用不在正文里，得拿 `im.v1.message.get` 另取。
 */

import { describe, expect, it, vi } from 'vitest'
import { cardText, quotedPrefix } from '../src/bridge.ts'
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

describe('cardText', () => {
  it('2.0 卡片：标题在前，正文按顺序', () => {
    const text = cardText({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '面板标题' } },
      body: { elements: [{ tag: 'markdown', content: '第一段' }, { tag: 'markdown', content: '第二段' }] },
    })
    expect(text).toContain('面板标题')
    expect(text.indexOf('面板标题')).toBeLessThan(text.indexOf('第一段'))
    expect(text.indexOf('第一段')).toBeLessThan(text.indexOf('第二段'))
  })

  it('1.0 卡片：title + elements 也读得出来', () => {
    const text = cardText({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '旧版卡片' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '旧版正文' } }],
    })
    expect(text).toContain('旧版卡片')
    expect(text).toContain('旧版正文')
  })

  it('没有任何文字时返回空串', () => {
    expect(cardText({ schema: '2.0', body: { elements: [] } })).toBe('')
    expect(cardText(null)).toBe('')
  })

  it('过长时截断并标注', () => {
    const text = cardText({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x'.repeat(500) }] } }, 100)
    expect(text).toContain('已截断')
    expect(text.length).toBeLessThan(200)
  })
})

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

/**
 * 引用一张卡片。
 *
 * 2026-11-04 的现场：用户引用了一条面板卡说「这个再改改」，模型只收到
 * `[interactive card]` 这个占位词——卡片正文根本没读到。
 *
 * 根因不在飞书：`im.v1.message.get` 有个 `card_msg_content_type` 参数，传
 * `user_card_content` 才返回**未降级**的原始卡片 JSON；不传时 2.0 卡片会被
 * 降级成 v1 占位。`@larksuite/channel` 的 `fetchRawMessage` 默认就带这个参数，
 * 而 `fetchMessage` 没带，桥一直用的是后者。
 */
describe('引用卡片', () => {
  /** 一张最小的 2.0 卡片，正文两段。 */
  const cardJson = JSON.stringify({
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '多代理执行面板' } },
    body: {
      elements: [
        { tag: 'markdown', content: '正在跑：重写 README' },
        { tag: 'markdown', content: '已完成：构建通过' },
      ],
    },
  })

  it('读得到卡片正文，而不是 [interactive card]', async () => {
    const harness = await mountChannel()
    try {
      // 归一化后的结果就是 SDK 读到的那种降级占位。
      harness.fake.quotedById.set('om_card_1', fakeMessage({
        messageId: 'om_card_1',
        senderName: 'DSH 控制台',
        content: '[interactive card]',
      }))
      // 原始 JSON 里才有真内容。
      harness.fake.rawById.set('om_card_1', {
        message_id: 'om_card_1',
        msg_type: 'interactive',
        body: { content: cardJson },
      })
      await harness.fake.emitMessage(fakeMessage({
        messageId: 'om_reply_card_1',
        replyToMessageId: 'om_card_1',
        content: '这个再改改',
      }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalled()
      }, PATIENCE)
      const text = textOf(harness.agents.created[0]!.agent.followup.mock.calls[0]![0]!)
      expect(text).toContain('多代理执行面板')
      expect(text).toContain('正在跑：重写 README')
      expect(text).toContain('已完成：构建通过')
      // 占位词不能留在模型看到的内容里。
      expect(text).not.toContain('[interactive card]')
    } finally {
      await harness.dispose()
    }
  })

  it('普通文本不额外发请求', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.quotedById.set('om_text_1', fakeMessage({
        messageId: 'om_text_1',
        senderName: '张三',
        content: '把第三段改成被动语态',
      }))
      await harness.fake.emitMessage(fakeMessage({
        messageId: 'om_reply_text_1',
        replyToMessageId: 'om_text_1',
        content: '好的',
      }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalled()
      }, PATIENCE)
      // 已经有正文了，补读是纯浪费：一次请求都不该多发。
      expect(harness.fake.fetchedRaw).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('补读失败时退回占位词，消息照样送达', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.quotedById.set('om_card_2', fakeMessage({
        messageId: 'om_card_2',
        content: '[interactive card]',
      }))
      // 故意不往 rawById 里放东西：fetchRawMessage 会返回空数组。
      await harness.fake.emitMessage(fakeMessage({
        messageId: 'om_reply_card_2',
        replyToMessageId: 'om_card_2',
        content: '这个再改改',
      }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalled()
      }, PATIENCE)
      const text = textOf(harness.agents.created[0]!.agent.followup.mock.calls[0]![0]!)
      // 用户自己说的话一个字都不能少。
      expect(text).toContain('这个再改改')
      expect(text).toContain('[引用')
    } finally {
      await harness.dispose()
    }
  })
})
