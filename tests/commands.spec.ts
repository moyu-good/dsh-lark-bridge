import { describe, expect, it, vi } from 'vitest'
import {
  PRESET_COMMAND,
  PRESET_NAMES,
  runCommandLine,
  SHIPPED_PRESET_IDS,
} from '../src/commands.ts'
import type { HostAgent, HostAgentPresets, HostCommands } from '../src/host.ts'
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
