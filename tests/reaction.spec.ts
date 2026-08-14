import { describe, expect, it, vi } from 'vitest'
import { createReactionTracker, DEFAULT_REACTION_PRESET, QUIET_REACTION_PRESET } from '../src/reaction.ts'

/** A fake reaction port recording calls. */
function fakePort() {
  const calls: { op: 'add' | 'remove'; messageId: string; emoji?: string; reactionId?: string }[] = []
  let nextId = 1
  const port = {
    calls,
    async addReaction(messageId: string, emojiType: string): Promise<string> {
      const id = `rid-${nextId++}`
      calls.push({ op: 'add', messageId, emoji: emojiType })
      return id
    },
    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      calls.push({ op: 'remove', messageId, reactionId })
    },
  }
  return port
}

const addCalls = (calls: { op: 'add' | 'remove'; messageId: string; emoji?: string; reactionId?: string }[]) =>
  calls.filter(c => c.op === 'add').map(c => c.emoji)
const removeCalls = (calls: { op: 'add' | 'remove'; messageId: string; emoji?: string; reactionId?: string }[]) =>
  calls.filter(c => c.op === 'remove').map(c => c.reactionId)

describe('createReactionTracker', () => {
  it('walks ack → working → done with one reaction at a time', async () => {
    const port = fakePort()
    const t = createReactionTracker(port)
    await t.ack('m1')
    await t.working('m1')
    await t.done('m1')
    expect(addCalls(port.calls)).toEqual(['OK', 'THINKING', 'DONE'])
    // each transition removes the previous before adding the next
    expect(removeCalls(port.calls)).toEqual(['rid-1', 'rid-2'])
  })

  it('walks ack → working → failure on error', async () => {
    const port = fakePort()
    const t = createReactionTracker(port)
    await t.ack('m1')
    await t.working('m1')
    await t.fail('m1')
    expect(addCalls(port.calls)).toEqual(['OK', 'THINKING', 'ERROR'])
  })

  it('ignores transitions after settle', async () => {
    const port = fakePort()
    const t = createReactionTracker(port)
    await t.done('m1')
    await t.working('m1')
    await t.ack('m1')
    expect(addCalls(port.calls)).toEqual(['DONE'])
  })

  it('ack only once for repeated messages to the same id', async () => {
    const port = fakePort()
    const t = createReactionTracker(port)
    await t.ack('m1')
    await t.ack('m1')
    expect(addCalls(port.calls)).toEqual(['OK'])
  })

  it('quiet preset skips working and clears the terminal reaction', async () => {
    vi.useFakeTimers()
    try {
      const port = fakePort()
      const t = createReactionTracker(port, QUIET_REACTION_PRESET)
      await t.ack('m1')
      await t.done('m1')
      expect(addCalls(port.calls)).toEqual(['OK', 'DONE'])
      // clearWhenDone schedules removal of the success emoji
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
      expect(removeCalls(port.calls)).toContain('rid-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports add failures through onError without throwing', async () => {
    const onError = vi.fn()
    const port = {
      async addReaction(): Promise<string> { throw new Error('no permission') },
      async removeReaction(): Promise<void> {},
    }
    const t = createReactionTracker(port, DEFAULT_REACTION_PRESET, onError)
    await t.ack('m1')
    await t.working('m1')
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('forget clears tracked state', async () => {
    const port = fakePort()
    const t = createReactionTracker(port)
    await t.ack('m1')
    t.forget('m1')
    await t.done('m1')
    expect(addCalls(port.calls)).toEqual(['OK', 'DONE'])
  })

  it('skips empty emojis in the preset', async () => {
    const port = fakePort()
    const t = createReactionTracker(port, { ack: '', working: 'THINKING', success: '', failure: '', clearWhenDone: false })
    await t.ack('m1')
    await t.working('m1')
    await t.done('m1')
    expect(addCalls(port.calls)).toEqual(['THINKING'])
  })
})
