import { describe, expect, it } from 'vitest'
import { applySyncPlan, buildSyncPlan } from '../src/sync/plugin-sync.ts'
import type { ProfileManifest } from '../src/sync/profile-manifest.ts'

function manifest(
  profile: string,
  dependencies: Record<string, string>,
  bundles: string[],
): ProfileManifest {
  return { profile, dependencies, bundles, mtimeMs: 1 }
}

const CORE = '@deepseek-ai/cordis'

describe('buildSyncPlan', () => {
  it('adopts peer plugins and skips shared ones', () => {
    const here = manifest('web', {
      [CORE]: '^4.0.1',
      '@moyu-good/dsh-lark-bridge': 'file:.',
    }, [CORE, '@moyu-good/dsh-lark-bridge'])
    const there = manifest('desktop', {
      [CORE]: '^4.0.1',
      '@moyu-good/dsh-lark-bridge': 'file:.',
      'community/cool-skill': '1.2.3',
      'another/skill': '0.0.1',
    }, [CORE, '@moyu-good/dsh-lark-bridge', 'community/cool-skill'])
    const plan = buildSyncPlan(here, there)
    expect(plan.steps.filter((s) => s.kind === 'add').map((s) => (s as { spec: string }).spec))
      .toEqual(['community/cool-skill@1.2.3', 'another/skill@0.0.1'])
    // community/cool-skill is being installed, so its bundle enable is not a
    // separate step; a bundle for an ALREADY-installed package would be.
    expect(plan.steps.filter((s) => s.kind === 'enable')).toHaveLength(0)
    expect(plan.inSync).toEqual(['@moyu-good/dsh-lark-bridge'])
  })

  it('never adopts runtime machinery', () => {
    const here = manifest('web', { [CORE]: '^4.0.1' }, [CORE])
    const there = manifest('desktop', { [CORE]: '^9.9.9', 'community/x': '1.0.0' }, [CORE])
    const plan = buildSyncPlan(here, there)
    expect(plan.steps.map((s) => (s.kind === 'add' ? s.spec : s.bundle))).toEqual(['community/x@1.0.0'])
  })

  it('surfaces bundle enable for already-installed packages', () => {
    const here = manifest('web', {
      [CORE]: '^4.0.1',
      'community/cool-skill': '1.2.3',
    }, [CORE])
    const there = manifest('desktop', {
      [CORE]: '^4.0.1',
      'community/cool-skill': '1.2.3',
    }, [CORE, 'community/cool-skill'])
    const plan = buildSyncPlan(here, there)
    expect(plan.steps).toEqual([{ kind: 'enable', profile: 'web', bundle: 'community/cool-skill' }])
  })
})

describe('applySyncPlan', () => {
  it('runs add steps through the injected runner', async () => {
    const here = manifest('web', { [CORE]: '^4.0.1' }, [CORE])
    const there = manifest('desktop', { [CORE]: '^4.0.1', 'community/x': '1.0.0' }, [CORE])
    const plan = buildSyncPlan(here, there)
    const ran: string[] = []
    const result = await applySyncPlan(plan, async (command) => {
      ran.push(command)
    })
    expect(ran).toEqual(['dsh plugin --profile web add community/x@1.0.0'])
    expect(result.failures).toHaveLength(0)
  })

  it('collects failures without aborting the sweep', async () => {
    const here = manifest('web', { [CORE]: '^4.0.1' }, [CORE])
    const there = manifest('desktop', {
      [CORE]: '^4.0.1',
      'community/x': '1.0.0',
      'community/y': '2.0.0',
    }, [CORE])
    const plan = buildSyncPlan(here, there)
    const result = await applySyncPlan(plan, async (command) => {
      if (command.includes('community/x')) throw new Error('registry 404')
    })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].error).toContain('404')
    expect(result.ran).toHaveLength(1)
  })

  it('returns enable steps unexecuted for human decision', async () => {
    const here = manifest('web', {
      [CORE]: '^4.0.1',
      'community/cool-skill': '1.2.3',
    }, [CORE])
    const there = manifest('desktop', {
      [CORE]: '^4.0.1',
      'community/cool-skill': '1.2.3',
    }, [CORE, 'community/cool-skill'])
    const plan = buildSyncPlan(here, there)
    const ran: string[] = []
    const result = await applySyncPlan(plan, async (command) => {
      ran.push(command)
    })
    expect(ran).toHaveLength(0)
    expect(result.skipped).toEqual([{ kind: 'enable', profile: 'web', bundle: 'community/cool-skill' }])
  })
})
