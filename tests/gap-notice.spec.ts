/**
 * 断线恢复后的补偿提示：先核实再说话。
 *
 * 传输层没有游标，断线窗口里的入站消息永久丢失。原来一断线就发一条
 * "可能丢了消息"的通用提示，对已经自己察觉到断线的用户就是噪音
 * （2026-11-04 运营方质疑）。现在重连后先按窗口拉一次飞书历史，
 * 只有真的存在 user 消息才点名说丢了几条；没有就静默；拉不到才兜底。
 */

import { describe, expect, it, vi } from 'vitest'
import type { FetchImpl } from '../src/sync/feishu-cloud.ts'
import { fakeMessage, mountChannel } from './harness.ts'

/** 入站处理和补偿提示都是 fire-and-forget，等它们落定。 */
const PATIENCE = { timeout: 5_000, interval: 20 } as const

const T0 = 1_790_000_000_000

/** 一条固定结构的 HTTP 应答，形状对齐 `FeishuCloud` 用的 fetch 接缝。 */
const reply = (body: Record<string, unknown>) => ({
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/** 只回答 token 和消息历史两个端点；其它请求一律报错，免得掩盖真实调用。 */
function historyFetch(handler: (url: string) => Record<string, unknown>): FetchImpl {
  return async (url) => {
    if (url.includes('/auth/v3/tenant_access_token/')) {
      return reply({ code: 0, tenant_access_token: 'test-token', expire: 7200 })
    }
    if (url.includes('/im/v1/messages')) return reply(handler(url))
    throw new Error(`unexpected fetch: ${url}`)
  }
}

const sentLines = (sent: { input: unknown }[]): string[] =>
  sent.map(entry => (entry.input as { markdown?: string }).markdown ?? '')

/** 建好一个绑定群，并把时钟固定下来驱动一次断线。 */
async function bindAndGap(
  gapMs: number,
  fetchImpl: FetchImpl,
  config: Parameters<typeof mountChannel>[0] = {},
) {
  const harness = await mountChannel(config, { fetchImpl })
  await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_gap', content: 'hi' }))
  await vi.waitFor(() => { expect(harness.agents.created.length).toBeGreaterThan(0) }, PATIENCE)
  const now = vi.spyOn(Date, 'now').mockReturnValue(T0)
  harness.fake.emitConnectionState('reconnecting')
  now.mockReturnValue(T0 + gapMs)
  harness.fake.emitConnectionState('reconnected')
  return { harness, restore: () => now.mockRestore() }
}

describe('断线恢复提示按事实说话', () => {
  it('窗口里有用户消息时，点名丢了几条', async () => {
    const fetchImpl = historyFetch(() => ({
      code: 0,
      data: {
        has_more: false,
        items: [
          { message_id: 'om_u1', msg_type: 'text', create_time: String(T0 + 60_000), sender: { sender_type: 'user' } },
          { message_id: 'om_a1', msg_type: 'text', create_time: String(T0 + 61_000), sender: { sender_type: 'app' } },
          { message_id: 'om_u2', msg_type: 'text', create_time: String(T0 + 62_000), sender: { sender_type: 'user' } },
        ],
      },
    }))
    const { harness, restore } = await bindAndGap(5 * 60_000, fetchImpl)
    try {
      await vi.waitFor(() => {
        const lines = sentLines(harness.fake.sent)
        if (!lines.some(line => line.includes('2 条消息没送到'))) {
          throw new Error(`还没收到精确提示：${JSON.stringify(lines)}`)
        }
      }, PATIENCE)
    } finally {
      restore()
      await harness.dispose()
    }
  })

  it('窗口里没有用户消息时保持沉默', async () => {
    const fetchImpl = historyFetch(() => ({ code: 0, data: { has_more: false, items: [] } }))
    const { harness, restore } = await bindAndGap(5 * 60_000, fetchImpl)
    try {
      // 给异步拉取留出时间；这段时间里不该出现任何补偿提示。
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(sentLines(harness.fake.sent).some(line => line.includes('连接中断了约'))).toBe(false)
      expect(sentLines(harness.fake.sent).some(line => line.includes('没送到'))).toBe(false)
    } finally {
      restore()
      await harness.dispose()
    }
  })

  it('历史拉不到时退回通用提示，不漏报', async () => {
    const fetchImpl = historyFetch(() => ({ code: 99991672, msg: 'no permission' }))
    const { harness, restore } = await bindAndGap(5 * 60_000, fetchImpl)
    try {
      await vi.waitFor(() => {
        const lines = sentLines(harness.fake.sent)
        if (!lines.some(line => line.includes('连接中断了约'))) {
          throw new Error(`还没收到兜底提示：${JSON.stringify(lines)}`)
        }
      }, PATIENCE)
    } finally {
      restore()
      await harness.dispose()
    }
  })

  it('短于阈值的中断不打扰', async () => {
    const fetchImpl = historyFetch(() => ({
      code: 0,
      data: { has_more: false, items: [{ message_id: 'om_u1', msg_type: 'text', create_time: String(T0 + 1_000), sender: { sender_type: 'user' } }] },
    }))
    const { harness, restore } = await bindAndGap(10_000, fetchImpl)
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(sentLines(harness.fake.sent).some(line => line.includes('连接中断了约'))).toBe(false)
      expect(sentLines(harness.fake.sent).some(line => line.includes('没送到'))).toBe(false)
    } finally {
      restore()
      await harness.dispose()
    }
  })

  it('gapNoticeMinMs = 0 时完全关闭', async () => {
    const fetchImpl = historyFetch(() => ({
      code: 0,
      data: { has_more: false, items: [{ message_id: 'om_u1', msg_type: 'text', create_time: String(T0 + 1_000), sender: { sender_type: 'user' } }] },
    }))
    const { harness, restore } = await bindAndGap(60 * 60_000, fetchImpl, { gapNoticeMinMs: 0 })
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(sentLines(harness.fake.sent).some(line => line.includes('没送到'))).toBe(false)
      expect(sentLines(harness.fake.sent).some(line => line.includes('连接中断了约'))).toBe(false)
    } finally {
      restore()
      await harness.dispose()
    }
  })
})
