import { describe, expect, it, vi } from 'vitest'
import {
  AUDIT_COMMAND,
  CONFIG_COMMAND,
  PRESET_COMMAND,
  PRESET_NAMES,
  runCommandLine,
  SCHEDULES_COMMAND,
  SESSIONS_COMMAND,
  SHIPPED_PRESET_IDS,
  TOOLS_COMMAND,
} from '../src/commands.ts'
import type { AuditStats, HostAgent, HostAgentPresets, HostCommands, HostSessionPersistence, ScheduleEntry } from '../src/host.ts'
import type { ResolvedConfig } from '../src/config.ts'
import type { Context } from '@deepseek-ai/cordis'

/** A fake agent whose scoped context carries the preset join. */
function fakeAgent(ctx: Context | undefined = undefined): HostAgent {
  return {
    id: 'ses_1',
    session: { id: 'ses_1' },
    followup: vi.fn(),
    cancel: vi.fn(),
    ...ctx === undefined ? {} : { ctx },
  } as unknown as HostAgent
}

/** A fake roster recording recompose calls. */
function fakePresets(overrides: Partial<HostAgentPresets> = {}): HostAgentPresets & { recomposed: string[] } {
  const recomposed: string[] = []
  return {
    defaultId: 'standard',
    resolve: async () => ({ id: 'standard' }),
    mount: async () => undefined,
    standingKeyFor: async () => ({}),
    list: async () => SHIPPED_PRESET_IDS.map(id => ({ id, trust: 'system' as const, name: PRESET_NAMES[id] })),
    composedPreset: () => 'standard',
    recompose: async (_ctx: Context, id: string) => { recomposed.push(id) },
    ...overrides,
    recomposed,
  }
}

