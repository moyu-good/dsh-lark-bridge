import { describe, expect, it, vi } from 'vitest'
import {
  EffortOverrides,
  FALLBACK_EFFORTS,
  effortCatalog,
  lastSelection,
  parseThinkLine,
  runThinkCommand,
} from '../src/think.ts'
import { THINK_COMMAND } from '../src/commands.ts'
import type { HostAgent, HostDefaultModel, HostLlm, HostSession } from '../src/host.ts'
import type { Context } from '@deepseek-ai/cordis'

/** A session whose log is the given events, addressed the way the host does. */
function fakeSession(events: readonly { type: string; data?: unknown }[] = []): HostSession {
  return {
    id: 'ses_1',
    seq: events.length,
    eventAt: (seq: number) => events[seq],
  } as unknown as HostSession
}

/** A context whose only seam is `get`, standing in for the host's service map. */
function fakeCtx(services: Record<string, unknown> = {}): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** An agent driving one session. */
function fakeAgent(session: HostSession): HostAgent {
  return {
    id: session.id,
    session,
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as HostAgent
}

/** A default-model service reporting one selection. */
function fakeDefaults(selection: { provider: string; model: string; reasoningEffort?: string }): HostDefaultModel {
  return { currentSelection: () => selection }
}

describe('parseThinkLine', () => {
  it('reads a bare command as "show"', () => {
    expect(parseThinkLine(`/${THINK_COMMAND}`)).toEqual({ kind: 'show' })
    expect(parseThinkLine(`  /${THINK_COMMAND}   `)).toEqual({ kind: 'show' })
  })

  it('reads a level as a switch, lowercased and trimmed', () => {
    expect(parseThinkLine(`/${THINK_COMMAND} MAX`)).toEqual({ kind: 'set', effort: 'max' })
    expect(parseThinkLine(`/${THINK_COMMAND}   low  `)).toEqual({ kind: 'set', effort: 'low' })
  })

  it('treats reset, default, and auto as the same intent', () => {
    for (const word of ['reset', 'default', 'auto']) {
      expect(parseThinkLine(`/${THINK_COMMAND} ${word}`)).toEqual({ kind: 'reset' })
    }
  })
})

describe('lastSelection', () => {
  it('returns undefined for a session that never recorded one', () => {
    expect(lastSelection(fakeSession([{ type: 'user/message' }]))).toBeUndefined()
  })

  it('returns the newest selection, ignoring other events', () => {
    const session = fakeSession([
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      { type: 'turn/start' },
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
    ])
    expect(lastSelection(session)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
  })
})

describe('effortCatalog', () => {
  it('uses the adapter’s own levels, in its order', async () => {
    const llm = {
      resolveModelInfo: async () => ({
        reasoning: {
          efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
          defaultEffort: 'high',
        },
      }),
    } as unknown as HostLlm
    const catalog = await effortCatalog(llm, 'p', 'm')
    expect(catalog.source).toBe('adapter')
    expect(catalog.levels.map(level => level.id)).toEqual(['off', 'high'])
    expect(catalog.defaultEffort).toBe('high')
  })

  it('falls back to the shipped levels when no llm service is composed', async () => {
    const catalog = await effortCatalog(undefined, 'p', 'm')
    expect(catalog.source).toBe('fallback')
    expect(catalog.levels.map(level => level.id)).toEqual([...FALLBACK_EFFORTS])
  })

  it('falls back when the route declares no reasoning metadata', async () => {
    const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) } as unknown as HostLlm
    const catalog = await effortCatalog(llm, 'p', 'm')
    expect(catalog.source).toBe('fallback')
  })

  it('falls back when the adapter throws instead of claiming "no levels"', async () => {
    const llm = { resolveModelInfo: async () => { throw new Error('adapter down') } } as unknown as HostLlm
    const catalog = await effortCatalog(llm, 'p', 'm')
    expect(catalog.source).toBe('fallback')
    expect(catalog.levels.length).toBeGreaterThan(0)
  })

  it('skips the lookup without a full route', async () => {
    const resolveModelInfo = vi.fn()
    const llm = { resolveModelInfo } as unknown as HostLlm
    await effortCatalog(llm, undefined, 'm')
    await effortCatalog(llm, 'p', '')
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })
})

