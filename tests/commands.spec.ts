import { describe, expect, it, vi } from 'vitest'
import {
  AUDIT_COMMAND,
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

  it('searches this chat sessions with a full-text query', async () => {
    const query = {
      searchSessions: async (req: { query: string }) => ({
        items: req.query === '飞书'
          ? [
              { session: { id: 'feishu-oc_chat_1', createdAt: 1_700_000_000_000 }, bestMatch: { snippet: '用户在做飞书桥的 i18n 开发' } },
              { session: { id: 'feishu-oc_chat_2', createdAt: 1_700_000_500_000 }, bestMatch: { snippet: '其他话题' } },
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

describe('/jobs command', () => {
  /** A fake job registry with the given snapshots. */
  function fakeJobs(snapshots: object[]): object {
    return { onJobDone: async () => () => {}, list: () => snapshots }
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
      get: async (name: string) => (name in bodies ? { body: bodies[name] } : undefined),
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

  it('refuses when the deployment pins provider/model in bridge config', async () => {
    const outcome = await runCommandLine(
      `/${MODEL_COMMAND} opencode-go/deepseek-v4-flash`,
      fakeAgent(),
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined,
      { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    )
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('固定了模型')
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
})