describe('/preset command', () => {
  it('lists the four shipped presets with the current one marked', async () => {
    const presets = fakePresets()
    const outcome = await runCommandLine(
      `/${PRESET_COMMAND}`,
      fakeAgent({} as Context),
      undefined,
      new AbortController().signal,
      presets,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('标准模式')
    expect(outcome.reply).toContain('极简模式')
    expect(outcome.reply).toContain('PTC 模式')
    expect(outcome.reply).toContain('创造模式')
    expect(outcome.reply).toContain('← 当前')
  })

  it('switches a blank agent to a named preset', async () => {
    const presets = fakePresets()
    const outcome = await runCommandLine(
      `/${PRESET_COMMAND} minimal`,
      fakeAgent({} as Context),
      undefined,
      new AbortController().signal,
      presets,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('极简模式')
    expect(presets.recomposed).toEqual(['minimal'])
  })

  it('refuses an unknown preset id', async () => {
    const presets = fakePresets()
    const outcome = await runCommandLine(
      `/${PRESET_COMMAND} turbo`,
      fakeAgent({} as Context),
      undefined,
      new AbortController().signal,
      presets,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('未知模式')
    expect(presets.recomposed).toEqual([])
  })

  it('reports when the current preset is already selected', async () => {
    const presets = fakePresets()
    const outcome = await runCommandLine(
      `/${PRESET_COMMAND} standard`,
      fakeAgent({} as Context),
      undefined,
      new AbortController().signal,
      presets,
    )
    expect(outcome.reply).toContain('当前已是')
    expect(presets.recomposed).toEqual([])
  })

  it('explains that a produced session cannot switch', async () => {
    const presets = fakePresets({
      recompose: async () => { throw new Error('agent-preset-locked: session has produced') },
    })
    const outcome = await runCommandLine(
      `/${PRESET_COMMAND} code`,
      fakeAgent({} as Context),
      undefined,
      new AbortController().signal,
      presets,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('切换失败')
    expect(outcome.reply).toContain('/new')
  })

  it('reports when no roster is composed', async () => {
    const outcome = await runCommandLine(
      `/${PRESET_COMMAND}`,
      fakeAgent({} as Context),
      undefined,
      new AbortController().signal,
      undefined,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('agent-presets')
  })
})

describe('/sessions command', () => {
  /** A fake store with the given session headers. */
  function fakeStore(headers: { id: string; createdAt: number }[]): HostSessionPersistence {
    return { list: async () => headers }
  }

  it('lists this chat sessions, newest first, marking the current one', async () => {
    const store = fakeStore([
      { id: 'feishu-oc_chat_1', createdAt: 1_700_000_000_000 },
      { id: 'feishu-oc_chat_2', createdAt: 1_700_000_500_000 },
      { id: 'feishu-oc_chat_1:ou_sender', createdAt: 1_700_000_400_000 },
    ])
    const agent = { ...fakeAgent(), session: { id: 'feishu-oc_chat_1' } } as unknown as HostAgent
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND}`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      store,
      'oc_chat_1',
    )
    expect(outcome.resolved).toBe(true)
    // The whole-chat session is current; the other chat's session is excluded.
    expect(outcome.reply).toContain('2 个')
    expect(outcome.reply).toContain('← 当前')
    expect(outcome.reply).not.toContain('oc_chat_2')
  })

  it('reports an empty history', async () => {
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      fakeStore([]),
      'oc_chat_1',
    )
    expect(outcome.reply).toContain('还没有')
  })

  it('reports when the session store is absent', async () => {
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      'oc_chat_1',
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('会话存储')
  })
})

describe('/tools command', () => {
  it('lists the current denied tools', async () => {
    const outcome = await runCommandLine(
      `/${TOOLS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      new Set(['bash']),
    )
    expect(outcome.reply).toContain('bash')
    expect(outcome.reply).toContain('1')
  })

  it('denies a tool at runtime', async () => {
    const denied = new Set(['bash'])
    const outcome = await runCommandLine(
      `/${TOOLS_COMMAND} deny web_search`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      denied,
    )
    expect(outcome.reply).toContain('已禁用')
    expect(denied.has('web_search')).toBe(true)
  })

  it('allows a denied tool back', async () => {
    const denied = new Set(['bash', 'web_search'])
    const outcome = await runCommandLine(
      `/${TOOLS_COMMAND} allow bash`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      denied,
    )
    expect(outcome.reply).toContain('已允许')
    expect(denied.has('bash')).toBe(false)
    expect(denied.has('web_search')).toBe(true)
  })

  it('reports when no runtime switch exists', async () => {
    const outcome = await runCommandLine(
      `/${TOOLS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('工具开关')
  })
})

describe('/schedules command', () => {
  const schedule = (id: string, kind: ScheduleEntry['kind'], prompt: string): ScheduleEntry =>
    ({ id, kind, prompt, createdAt: 1_700_000_000_000 })

  it('lists the session active schedules', async () => {
    const agent = fakeAgent()
    const schedules = new Map<string, Map<string, ScheduleEntry>>([
      [agent.session.id, new Map([
        ['s1', schedule('s1', 'after', '10 分钟后提醒我喝水')],
        ['s2', schedule('s2', 'every', '每小时汇总一次进度')],
      ])],
    ])
    const outcome = await runCommandLine(
      `/${SCHEDULES_COMMAND}`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      schedules,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('2 个活跃')
    expect(outcome.reply).toContain('延时')
    expect(outcome.reply).toContain('周期')
    expect(outcome.reply).toContain('喝水')
  })

  it('reports an empty schedule registry', async () => {
    const agent = fakeAgent()
    const schedules = new Map<string, Map<string, ScheduleEntry>>([[agent.session.id, new Map()]])
    const outcome = await runCommandLine(
      `/${SCHEDULES_COMMAND}`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      schedules,
    )
    expect(outcome.reply).toContain('没有活跃')
  })

  it('reports when schedules are not tracked', async () => {
    const outcome = await runCommandLine(
      `/${SCHEDULES_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('定时提醒')
  })
})

describe('/audit command', () => {
  const stats = (overrides: Partial<AuditStats> = {}): AuditStats => ({
    startedAt: 1_700_000_000_000,
    turns: 5, steps: 12, toolCalls: 30, turnErrors: 1,
    compactions: 2, retries: 3, subagents: 4, workflows: 1, schedules: 2,
    ...overrides,
  })

  it('renders the operation counters', async () => {
    const agent = fakeAgent()
    const audits = new Map<string, AuditStats>([[agent.session.id, stats()]])
    const outcome = await runCommandLine(
      `/${AUDIT_COMMAND}`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      audits,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('轮次：5')
    expect(outcome.reply).toContain('工具调用：30')
    expect(outcome.reply).toContain('出错 1，20%')
    expect(outcome.reply).toContain('上下文压缩：2')
    expect(outcome.reply).toContain('子代理：4')
  })

  it('reports a session with no recorded operations', async () => {
    const agent = fakeAgent()
    const outcome = await runCommandLine(
      `/${AUDIT_COMMAND}`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map([[agent.session.id, stats({ turns: 0, toolCalls: 0 } as Partial<AuditStats>)]]),
    )
    expect(outcome.reply).toContain('0%')
  })

  it('reports when audit is not enabled', async () => {
    const outcome = await runCommandLine(
      `/${AUDIT_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('审计')
  })
})

describe('/config command', () => {
  const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    appId: 'cli_secret',
    appSecret: 'top-secret',
    sessionScope: 'chat',
    output: 'cot',
    showProcess: true,
    attachImages: false,
    hideProcessWhenDone: false,
    syncSlashCommands: true,
    onboarding: true,
    denyTools: ['web_search'],
    requireMention: true,
    reactionFeedback: true,
    senderAllowlist: [],
    groupAllowlist: [],
    approvers: [],
    autoResumeGoals: true,
    approvalReminderMs: 120_000,
    ...overrides,
  })

  it('renders the live configuration with credentials redacted', async () => {
    const outcome = await runCommandLine(
      `/${CONFIG_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      config(),
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('会话维度：chat')
    expect(outcome.reply).toContain('禁用工具：web_search')
    expect(outcome.reply).toContain('审批提醒：120s')
    expect(outcome.reply).toContain('自动恢复目标：开')
    // Credentials never reach the chat.
    expect(outcome.reply).not.toContain('cli_secret')
    expect(outcome.reply).not.toContain('top-secret')
  })

  it('reports when no config snapshot exists', async () => {
    const outcome = await runCommandLine(
      `/${CONFIG_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('配置')
  })
})
