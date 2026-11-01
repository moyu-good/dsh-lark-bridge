import { describe, expect, it, vi } from 'vitest'
import {
  AUDIT_COMMAND,
  setRestartScheduler,
  setRestartRequestRecorder,
  CONFIG_COMMAND,
  CONTEXT_COMMAND,
  FEEDBACK_COMMAND,
  JOBS_COMMAND,
  MODEL_COMMAND,
  PRESET_COMMAND,
  PRESET_NAMES,
  runCommandLine,
  SCHEDULES_COMMAND,
  SESSIONS_COMMAND,
  SHIPPED_PRESET_IDS,
  SKILLS_COMMAND,
  TOOLS_COMMAND,
  WS_COMMAND,
} from '../src/commands.ts'
import type { AuditStats, HostAgent, HostAgentPresets, HostCommands, HostSessionPersistence, ScheduleEntry } from '../src/host.ts'
import type { ResolvedConfig } from '../src/config.ts'
import type { Context } from '@deepseek-ai/cordis'

/** A fake agent whose scoped context carries the preset join. */
function fakeAgent(ctx: Context | undefined = undefined): HostAgent {
  return {
    id: 'ses_1',
    // The session carries what the host's token meter replays the log
    // through: `seq` and `eventAt()`. A session that only has an id is the
    // shape that made the meter report zero tokens for every session.
    session: { id: 'ses_1', seq: 0, eventAt: () => undefined },
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
    // The persistence store hands back snapshots, and the header sits one
    // level down inside each. A flat record here would let the bridge read
    // `id` off a shape the host never sends.
    return { list: async () => headers.map(header => ({ header })) }
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

  // 一个用了几个月的聊天能攒出上百个会话：列全会撑爆一张回复的载荷上限，
  // 也把最近的几个挤出视野。取最近的 N 个，剩下的只报数量。
  it('caps a long history at the newest rows and says how many are left', async () => {
    const headers = Array.from({ length: 45 }, (_, i) => ({
      id: `feishu-oc_chat_1:r${String(i).padStart(4, '0')}`,
      createdAt: 1_700_000_000_000 + i * 1_000,
    }))
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      fakeStore(headers),
      'oc_chat_1',
    )
    expect(outcome.reply).toContain('45 个')
    expect(outcome.reply).toContain('还有 25 个更早的未列出')
    // 列表行以 `·` 开头，前面的标题与提示不算。
    const rows = outcome.reply.split('\n').filter(line => line.startsWith('·'))
    expect(rows).toHaveLength(20)
  })

  it('reports an empty history', async () => {    const outcome = await runCommandLine(
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

  it('searches this chat sessions with a full-text query', async () => {
    const query = {
      searchSessions: async (req: { query: string }) => ({
        items: req.query === '飞书'
          ? [
              { header: { id: 'feishu-oc_chat_1', createdAt: 1_700_000_000_000 }, bestMatch: { snippet: '用户在做飞书桥的 i18n 开发' } },
              { header: { id: 'feishu-oc_chat_2', createdAt: 1_700_000_500_000 }, bestMatch: { snippet: '其他话题' } },
            ]
          : [],
      }),
    }
    const agent = { ...fakeAgent(), session: { id: 'feishu-oc_chat_1' } } as unknown as HostAgent
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND} 飞书`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      'oc_chat_1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      query as never,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('飞书桥的 i18n 开发')
    expect(outcome.reply).toContain('← 当前')
    expect(outcome.reply).not.toContain('oc_chat_2')
    expect(outcome.reply).not.toContain('其他话题')
  })

  it('reports no search matches', async () => {
    const query = {
      searchSessions: async () => ({ items: [] }),
    }
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND} 不存在`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      'oc_chat_1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      query as never,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('没有找到')
  })

  it('hints when search is requested without a query backend', async () => {
    const outcome = await runCommandLine(
      `/${SESSIONS_COMMAND} 飞书`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      'oc_chat_1',
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('全文检索')
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
    busyPolicy: 'queue',
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
    expect(outcome.reply).toContain('忙时策略：排队（queue）')
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

describe('/jobs command', () => {
  /** A fake job registry with the given snapshots. */
  function fakeJobs(snapshots: object[]): object {
    return { events: { subscribe: () => () => {} }, list: () => snapshots }
  }

  it('lists jobs with active ones first', async () => {
    const jobs = fakeJobs([
      { id: 'bash-2', kind: 'bash', label: 'watch', status: 'completed', startedAt: 1_700_000_000_000 },
      { id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: 1_699_000_000_000 },
    ])
    const outcome = await runCommandLine(
      `/${JOBS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jobs as never,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('2 个')
    expect(outcome.reply).toContain('1 活动')
    expect(outcome.reply.indexOf('🔵')).toBeLessThan(outcome.reply.indexOf('✅'))
    expect(outcome.reply).toContain('pnpm build')
  })

  it('reports an empty job list', async () => {
    const outcome = await runCommandLine(
      `/${JOBS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeJobs([]) as never,
    )
    expect(outcome.reply).toContain('当前没有任务')
  })

  it('reports when the job registry is absent', async () => {
    const outcome = await runCommandLine(
      `/${JOBS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('后台任务运行时')
  })
})

describe('/feedback command', () => {
  function fakeFeedback(ok = true, code = 'unknown'): object {
    return { put: async () => ok ? { ok: true } : { ok: false, error: { code } } }
  }
  const agent = fakeAgent()

  it('records a positive rating with a note', async () => {
    const feedback = fakeFeedback()
    const outcome = await runCommandLine(
      `/${FEEDBACK_COMMAND} positive 很好`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      feedback as never,
      'msg-1',
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('正面')
    expect(outcome.reply).toContain('很好')
  })

  it('reports a rejected put with its code', async () => {
    const outcome = await runCommandLine(
      `/${FEEDBACK_COMMAND} negative`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeFeedback(false, 'target-not-found') as never,
      'msg-1',
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('target-not-found')
  })

  it('asks for an answer before rating', async () => {
    const outcome = await runCommandLine(
      `/${FEEDBACK_COMMAND} positive`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeFeedback() as never,
      undefined,
    )
    expect(outcome.reply).toContain('还没有可评分')
  })

  it('rejects an invalid rating with usage', async () => {
    const outcome = await runCommandLine(
      `/${FEEDBACK_COMMAND} great`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeFeedback() as never,
      'msg-1',
    )
    expect(outcome.reply).toContain('用法')
  })

  it('reports when the feedback service is absent', async () => {
    const outcome = await runCommandLine(
      `/${FEEDBACK_COMMAND} positive`,
      agent,
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('反馈服务')
  })
})

describe('/context command', () => {
  it('shows current context pressure', async () => {
    const meter = { measure: () => ({ totalTokens: 123_456, surfaceTokens: 20_000 }) }
    const outcome = await runCommandLine(
      `/${CONTEXT_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      meter as never,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('123,456')
    expect(outcome.reply).toContain('/compact')
  })

  it('stays quiet below the high-pressure threshold', async () => {
    const outcome = await runCommandLine(
      `/${CONTEXT_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { measure: () => ({ totalTokens: 30_000, surfaceTokens: 5_000 }) } as never,
    )
    expect(outcome.reply).toContain('30,000')
    expect(outcome.reply).not.toContain('偏高')
  })

  it('hands the meter the session object, not the id alone', async () => {
    // The meter replays the session's event log, so it needs the session:
    // its `seq` and `eventAt()`. Handing it `{ id }` makes the replay read
    // nothing and the meter report zero tokens for every session — with no
    // error raised, which is why this stayed invisible.
    const seen: { session: unknown } = { session: undefined }
    const meter = {
      measure: (session: unknown) => {
        seen.session = session
        return { totalTokens: 1, surfaceTokens: 1 }
      },
    }
    const agent = fakeAgent()
    await runCommandLine(
      `/${CONTEXT_COMMAND}`,
      agent,
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      meter as never,
    )
    expect(seen.session).toBe(agent.session)
    expect(typeof (seen.session as { eventAt?: unknown }).eventAt).toBe('function')
    expect(typeof (seen.session as { seq?: unknown }).seq).toBe('number')
  })

  it('reports when the token meter is absent', async () => {
    const outcome = await runCommandLine(
      `/${CONTEXT_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('token 计量')
  })
})

describe('/skills command', () => {
  function fakeSkills(summaries: Array<{ name: string; description: string; source?: string }> = [], bodies: Record<string, string> = {}) {
    return {
      list: async () => summaries,
      get: async (name: string) => (name in bodies ? { content: bodies[name] } : undefined),
    }
  }

  it('lists discoverable skills with names and descriptions', async () => {
    const outcome = await runCommandLine(
      `/${SKILLS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeSkills([
        { name: 'code-review', description: 'Review a PR before merge', source: 'bundled' },
        { name: 'research', description: 'Deep research on a topic', source: 'user-dsh' },
      ]),
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('可用的 skills')
    expect(outcome.reply).toContain('code-review')
    expect(outcome.reply).toContain('Review a PR')
    expect(outcome.reply).toContain('research')
    expect(outcome.reply).toContain('/skills <name>')
  })

  it('shows one skill body when named', async () => {
    const outcome = await runCommandLine(
      `/${SKILLS_COMMAND} code-review`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeSkills([], { 'code-review': 'Check for security issues and quality gates.' }),
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('Skill · code-review')
    expect(outcome.reply).toContain('security issues')
  })

  it('reports an unknown skill name', async () => {
    const outcome = await runCommandLine(
      `/${SKILLS_COMMAND} nope`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeSkills([]),
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('找不到 skill')
  })

  it('reports when the skill registry is absent', async () => {
    const outcome = await runCommandLine(
      `/${SKILLS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('skill 注册表')
  })
})

describe('/model command', () => {
  function fakeDefaultModel(selection: { provider: string; model: string }, withSave = true) {
    const saved: Array<{ provider: string; model: string }> = []
    return {
      currentSelection: () => ({ ...selection }),
      ...withSave ? { saveSelection: async (s: { provider: string; model: string }) => { saved.push(s) } } : {},
      saved,
    }
  }

  it('shows the current default model when bare', async () => {
    const dm = fakeDefaultModel({ provider: 'deepseek-official', model: 'deepseek-v4' })
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      dm as never,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('deepseek-official/deepseek-v4')
  })

  it('switches through saveSelection', async () => {
    const dm = fakeDefaultModel({ provider: 'deepseek-official', model: 'deepseek-v4' })
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND} opencode-go/deepseek-v4-flash`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      dm as never,
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('opencode-go/deepseek-v4-flash')
    expect(dm.saved).toEqual([{ provider: 'opencode-go', model: 'deepseek-v4-flash' }])
  })

  it('refuses a malformed selection', async () => {
    const dm = fakeDefaultModel({ provider: 'a', model: 'b' })
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND} just-a-model-name`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      dm as never,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('格式')
  })

  it('allows /model switch even when config pins a default (config = initial default, not lock)', async () => {
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND} other-provider/other-model`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      { currentSelection: () => ({ provider: 'zen-go', model: 'ox-alpha-free' }),
       saveSelection: async () => {} },
      { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('已切换')
  })

  it('reports when saveSelection is unavailable (no settings layer)', async () => {
    const dm = fakeDefaultModel({ provider: 'a', model: 'b' }, false)
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND} x/y`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      dm as never,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('settings')
  })

  it('reports when the agent-default-model service is absent', async () => {
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('agent-default-model')
  })

  it('appends the terminal consequence to a successful /permission switch (E2)', async () => {
    const hostCommands = {
      list: () => [],
      execute: async (_agent: unknown, line: string) => {
        const preset = line.includes('danger') ? 'danger-full-access' : 'workspace-write'
        return { result: { kind: 'success' as const, text: `preset ${preset}` } }
      },
    }
    const danger = await runCommandLine('/permission danger-full-access', fakeAgent(), hostCommands as never, new AbortController().signal)
    expect(danger.reply).toContain('terminal')
    expect(danger.reply).toContain('preset danger-full-access')
    const safe = await runCommandLine('/permission workspace-write', fakeAgent(), hostCommands as never, new AbortController().signal)
    expect(safe.reply).toContain('被拒绝')
    // Other commands pass through untouched.
    const plain = await runCommandLine('/goal', fakeAgent(), {
      list: () => [],
      execute: async () => ({ result: { kind: 'success' as const, text: 'preset danger-full-access' } }),
    } as never, new AbortController().signal)
    expect(plain.reply).not.toContain('💡')
  })
})

describe('/compact reply translation', () => {
  /** Run /compact against a host command runtime with one canned result. */
  async function runCompact(result: { kind: 'success' | 'error'; text: string }) {
    const hostCommands = {
      list: () => [],
      execute: async () => ({ result }),
    }
    return runCommandLine('/compact', fakeAgent(), hostCommands as never, new AbortController().signal)
  }

  it('translates a successful compaction and keeps the numbers', async () => {
    const outcome = await runCompact({ kind: 'success', text: 'Compacted 8 history items (~12,345 tokens).' })
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('压缩完成')
    expect(outcome.reply).toContain('8 条')
    expect(outcome.reply).toContain('12,345')
  })

  it('explains an empty compaction instead of echoing English', async () => {
    const outcome = await runCompact({ kind: 'success', text: 'No compactable history yet.' })
    expect(outcome.reply).toContain('没有可压缩')
  })

  it('explains a busy rejection', async () => {
    const outcome = await runCompact({
      kind: 'error',
      text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
    })
    expect(outcome.reply).toContain('现在压不了')
  })

  it('falls back to the generic error echo for other failures', async () => {
    const outcome = await runCompact({ kind: 'error', text: 'Compaction could not produce a useful summary.' })
    expect(outcome.reply).toContain('执行失败')
    expect(outcome.reply).toContain('useful summary')
  })
})

describe('/ws command', () => {
  function fakeRegistry(entries: ReadonlyArray<{ id: string; path: string }>, withList = true) {
    return {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'x', path: '/x', attachSession: async () => undefined }),
      ...withList ? { list: () => entries.map(e => ({ ...e, attachSession: async () => undefined })) } : {},
    }
  }

  it('lists registered workspaces and marks the current one', async () => {
    const outcome = await runWs(
      fakeRegistry([
        { id: 'ws_project-a', path: '/home/user/project-a' },
        { id: 'ws_project-b', path: '/srv/work/project-b' },
      ]) as never,
      '/srv/work/project-b',
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('/home/user/project-a')
    expect(outcome.reply).toContain('← 当前')
  })

  it('reports an empty registry with the deployment cwd', async () => {
    const outcome = await runWs(fakeRegistry([]) as never, '/srv/work')
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('为空')
    expect(outcome.reply).toContain('/srv/work')
  })

  it('refuses when the registry is absent or list-less', async () => {
    const outcome = await runWs(undefined, '/srv/work')
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('workspace 插件')
    const noList = await runWs(fakeRegistry([], false) as never, undefined)
    expect(noList.resolved).toBe(false)
  })

  async function runWs(workspaces: unknown, currentCwd: string | undefined, bound = false) {
    // runCommandLine's trailing params: indexes 20/21 = (…, workspaces, currentCwd);
    // 16 undefineds fill presets(4) … configModel(19). `cwdBound` trails
    // loaderEntries/sync/tools/toolScope, all of which `/ws` never reads.
    return await runCommandLine(
      `/${WS_COMMAND}`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, // 4-7
      undefined, undefined, undefined, undefined, // 8-11
      undefined, undefined, undefined, undefined, // 12-15
      undefined, undefined, undefined, undefined, // 16-19
      workspaces as never,
      currentCwd,
      undefined, undefined, undefined, undefined, // 22-25
      bound,
    ) as unknown as { resolved: boolean; reply: string }
  }

  // 2026-10-30 的现象：本群 `/ws use` 绑到了项目目录，`/new` 也确实落在
  // 项目目录，但 `/ws` 的「← 当前」还挂在部署目录上，尾巴还写着「由部署配置
  // cwd 决定」——因为它拿到的是 config.cwd，不是本群生效目录。
  it('marks the chat\'s bound directory, not the deployment default', async () => {
    // 中性路径：仓库的卫生检查会把真实的用户目录当作隐私泄漏拦下来，而这条
    // 用例要证明的是「两个目录谁被标」，与它们叫什么无关。
    const outcome = await runWs(
      fakeRegistry([
        { id: 'ws_root', path: '/srv' },
        { id: 'ws_project', path: '/srv/proj' },
      ]) as never,
      '/srv/proj',
      true,
    )
    const lines = outcome.reply.split('\n')
    expect(lines.find(line => line.includes('ws_project'))).toContain('← 当前')
    // 部署目录也注册过，但它不是本群生效目录，绝不能被标成「当前」。
    expect(lines.find(line => line.includes('ws_root'))).not.toContain('← 当前')
    expect(outcome.reply).toContain('由本群绑定')
    expect(outcome.reply).not.toContain('cordis.patch.yml')
  })

  it('says the deployment cwd decides when the chat has no binding', async () => {
    const outcome = await runWs(
      fakeRegistry([{ id: 'ws_work', path: '/srv/work' }]) as never,
      '/srv/work',
    )
    expect(outcome.reply).toContain('← 当前')
    expect(outcome.reply).toContain('cordis.patch.yml')
  })

  // 绑定里存的是人手敲的串，注册表存的是 realpath：大小写、尾部分隔符、
  // 相对写法都能指向同一个目录，纯字符串相等会把它们判成不匹配。
  it('treats two spellings of one directory as the same workspace', async () => {
    const marker = process.platform === 'win32' ? 'C:\\srv\\Proj' : '/srv/Proj'
    const spelled = process.platform === 'win32' ? 'c:\\srv\\proj\\' : '/srv/proj/'
    const same = await runWs(fakeRegistry([{ id: 'ws_p', path: marker }]) as never, spelled, true)
    expect(same.reply).toContain('← 当前')
  })

  // 2026-10-30：`/ws` 之前能吐回整棵注册表，注册表大、路径长时一张回复就能
  // 撑爆平台载荷上限，整条消息发不出去——用户看到的是「命令没反应」。现在
  // 列出前 N 个，并明说还剩多少，链接回 `/sessions` 那种可继续查的地方。
  it('bounds a large registry and says how many are left', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `ws_${i}`,
      path: `/srv/really-long-workspace-name-for-scrollback-${i}`,
    }))
    const outcome = await runWs(fakeRegistry(many) as never, undefined)
    expect(outcome.resolved).toBe(true)
    const shown = outcome.reply.split('\n').filter(line => line.startsWith('·'))
    expect(shown.length).toBeLessThan(many.length)
    expect(outcome.reply).toContain('还有')
    // 被点名的目录仍是真实条目，不是编出来的。
    expect(outcome.reply).toMatch(/really-long-workspace-name-for-scrollback-\d+/)
  })
})


describe('/restart command', () => {
  const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    appId: 'cli_secret',
    appSecret: 'top-secret',
    sessionScope: 'chat',
    output: 'cot',
    busyPolicy: 'queue',
    showProcess: true,
    attachImages: false,
    hideProcessWhenDone: false,
    syncSlashCommands: true,
    onboarding: true,
    denyTools: [],
    requireMention: true,
    reactionFeedback: true,
    senderAllowlist: [],
    groupAllowlist: [],
    approvers: [],
    autoResumeGoals: false,
    restartCommand: '',
    approvalReminderMs: 0,
    ...overrides,
  })

  it('answers with an error and spawns nothing when unconfigured', async () => {
    const outcome = await runCommandLine(
      '/restart',
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      config({ restartCommand: '' }),
    )
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('未配置')
  })

  it('schedules a detached restart when configured', async () => {
    const shells: string[] = []
    const restore = setRestartScheduler((shell: string) => { shells.push(shell) })
    try {
      const outcome = await runCommandLine(
        '/restart',
        fakeAgent(),
        undefined,
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        config({ restartCommand: 'systemctl restart my-dsh.service' }),
      )
      expect(outcome.resolved).toBe(true)
      expect(outcome.reply).toContain('正在重启')
      expect(shells).toEqual(['systemctl restart my-dsh.service'])
    } finally {
      restore()
    }
  })

  it('records the requesting chat for the boot-time notice', async () => {
    const recorded: string[] = []
    const restoreSchedule = setRestartScheduler(() => {})
    const restoreRecorder = setRestartRequestRecorder((chatId: string) => {
      recorded.push(chatId)
      return true
    })
    try {
      const outcome = await runCommandLine(
        '/restart',
        fakeAgent(),
        undefined,
        new AbortController().signal,
        undefined,
        undefined,
        'oc_requesting_chat',
        undefined,
        undefined,
        undefined,
        config({ restartCommand: 'systemctl restart my-dsh.service' }),
      )
      expect(outcome.resolved).toBe(true)
      expect(recorded).toEqual(['oc_requesting_chat'])
    } finally {
      restoreSchedule()
      restoreRecorder()
    }
  })
})
describe('host command execute argument shape (issue #2)', () => {
  /**
   * The upstream `execute` gained an attachments slot in front of `signal`.
   * Passing the old three-argument shape puts the signal where the
   * attachments belong, leaves the real signal undefined, and the host
   * throws on `signal.aborted` — every slash command dies with a generic
   * "cannot start session" line.
   *
   * The bridge cannot tell the two shapes apart by counting arguments: a
   * host that gives `signal` a default value reports three arguments while
   * still having the attachments slot, and choosing the three-argument
   * shape for it puts the signal where the attachments belong. That is
   * issue #2's failure, except silent — the host falls back to its default
   * signal and the abort is lost.
   *
   * So the third argument is both: an empty array for the host that wants
   * attachments there, and the signal's own members for the host that
   * wants the signal there. These tests pin the behaviour against each
   * host shape, using real declared parameters — a rest-parameter mock
   * reports a length of zero and would pass whatever the bridge did.
   */
  it('gives a four-argument host an empty attachments slot and the real signal', async () => {
    const seen: { args: unknown[] } = { args: [] }
    const hostCommands = {
      list: () => [],
      execute: async function (_agent: unknown, _line: string, _attachments: readonly unknown[], _signal: AbortSignal) {
        seen.args = Array.from(arguments)
        return { result: { kind: 'success' as const, text: 'ok' } }
      },
    }
    const outcome = await runCommandLine('/goal', fakeAgent(), hostCommands as never, new AbortController().signal)
    expect(outcome.resolved).toBe(true)
    expect(seen.args).toHaveLength(4)
    expect(Array.isArray(seen.args[2])).toBe(true)
    expect((seen.args[2] as unknown[])).toHaveLength(0)
    expect(seen.args[3]).toBeInstanceOf(AbortSignal)
  })

  it('gives a three-argument host a signal it can read in the third slot', async () => {
    const seen: { args: unknown[] } = { args: [] }
    const hostCommands = {
      list: () => [],
      execute: async function (_agent: unknown, _line: string, _signal: AbortSignal) {
        seen.args = Array.from(arguments)
        return { result: { kind: 'success' as const, text: 'ok' } }
      },
    }
    const outcome = await runCommandLine('/goal', fakeAgent(), hostCommands as never, new AbortController().signal)
    expect(outcome.resolved).toBe(true)
    // JavaScript does not cut arguments to the declared count: the host
    // receives four and reads the first three. What matters is that the
    // third slot answers the questions a signal is asked — it must not be
    // undefined, and reading `aborted` must not throw.
    expect(seen.args[2]).toBeDefined()
    expect((seen.args[2] as { aborted?: boolean }).aborted).toBe(false)
    expect(typeof (seen.args[2] as { throwIfAborted?: unknown }).throwIfAborted).toBe('function')
  })

  it('keeps the signal usable when the host gives it a default value', async () => {
    // The shape the arity reading cannot see: four parameters, but the
    // signal has a default, so the method reports three. The host would
    // read its own default signal and the bridge's abort would be lost.
    const seen: { args: unknown[] } = { args: [] }
    const hostCommands = {
      list: () => [],
      execute: async function (
        _agent: unknown,
        _line: string,
        _attachments: readonly unknown[],
        _signal: AbortSignal = new AbortController().signal,
      ) {
        seen.args = Array.from(arguments)
        return { result: { kind: 'success' as const, text: 'ok' } }
      },
    }
    expect(hostCommands.execute.length).toBe(3)
    const outcome = await runCommandLine('/goal', fakeAgent(), hostCommands as never, new AbortController().signal)
    expect(outcome.resolved).toBe(true)
    expect(seen.args).toHaveLength(4)
    expect(Array.isArray(seen.args[2])).toBe(true)
    // The real signal must arrive in the fourth slot, not be replaced by
    // the host's default.
    expect(seen.args[3]).toBeInstanceOf(AbortSignal)
    expect((seen.args[3] as AbortSignal).aborted).toBe(false)
  })
})