describe('EffortOverrides', () => {
  it('records a choice and reads it back', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    expect(overrides.get(session.id)).toBe('low')
  })

  it('clears the choice when the selection carries no effort', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    overrides.set(session, { provider: 'p', model: 'm' })
    expect(overrides.get(session.id)).toBeUndefined()
  })

  it('appends the choice as a durable model/selection event', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const append = vi.fn()
    const session = { ...fakeSession(), append } as unknown as HostSession
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'max' })
    expect(append).toHaveBeenCalledWith('model/selection', { provider: 'p', model: 'm', reasoningEffort: 'max' })
  })

  it('keeps the choice in memory when the host cannot append', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    expect(() => overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'off' })).not.toThrow()
    expect(overrides.get(session.id)).toBe('off')
  })

  it('restores a resumed session’s choice from its own log', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession([
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
    ])
    overrides.restore(session)
    expect(overrides.get(session.id)).toBe('low')
  })

  it('restores "follow the default" from a selection without an effort', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession([
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      { type: 'model/selection', data: { provider: 'p', model: 'm' } },
    ])
    overrides.restore(session)
    expect(overrides.get(session.id)).toBeUndefined()
  })

  describe('the request hook', () => {
    /** Install the hook and hand back a function that runs it once. */
    function hook(overrides: EffortOverrides, sessionId: string): (envelope: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown> {
      const handlers = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
      const scope = {
        on: (name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
          handlers.set(name, listener)
          return () => undefined
        },
      } as unknown as Context
      overrides.install(scope, sessionId)
      const listener = handlers.get('agent/request')
      if (listener === undefined) throw new Error('hook not installed')
      return envelope => listener({ turn: 1, step: 1, signal: new AbortController().signal }, async () => envelope)
    }

    it('passes the envelope through untouched with no choice', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      const run = hook(overrides, 'ses_1')
      await expect(run({ provider: 'p', model: 'm', reasoningEffort: 'high' })).resolves.toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    })

    it('rewrites the effort the request will send', async () => {
      const overrides = new EffortOverrides(fakeCtx({
        llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'max' }] } }) },
      }))
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'low' })
      const run = hook(overrides, 'ses_1')
      await expect(run({ provider: 'p', model: 'm', reasoningEffort: 'max' })).resolves.toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
    })

    it('keeps the rest of the envelope (maxTokens and the route)', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'off' })
      const run = hook(overrides, 'ses_1')
      const result = await run({ provider: 'p', model: 'm', maxTokens: 4096 } as unknown as { provider: string; model: string })
      expect(result).toMatchObject({ provider: 'p', model: 'm', maxTokens: 4096, reasoningEffort: 'off' })
    })

    it('leaves the request alone when the route does not offer the level', async () => {
      // The case that matters: /model moved the session to a route that only
      // takes `off`, while the session still remembers `max`. Failing every
      // turn would be the alternative.
      const overrides = new EffortOverrides(fakeCtx({
        llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }) },
      }))
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'max' })
      const run = hook(overrides, 'ses_1')
      await expect(run({ provider: 'p', model: 'other' })).resolves.toEqual({ provider: 'p', model: 'other' })
    })

    it('applies the choice when the adapter cannot describe the route', async () => {
      const overrides = new EffortOverrides(fakeCtx({
        llm: { resolveModelInfo: async () => { throw new Error('no capability') } },
      }))
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'max' })
      const run = hook(overrides, 'ses_1')
      await expect(run({ provider: 'p', model: 'm' })).resolves.toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
    })

    it('is scoped to one session', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'off' })
      const run = hook(overrides, 'ses_2')
      await expect(run({ provider: 'p', model: 'm' })).resolves.toEqual({ provider: 'p', model: 'm' })
    })
  })
})

describe('runThinkCommand', () => {
  const defaults = fakeDefaults({ provider: 'p', model: 'm', reasoningEffort: 'max' })

  it('shows the session’s choice, the levels, and the deployment default', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(fakeSession()), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('思考强度')
    expect(outcome.reply).toContain('`off`')
    expect(outcome.reply).toContain('部署默认：`max`')
  })

  it('reports the live choice as this session’s own', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.reply).toContain('`low`')
    expect(outcome.reply).toContain('本会话设置')
  })

  it('reads what the last request actually sent from the header', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = {
      ...fakeSession(),
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    } as unknown as HostSession
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.reply).toContain('`high`')
    expect(outcome.reply).toContain('上一次请求实际使用')
  })

  it('switches a known level and says when it lands', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    const outcome = await runThinkCommand(`/${THINK_COMMAND} low`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(true)
    expect(overrides.get(session.id)).toBe('low')
    expect(outcome.reply).toContain('下一步请求即生效')
  })

  it('refuses an unknown level and lists the real ones', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    const outcome = await runThinkCommand(`/${THINK_COMMAND} turbo`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(false)
    expect(overrides.get(session.id)).toBeUndefined()
    expect(outcome.reply).toContain('`off`')
  })

  it('clears the choice on reset and names what it returns to', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'off' })
    const outcome = await runThinkCommand(`/${THINK_COMMAND} reset`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(true)
    expect(overrides.get(session.id)).toBeUndefined()
    expect(outcome.reply).toContain('`max`')
  })

  it('is unavailable when the bridge wired no override table', async () => {
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(fakeSession()), undefined, undefined, defaults)
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('不可用')
  })

  it('asks for one request when the route is not known yet', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const outcome = await runThinkCommand(`/${THINK_COMMAND} low`, fakeAgent(fakeSession()), overrides, undefined, undefined)
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('等这轮请求跑完')
  })
})
