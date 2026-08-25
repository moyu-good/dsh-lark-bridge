import { isAbsolute } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Context } from '@deepseek-ai/cordis'
import type { CardActionEvent } from '@larksuite/channel'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import type { HostApprovalOutcome, HostApprovalRequest } from '../src/host.ts'
import type { RegisterAppPort, RegisterAppRequest } from '../src/onboarding.ts'
import { stripToolCallMarkup } from '../src/outbound.ts'
import {
  approvalValueFromCard,
  createFakeAttachments,
  createFakeCommands,
  createFakePresets,
  createFakeSettings,
  createFakeTools,
  createFakeWorkspaces,
  fakeMessage,
  INBOUND_SUBSCRIPTIONS,
  mountChannel,
  SENDER_ID,
} from './harness.ts'

/** A card action clicking one approval button, as the authorized owner by default. */
function clickAction(
  value: unknown,
  by: { openId?: string; chatId?: string; name?: string } = {},
): CardActionEvent {
  return {
    messageId: 'om_card_1',
    chatId: by.chatId ?? 'oc_chat_1',
    operator: {
      openId: by.openId ?? SENDER_ID,
      ...by.name === undefined ? {} : { name: by.name },
    },
    action: { value, tag: 'button' },
  }
}

describe('dsh-lark-bridge', () => {
  it('preserves the function-plugin namespace through Loader unwrapping', () => {
    expect('default' in plugin).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.name).toBe('dsh-lark-bridge')
    expect(unwrapped.inject).toEqual(['agents', 'goals'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('connects on activation and subscribes inbound events', async () => {
    const harness = await mountChannel()
    expect(harness.fake.state.connects).toBe(1)
    expect(harness.fake.state.subscriptions).toBe(INBOUND_SUBSCRIPTIONS)
    await harness.dispose()
  })

  it('reconnects when re-applied after disposal (HMR reload)', async () => {
    const harness = await mountChannel()
    expect(harness.fake.state.connects).toBe(1)
    // Unload the plugin fiber without restoring internals, then apply it again
    // on the same context — exactly what a Cordis HMR reload does.
    await harness.fiber.dispose()
    expect(harness.fake.state.disconnects).toBe(1)
    const fiber2 = await harness.ctx.plugin(plugin, harness.config)
    await vi.waitFor(() => {
      if (harness.fake.state.connects !== 2) throw new Error('bridge did not reconnect on reload')
    })
    await fiber2.dispose()
  })

  it('drives one agent per chat from inbound messages', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: 'first' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })

    const created = harness.agents.created[0]!
    // Derived from the conversation alone, so a restart reaches this session again.
    expect(created.sessionId).toBe('feishu-oc_chat_1')
    expect(created.meta?.cwd !== undefined && isAbsolute(created.meta.cwd)).toBe(true)
    expect(created.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    const first = created.agent.followup.mock.calls[0]![0]
    expect(first.role).toBe('user')
    expect(first.source).toEqual({ kind: 'user' })
    expect(first.content).toEqual([{ type: 'text', text: 'first' }])

    // The same chat reuses its agent; a new chat gets its own.
    await harness.fake.emitMessage(fakeMessage({ content: 'second' }))
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(2) })
    expect(harness.agents.created).toHaveLength(1)
    await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_chat_2', content: 'other' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
    await harness.dispose()
  })

  it('sends the first-contact guide once for a brand-new session', async () => {
    const harness = await mountChannel({ onboarding: true })
    await harness.fake.emitMessage(fakeMessage({ content: 'first' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown.includes('/help'))).toBe(true)
    })
    // A second message to the same session does not repeat the guide.
    await harness.fake.emitMessage(fakeMessage({ content: 'second' }))
    await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(2) })
    const guides = harness.fake.sent.filter((m) => 'markdown' in m.input && m.input.markdown.includes('/help'))
    expect(guides).toHaveLength(1)
    await harness.dispose()
  })

  it('prefixes group messages with the sender', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ chatType: 'group', senderName: 'Alice', content: 'hi all' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const followup = harness.agents.created[0]!.agent.followup
    await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
    const block = followup.mock.calls[0]![0].content[0]!
    expect(block.type === 'text' && block.text).toBe('Alice: hi all')
    await harness.dispose()
  })

  it('rates the last assistant message through /feedback', async () => {
    const puts: { sessionId: string; messageId: string; rating: string; note?: string }[] = []
    const feedback = {
      put: async (req: { sessionId: string; messageId: string; rating: string; note?: string }) => {
        puts.push(req)
        return { ok: true }
      },
    }
    const harness = await mountChannel({}, { messageFeedback: feedback } as never)
    await harness.fake.emitMessage(fakeMessage({ content: '帮我看看' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    harness.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 0, message: { id: 'assistant-1', content: [{ type: 'text', text: '答案' }] } },
    })
    await harness.fake.emitMessage(fakeMessage({ content: '/feedback positive 很好' }))
    await vi.waitFor(() => { expect(puts).toHaveLength(1) })
    expect(puts[0]).toMatchObject({ sessionId: session.id, messageId: 'assistant-1', rating: 'positive', note: '很好' })
    await harness.dispose()
  })

  it('announces background job terminals in the chat', async () => {
    const jobsListeners: { fn: (snapshot: unknown, owner: unknown) => void }[] = []
    const fakeJobs = {
      onJobDone: (fn: (snapshot: unknown, owner: unknown) => void) => {
        jobsListeners.push({ fn })
        return () => { /* no-op: the test disposes the harness */ }
      },
    }
    const harness = await mountChannel({}, { jobs: fakeJobs } as never)
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const owner = harness.agents.created[0]!.agent
    expect(jobsListeners).toHaveLength(1)
    jobsListeners[0]!.fn({ id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'completed' }, owner)
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('后台任务完成'))).toBe(true) })
    await harness.dispose()
  })

  it('streams workflow fan-out events into the chat', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    const emit = (type: string, data: unknown) => harness.ctx.emit('session/event', session, { type, data })

    emit('tool-workflow/run-start', { runId: 'run-1', name: '调研' })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('工作流「调研」'))).toBe(true) })
    emit('tool-workflow/agent-start', { runId: 'run-1', seq: 1, label: '爬虫', childId: 'child-1' })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('爬虫 启动'))).toBe(true) })
    harness.ctx.emit('workflow/phase', { id: 'run-1', meta: {} }, '爬取数据')
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('阶段：爬取数据'))).toBe(true) })
    harness.ctx.emit('workflow/log', { id: 'run-1', meta: {} }, '正在抓取 100 页')
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('正在抓取 100 页'))).toBe(true) })
    emit('tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('✅'))).toBe(true) })
    emit('tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('全部完成'))).toBe(true) })
    await harness.dispose()
  })

  it('announces compaction start and reports a failing one', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    const emit = (type: string, data: unknown) => harness.ctx.emit('session/event', session, { type, data })

    emit('compaction/start', { compactionId: 'c-1', turn: null })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('正在压缩'))).toBe(true) })
    emit('compaction/end', { compactionId: 'c-1', turn: null, error: 'model timeout' })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('压缩失败'))).toBe(true) })
    await harness.dispose()
  })

  it('surfaces subagent, schedule, search, and retry notices', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    const emit = (type: string, data: unknown) => harness.ctx.emit('session/event', session, { type, data })

    emit('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'test', label: '爬虫' })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('爬虫'))).toBe(true) })
    emit('schedule/change', { version: 1, operation: 'create', schedule: { id: 's1', kind: 'every', prompt: '每日简报' } })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('周期任务'))).toBe(true) })
    emit('web/deepseek-search-llm-request', {})
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('搜索网络'))).toBe(true) })
    emit('llm/retry', { retryId: 'r1', turn: 1, step: 1, provider: 'p', retry: 1, maxRetries: 3 })
    await vi.waitFor(() => { expect(harness.fake.sent.every(m => !('markdown' in m.input) || !m.input.markdown.includes('重试'))).toBe(true) })
    // The final attempt IS announced — the next failure kills the turn.
    emit('llm/retry', { retryId: 'r2', turn: 1, step: 1, provider: 'p', retry: 3, maxRetries: 3 })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'markdown' in m.input && m.input.markdown.includes('最后一次重试'))).toBe(true) })
    await harness.dispose()
  })

  it('re-arms an interrupted goal when autoResumeGoals is on', async () => {
    const resumed: { id: string; revision: number }[] = []
    const goals = {
      get: () => ({
        goal: { id: 'goal-1', revision: 2, phase: 'active' },
        activation: 'disarmed',
      }),
      resume: async (_agent: unknown, ref: { id: string; revision: number }) => { resumed.push(ref) },
    }
    const harness = await mountChannel({ autoResumeGoals: true }, { goals })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    await vi.waitFor(() => { expect(resumed).toHaveLength(1) })
    expect(resumed[0]).toEqual({ id: 'goal-1', revision: 2 })
    await harness.dispose()
  })

  it('leaves a goal disarmed when autoResumeGoals is off', async () => {
    const resumed: { id: string; revision: number }[] = []
    const goals = {
      get: () => ({
        goal: { id: 'goal-1', revision: 2, phase: 'active' },
        activation: 'disarmed',
      }),
      resume: async (_agent: unknown, ref: { id: string; revision: number }) => { resumed.push(ref) },
    }
    const harness = await mountChannel({ autoResumeGoals: false }, { goals })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1) })
    expect(resumed).toHaveLength(0)
    await harness.dispose()
  })

  it('drives a goal card button through the goals service', async () => {
    const calls: string[] = []
    const goals = {
      get: () => ({ goal: { id: 'goal-1', revision: 3, phase: 'active' } }),
      pause: () => { calls.push('pause') },
      resume: () => { calls.push('resume') },
      clear: () => { calls.push('clear') },
    }
    const harness = await mountChannel({}, { goals })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    harness.ctx.emit('session/event', session, {
      type: 'goal/change',
      data: { operation: 'create', goal: { id: 'goal-1', revision: 3, objective: '写论文', phase: 'active' } },
    })
    // The goal card appears with buttons; find the pause button and click it.
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'card' in m.input)).toBe(true) })
    const card = harness.fake.sent.find(m => 'card' in m.input)!.input as { card: { elements?: { tag?: string; actions?: { value?: object }[] }[] } }
    const actions = card.card.elements?.find(e => e.tag === 'action')?.actions ?? []
    expect(actions.length).toBeGreaterThan(0)
    const pause = actions.find(a => (a.value as { operation?: string }).operation === 'pause')
    expect(pause).toBeDefined()
    const response = await harness.fake.emitCardAction(clickAction(pause!.value))
    expect(response).toEqual({ toast: { type: 'success', content: '已暂停' } })
    expect(calls).toEqual(['pause'])
    await harness.dispose()
  })

  it('refuses a goal card click from an unauthorized operator', async () => {
    const calls: string[] = []
    const goals = {
      get: () => ({ goal: { id: 'goal-1', revision: 3, phase: 'active' } }),
      pause: () => { calls.push('pause') },
      resume: () => { calls.push('resume') },
      clear: () => { calls.push('clear') },
    }
    const harness = await mountChannel({ senderAllowlist: [SENDER_ID] }, { goals })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    harness.ctx.emit('session/event', session, {
      type: 'goal/change',
      data: { operation: 'create', goal: { id: 'goal-1', revision: 3, objective: '写论文', phase: 'active' } },
    })
    await vi.waitFor(() => { expect(harness.fake.sent.some(m => 'card' in m.input)).toBe(true) })
    const card = harness.fake.sent.find(m => 'card' in m.input)!.input as { card: { elements?: { tag?: string; actions?: { value?: object }[] }[] } }
    const actions = card.card.elements?.find(e => e.tag === 'action')?.actions ?? []
    const pause = actions.find(a => (a.value as { operation?: string }).operation === 'pause')
    // An operator who is not allowed to drive this chat gets a refusal.
    const response = await harness.fake.emitCardAction(clickAction(pause!.value, { openId: 'ou_stranger' }))
    expect(response).toEqual({ toast: { type: 'error', content: '你无权操作此目标' } })
    expect(calls).toEqual([])
    await harness.dispose()
  })

  it('registers the send_file tool on every chat agent scope', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const composed = harness.agents.created[0]!
    // The composition ran the bridge's setup, which registered the channel
    // tool on the agent's scope; the harness records the setup call.
    expect(composed.setupRan).toBe(true)
    await harness.dispose()
  })

  it('falls back to the host default model selection', async () => {
    const harness = await mountChannel(
      { provider: undefined, model: undefined },
      { defaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) } },
    )
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    expect(harness.agents.created[0]!.agentOptions).toEqual({ provider: 'default-p', model: 'default-m' })
    await harness.dispose()
  })

  it('reports agent-creation failure to the chat and retries next message', async () => {
    // No provider/model configured and no default-model service composed.
    const harness = await mountChannel({ provider: undefined, model: undefined })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
    const input = harness.fake.sent[0]!.input
    expect('text' in input && input.text.startsWith('⚠️ 无法启动会话')).toBe(true)
    expect(harness.agents.created).toHaveLength(0)

    // The failed binding slot is cleared, so the next message retries creation.
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(2) })
    await harness.dispose()
  })

  it('sends committed assistant text back to its chat only', async () => {
    const harness = await mountChannel({ showProcess: false })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session

    // A foreign session's text must not reach this chat, whatever it says.
    harness.ctx.emit('session/event', { id: 'foreign-session' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'ignore me' }] } },
    })
    harness.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '你好' }, { type: 'reasoning', text: '想了想' }] } },
    })
    harness.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
    // Reasoning blocks are not text the chat carries.
    expect((harness.fake.sent[0]!.input as { markdown: string }).markdown).toBe('你好')
    await harness.dispose()
  })

  it('reports failed turns to the chat', async () => {
    const harness = await mountChannel({ showProcess: false })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session

    harness.ctx.emit('session/event', session, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { code: 'E_MODEL', message: 'boom' } } },
    })
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'text' in m.input && m.input.text === '⚠️ 本轮任务失败 E_MODEL: boom')).toBe(true)
    })
    await harness.dispose()
  })

  it('strips off-protocol tool-call markup with a notice', () => {
    const leaked = '我先看一下工作区。\n\n'
      + '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="exec_command">\n'
      + '<｜｜DSML｜｜parameter name="cmd" string="true">pwd</｜｜DSML｜｜parameter>\n'
      + '</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
    const stripped = stripToolCallMarkup(leaked)
    expect(stripped).not.toContain('DSML')
    expect(stripped).not.toContain('exec_command')
    expect(stripped.startsWith('我先看一下工作区。')).toBe(true)
    expect(stripped).toContain('未被识别的工具调用标记')

    // A truncated opener cuts to the end rather than leaking a partial block.
    expect(stripToolCallMarkup('写点东西 <｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash"'))
      .not.toContain('DSML')
    // Ordinary text with no markup is returned verbatim, notice included.
    expect(stripToolCallMarkup('普通回答 <tag> `code`')).toBe('普通回答 <tag> `code`')
  })

  describe('approval cards', () => {
    async function boundApproval(harness: Awaited<ReturnType<typeof mountChannel>>, signal?: AbortSignal) {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const request: HostApprovalRequest = {
        agent: harness.agents.created[0]!.agent,
        toolName: 'bash',
        reason: 'rm -rf build',
        ...(signal === undefined ? {} : { signal }),
      }
      const outcome = harness.ctx.waterfall(
        'approval/request',
        request,
        async (): Promise<HostApprovalOutcome> => 'unavailable',
      )
      await vi.waitFor(() => { expect(harness.fake.sent.some((m) => 'card' in m.input)) .toBe(true) })
      const card = harness.fake.sent.find((m) => 'card' in m.input)!.input as { card: object }
      return { outcome, values: approvalValueFromCard(card.card) }
    }

    it('grants once through the allow button', async () => {
      const harness = await mountChannel()
      const { outcome, values } = await boundApproval(harness)
      const allow = values.find((value) => value.decision === 'allow')!
      const response = await harness.fake.emitCardAction(clickAction(allow))
      expect(response).toEqual({ toast: { type: 'success', content: '已允许执行一次' } })
      expect(await outcome).toBe('allowed-once')
      await vi.waitFor(() => { expect(harness.fake.updated).toHaveLength(1) })
      await harness.dispose()
    })

    it('rejects through the reject button', async () => {
      const harness = await mountChannel()
      const { outcome, values } = await boundApproval(harness)
      const reject = values.find((value) => value.decision === 'reject')!
      await harness.fake.emitCardAction(clickAction(reject))
      expect(await outcome).toBe('rejected')
      await harness.dispose()
    })

    it('nudges an unanswered card after the reminder delay', async () => {
      vi.useFakeTimers()
      try {
        const harness = await mountChannel({ approvalReminderMs: 120_000 })
        await harness.fake.emitMessage(fakeMessage())
        await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
        const request: HostApprovalRequest = {
          agent: harness.agents.created[0]!.agent,
          toolName: 'bash',
          reason: 'rm -rf build',
        }
        const outcome = harness.ctx.waterfall(
          'approval/request',
          request,
          async (): Promise<HostApprovalOutcome> => 'unavailable',
        )
        await vi.waitFor(() => { expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(true) })
        const before = harness.fake.sent.filter((m) => 'markdown' in m.input).length
        await vi.advanceTimersByTimeAsync(120_000)
        await vi.waitFor(() => {
          expect(harness.fake.sent.filter((m) => 'markdown' in m.input && m.input.markdown.includes('审批卡'))).toHaveLength(1)
        })
        void outcome
        await harness.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not nudge a card answered before the delay', async () => {
      vi.useFakeTimers()
      try {
        const harness = await mountChannel({ approvalReminderMs: 120_000 })
        const { outcome, values } = await boundApproval(harness)
        const allow = values.find((value) => value.decision === 'allow')!
        await harness.fake.emitCardAction(clickAction(allow))
        expect(await outcome).toBe('allowed-once')
        await vi.advanceTimersByTimeAsync(120_000)
        expect(harness.fake.sent.filter((m) => 'markdown' in m.input && m.input.markdown.includes('审批卡'))).toHaveLength(0)
        await harness.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('ignores foreign and stale card actions', async () => {
      const harness = await mountChannel()
      const { outcome, values } = await boundApproval(harness)
      expect(await harness.fake.emitCardAction(clickAction({ some: 'other-plugin' }))).toBeUndefined()
      const allow = values.find((value) => value.decision === 'allow')!
      await harness.fake.emitCardAction(clickAction(allow))
      expect(await outcome).toBe('allowed-once')
      // The question is already settled; a second click gets the stale toast.
      const stale = await harness.fake.emitCardAction(clickAction(allow))
      expect(stale).toEqual({ toast: { type: 'info', content: '该审批已失效' } })
      await harness.dispose()
    })

    it('delegates questions about foreign agents', async () => {
      const harness = await mountChannel()
      const request: HostApprovalRequest = {
        agent: { id: 'foreign', session: { id: 'foreign' }, followup: () => {}, cancel: () => {} },
        toolName: 'bash',
      }
      const outcome = await harness.ctx.waterfall(
        'approval/request',
        request,
        async (): Promise<HostApprovalOutcome> => 'unavailable',
      )
      expect(outcome).toBe('unavailable')
      expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(false)
      await harness.dispose()
    })

    it('delegates when the card cannot be sent', async () => {
      const harness = await mountChannel()
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      harness.fake.state.failNextSend = true
      const outcome = await harness.ctx.waterfall(
        'approval/request',
        { agent: harness.agents.created[0]!.agent, toolName: 'bash' },
        async (): Promise<HostApprovalOutcome> => 'unavailable',
      )
      expect(outcome).toBe('unavailable')
      await harness.dispose()
    })

    it('settles cancelled when the asker withdraws', async () => {
      const harness = await mountChannel()
      const controller = new AbortController()
      const { outcome } = await boundApproval(harness, controller.signal)
      controller.abort()
      expect(await outcome).toBe('cancelled')
      await harness.dispose()
    })
  })

  it('disposal disconnects, disposes chat agents, and settles open approvals', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const outcome = harness.ctx.waterfall(
      'approval/request',
      { agent: harness.agents.created[0]!.agent, toolName: 'bash' },
      async (): Promise<HostApprovalOutcome> => 'unavailable',
    )
    await vi.waitFor(() => { expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(true) })

    await harness.dispose()
    expect(await outcome).toBe('cancelled')
    expect(harness.fake.state.disconnects).toBe(1)
    expect(harness.fake.state.subscriptions).toBe(0)
    expect(harness.agents.created[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  describe('agent composition', () => {
    /** Drive one chat message and return the created agent record. */
    async function firstAgent(harness: Awaited<ReturnType<typeof mountChannel>>) {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      return harness.agents.created[0]!
    }

    it('joins the roster default preset so the model gets tools', async () => {
      const roster = createFakePresets(['default', 'reviewer'])
      const harness = await mountChannel({}, { presets: roster.presets })
      const created = await firstAgent(harness)

      expect(roster.resolved).toEqual([undefined])
      expect(created.meta?.agentPreset).toBe('default')
      expect(created.setupRan).toBe(true)
      expect(roster.mounted).toEqual([{ id: 'default', scoped: true }])
      await harness.dispose()
    })

    it('joins the configured preset', async () => {
      const roster = createFakePresets(['default', 'reviewer'])
      const harness = await mountChannel({ preset: 'reviewer' }, { presets: roster.presets })
      const created = await firstAgent(harness)

      expect(created.meta?.agentPreset).toBe('reviewer')
      expect(roster.mounted).toEqual([{ id: 'reviewer', scoped: true }])
      await harness.dispose()
    })

    it('reports an unknown preset instead of running a toolless agent', async () => {
      const roster = createFakePresets(['default'])
      const harness = await mountChannel({ preset: 'nope' }, { presets: roster.presets })
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      const input = harness.fake.sent[0]!.input
      expect('text' in input && input.text.includes('unknown preset "nope"')).toBe(true)
      expect(harness.agents.created).toHaveLength(0)
      await harness.dispose()
    })

    it('does not deny the human-interaction tools the bridge answers as cards', async () => {
      const harness = await mountChannel()
      const created = await firstAgent(harness)

      // On a chat profile the bridge registers the single user-questions
      // provider, so ask_user_question and exit_plan_mode resolve through
      // Feishu cards — no denial, no prose fallback needed.
      expect(created.denyReason('ask_user_question')).toBeUndefined()
      expect(created.denyReason('exit_plan_mode')).toBeUndefined()
      expect(created.denyReason('bash')).toBeUndefined()
      await harness.dispose()
    })

    it('honours a configured deny list', async () => {
      const harness = await mountChannel({ denyTools: ['web_search'] })
      const created = await firstAgent(harness)
      expect(created.denyReason('web_search')).toBeDefined()
      expect(created.denyReason('ask_user_question')).toBeUndefined()
      await harness.dispose()
    })

    it('composes no restriction for an empty deny list', async () => {
      const harness = await mountChannel({ denyTools: [] })
      const created = await firstAgent(harness)
      expect(created.denyReason('ask_user_question')).toBeUndefined()
      // The channel identity is always injected; only the tool restriction is
      // conditional on a non-empty deny list.
      expect(created.promptSections.map(s => s.name)).toContain('dsh-lark-bridge:identity')
      expect(created.promptSections.some(s => s.text.includes('unavailable here'))).toBe(false)
      await harness.dispose()
    })

    it('records no preset when the deployment has no roster', async () => {
      const harness = await mountChannel()
      const created = await firstAgent(harness)
      expect(created.meta?.agentPreset).toBeUndefined()
      // Setup still runs: this channel composes its own per-agent world
      // (prompt guidance) with or without a roster.
      expect(created.setupRan).toBe(true)
      expect(created.denyReason('ask_user_question')).toBeUndefined()
      await harness.dispose()
    })
  })

  describe('image input', () => {
    /** One inbound message carrying image resources the transport can serve. */
    function withImage(
      harness: Awaited<ReturnType<typeof mountChannel>>,
      resources: { fileKey: string; fileName?: string }[],
      bytes: { buffer: Uint8Array; contentType?: string },
    ) {
      for (const resource of resources) harness.fake.resourceBytes.set(resource.fileKey, bytes)
      return fakeMessage({
        content: '这个报错怎么回事',
        resources: resources.map((r) => ({ type: 'image' as const, ...r })),
      })
    }

    it('attaches a screenshot to the message the model reads', async () => {
      const attachments = createFakeAttachments()
      const harness = await mountChannel({ attachImages: true }, { attachments: attachments.service })
      await harness.fake.emitMessage(withImage(
        harness,
        [{ fileKey: 'img_1', fileName: 'shot.png' }],
        { buffer: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      ))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const followup = harness.agents.created[0]!.agent.followup
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })

      const content = followup.mock.calls[0]![0].content
      expect(content[0]).toEqual({ type: 'text', text: '这个报错怎么回事' })
      // An opaque reference the attachment store owns, never a path or a URL.
      expect(content[1]).toEqual({
        type: 'image',
        attachment: expect.objectContaining({ attachmentId: 'att_1', mediaType: 'image/png' }),
      })
      expect(attachments.saved[0]).toEqual({ mediaType: 'image/png', bytes: 3, name: 'shot.png' })
      await harness.dispose()
    })

    it('falls back to the file name when the transport names no type', async () => {
      const attachments = createFakeAttachments()
      const harness = await mountChannel({ attachImages: true }, { attachments: attachments.service })
      await harness.fake.emitMessage(withImage(
        harness,
        [{ fileKey: 'img_1', fileName: 'photo.jpg' }],
        { buffer: new Uint8Array([1]) },
      ))
      await vi.waitFor(() => { expect(attachments.saved).toHaveLength(1) })
      expect(attachments.saved[0]!.mediaType).toBe('image/jpeg')
      await harness.dispose()
    })

    it('tells the model about an image it will not see', async () => {
      const attachments = createFakeAttachments({ maxImageBytes: 2 })
      const harness = await mountChannel({ attachImages: true }, { attachments: attachments.service })
      await harness.fake.emitMessage(withImage(
        harness,
        [{ fileKey: 'img_1', fileName: 'big.png' }],
        { buffer: new Uint8Array([1, 2, 3, 4, 5]), contentType: 'image/png' },
      ))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const followup = harness.agents.created[0]!.agent.followup
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })

      const first = followup.mock.calls[0]![0].content[0]!
      // Silence would let the model answer as though it had seen the screenshot.
      expect(first.type === 'text' && first.text).toContain('超出大小上限')
      expect(followup.mock.calls[0]![0].content).toHaveLength(1)
      expect(attachments.saved).toEqual([])
      await harness.dispose()
    })

    it('bounds how many images one message may carry', async () => {
      const attachments = createFakeAttachments({ maxImagesPerMessage: 2 })
      const harness = await mountChannel({ attachImages: true }, { attachments: attachments.service })
      await harness.fake.emitMessage(withImage(
        harness,
        [{ fileKey: 'a' }, { fileKey: 'b' }, { fileKey: 'c' }],
        { buffer: new Uint8Array([1]), contentType: 'image/png' },
      ))
      await vi.waitFor(() => { expect(attachments.saved).toHaveLength(2) })
      const first = harness.agents.created[0]!.agent.followup.mock.calls[0]![0].content[0]!
      expect(first.type === 'text' && first.text).toContain('超出单条消息上限')
      await harness.dispose()
    })

    it('says so when no attachment store is composed', async () => {
      const harness = await mountChannel({ attachImages: true })
      await harness.fake.emitMessage(withImage(
        harness,
        [{ fileKey: 'img_1' }],
        { buffer: new Uint8Array([1]), contentType: 'image/png' },
      ))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const followup = harness.agents.created[0]!.agent.followup
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
      const first = followup.mock.calls[0]![0].content[0]!
      expect(first.type === 'text' && first.text).toContain('没有组合附件存储')
      await harness.dispose()
    })

    it('does not pass images to a route that was not declared to accept them', async () => {
      const attachments = createFakeAttachments()
      // A route that rejects image content rejects the whole request, and the
      // image is in the log by then — every later turn resends it.
      const harness = await mountChannel({}, { attachments: attachments.service })
      await harness.fake.emitMessage(withImage(
        harness,
        [{ fileKey: 'img_1', fileName: 'shot.png' }],
        { buffer: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      ))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const followup = harness.agents.created[0]!.agent.followup
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })

      const content = followup.mock.calls[0]![0].content
      expect(content).toHaveLength(1)
      const first = content[0]!
      expect(first.type === 'text' && first.text).toContain('未向模型传递图片')
      expect(attachments.saved).toEqual([])
      await harness.dispose()
    })

    it('tells the chat when a failure will repeat forever', async () => {
      const harness = await mountChannel({ showProcess: false })
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      harness.ctx.emit('session/event', harness.agents.created[0]!.agent.session, {
        type: 'turn/end',
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            error: { code: 'UNSUPPORTED_CONTENT', message: 'no image support' },
          },
        },
      })

      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      const line = (harness.fake.sent[0]!.input as { text: string }).text
      // Echoing the code alone leaves someone retrying it forever.
      expect(line).toContain('之后每轮都会以同样原因失败')
      await harness.dispose()
    })

    it('keeps the turn when a download fails', async () => {
      const attachments = createFakeAttachments()
      const harness = await mountChannel({ attachImages: true }, { attachments: attachments.service })
      // The transport serves nothing for this key.
      await harness.fake.emitMessage(fakeMessage({
        content: '看这个', resources: [{ type: 'image', fileKey: 'missing' }],
      }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const followup = harness.agents.created[0]!.agent.followup
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
      const first = followup.mock.calls[0]![0].content[0]!
      expect(first.type === 'text' && first.text).toContain('附加失败')
      await harness.dispose()
    })
  })

  describe('slash commands', () => {
    it('runs a host command instead of prompting the model', async () => {
      const commands = createFakeCommands([{ name: 'clear', description: '开始新的对话' }])
      const harness = await mountChannel({}, { commands: commands.service })
      await harness.fake.emitMessage(fakeMessage({ content: '/clear' }))
      await vi.waitFor(() => { expect(commands.executed).toEqual(['/clear']) })

      // The model never sees the line: a command is a control, not a prompt.
      const created = harness.agents.created[0]!
      expect(created.agent.followup).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === 'ran clear')).toBe(true)
      })
      await harness.dispose()
    })

    it('stops the running turn', async () => {
      const harness = await mountChannel({}, { commands: createFakeCommands().service })
      await harness.fake.emitMessage(fakeMessage({ content: 'do something long' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const created = harness.agents.created[0]!

      await harness.fake.emitMessage(fakeMessage({ content: '/stop' }))
      // Cancellation is an agent method, not a registered command.
      await vi.waitFor(() => { expect(created.agent.cancel).toHaveBeenCalledTimes(1) })
      expect(created.agent.followup).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => {
        expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown.includes('已停止'))).toBe(true)
      })
      await harness.dispose()
    })

    it('lists what the chat accepts', async () => {
      const commands = createFakeCommands([
        { name: 'clear', description: '开始新的对话' },
        { name: 'compact', description: '压缩上下文' },
      ])
      const harness = await mountChannel({}, { commands: commands.service })
      await harness.fake.emitMessage(fakeMessage({ content: '/help' }))
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })

      const listing = (harness.fake.sent[0]!.input as { markdown: string }).markdown
      // Host commands and the channel's own, in one listing.
      expect(listing).toContain('/clear')
      expect(listing).toContain('压缩较早的对话历史')
      expect(listing).toContain('/stop')
      expect(commands.executed).toEqual([])
      await harness.dispose()
    })

    it('names an unknown command instead of feeding it to the model', async () => {
      const commands = createFakeCommands()
      const harness = await mountChannel({}, { commands: commands.service })
      await harness.fake.emitMessage(fakeMessage({ content: '/nope' }))
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })

      const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
      // This is exactly how a typed /stop became a message the bot ignored.
      expect(reply).toContain('未知命令')
      expect(reply).toContain('/clear')
      expect(harness.agents.created[0]!.agent.followup).not.toHaveBeenCalled()
      await harness.dispose()
    })

    it('reports a command that failed', async () => {
      const commands = createFakeCommands(
        [{ name: 'compact', description: '压缩上下文' }],
        { compact: { kind: 'error', text: 'nothing to compact' } },
      )
      const harness = await mountChannel({}, { commands: commands.service })
      await harness.fake.emitMessage(fakeMessage({ content: '/compact' }))
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      expect((harness.fake.sent[0]!.input as { markdown: string }).markdown).toContain('nothing to compact')
      await harness.dispose()
    })

    it('says so when no command runtime is composed', async () => {
      const harness = await mountChannel()
      await harness.fake.emitMessage(fakeMessage({ content: '/clear' }))
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      expect((harness.fake.sent[0]!.input as { markdown: string }).markdown).toContain('没有组合命令运行时')
      await harness.dispose()
    })

    it('leaves ordinary text alone', async () => {
      const commands = createFakeCommands()
      const harness = await mountChannel({}, { commands: commands.service })
      // Only a leading slash marks a control; prose that merely mentions one does not.
      await harness.fake.emitMessage(fakeMessage({ content: '用 /clear 能清空吗？' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1)
      })
      expect(commands.executed).toEqual([])
      await harness.dispose()
    })

  })

    it("publishes what the chat accepts to the bot's slash panel", async () => {
      const commands = createFakeCommands([
        { name: 'clear', description: '开始新的对话' },
        { name: 'compact', description: '压缩上下文' },
      ])
      const harness = await mountChannel({}, { commands: commands.service })
      await harness.fake.emitMessage(fakeMessage())
      // Typing `/` should offer these without anyone having to know them.
      await vi.waitFor(() => { expect(harness.fake.panelCreated).toContain('clear') })
      expect(harness.fake.panelCreated).toEqual(
        expect.arrayContaining(['clear', 'compact', 'stop', 'help']),
      )
      await harness.dispose()
    })

    it('syncs the channel floor at boot, before any message (E3)', async () => {
      const harness = await mountChannel({})
      // No message was emitted: the boot-time sync must still register the
      // channel-owned commands, so a fresh process restores its panel.
      await vi.waitFor(() => {
        expect(harness.fake.panelCreated).toEqual(expect.arrayContaining(['skills', 'model', 'ws', 'help']))
      })
      await harness.dispose()
    })

    it('lists deployed plugins with live status via /plugins', async () => {
      const harness = await mountChannel({}, {
        loader: {
          await: async () => undefined,
          entries: () => [
            { options: { name: 'feishu-channel' }, disabled: false, fiber: { state: 2 } },
            { options: { name: 'agent-presets' }, disabled: false, fiber: { state: 0 } },
          ],
        },
      })
      await harness.fake.emitMessage(fakeMessage({ content: '/plugins' }))
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
      expect(reply).toContain('已部署插件')
      expect(reply).toContain('feishu-channel')
      await harness.dispose()
    })

    it('removes an entry the channel no longer offers', async () => {
      const harness = await mountChannel({}, { commands: createFakeCommands().service })
      // A command dropped from the channel used to stay in the menu and answer
      // "unknown command" for everyone who picked it.
      harness.fake.panelCommands.push('new')
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.fake.panelDeleted).toContain('new') })
      expect(harness.fake.panelCreated).not.toContain('new')
      await harness.dispose()
    })

    it('removes nothing when the sync is off', async () => {
      const harness = await mountChannel(
        { syncSlashCommands: false },
        { commands: createFakeCommands().service },
      )
      harness.fake.panelCommands.push('hand-curated')
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      expect(harness.fake.panelDeleted).toEqual([])
      await harness.dispose()
    })

    it('publishes once, and only what the panel is missing', async () => {
      const harness = await mountChannel({}, { commands: createFakeCommands().service })
      harness.fake.panelCommands.push('clear')
      await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_a' }))
      await vi.waitFor(() => { expect(harness.fake.panelCreated).toContain('help') })
      // An entry already on the panel is not created again: a duplicate is an error.
      expect(harness.fake.panelCreated).not.toContain('clear')

      const afterFirst = harness.fake.panelCreated.length
      await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_b' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
      expect(harness.fake.panelCreated).toHaveLength(afterFirst)
      await harness.dispose()
    })

    it('keeps working when the panel cannot be synced', async () => {
      const harness = await mountChannel({}, { commands: createFakeCommands().service })
      harness.fake.state.failPanelList = true
      await harness.fake.emitMessage(fakeMessage({ content: '/clear' }))
      // Discovery is a convenience; the command still runs typed by hand.
      await vi.waitFor(() => {
        expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === 'ran clear')).toBe(true)
      })
      expect(harness.notices.some((line) => line.includes('panel not synced'))).toBe(true)
      await harness.dispose()
    })

    it('can be turned off', async () => {
      const harness = await mountChannel(
        { syncSlashCommands: false },
        { commands: createFakeCommands().service },
      )
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      expect(harness.fake.panelCreated).toEqual([])
      await harness.dispose()
    })

  describe('workspace grouping', () => {
    it('accounts a chat session under the workspace for its directory', async () => {
      const cwd = process.cwd()
      const workspaces = createFakeWorkspaces({ [cwd]: 'ws_existing' })
      const harness = await mountChannel({ cwd }, { workspaces: workspaces.service })
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(workspaces.attached).toHaveLength(1) })

      // Grouping is an account, not a cwd derivation: without this the GUI
      // files every chat session under Ungrouped.
      const created = harness.agents.created[0]!
      expect(workspaces.attached[0]).toEqual({ workspaceId: 'ws_existing', sessionId: created.sessionId })
      expect(workspaces.created).toEqual([])
      await harness.dispose()
    })

    it('registers the directory when no workspace claims it', async () => {
      const cwd = process.cwd()
      const workspaces = createFakeWorkspaces()
      const harness = await mountChannel({ cwd }, { workspaces: workspaces.service })
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(workspaces.attached).toHaveLength(1) })
      expect(workspaces.created).toEqual([cwd])
      await harness.dispose()
    })

    it('resolves the workspace once for every chat', async () => {
      const cwd = process.cwd()
      const workspaces = createFakeWorkspaces()
      const harness = await mountChannel({ cwd }, { workspaces: workspaces.service })
      await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_a' }))
      await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_b' }))
      await vi.waitFor(() => { expect(workspaces.attached).toHaveLength(2) })
      expect(workspaces.created).toEqual([cwd])
      await harness.dispose()
    })

    it('keeps the chat working when attaching fails', async () => {
      const workspaces = createFakeWorkspaces({ [process.cwd()]: 'ws_existing' })
      workspaces.state.failAttach = true
      const harness = await mountChannel({ cwd: process.cwd() }, { workspaces: workspaces.service })
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })

      // Grouping is presentation; the turn must still run.
      const followup = harness.agents.created[0]!.agent.followup
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
      expect(harness.notices.some((line) => line.includes('stays ungrouped'))).toBe(true)
      await harness.dispose()
    })

    it('runs without a workspace registry composed', async () => {
      const harness = await mountChannel()
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      await harness.dispose()
    })
  })

  describe('streaming output', () => {
    /** Bind one chat and return its session plus a session-event emitter. */
    async function streamingChat(harness: Awaited<ReturnType<typeof mountChannel>>) {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const session = harness.agents.created[0]!.agent.session
      return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
    }

    it('streams text deltas into one card per turn and shows tool activity', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '你' } })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '（内心）' } })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '好' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('你好') })

      emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toContain('🔧 bash') })
      // Reasoning never reaches the chat.
      expect(harness.fake.streams[0]!.content).not.toContain('内心')

      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      // One card for the whole turn, and no duplicate plain message.
      expect(harness.fake.streams).toHaveLength(1)
      expect(harness.fake.sent).toHaveLength(0)
      await harness.dispose()
    })

    it('labels a call with the tool\'s own presentation title', async () => {
      const tools = createFakeTools({
        grep: (args) => ({ title: `Search for ${(args as { pattern: string }).pattern}` }),
      })
      const harness = await mountChannel({ output: 'stream' }, { tools: tools.service })
      const emit = await streamingChat(harness)

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '找一下。' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('tool/call', { turn: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"card view"}' })

      await vi.waitFor(() => {
        expect(harness.fake.streams[0]!.content).toContain('🔧 Search for card view')
      })
      // Ten bare tool names told a reader nothing; this is what each call did.
      expect(harness.fake.streams[0]!.content).not.toContain('🔧 grep\n')
      await harness.dispose()
    })

    it('falls back to the description argument, then the name', async () => {
      const harness = await mountChannel({ output: 'stream' }, { tools: createFakeTools().service })
      const emit = await streamingChat(harness)
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'x' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })

      emit('tool/call', {
        turn: 1, callId: 'c1', name: 'bash',
        arguments: '{"command":"ls -la","description":"List files in the web app"}',
      })
      await vi.waitFor(() => {
        expect(harness.fake.streams[0]!.content).toContain('🔧 bash · List files in the web app')
      })

      // Malformed model JSON still yields a line rather than losing the activity.
      emit('tool/call', { turn: 1, callId: 'c2', name: 'glob', arguments: '{not json' })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toContain('🔧 glob') })
      await harness.dispose()
    })

    it('bounds a title and keeps it on one line', async () => {
      const tools = createFakeTools({
        bash: () => ({ title: `line one\nline two \`\`\`fence${'x'.repeat(200)}` }),
      })
      const harness = await mountChannel({ output: 'stream' }, { tools: tools.service })
      const emit = await streamingChat(harness)
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'x' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })

      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toContain('line one line two') })
      const label = harness.fake.streams[0]!.content.split('🔧 ')[1]!.split('\n')[0]!
      // A newline or a fence in a model-influenced value could restructure the card.
      expect(label).not.toContain('`')
      expect(label.length).toBeLessThanOrEqual(90)
      await harness.dispose()
    })

    it('warms the card up at the step boundary, before any text arrives', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)

      emit('step/start', { turn: 1, step: 1 })
      // The card exists and is empty: creating it costs two round trips, and
      // doing that now overlaps them with the model's time to first token
      // instead of with its output, which is what made a whole reply land at once.
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      expect(harness.fake.streams[0]!.content).toBe('')

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '你' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('你') })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '好' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('你好') })
      // Two appends, not one batch.
      expect(harness.fake.streams[0]!.ops.filter((op) => 'append' in op)).toHaveLength(2)
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      await harness.dispose()
    })

    it('closes an idle warmed-up card honestly', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      emit('step/start', { turn: 1, step: 1 })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      // Otherwise the card sits on the transport's placeholder forever.
      expect(harness.fake.streams[0]!.content).toBe('（本轮没有产生输出）')
      await harness.dispose()
    })

    it('streams thinking, then replaces it with the answer', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      emit('step/start', { turn: 1, step: 1 })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })

      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先看目录' } })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '，再回答。' } })
      // The wait is visible instead of silent.
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('先看目录，再回答。') })

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '你好' } })
      // One rewrite drops the thinking; the answer is not appended after it.
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('你好') })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '！' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('你好！') })

      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好！' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      expect(harness.fake.streams[0]!.content).toBe('你好！')
      await harness.dispose()
    })

    it('shows no process when it is switched off', async () => {
      const harness = await mountChannel({ output: 'stream', showProcess: false })
      const emit = await streamingChat(harness)
      emit('step/start', { turn: 1, step: 1 })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })

      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '内心戏' } })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '答案' } })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toBe('答案') })
      expect(harness.fake.streams[0]!.ops.every((op) => !JSON.stringify(op).includes('内心戏'))).toBe(true)
      await harness.dispose()
    })

    it('drops thinking that led only to a tool call', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      emit('step/start', { turn: 1, step: 1 })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })

      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '该看文件了' } })
      emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
      await vi.waitFor(() => { expect(harness.fake.streams[0]!.content).toContain('🔧 bash') })
      expect(harness.fake.streams[0]!.content).not.toContain('该看文件了')
      await harness.dispose()
    })

    it('closes a card that only ever produced thinking', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      emit('step/start', { turn: 1, step: 1 })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想了但没说' } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      // Transient thinking is not an answer, so the card says so instead of
      // keeping raw reasoning as if it were one.
      expect(harness.fake.streams[0]!.content).toBe('（本轮没有产生输出）')
      await harness.dispose()
    })

    it('opens a separate card per turn', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'first' } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      emit('assistant/chunk', { turn: 2, chunk: { type: 'text-delta', text: 'second' } })
      emit('turn/end', { turn: 2, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(2) })
      await vi.waitFor(() => { expect(harness.fake.streams.every((card) => card.closed)).toBe(true) })
      expect(harness.fake.streams[0]!.content).toBe('first')
      expect(harness.fake.streams[1]!.content).toBe('second')
      await harness.dispose()
    })

    it('corrects the card when the committed text carried markup', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      const leaked = '看一下。\n\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="exec_command">\n</｜｜DSML｜｜tool_calls>'

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: leaked } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: leaked }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      // The raw deltas streamed, then setContent replaced them with clean text.
      expect(harness.fake.streams[0]!.content).not.toContain('DSML')
      expect(harness.fake.streams[0]!.content).toContain('未被识别的工具调用标记')
      expect(harness.fake.streams[0]!.ops.some((op) => 'set' in op)).toBe(true)
      await harness.dispose()
    })

    it('appends a failed turn to its card', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '开始' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_MODEL', message: 'boom' } } })

      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      expect(harness.fake.streams[0]!.content).toContain('E_MODEL: boom')
      await harness.dispose()
    })

    it('reports a failure that produced no card as a plain message', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_KEY', message: 'no key' } } })

      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      const input = harness.fake.sent[0]!.input
      expect('text' in input && input.text).toBe('⚠️ 本轮任务失败 E_KEY: no key')
      expect(harness.fake.streams).toHaveLength(0)
      await harness.dispose()
    })

    it('falls back to a plain message when streaming is rejected', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      harness.fake.state.failStreams = true

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '答案' } })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      // The answer still arrives, as an ordinary markdown message.
      await vi.waitFor(() => {
        expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
      })
      await harness.dispose()
    })

    it('shows no tool activity when the process is off', async () => {
      const harness = await mountChannel({ output: 'stream', showProcess: false })
      const emit = await streamingChat(harness)

      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'x' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })
      emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.streams[0]!.closed).toBe(true) })
      expect(harness.fake.streams[0]!.content).toBe('x')
      await harness.dispose()
    })

    it('settles an open card on disposal', async () => {
      const harness = await mountChannel({ output: 'stream' })
      const emit = await streamingChat(harness)
      emit('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '半句' } })
      await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })

      await harness.dispose()
      expect(harness.fake.streams[0]!.closed).toBe(true)
      expect(harness.fake.streams[0]!.content).toBe('半句')
    })
  })

  describe('approval precedence over a host answerer', () => {
  it('answers its own chats before a host answerer that claims everything', async () => {
    const competing = { claims: [] as { toolName: string }[] }
    // Asserts on the streaming card, so it names the output rather than
    // riding whichever one is default.
    const harness = await mountChannel({ output: 'stream' }, { competingAnswerer: competing })
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const created = harness.agents.created[0]!

    // A turn mid-stream, exactly the state a sandbox escalation asks from.
    harness.ctx.emit('session/event', created.agent.session, {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'text-delta', text: '我先看一下。' } },
    })
    await vi.waitFor(() => { expect(harness.fake.streams).toHaveLength(1) })

    const outcome = harness.ctx.waterfall(
      'approval/request',
      { agent: created.agent, toolName: 'bash', reason: 'escalate sandbox to danger-full-access' },
      async (): Promise<HostApprovalOutcome> => 'unavailable',
    )

    // The chat gets the card, and the host answerer never claimed the question.
    await vi.waitFor(() => { expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(true) })
    expect(competing.claims).toEqual([])

    const card = harness.fake.sent.find((m) => 'card' in m.input)!.input as { card: object }
    const allow = approvalValueFromCard(card.card).find((v) => v.decision === 'allow')!
    await harness.fake.emitCardAction(clickAction(allow))
    expect(await outcome).toBe('allowed-once')
    await harness.dispose()
  })

  it('still delegates a foreign session to the host answerer', async () => {
    const competing = { claims: [] as { toolName: string }[] }
    // Asserts on the streaming card, so it names the output rather than
    // riding whichever one is default.
    const harness = await mountChannel({ output: 'stream' }, { competingAnswerer: competing })
    harness.ctx.waterfall(
      'approval/request',
      { agent: { id: 'other', session: { id: 'other' }, followup: () => {}, cancel: () => {} }, toolName: 'fs_write' },
      async (): Promise<HostApprovalOutcome> => 'unavailable',
    ).catch(() => undefined)

    await vi.waitFor(() => { expect(competing.claims).toEqual([{ toolName: 'fs_write' }]) })
    expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(false)
    await harness.dispose()
  })
  })

  describe('authorization', () => {
    it('serves direct messages and groups with nothing configured', async () => {
      // Who can reach the bot at all is the app's visibility scope, decided in
      // the developer console; narrowing again here by default only adds friction.
      const harness = await mountChannel()
      await vi.waitFor(() => { expect(harness.fake.state.connects).toBe(1) })
      expect(harness.portAuthorizations[0]!.directSenders).toEqual([])

      await harness.fake.emitMessage(fakeMessage({ senderId: 'ou_colleague' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      await harness.fake.emitMessage(fakeMessage({ chatType: 'group', chatId: 'oc_team' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
      await harness.dispose()
    })

    it('narrows direct messages to senderAllowlist when set', async () => {
      const harness = await mountChannel({ senderAllowlist: ['ou_ops'] })
      await harness.fake.emitMessage(fakeMessage({ senderId: 'ou_ops' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })

      await harness.fake.emitMessage(fakeMessage({ senderId: 'ou_stranger', chatId: 'oc_dm2' }))
      await new Promise((done) => { setTimeout(done, 30) })
      expect(harness.agents.created).toHaveLength(1)
      // Silent in the chat; named on the console.
      expect(harness.fake.sent).toHaveLength(0)
      expect(harness.notices.some((line) => line.includes('ou_stranger is not in senderAllowlist'))).toBe(true)
      // The transport is narrowed to match, so unauthorized traffic stops earlier too.
      expect(harness.portAuthorizations[0]!.directSenders).toEqual(['ou_ops'])
      await harness.dispose()
    })

    it('does not gate group members individually', async () => {
      const harness = await mountChannel({ senderAllowlist: ['ou_ops'] })
      // A narrowed direct list says nothing about a room someone added the bot to.
      await harness.fake.emitMessage(fakeMessage({
        chatType: 'group', chatId: 'oc_team', senderId: 'ou_colleague',
      }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      await harness.dispose()
    })

    it('narrows groups to groupAllowlist when set', async () => {
      const harness = await mountChannel({ groupAllowlist: ['oc_allowed'] })
      await harness.fake.emitMessage(fakeMessage({ chatType: 'group', chatId: 'oc_other' }))
      await new Promise((done) => { setTimeout(done, 30) })
      expect(harness.agents.created).toHaveLength(0)
      expect(harness.notices.some((line) => line.includes('not in groupAllowlist'))).toBe(true)

      await harness.fake.emitMessage(fakeMessage({ chatType: 'group', chatId: 'oc_allowed' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      await harness.dispose()
    })

    it('states its reach on the operator console', async () => {
      const harness = await mountChannel({ approvers: ['ou_lead'] })
      await vi.waitFor(() => {
        expect(harness.notices.some((line) => line.includes('approvals: ou_lead'))).toBe(true)
      })
      expect(harness.notices.some((line) => line.includes('anyone the app is visible to'))).toBe(true)
      await harness.dispose()
    })

    it('reports who registered the app without authorizing on it', async () => {
      const store = createFakeSettings()
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          settings: store.settings,
          registerApp: async () => ({
            client_id: 'cli_new',
            client_secret: 'new-secret',
            user_info: { open_id: 'ou_scanner' },
          }),
        },
      )
      await vi.waitFor(() => { expect(harness.fake.state.connects).toBe(1) })
      expect(store.updates).toEqual([
        { appId: 'cli_new', appSecret: 'new-secret', registeredBy: 'ou_scanner' },
      ])
      // Recorded for reference; it narrows nothing on its own.
      expect(harness.portAuthorizations[0]!.directSenders).toEqual([])
      await harness.dispose()
    })
  })

  describe('approval card safety', () => {
    /** Bind a chat, publish a tool call, and ask for approval of it. */
    async function escalation(
      harness: Awaited<ReturnType<typeof mountChannel>>,
      args: string,
      chatType: 'p2p' | 'group' = 'p2p',
    ) {
      await harness.fake.emitMessage(fakeMessage({ chatType }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const created = harness.agents.created[0]!
      harness.ctx.emit('session/event', created.agent.session, {
        type: 'tool/call',
        data: { turn: 1, callId: 'call_1', name: 'bash', arguments: args },
      })
      const outcome = harness.ctx.waterfall(
        'approval/request',
        {
          agent: created.agent,
          toolName: 'bash',
          callId: 'call_1',
          reason: 'escalate sandbox to danger-full-access: **看起来无害**',
        },
        async (): Promise<HostApprovalOutcome> => 'unavailable',
      )
      await vi.waitFor(() => { expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(true) })
      const card = harness.fake.sent.find((m) => 'card' in m.input)!.input as { card: object }
      return { outcome, card: card.card, values: approvalValueFromCard(card.card) }
    }

    /** Every element of a card, flattened for content assertions. */
    function elementsOf(card: object): { tag: string; text?: { tag: string; content: string } }[] {
      return (card as { elements: { tag: string; text?: { tag: string; content: string } }[] }).elements
    }

    it('shows the exact command, as literal text', async () => {
      const harness = await mountChannel()
      const { card } = await escalation(harness, '{"command":"rm -rf important-data"}')
      const elements = elementsOf(card)

      const shown = elements.find((e) => e.text?.content.includes('rm -rf important-data'))
      expect(shown).toBeDefined()
      // Model-authored values render literally, so neither the command nor the
      // justification can pose as the card's own markup.
      expect(shown!.text!.tag).toBe('plain_text')
      const justification = elements.find((e) => e.text?.content.includes('看起来无害'))
      expect(justification!.text!.tag).toBe('plain_text')
      await harness.dispose()
    })

    it('bounds an oversized command', async () => {
      const harness = await mountChannel()
      const { card } = await escalation(harness, `{"command":"${'x'.repeat(2000)}"}`)
      const shown = elementsOf(card).find((e) => e.text?.content.startsWith('{"command":"xxx'))
      expect(shown!.text!.content.length).toBeLessThanOrEqual(600)
      expect(shown!.text!.content.endsWith('…')).toBe(true)
      await harness.dispose()
    })

    it('lets anyone in a group answer, and names who did', async () => {
      const harness = await mountChannel()
      const { outcome, values } = await escalation(harness, '{"command":"ls"}', 'group')
      const allow = values.find((v) => v.decision === 'allow')!

      // No approvers configured: the room decides, as it drives.
      await harness.fake.emitCardAction(clickAction(allow, { openId: 'ou_colleague', name: '同事' }))
      expect(await outcome).toBe('allowed-once')
      await vi.waitFor(() => { expect(harness.fake.updated).toHaveLength(1) })
      const settled = JSON.stringify(harness.fake.updated[0]!.card)
      expect(settled).toContain('同事')
      await harness.dispose()
    })

    it('restricts the decision to configured approvers', async () => {
      const harness = await mountChannel({ approvers: ['ou_lead'] })
      const { outcome, values } = await escalation(harness, '{"command":"ls"}', 'group')
      const allow = values.find((v) => v.decision === 'allow')!

      const response = await harness.fake.emitCardAction(clickAction(allow, { openId: 'ou_bystander' }))
      expect(response).toEqual({ toast: { type: 'error', content: '你无权批准此操作' } })
      expect(harness.notices.some((line) => line.includes('ou_bystander is not in approvers'))).toBe(true)

      // Still pending until the named human presses it.
      await harness.fake.emitCardAction(clickAction(allow, { openId: 'ou_lead' }))
      expect(await outcome).toBe('allowed-once')
      await harness.dispose()
    })

    it('refuses a direct-message approval from a narrowed-out sender', async () => {
      const harness = await mountChannel({ senderAllowlist: [SENDER_ID] })
      const { outcome, values } = await escalation(harness, '{"command":"ls"}')
      const allow = values.find((v) => v.decision === 'allow')!

      // A direct chat is judged by its sender rule, so a narrowed-out id cannot answer.
      const response = await harness.fake.emitCardAction(clickAction(allow, { openId: 'ou_stranger' }))
      expect(response).toEqual({ toast: { type: 'error', content: '你无权批准此操作' } })
      await harness.fake.emitCardAction(clickAction(allow))
      expect(await outcome).toBe('allowed-once')
      await harness.dispose()
    })

    it('rejects a click arriving from another chat', async () => {
      const harness = await mountChannel()
      const { outcome, values } = await escalation(harness, '{"command":"ls"}')
      const allow = values.find((v) => v.decision === 'allow')!

      const response = await harness.fake.emitCardAction(clickAction(allow, { chatId: 'oc_elsewhere' }))
      expect(response).toEqual({ toast: { type: 'error', content: '你无权批准此操作' } })
      await harness.fake.emitCardAction(clickAction(allow))
      expect(await outcome).toBe('allowed-once')
      await harness.dispose()
    })
  })

  describe('first-boot QR onboarding', () => {
    it('registers an app and connects when no credentials are configured', async () => {
      const requests: RegisterAppRequest[] = []
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          registerApp: async (request) => {
            requests.push(request)
            request.onQRCodeReady({ url: 'https://example.local/qr', expireIn: 600 })
            return { client_id: 'cli_new', client_secret: 'new-secret' }
          },
        },
      )
      await vi.waitFor(() => { expect(harness.fake.state.subscriptions).toBe(INBOUND_SUBSCRIPTIONS) })
      expect(requests).toHaveLength(1)
      // Selecting an existing app stays available: the confirm page shows the
      // config diff and requires re-authorization, so hiding it only forced
      // app proliferation.
      expect('createOnly' in requests[0]!).toBe(false)
      expect(harness.notices.some((line) => line.includes('https://example.local/qr'))).toBe(true)
      expect(harness.portConfigs[0]!.appId).toBe('cli_new')
      expect(harness.portConfigs[0]!.appSecret).toBe('new-secret')

      // The connected bridge is fully functional after onboarding.
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      await harness.dispose()
    })

    it('persists scanned credentials through the settings service', async () => {
      const store = createFakeSettings()
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          settings: store.settings,
          registerApp: async () => ({ client_id: 'cli_new', client_secret: 'new-secret' }),
        },
      )
      await vi.waitFor(() => { expect(harness.fake.state.subscriptions).toBe(INBOUND_SUBSCRIPTIONS) })
      expect(store.registered[0]!.ns).toBe('dsh-lark-bridge')
      expect(store.updates).toEqual([{ appId: 'cli_new', appSecret: 'new-secret' }])
      await harness.dispose()
    })

    it('uses credentials stored in settings without re-registering', async () => {
      const store = createFakeSettings({ appId: 'cli_stored', appSecret: 'stored-secret' })
      const registerApp = vi.fn<RegisterAppPort>()
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        { settings: store.settings, registerApp },
      )
      await vi.waitFor(() => { expect(harness.fake.state.subscriptions).toBe(INBOUND_SUBSCRIPTIONS) })
      expect(registerApp).not.toHaveBeenCalled()
      expect(harness.portConfigs[0]!.appId).toBe('cli_stored')
      await harness.dispose()
    })

    it('shows the code as a scannable drawing beside its URL', async () => {
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          registerApp: async (request) => {
            request.onQRCodeReady({ url: 'https://example.local/qr', expireIn: 600 })
            return { client_id: 'cli_new', client_secret: 'new-secret' }
          },
        },
      )
      // The console of a deployment that needs onboarding is usually a server's:
      // a URL there needs a browser already logged into Feishu ON THAT HOST,
      // which is nobody. A drawn code is scanned with the phone the flow expects.
      await vi.waitFor(() => {
        expect(harness.notices.some((line) => line.includes('▀') || line.includes('█'))).toBe(true)
      })
      expect(harness.notices.some((line) => line.includes('https://example.local/qr'))).toBe(true)
      await harness.dispose()
    })

    it('issues a fresh code when nobody scanned the last one in time', async () => {
      const rounds: string[] = []
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          registerApp: async (request) => {
            rounds.push('issued')
            request.onQRCodeReady({ url: `https://example.local/qr/${String(rounds.length)}`, expireIn: 600 })
            // A code lives ten minutes; an operator who installs the plugin and
            // gets to it later is the ORDINARY case, so expiry cannot be the end
            // of the flow — it used to report a failure and never try again,
            // leaving a restart as the only way back.
            if (rounds.length === 1) throw { code: 'expired_token', description: 'Polling timed out' }
            return { client_id: 'cli_new', client_secret: 'new-secret' }
          },
        },
      )
      await vi.waitFor(() => { expect(harness.fake.state.subscriptions).toBe(INBOUND_SUBSCRIPTIONS) })
      expect(rounds).toHaveLength(2)
      expect(harness.notices.some((line) => line.includes('上一个二维码已过期，这是第 2 个'))).toBe(true)
      expect(harness.portConfigs[0]!.appId).toBe('cli_new')
      await harness.dispose()
    })

    it('stops on a refusal, naming the reason it was given', async () => {
      const attempts: string[] = []
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          registerApp: async () => {
            attempts.push('issued')
            // The flow rejects with a plain `{ code, description }` object rather
            // than an Error, so stringifying it reported `[object Object]`.
            throw { code: 'access_denied', description: 'User declined the authorization' }
          },
        },
      )
      await vi.waitFor(() => {
        expect(harness.notices.some((line) => line.includes('access_denied'))).toBe(true)
      })
      expect(harness.notices.some((line) => line.includes('User declined the authorization'))).toBe(true)
      expect(harness.notices.every((line) => !line.includes('[object Object]'))).toBe(true)
      // A refusal is a human decision; a new code would not supply one.
      expect(attempts).toHaveLength(1)
      expect(harness.portConfigs).toHaveLength(0)
      await harness.dispose()
    })

    it('withdraws a pending scan on disposal', async () => {
      let seenSignal: AbortSignal | undefined
      const harness = await mountChannel(
        { appId: undefined, appSecret: undefined },
        {
          registerApp: (request) => {
            seenSignal = request.signal
            return new Promise(() => {})
          },
        },
      )
      await vi.waitFor(() => { expect(seenSignal).toBeDefined() })
      await harness.dispose()
      expect(seenSignal!.aborted).toBe(true)
      expect(harness.portConfigs).toHaveLength(0)
      expect(harness.fake.state.subscriptions).toBe(0)
    })
  })

  it('registers the invariant companion through its local host contract', async () => {
    const ctx = new Context()
    const unregister = vi.fn()
    const register = vi.fn<(packageName: string, installer: unknown) => () => void>(() => unregister)
    const removeService = ctx.provide('invariants', { register })

    const fiber = await ctx.plugin(invariant)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toBe('dsh-lark-bridge')
    expect(typeof register.mock.calls[0]?.[1]).toBe('function')

    await fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
    await removeService()
  })
})
