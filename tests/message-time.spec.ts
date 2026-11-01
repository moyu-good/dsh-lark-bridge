/**
 * 消息时间戳：引用那条和本条的都要给到模型。
 *
 * 为什么要盯这条：模型看不到任何时间，判断「刚才那个是不是没成」时只能去翻
 * 进程启动时间和文件修改时间，而这个判断一旦错，后面整段复查都白跑。时间戳
 * 必须按本地时区渲染并带偏移——飞书给的是毫秒时间戳，直接格式化在别的时区
 * 机器上会差 8 小时。
 *
 * 另一条同样的教训：同一个瞬间只说一遍。曾经「当前时间」和「消息发送时刻」
 * 各占一行，两个时间戳差三秒并排出现，模型还得猜哪个才是现在。
 */

import { describe, expect, it, vi } from 'vitest'
import { messageTimeStamp, quotedPrefix, sessionGapPhrase } from '../src/bridge.ts'
import type { NormalizedMessage } from '@larksuite/channel'
import { fakeMessage, mountChannel } from './harness.ts'

/** 模型实际读到的那段文字。 */
function textOf(message: { content: unknown }): string {
  const blocks = message.content as { type: string; text?: string }[]
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
}

/** 一条最简消息，只有引用渲染会读的字段。 */
function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_sender',
    content: '正文',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 0,
    ...overrides,
  } as NormalizedMessage
}

describe('messageTimeStamp', () => {
  it('按本地时区渲染到秒，并带上偏移', () => {
    // 2026-11-01 00:29:00 +08:00
    const stamp = messageTimeStamp(1793464140000)
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(\+08:00\)$/)
    expect(stamp).toContain(':29:00')
  })

  it('同一分钟里能分出先后', () => {
    // 这是"精确到秒"存在的理由：一分钟内常有两条相对独立的消息。
    const base = 1793464140000
    const earlier = messageTimeStamp(base)
    const later = messageTimeStamp(base + 1_500)
    expect(earlier).toBe('2026-11-01 00:29:00 (+08:00)')
    expect(later).toBe('2026-11-01 00:29:01 (+08:00)')
    expect(earlier).not.toBe(later)
  })

  it('本地时区的分钟数换算正确，不差小时', () => {
    // 断言"时刻"而不是写死字符串：换一台别的时区的机器跑，这条仍应成立。
    const at = 1793464140000
    const expected = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at)).replace(/,? /g, ' ')
    expect(messageTimeStamp(at)!.startsWith(expected.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3'))).toBe(true)
    expect(messageTimeStamp(at)).toContain(':29:')
  })

  it('没有时间就返回 undefined，不瞎编', () => {
    expect(messageTimeStamp(undefined)).toBeUndefined()
    expect(messageTimeStamp(0)).toBeUndefined()
    expect(messageTimeStamp(Number.NaN)).toBeUndefined()
    expect(messageTimeStamp(-1)).toBeUndefined()
  })
})

describe('quotedPrefix 的时间', () => {
  const quoted = message({ senderName: '陶佳明', content: '重启了好像没生效', createTime: 1793464140000 })

  it('开着时间时，表头带上引用那条的发送时间', () => {
    const block = quotedPrefix(quoted, 8000, true)
    expect(block.startsWith('[引用 · 陶佳明 · ')).toBe(true)
    expect(block).toContain('(+08:00)]')
    expect(block).toContain('重启了好像没生效')
  })

  it('关着时间时退回老样子，不留空括号', () => {
    const block = quotedPrefix(quoted, 8000, false)
    expect(block.startsWith('[引用 · 陶佳明]\n')).toBe(true)
    expect(block).not.toContain('(+08:00)')
  })

  it('引用没有时间戳时，表头不带空的时间位', () => {
    const block = quotedPrefix(message({ senderName: '陶佳明', createTime: 0 }), 8000, true)
    expect(block.startsWith('[引用 · 陶佳明]\n')).toBe(true)
  })

  it('超长引用照样截断，时间不受影响', () => {
    const block = quotedPrefix(message({ senderName: '陶佳明', content: 'x'.repeat(50), createTime: 1793464140000 }), 10, true)
    expect(block).toContain('已截断')
    expect(block).toContain('(+08:00)')
  })
})

