/**
 * 压缩/修剪提示要说得清"修剪了什么"。
 *
 * `compaction/*` 事件只带 `shadowedSeqs`（会话日志里的序号），桥接按
 * `session.eventAt` 把它们读回来归类。这条链路错了，聊天里就退化成
 * 「已修剪 1 条旧消息」——用户仍然不知道那一条是什么（2026-11-05 的反馈）。
 */

import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

// 入站处理是 fire-and-forget，agent 与绑定在 emitMessage 返回之后才落地；
// 机器有负载时这一步能慢到几秒，给足余量再断言。
const PATIENCE = { timeout: 20_000, interval: 50 } as const

const said = (sent: { input: unknown }[]): string[] =>
  sent.map(entry => (entry.input as { markdown?: string }).markdown ?? '')

/** 建一个绑定会话，并把它的会话日志塞成测试给的样子。 */
async function bindChat(
  log: readonly { type: string; data?: unknown }[],
  services: Parameters<typeof mountChannel>[0] = {},
) {
  const harness = await mountChannel({}, services)
  await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_cmp', content: 'hi' }))
  await vi.waitFor(() => { expect(harness.agents.created.length).toBe(1) }, PATIENCE)
  const session = harness.agents.created[0]!.agent.session
  const events = harness.agents.sessionEvents.get(session.id)!
  events.push(...log)
  return { harness, session }
}

describe('压缩提示点名被折叠的记录', () => {
  it('修剪时说明是哪几类消息', async () => {
    const { harness, session } = await bindChat([
      { type: 'user/message', data: { source: { kind: 'user' } } },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: {} },
    ])
    try {
      harness.ctx.emit('session/event', session, {
        type: 'compaction/prune',
        data: {
          shadowedRange: { start: 0, end: 2 },
          shadowedSeqs: [0, 1, 2],
          shadowedTokenCount: 2_301,
        },
      })
      await vi.waitFor(() => {
        const lines = said(harness.fake.sent)
        const line = lines.find(text => text.includes('已修剪'))
        if (line === undefined) throw new Error(`还没收到修剪提示：${JSON.stringify(lines)}`)
        expect(line).toContain('1 条你的提问')
        expect(line).toContain('1 条工具输出')
        expect(line).toContain('1 条我的回复')
        expect(line).toContain('2,301')
      }, PATIENCE)
    } finally {
      await harness.dispose()
    }
  })

  it('压缩时不再把摘要正文贴进聊天', async () => {
    const { harness, session } = await bindChat([
      { type: 'user/message', data: { source: { kind: 'user' } } },
      { type: 'tool/result', data: {} },
    ])
    try {
      harness.ctx.emit('session/event', session, {
        type: 'compaction/summary',
        data: {
          compactionId: 'c1',
          summary: [{ type: 'text', text: '##### Primary Request and Intent\n- Chat bound to `D:\\Desktop`' }],
          shadowedSeqs: [0, 1],
          shadowedTokenCount: 49_212,
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      })
      await vi.waitFor(() => {
        const lines = said(harness.fake.sent)
        const line = lines.find(text => text.includes('压缩完成'))
        if (line === undefined) throw new Error(`还没收到压缩提示：${JSON.stringify(lines)}`)
        expect(line).toContain('2 条较早消息')
        expect(line).toContain('1 条你的提问')
        expect(line).toContain('49,212')
        // 摘要原文（英文标题、路径）不该出现在聊天里。
        expect(line).not.toContain('Primary Request')
        expect(line).not.toContain('Chat bound to')
      }, PATIENCE)
    } finally {
      await harness.dispose()
    }
  })

  it('日志里读不到的序号记为其它记录，不猜', async () => {
    const { harness, session } = await bindChat([{ type: 'user/message', data: { source: { kind: 'user' } } }])
    try {
      harness.ctx.emit('session/event', session, {
        type: 'compaction/prune',
        data: {
          shadowedRange: { start: 0, end: 9 },
          // 1 和 9 超出日志末尾，只能算其它。
          shadowedSeqs: [0, 1, 9],
          shadowedTokenCount: 100,
        },
      })
      await vi.waitFor(() => {
        const line = said(harness.fake.sent).find(text => text.includes('已修剪'))
        if (line === undefined) throw new Error('还没收到修剪提示')
        expect(line).toContain('1 条你的提问')
        expect(line).toContain('2 条其它记录')
      }, PATIENCE)
    } finally {
      await harness.dispose()
    }
  })
})

describe('压缩提示报出压后占用', () => {
  it('注入计量服务后，提示带上压后总量与剩余可用', async () => {
    let measured = 0
    const { harness, session } = await bindChat(
      [{ type: 'user/message', data: { source: { kind: 'user' } } }],
      {
        tokenMeter: {
          measure: () => {
            measured += 1
            return { totalTokens: 62_340, surfaceTokens: 10_000 }
          },
        },
      },
    )
    try {
      harness.ctx.emit('session/event', session, {
        type: 'compaction/summary',
        data: {
          compactionId: 'c1',
          summary: [],
          shadowedSeqs: [0],
          shadowedTokenCount: 48_810,
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      })
      await vi.waitFor(() => {
        const line = said(harness.fake.sent).find(text => text.includes('压缩完成'))
        if (line === undefined) throw new Error('还没收到压缩提示')
        expect(measured).toBe(1)
        expect(line).toContain('压缩后占用约 62,340 tokens')
      }, PATIENCE)
    } finally {
      await harness.dispose()
    }
  })
})
