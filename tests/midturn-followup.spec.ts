import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * P141（2026-09-14 owner report）：任务运行中再发一条命令，聊天面无反馈、感知为卡死。
 * 契约：agent.status==='running' 期间到达的消息 → 一条「已排队」回执；空闲时不发。
 */
describe('mid-turn followup (P141)', () => {
  it('sends a queued receipt when a message lands while the agent is running', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'task-a' }))
    await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1) })

    const agent = harness.agents.created[0]!.agent
    Object.defineProperty(agent, 'status', { value: 'running', configurable: true })
    const sent: Array<{ to: string; input: Record<string, unknown> }> = harness.fake.sent
    const before = sent.length

    await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
    await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => {
      const receipts = sent.slice(before).filter(entry => String((entry.input as { markdown?: string }).markdown ?? '').includes('已排队'))
      if (receipts.length < 1) throw new Error('queued receipt not sent yet')
    }, { timeout: 5_000, interval: 50 })
    await harness.dispose()
  })

  it('does not send the receipt while the agent is idle', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'task-a' }))
    await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1) })
    const agent = harness.agents.created[0]!.agent
    Object.defineProperty(agent, 'status', { value: 'idle', configurable: true })
    const sent: Array<{ to: string; input: Record<string, unknown> }> = harness.fake.sent
    const before = sent.length

    await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
    await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalledTimes(2) })
    const receipts = sent.slice(before).filter(entry => String((entry.input as { markdown?: string }).markdown ?? '').includes('已排队'))
    expect(receipts.length).toBe(0)
    await harness.dispose()
  })
})

type sent_list = Array<{ to: string; input: Record<string, unknown> }>
