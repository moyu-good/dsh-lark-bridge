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
import type { ProfileManifest } from './profile-manifest.ts';
/** What one install step will run, in dry-run or execution form. */
export interface InstallStep {
    kind: 'add';
    profile: string;
    /** Package spec passed to `dsh plugin add` (`name@version`). */
    spec: string;
    command: string;
}
/** Packages present on the peer but not bundled here — needs a human choice. */
export interface EnableStep {
    kind: 'enable';
    profile: string;
    bundle: string;
}
/** The full plan produced from a manifest diff. */
export interface SyncPlan {
    steps: (InstallStep | EnableStep)[];
    /** Packages both sides already share (informational). */
    inSync: string[];
}
/** Options for building a plan. */
export interface PlanOptions {
    /** Exclude per-profile machinery from adoption (defaults cover dsh core). */
    exclude?: readonly string[];
}
/** Build the install plan adopting the peer manifest into this profile. */
export declare function buildSyncPlan(here: ProfileManifest, there: ProfileManifest, options?: PlanOptions): SyncPlan;
/** Result of running a plan. */
export interface ApplyResult {
    ran: InstallStep[];
    skipped: EnableStep[];
    failures: {
        step: InstallStep;
        error: string;
    }[];
}
/**
 * Execute a plan's `add` steps through the upstream CLI. `runCommand` is
 * injected so tests never touch a real dsh; production passes a child-process
 * runner. Enable steps are returned unexecuted — bundling an existing package
 * changes agent behavior materially and belongs to an explicit human choice,
 * not to a sync sweep.
 */
export declare function applySyncPlan(plan: SyncPlan, runCommand: (command: string) => Promise<void>): Promise<ApplyResult>;
//# sourceMappingURL=plugin-sync.d.ts.map