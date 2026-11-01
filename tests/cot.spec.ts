import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/** Every event written to the first thinking process, in order. */
function events(harness: Awaited<ReturnType<typeof mountChannel>>) {
  return harness.fake.cots[0]?.events ?? []
}

/** The content of the first event of one type. */
function contentOf(harness: Awaited<ReturnType<typeof mountChannel>>, type: string) {
  return events(harness).find((e) => e.type === type)?.content
}

describe('thinking process (CoT)', () => {
  /** Bind one chat and return an emitter for its session events. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('is the default output, opened per turn and aimed at the asking message', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })

    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    const cot = harness.fake.cots[0]!
    expect(cot.chatId).toBe('oc_chat_1')
    // The process belongs to the message that asked for it.
    expect(cot.replyTo).toBe('om_in_1')
    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_STARTED') })
    // A step is one iteration of the agent's loop; numbering it above the work
    // tells a reader nothing the reasoning and tool calls do not.
    expect(events(harness).map((e) => e.type)).not.toContain('STEP_STARTED')
    await harness.dispose()
  })

  it('streams reasoning into the thinking area, not the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先看目录' } })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '，再回答。' } })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(2)
    })
    expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_START')
    expect(contentOf(harness, 'REASONING_MESSAGE_CONTENT')).toMatchObject({ delta: '先看目录' })
    // Reasoning never becomes a chat message.
    expect(harness.fake.sent).toHaveLength(0)
    await harness.dispose()
  })

  it('gives each reasoning block its own id, so a thought stays where it happened', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // One agentic step: think, run a tool, think again. The second thought
    // belongs AFTER the call — reusing one id for the whole turn made the
    // client treat it as an edit of the first block, so every thought piled up
    // at the top of the thinking area, away from the call it explains.
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先读日志' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok', toolCallId: 'c1' }] },
    })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '日志里没写，换个地方' } })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(2)
    })
    const written = events(harness)
    const starts = written
      .filter((e) => e.type === 'REASONING_MESSAGE_START')
      .map((e) => e.content.messageId as string)
    expect(starts).toHaveLength(2)
    expect(new Set(starts).size).toBe(2)
    // Each delta carries the id of the block it belongs to.
    const contents = written
      .filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => e.content.messageId as string)
    expect(contents).toEqual(starts)
    // And the second block opens after the tool call closed, not before it.
    const callEnd = written.findIndex((e) => e.type === 'TOOL_CALL_END')
    const secondStart = written.findIndex(
      (e) => e.type === 'REASONING_MESSAGE_START' && e.content.messageId === starts[1],
    )
    expect(callEnd).toBeGreaterThanOrEqual(0)
    expect(secondStart).toBeGreaterThan(callEnd)
    await harness.dispose()
  })

  it('renders a whole reasoning block when the adapter delivers block-end, not deltas', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // pi-ai's deepseek route emits ONE block-end carrying the complete
    // reasoning text and no reasoning-delta events in between.
    const thinking = '这个问题的完整思考链：先看上下文，再决定如何回答。'.repeat(10)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'block-start', blockType: 'reasoning' } })
    emit('assistant/chunk', {
      turn: 1,
      chunk: { type: 'block-end', block: { type: 'reasoning', text: thinking } },
    })

    await vi.waitFor(() => {
      expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_START')
    })
    const contents = events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
    // The full block lands as one content event (the API's per-event bound
    // applies, but a 637-char reasoning block is far under it).
    expect(contents).toHaveLength(1)
    expect(contents[0]!.content).toMatchObject({ delta: thinking })
    // The block is closed so the client stops showing "still thinking".
    expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_END')
    await harness.dispose()
  })

  it('stamps every event after the one before it', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    for (const delta of ['一', '二', '三', '四', '五', '六', '七', '八']) {
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: delta } })
    }

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(8)
    })
    // The client ORDERS by timestamp, and a burst shares a millisecond — equal
    // stamps are free to be reordered, which arrives as interleaved sentences.
    const stamps = harness.fake.cots[0]!.timestamps.map(Number)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(new Set(stamps).size).toBe(stamps.length)
    await harness.dispose()
  })

  it('reports a tool call with the platform icon its kind maps to', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_START')).toBeDefined() })
    // With no presenter composed the label is the bare name and the icon the
    // default. The title also carries the clock time: the AG-UI timestamp is
    // an ordering key the client never renders, so "when did this happen" has
    // to ride on the one string the reader actually sees.
    expect(contentOf(harness, 'TOOL_CALL_START')).toMatchObject({
      toolCallId: 'c1', toolCallName: 'bash', icon: 'default',
    })
    expect((contentOf(harness, 'TOOL_CALL_START') as { title: string }).title)
      .toMatch(/^bash · \d{2}:\d{2}:\d{2}$/)
    const written = events(harness).map((e) => e.type)
    expect(written).toContain('TOOL_CALL_ARGS')
    expect(written).toContain('TOOL_CALL_END')
    // The arguments are summarised, not copied. A file write's arguments
    // are the whole file, and the chat already has the file on disk; the
    // session log keeps the full arguments.
    expect(contentOf(harness, 'TOOL_CALL_ARGS')).toMatchObject({ delta: 'command: ls -la' })
    await harness.dispose()
  })

  it('never puts a tool\'s payload into the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    const payload = 'x'.repeat(5000)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ path: '/tmp/a.txt', content: payload }) })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_ARGS')).toBeDefined() })
    const written = JSON.stringify(events(harness))
    expect(written).not.toContain(payload)
    // What identifies the call is kept.
    expect(contentOf(harness, 'TOOL_CALL_ARGS')).toMatchObject({ delta: 'path: /tmp/a.txt · content: 5000 字符' })
    await harness.dispose()
  })

  it('stamps every tool call with the clock time it started', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'TOOL_CALL_START')).toHaveLength(2)
    })
    // The fake parses each event's payload on the way in, the way the API does.
    const titles = events(harness)
      .filter((e) => e.type === 'TOOL_CALL_START')
      .map((e) => e.content.title as string)
    // Two calls in the same run may share a second — but each carries a time,
    // which is the thing a reader needs to line a step up against their message.
    for (const title of titles) expect(title).toMatch(/ · \d{2}:\d{2}:\d{2}$/)
    await harness.dispose()
  })

  it('reports how long a slow tool call took, and stays quiet about a fast one', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'slow', name: 'bash', arguments: '{}' })
    // The elapsed time is measured between the call and its result; a fake
    // clock is the only way to say "this one took 18 seconds" deterministically.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 18_200))
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'slow' }, content: [{ type: 'text', text: 'ok', toolCallId: 'slow' }] },
    })
    emit('tool/call', { turn: 1, callId: 'fast', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'fast' }, content: [{ type: 'text', text: 'ok', toolCallId: 'fast' }] },
    })
    vi.useRealTimers()

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'TOOL_CALL_RESULT')).toHaveLength(2)
    })
    const results = events(harness)
      .filter((e) => e.type === 'TOOL_CALL_RESULT')
      .map((e) => (e.content.content as { code: string }).code)
    expect(results[0]).toContain('18.2s')
    // A sub-second call says nothing rather than "0ms" — the noise is worse
    // than the silence, and the line stays where a reader expects the output.
    expect(results[1]).not.toContain('⏱')
    expect(results[1]).toBe('ok')
    await harness.dispose()
  })

  it('names the slowest step in the closing line, which lives in the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '跑两个命令' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"build"}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'done', toolCallId: 'c1' }] },
    })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{"command":"test"}' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 252_000))
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'pass', toolCallId: 'c2' }] },
    })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '结论。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.useRealTimers()

    // The closing line goes to the chat, not the thinking area: the platform
    // hides the process when a run ends, so a line written there would vanish.
    await vi.waitFor(() => {
      const texts = harness.fake.sent.map((m) => (m.input as { markdown?: string }).markdown ?? '')
      expect(texts.some((t) => t.includes('本轮完成'))).toBe(true)
    })
    const closing = harness.fake.sent
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
      .find((text) => text.includes('本轮完成'))!
    expect(closing).toContain('2 次工具调用')
    // The total says how long; naming the slowest says where the time went.
    expect(closing).toContain('最慢')
    expect(closing).toContain('4 分 12 秒')
    await harness.dispose()
  })

  it('shows a tool result as its head, not as the whole output', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: output, toolCallId: 'c1' }] },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    const code = (contentOf(harness, 'TOOL_CALL_RESULT') as { content: { code: string } }).content.code
    expect(code).toContain('line 0')
    expect(code).toContain('共 40 行')
    expect(code).not.toContain('line 39')
    await harness.dispose()
  })

  it('says the turn is over, in a message that stays', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '结论。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) })
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBe(2) })
    const texts = harness.fake.sent.map((m) => (m.input as { markdown?: string }).markdown ?? '')
    // The closing line is a message of its own, not part of the process the
    // platform hides when the run ends.
    expect(texts.some((t) => t.includes('本轮完成') && t.includes('2 次工具调用'))).toBe(true)
    await harness.dispose()
  })

  it('labels a subagent delegation distinctly from a local tool call', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'subagent', arguments: '{"description":"调研","prompt":"...","run_in_background":true}' })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_START')).toBeDefined() })
    // The delegation reads as a subagent activity, not a bare tool name.
    expect(contentOf(harness, 'TOOL_CALL_START')).toMatchObject({
      toolCallId: 'c1', toolCallName: 'subagent',
    })
    expect(contentOf(harness, 'TOOL_CALL_START').title).toContain('🧑💻')
    await harness.dispose()
  })

  it("renders a tool's output as a code block", async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: {
        source: { callId: 'c1' },
        content: [{ type: 'text', text: 'total 24', toolCallId: 'c1' }],
      },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    expect(contentOf(harness, 'TOOL_CALL_RESULT')).toMatchObject({
      toolCallId: 'c1', role: 'tool', content: { type: 'code', code: 'total 24' },
    })
    await harness.dispose()
  })

  it('sends the answer as an ordinary message, never into the process', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想一下' } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好！' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The platform reserves the process for thinking; the answer is its own message.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '你好！')).toBe(true)
    })
    expect(events(harness).map((e) => e.type)).not.toContain('TEXT_MESSAGE_CONTENT')
    await harness.dispose()
  })

  it('answers a many-step turn once, with the narration in the process', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // An agentic turn narrates between tool calls: every one of these commits
    // used to become its own reply, which is a wall of them for one question.
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '先做整体探索。' }] } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '继续看核心文档。' }] } })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '分析完成，结论如下。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThanOrEqual(1) })
    // The chat carries the text the turn ended on, once.
    const answer = harness.fake.sent
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
      .find((t) => t === '分析完成，结论如下。')
    expect(answer).toBe('分析完成，结论如下。')
    // The narration it replaced is in the process instead; writes are queued,
    // so this is where the queue has drained.
    await vi.waitFor(() => {
      const narration = events(harness)
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
        .map((e) => e.content.delta)
      expect(narration).toEqual(['先做整体探索。', '继续看核心文档。'])
    })
    await harness.dispose()
  })

  it('closes the run, ending an open thinking block first', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想到一半' } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_FINISHED') })
    const written = events(harness).map((e) => e.type)
    expect(written.indexOf('REASONING_MESSAGE_END')).toBeLessThan(written.indexOf('RUN_FINISHED'))
    expect(contentOf(harness, 'RUN_FINISHED')).toMatchObject({ status: 'done' })
    await harness.dispose()
  })

  it('marks a failed turn as a failed run', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_MODEL', message: 'boom' } } })

    await vi.waitFor(() => { expect(contentOf(harness, 'RUN_ERROR')).toBeDefined() })
    expect(contentOf(harness, 'RUN_ERROR')).toMatchObject({ message: 'E_MODEL: boom' })
    // The chat is told too, by the answer half.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'text' in m.input && m.input.text.includes('E_MODEL'))).toBe(true)
    })
    await harness.dispose()
  })

  it('opens one process per turn', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    emit('step/start', { turn: 2, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(2) })
    await harness.dispose()
  })

  it('still answers when the platform refuses the process', async () => {
    const harness = await mountChannel()
    harness.fake.state.failCotCreate = true
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想' } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The answer never depended on the thinking process existing.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.notices.some((line) => line.includes('outbound send failed'))).toBe(true)
    await harness.dispose()
  })

  it('asks the platform to drop the process when the run ends', async () => {
    const harness = await mountChannel({ hideProcessWhenDone: true })
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    expect(harness.fake.cots[0]!.hidden).toBe(true)
    await harness.dispose()
  })

  it('opens no process at all when it is switched off', async () => {
    const harness = await mountChannel({ showProcess: false })
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '不该出现' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The answer still arrives; an empty process would be worse than none.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.fake.cots).toEqual([])
    await harness.dispose()
  })
})

describe('mid-turn re-aim (P141)', () => {
  it('keeps the running turn on its own target and hands the next turn to the follow-up', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const emit = (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }

    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    expect(harness.fake.cots[0]!.replyTo).toBe('om_in_1')

    // A follow-up lands while turn 1 is still working: turn 1 keeps its target.
    await harness.fake.emitMessage(fakeMessage({ messageId: 'om_in_2', content: '这条是我的' }))
    await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(2) })
    emit('step/start', { turn: 2, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(2) })
    expect(harness.fake.cots[0]!.replyTo).toBe('om_in_1')
    expect(harness.fake.cots[1]!.replyTo).toBe('om_in_2')

    emit('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'answer-b' }] } })
    emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(harness.fake.sent.some(s => String((s.input as { markdown?: string }).markdown ?? '').includes('answer-b'))).toBe(true)
    })
    await harness.dispose()
  })
})

describe('mid-turn messages (steering)', () => {
  /** Bind one chat and return an emitter for its session events. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('shows a message sent mid-turn, at the step that admitted it', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    emit('step/start', { turn: 1, step: 1 })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })

    // 用户在中途插话。宿主不立刻记录：它先进收件箱，在下一个 step 边界被
    // 接纳时才以 `user/message` 追加进会话日志——所以它夹在两步之间。
    emit('user/message', {
      id: 'um_1',
      role: 'user',
      content: [{ type: 'text', text: '改成先看测试' }],
      source: { kind: 'user' },
    })
    emit('step/start', { turn: 1, step: 2 })

    await vi.waitFor(() => {
      expect(harness.fake.cots[0]!.events.map(e => e.type)).toContain('TEXT_MESSAGE_CONTENT')
    })
    const list = harness.fake.cots[0]!.events
    const start = list.findIndex(e => e.type === 'TEXT_MESSAGE_START')
    expect(list[start]!.content).toMatchObject({ role: 'user' })
    expect(list[start + 1]!.content).toMatchObject({ delta: '改成先看测试' })
    expect(list[start + 2]!.type).toBe('TEXT_MESSAGE_END')
    // 它必须排在插话之前那次工具调用之后，才看得出「因为这句话才转向」。
    const lastTool = list.map(e => e.type).lastIndexOf('TOOL_CALL_END')
    expect(lastTool).toBeLessThan(start)
    await harness.dispose()
  })

  it('leaves the message that opened the turn to the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    // 开轮的那条消息在聊天里有自己的气泡，不该在思考区重复一遍。
    emit('user/message', {
      id: 'um_0',
      role: 'user',
      content: [{ type: 'text', text: '开轮的第一条' }],
      source: { kind: 'user' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(harness.fake.cots).toEqual([])
    await harness.dispose()
  })

  it('ignores the messages the host writes to itself', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })

    // goal / 指令 / 上下文都是宿主自己写的，读者不会认成自己的话。
    emit('user/message', {
      id: 'um_goal',
      role: 'user',
      content: [{ type: 'text', text: '继续推进目标' }],
      source: { kind: 'goal' },
    })
    emit('user/message', {
      id: 'um_inst',
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>' }],
      source: { kind: 'agent-instructions' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(harness.fake.cots[0]!.events.map(e => e.type)).not.toContain('TEXT_MESSAGE_START')
    await harness.dispose()
  })
})