describe('sessionGapPhrase 只给间隔', () => {
  const base = 1793464140000

  it('第一轮不知道间隔就什么都不说，不编造', () => {
    // 进程刚起，不知道这个会话上次何时说话——编一个「刚刚」会让模型
    // 把一段很长的空白当成刚发生的事。
    expect(sessionGapPhrase('sess-first', base)).toBe('')
  })

  it('第二轮给出距上一轮的间隔', () => {
    sessionGapPhrase('sess-gap', base)
    expect(sessionGapPhrase('sess-gap', base + 8 * 3_600_000)).toBe('8 小时前')
  })

  it('绝不再带一个绝对时间回来', () => {
    // 这正是要修的 bug：同一瞬间被说两遍，两行时间戳差三秒，模型得猜
    // 哪个才是「现在」。绝对时刻属于消息那行，这里只能有间隔。
    sessionGapPhrase('sess-no-clock', base)
    const phrase = sessionGapPhrase('sess-no-clock', base + 4 * 60_000)
    expect(phrase).toBe('4 分钟前')
    expect(phrase).not.toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(phrase).not.toContain('当前时间')
  })

  it('紧挨着说话时不啰嗦「刚刚」', () => {
    sessionGapPhrase('sess-tight', base)
    expect(sessionGapPhrase('sess-tight', base + 5_000)).toBe('')
  })

  it('间隔量的是上一轮，不是第一次', () => {
    sessionGapPhrase('sess-chain', base)
    sessionGapPhrase('sess-chain', base + 60_000)
    // 第三条距的是第二条的一小时，不是距第一条的一小时零一分钟。
    expect(sessionGapPhrase('sess-chain', base + 60_000 + 3_600_000)).toBe('1 小时前')
  })

  it('会话之间互不影响', () => {
    sessionGapPhrase('sess-a', base)
    expect(sessionGapPhrase('sess-b', base + 3_600_000)).toBe('')
  })
})

describe('模型看到的那条消息里只有一个时间', () => {
  it('第二轮起，时间行里带间隔，而不再多一行时间', async () => {
    // createTime 必须给真值：harness 的默认是 0，那样消息头会是
    // `1970-01-01 08:00:00`，而一个假的「有时间的消息」会让这条断言看
    // 似通过、实则什么都没测到——第一版正是这么漏过去的。
    const first = 1793464140000
    const harness = await mountChannel()
    try {
      const agent = () => harness.agents.created[0]!.agent
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_t1', content: '第一句', createTime: first }))
      await vi.waitFor(() => { expect(agent().followup).toHaveBeenCalledTimes(1) })
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_t2', content: '第二句', createTime: first + 4 * 60_000 }))
      await vi.waitFor(() => { expect(agent().followup).toHaveBeenCalledTimes(2) })

      const seen = agent().followup.mock.calls.map((call) => textOf(call[0]!))
      for (const text of seen) {
        // 一条消息里只许出现一处 `HH:MM:SS`——重复两份时间戳正是这次修的 bug。
        expect(text.match(/\d{2}:\d{2}:\d{2}/g) ?? []).toHaveLength(1)
        expect(text).not.toContain('当前时间')
        // 时间行确实在：不然「只有一处时间」可以靠整行消失来骗过。
        expect(text).toContain('(+08:00)')
      }
      // 开头这一行的形状：要么只有时刻，要么时刻＋间隔；绝不能两行时间。
      for (const text of seen) {
        expect(text.split('\n')[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(\+08:00\)( · 距上一轮 .+)?\]$/)
      }
      // 两轮在这个测试里几乎是连着跑的，间隔落在「刚刚」那一档，按设计
      // 刻意不写出来（消息已经自带时刻了，再加「刚刚」纯属噪音）。真正
      // 走到「有间隔」那一支的是下面那条用例——这里不能为了省事去伪造。
      expect(seen[1]).not.toContain('刚刚')
    } finally {
      await harness.dispose()
    }
  })

  it('隔了几分钟再说话，间隔就并在那一行里', async () => {
    // 上面那条摸不到「距上一轮」这条路：真实耗时永远是几百毫秒，落在「刚刚」
    // 那一档。这里直接把 Date.now 拨快四分钟，才真正走到拼接的那一刀。
    //
    // 用 spyOn 而不是 useFakeTimers：vitest 的假时钟换掉整套 timer，桥内部的
    // 异步等待会跟着停摆，实测反而让第二轮的 Date.now 没被替换。
    const harness = await mountChannel()
    const realNow = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow)
    try {
      const agent = () => harness.agents.created[0]!.agent
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_g1', content: '第一句', createTime: 1793464140000 }))
      await vi.waitFor(() => { expect(agent().followup).toHaveBeenCalledTimes(1) })

      spy.mockReturnValue(realNow + 4 * 60_000)
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_g2', content: '第二句', createTime: 1793464140000 }))
      await vi.waitFor(() => { expect(agent().followup).toHaveBeenCalledTimes(2) })

      const text = textOf(agent().followup.mock.calls[1]![0]!)
      const head = text.split('\n')[0]!
      // 一个时刻、一个间隔，同一行、同一个方括号里。
      expect(head).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(\+08:00\) · 距上一轮 4 分钟前\]$/)
      expect(text.match(/\d{2}:\d{2}:\d{2}/g) ?? []).toHaveLength(1)
    } finally {
      spy.mockRestore()
      await harness.dispose()
    }
  })
})
