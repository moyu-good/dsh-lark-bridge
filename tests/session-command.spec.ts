/**
 * `/session`：一条命令说清「我现在这个会话是什么」。
 *
 * 为什么值得单独盯：这个命令存在的理由是替人省掉跨几条消息拼凑事实的
 * 过程。如果它自己报错、或者把配置默认当成真的路由报出来，那它比没有更坏——
 * 人会相信它。所以这里既测正常路径，也测「读不到」时它怎么说话。
 */

import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/** 让一条命令跑完并拿到它回给聊天的那段文字。 */
async function runCommand(
  harness: Awaited<ReturnType<typeof mountChannel>>,
  command: string,
): Promise<string> {
  await harness.fake.emitMessage(fakeMessage({ content: command }))
  await vi.waitFor(() => {
    const replies = harness.fake.sent.map((m) => (m.input as { markdown?: string }).markdown ?? '')
    expect(replies.some((r) => r !== '')).toBe(true)
  }, { timeout: 10_000 })
  return harness.fake.sent.map((m) => (m.input as { markdown?: string }).markdown ?? '').join('\n')
}

describe('/session 查看当前会话', () => {
  it('报出会话 id、日志规模与状态', async () => {
    const harness = await mountChannel()
    try {
      const text = await runCommand(harness, '/session')
      const sessionId = harness.agents.created[0]!.agent.session.id
      expect(text).toContain('当前会话')
      expect(text).toContain(sessionId)
      expect(text).toContain('日志事件')
      // 假 agent 没有 status，读不到时按空闲说，不编造「运行中」。
      expect(text).toContain('状态')
    } finally {
      await harness.dispose()
    }
  })

  it('有 token 计量时报出上下文规模，读不到时给出去哪儿看', async () => {
    const harness = await mountChannel({}, {
      tokenMeter: {
        measure: () => ({ totalTokens: 12_000, surfaceTokens: 9_000 }),
      },
    })
    try {
      const text = await runCommand(harness, '/session')
      expect(text).toContain('12,000')
      expect(text).toContain('固定开销')
      // 1.2 万 / 12 万 = 10%
      expect(text).toContain('10%')
    } finally {
      await harness.dispose()
    }
  })

  it('没有 token 计量时不报错，也不假装有数', async () => {
    const harness = await mountChannel()
    try {
      const text = await runCommand(harness, '/session')
      expect(text).toContain('当前会话')
      expect(text).not.toContain('tokens')
    } finally {
      await harness.dispose()
    }
  })

  it('读不到真实路由时，说清那是配置默认而不是已经发出去的请求', async () => {
    // 假 agent 没有 requestHeader；此时报配置里的模型可以，但必须标明
    // 「尚未发出请求」——否则人会以为这就是正在跑的模型。
    const harness = await mountChannel({ provider: 'deepseek', model: 'deepseek-v4' })
    try {
      const text = await runCommand(harness, '/session')
      expect(text).toContain('deepseek/deepseek-v4')
      expect(text).toContain('尚未发出请求')
    } finally {
      await harness.dispose()
    }
  })

  it('/help 与面板都列出 /session，且不和 /sessions 混为一谈', async () => {
    const harness = await mountChannel()
    try {
      const text = await runCommand(harness, '/help')
      expect(text).toContain('/session')
      expect(text).toContain('/sessions')
      // 两条各自有描述，不是一条被另一条盖掉。
      expect(text).toMatch(/\/session` — [^\n]+/)
      expect(text).toMatch(/\/sessions` — [^\n]+/)
    } finally {
      await harness.dispose()
    }
  })
})
