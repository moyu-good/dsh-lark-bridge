import { describe, expect, it, vi } from 'vitest'
import { mountChannel, fakeMessage } from './harness.ts'

/**
 * The multi-agent panel must actually follow a child's work.
 *
 * 0.1.5 gives every child its OWN session: the driver mints the session id that
 * `subagent/catalog` reports as `childId`, and each child writes its own
 * `session.v3.jsonl.zstd` (verified on a live install: 20/20 catalog ids had a
 * matching session directory). So a child's events arrive under a session id
 * that has NO chat binding — resolving the panel row by "the session the child
 * shares with its spawner" (true on older hosts, and what the first cut of this
 * panel assumed) matches nothing, and the card freezes at「进行中 · 0秒」.
 */
describe('multi-agent panel follows a child session', () => {
  it('shows what the child is doing, from the child session\'s own events', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const sentBefore = harness.fake.sent.length

    // The spawning turn records the child on the PARENT session (durable catalog).
    harness.ctx.emit('session/event', session, {
      type: 'subagent/catalog',
      data: { version: 0, childId: 'child-9', childCreatedAt: Date.now(), mode: 'one-shot', label: '纪四复核' },
    })

    // The child then works — in ITS OWN session, which has no chat binding.
    const childSession = { id: 'child-9' }
    harness.ctx.emit('session/event', childSession, {
      type: 'tool/call',
      data: { turn: 1, step: 1, name: 'read_file', arguments: { path: '内容/storylets/v1/纪四_E4-047.yaml' } },
    })

    // The panel is one card, UPDATED in place: the first render goes through
    // `send`, every later refresh through `updateCard` — so a test that only
    // reads `sent` sees the frozen first frame and concludes nothing happened.
    const cardBodies = (): string => [
      ...harness.fake.sent.slice(sentBefore).map(m => m.input.card).filter(Boolean),
      ...harness.fake.updated.map(u => u.card),
    ].map(c => JSON.stringify(c)).join('\n')

    await vi.waitFor(() => {
      expect(cardBodies()).toContain('read_file')
    }, { timeout: 20_000, interval: 100 })
    const body = cardBodies()
    expect(body).toContain('纪四复核')
    expect(body).toContain('纪四_E4-047.yaml')
    await harness.dispose()
  })

  it('never invents a row for a session that was not catalogued', async () => {
    // Attribution must be exact, not "there is only one child so it must be
    // him": an unknown session id proposes nothing, so a child's work can never
    // be filed under another child's name.
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const sentBefore = harness.fake.sent.length
    harness.ctx.emit('session/event', { id: 'ghost-session' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, name: 'read_file', arguments: { path: '不该出现的路径.md' } },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(harness.fake.sent.slice(sentBefore).filter(m => m.input.card !== undefined)).toHaveLength(0)
    await harness.dispose()
  })
})
