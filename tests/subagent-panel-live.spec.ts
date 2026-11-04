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


/**
 * A delegation has to be visible in the chat, not only in the panel card.
 *
 * The panel is a card the reader has to find; the chat is where the
 * question was asked. A child that is announced only in the panel leaves
 * the chat saying nothing happened until the answer arrives — which reads
 * as a stall, and the reader starts asking what happened.
 */
describe('a delegation is announced in the chat', () => {
  it('says what was delegated, when the delegation happens', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const sentBefore = harness.fake.sent.length

    harness.ctx.emit('session/event', session, {
      type: 'subagent/catalog',
      data: { version: 0, childId: 'child-1', childCreatedAt: Date.now(), mode: 'one-shot', label: '书评检索' },
    })

    await vi.waitFor(() => {
      const lines = harness.fake.sent.slice(sentBefore)
        .map((m) => (m.input as { markdown?: string }).markdown ?? '')
      expect(lines.some((l) => l.includes('派出子代理') && l.includes('书评检索'))).toBe(true)
    }, { timeout: 20_000, interval: 100 })
    await harness.dispose()
  })

  it('keeps the child\'s progress in the panel instead of the chat', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const sentBefore = harness.fake.sent.length

    harness.ctx.emit('session/event', session, {
      type: 'subagent/catalog',
      data: { version: 0, childId: 'child-2', childCreatedAt: Date.now(), mode: 'one-shot', label: '架构设计' },
    })
    const childSession = { id: 'child-2' }
    harness.ctx.emit('session/event', childSession, {
      type: 'tool/call',
      data: { turn: 1, step: 1, name: 'read', arguments: { path: 'docs/设计.md' } },
    })

    // A child's step now REDRAWS THE PANEL and says nothing in the chat.
    // It used to also post `🔀 架构设计 · read docs/设计.md`, on a PER-CHILD
    // 30s window — so six concurrent children could put twelve messages a
    // minute into a chat the panel was already reporting. Give the write a
    // moment to land, then assert the chat stayed clean and the panel carries
    // the step.
    await vi.waitFor(() => {
      const card = JSON.stringify(harness.fake.updated.at(-1)?.card ?? harness.fake.sent.at(-1)?.input)
      expect(card).toContain('docs/设计.md')
    }, { timeout: 20_000, interval: 100 })

    const lines = harness.fake.sent.slice(sentBefore)
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
    expect(lines.some((l) => l.includes('🔀') && l.includes('docs/设计.md'))).toBe(false)
    await harness.dispose()
  })

  it('stays silent when the announcement is switched off', async () => {
    const harness = await mountChannel({ announceSubagents: false })
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const sentBefore = harness.fake.sent.length

    harness.ctx.emit('session/event', session, {
      type: 'subagent/catalog',
      data: { version: 0, childId: 'child-3', childCreatedAt: Date.now(), mode: 'one-shot', label: '不announce' },
    })

    await new Promise((r) => setTimeout(r, 300))
    const lines = harness.fake.sent.slice(sentBefore)
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
    expect(lines.some((l) => l.includes('派出子代理'))).toBe(false)
    await harness.dispose()
  })

  it('does not flood the chat when six children work at once', async () => {
    // The regression this guards: progress used to reach the chat on a
    // PER-CHILD 30s window, so six concurrent children could emit up to twelve
    // `🔀 label · step` messages a minute. A real fan-out put hundreds of
    // `🔀 … write {…}` fragments into the chat within twenty minutes and made
    // the chat unreadable — each fragment said less than the panel row it
    // duplicated. Progress now lives only in the panel.
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session

    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    for (const id of ids) {
      harness.ctx.emit('session/event', session, {
        type: 'subagent/catalog',
        data: { version: 0, childId: `child-${id}`, childCreatedAt: Date.now(), mode: 'one-shot', label: `任务${id}` },
      })
    }
    const sentBefore = harness.fake.sent.length

    // Each child does a burst of tool calls; the panel sees all of it.
    for (const id of ids) {
      const childSession = { id: `child-${id}` }
      for (let step = 1; step <= 5; step += 1) {
        harness.ctx.emit('session/event', childSession, {
          type: 'tool/call',
          data: { turn: 1, step, name: 'edit', arguments: { path: `src/${id}/f${step}.ts` } },
        })
      }
    }

    await vi.waitFor(() => {
      // The panel carries all six rows and the last step of one of them.
      const body = JSON.stringify(harness.fake.updated.at(-1)?.card ?? harness.fake.sent.at(-1)?.input ?? '')
      expect(body).toContain('任务a')
      expect(body).toContain('src/f/')
    }, { timeout: 20_000, interval: 100 })

    const progress = harness.fake.sent.slice(sentBefore)
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
      .filter((l) => l.includes('🔀'))
    expect(progress).toHaveLength(0)
    await harness.dispose()
  })
})

/**
 * `/panel` 把面板捞回消息流底部。
 *
 * 面板是就地更新的一张卡，位置在发出去那一刻就钉死了；长任务里后面的每条消息
 * 都排在它下面，要往上翻很久才看得见进度。飞书既没有撤回接口也没有「重新置底」
 * 接口，所以唯一的办法是发一张新的、把旧的冻结掉。
 */
describe('/panel 重发面板', () => {
  it('冻结旧卡并在底部发一张新卡接管更新', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session

    harness.ctx.emit('session/event', session, {
      type: 'subagent/catalog',
      data: { version: 0, childId: 'child-p', childCreatedAt: Date.now(), mode: 'one-shot', label: '调研' },
    })
    await vi.waitFor(() => {
      expect(harness.fake.sent.some(m => m.input.card !== undefined)).toBe(true)
    }, { timeout: 20_000, interval: 100 })

    const cardsBefore = harness.fake.sent.filter(m => m.input.card !== undefined).length
    harness.fake.updated.length = 0

    await harness.fake.emitMessage(fakeMessage({ content: '/panel' }))
    await vi.waitFor(() => {
      expect(harness.fake.sent.filter(m => m.input.card !== undefined).length).toBe(cardsBefore + 1)
    }, { timeout: 20_000, interval: 100 })

    // 旧卡被改写成快照：标题写明是历史快照，配色转灰，读者不会把它当活的。
    const frozen = harness.fake.updated.map(u => JSON.stringify(u.card)).join('\n')
    expect(frozen).toContain('历史快照')
    expect(frozen).toContain('grey')

    // 之后子代理再有动静，更新只打在新卡上——绝不能回头去改那张已冻结的。
    harness.fake.updated.length = 0
    harness.ctx.emit('session/event', { id: 'child-p' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, name: 'read', arguments: { path: '重发之后的新动作' } },
    })
    await vi.waitFor(() => {
      expect(harness.fake.updated.length).toBeGreaterThan(0)
    }, { timeout: 20_000, interval: 100 })
    const afterRepost = harness.fake.updated.map(u => JSON.stringify(u.card)).join('\n')
    expect(afterRepost).toContain('重发之后的新动作')
    expect(afterRepost).not.toContain('历史快照')

    await harness.dispose()
  })

  it('没派过子代理时说明没有面板可发', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const before = harness.fake.sent.length

    await harness.fake.emitMessage(fakeMessage({ content: '/panel' }))
    await vi.waitFor(() => {
      const said = harness.fake.sent.slice(before)
        .map(m => (m.input as { markdown?: string }).markdown ?? '')
        .join('\n')
      expect(said).toContain('还没派过子代理')
    }, { timeout: 20_000, interval: 100 })
    await harness.dispose()
  })
})
