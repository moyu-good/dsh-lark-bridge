import { describe, expect, it, vi } from 'vitest'
import { mountChannel, fakeMessage } from './harness.ts'

/**
 * One answer, one bubble — whichever surface produced it.
 *
 * History, because this is the second time this contract has been broken: a
 * `🌐【web】` cross-surface mirror was added on the premise that turns initiated
 * outside the bridge "never passed the Feishu pipeline". They already did — the
 * renderer handles every event of a bound session, whoever drove the turn — so
 * every external turn was posted twice: the normal answer, and the same text
 * 0.1s later behind a `🌐【web】` prefix (7 such pairs in one 150-message window
 * of production traffic). The mirror also carried a dead guard: it deleted the
 * driving flag at `turn/end` *before* reading it, so that check could never fail.
 */
describe('cross-surface delivery', () => {
  it('delivers an externally-initiated answer exactly once', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    // The bind turn completes naturally (its turn/end closes the bridge's turn).
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const sentBefore = harness.fake.sent.length

    // A turn initiated OUTSIDE the bridge (web UI): no emitMessage preceded it.
    harness.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 9, message: { id: 'm-web-1', content: [{ type: 'text', text: '网页端算出的答案' }] } },
    })
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })

    await vi.waitFor(() => {
      const delivered = harness.fake.sent.slice(sentBefore).filter(m => m.input.markdown?.includes('网页端算出的答案'))
      expect(delivered.length).toBeGreaterThan(0)
    }, { timeout: 20_000, interval: 50 })

    const delivered = harness.fake.sent.slice(sentBefore).filter(m => m.input.markdown?.includes('网页端算出的答案'))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.input.markdown).not.toContain('🌐【web】')
    await harness.dispose()
  })

  it('does not double-post a turn the bridge drove itself', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'hello from feishu' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const sentBefore = harness.fake.sent.length
    harness.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-bridge-1', content: [{ type: 'text', text: '桥的回答' }] } },
    })
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    await vi.waitFor(() => {
      expect(harness.fake.sent.slice(sentBefore).some(m => m.input.markdown?.includes('桥的回答'))).toBe(true)
    }, { timeout: 20_000, interval: 50 })
    const delivered = harness.fake.sent.slice(sentBefore).filter(m => m.input.markdown?.includes('桥的回答'))
    expect(delivered).toHaveLength(1)
    await harness.dispose()
  })
})
