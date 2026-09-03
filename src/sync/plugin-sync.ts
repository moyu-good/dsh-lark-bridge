/**
 * Plugin-manifest sync between profile forms — the concrete fix for upstream
 * dsh-desktop#93 ("conversations survive, plugins don't"). The bridge diffs
 * the two profiles' manifests and installs what is missing here, one package
 * at a time, through the upstream `dsh plugin` CLI. It never writes a plugin
 * tree itself: two hosts writing one tree corrupts workspace session lists
 * (deepseek-harness#1485), so installation semantics stay with the CLI that
 * owns the profile.
 * @module dsh-lark-bridge/sync/plugin-sync
 */

import type { ManifestDiff, ProfileManifest } from './profile-manifest.ts'
import { diffManifests } from './profile-manifest.ts'

/** What one install step will run, in dry-run or execution form. */
export interface InstallStep {
  kind: 'add'
  profile: string
  /** Package spec passed to `dsh plugin add` (`name@version`). */
  spec: string
  command: string
}

/** Packages present on the peer but not bundled here — needs a human choice. */
export interface EnableStep {
  kind: 'enable'
  profile: string
  bundle: string
}

/** The full plan produced from a manifest diff. */
export interface SyncPlan {
  steps: (InstallStep | EnableStep)[]
  /** Packages both sides already share (informational). */
  inSync: string[]
}

/** Options for building a plan. */
export interface PlanOptions {
  /** Exclude per-profile machinery from adoption (defaults cover dsh core). */
  exclude?: readonly string[]
}

/** Packages that belong to the runtime, not to a chat's plugin taste. */
const DEFAULT_EXCLUDE = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/schemastery',
] as const

/** Build the install plan adopting the peer manifest into this profile. */
export function buildSyncPlan(
  here: ProfileManifest,
  there: ProfileManifest,
  options?: PlanOptions,
): SyncPlan {
  const diff: ManifestDiff = diffManifests(here, there, {
    exclude: options?.exclude ?? DEFAULT_EXCLUDE,
  })
  const steps: (InstallStep | EnableStep)[] = []
  for (const pkg of diff.toInstall) {
    const spec = `${pkg.name}@${pkg.version}`
    steps.push({
      kind: 'add',
      profile: here.profile,
      spec,
      command: `dsh plugin --profile ${here.profile} add ${spec}`,
    })
  }
  for (const bundle of diff.bundlesToEnable) {
    // Only meaningful when the package already exists locally; otherwise the
    // `add` above should bring its bundle in. Kept visible so nothing is
    // silently dropped.
    if (here.dependencies[bundle] !== undefined) {
      steps.push({ kind: 'enable', profile: here.profile, bundle })
    }
  }
  const installing = new Set(diff.toInstall.map((pkg) => pkg.name))
  const inSync = Object.keys(here.dependencies)
    .filter((name) => there.dependencies[name] !== undefined
      && !installing.has(name)
      && !(options?.exclude ?? DEFAULT_EXCLUDE).includes(name))
  return { steps, inSync }
}

/** Result of running a plan. */
export interface ApplyResult {
  ran: InstallStep[]
  skipped: EnableStep[]
  failures: { step: InstallStep; error: string }[]
}

/**
 * Execute a plan's `add` steps through the upstream CLI. `runCommand` is
 * injected so tests never touch a real dsh; production passes a child-process
 * runner. Enable steps are returned unexecuted — bundling an existing package
 * changes agent behavior materially and belongs to an explicit human choice,
 * not to a sync sweep.
 */
export async function applySyncPlan(
  plan: SyncPlan,
  runCommand: (command: string) => Promise<void>,
): Promise<ApplyResult> {
  const result: ApplyResult = { ran: [], skipped: [], failures: [] }
  for (const step of plan.steps) {
    if (step.kind !== 'add') {
      result.skipped.push(step)
      continue
    }
    try {
      await runCommand(step.command)
      result.ran.push(step)
    } catch (err) {
      result.failures.push({ step, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}
