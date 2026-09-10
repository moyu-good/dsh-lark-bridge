import { describe, expect, it, vi } from 'vitest'
import { mountChannel, fakeMessage } from './harness.ts'

describe('cross-surface mirror (W-11)', () => {
  it('mirrors an externally-initiated assistant turn into the bound chat', async () => {
    const harness = await mountChannel()
    // Bind a chat first (bridge drives this turn normally).
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    // The bind turn completes naturally (its turn/end clears the driving flag).
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const sentBefore = harness.fake.sent.length

    // A turn initiated OUTSIDE the bridge (web UI): no emitMessage preceded it.
    harness.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 9, message: { id: 'm-web-1', content: [{ type: 'text', text: '网页端算出的答案' }] } },
    })
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })

    await vi.waitFor(() => {
      expect(harness.fake.sent.slice(sentBefore).some(m => m.to !== '' && m.input.markdown?.includes('🌐【web】网页端算出的答案'))).toBe(true)
    }, { timeout: 20_000, interval: 50 })
    await harness.dispose()
  })

  it('does not mirror the bridge own turns', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'hello from feishu' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    // The bridge IS driving this session (flag set at followup): its assistant
    // stream must NOT be double-posted by the mirror.
    harness.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-bridge-1', content: [{ type: 'text', text: '桥的回答' }] } },
    })
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const mirrored = harness.fake.sent.filter(m => m.input.markdown?.includes('🌐【web】'))
    expect(mirrored).toHaveLength(0)
    await harness.dispose()
  })
})
