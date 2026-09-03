/**
 * The `/bot` command: bridge identity, cross-form settings, and plugin sync —
 * the chat-facing surface of the dual-end sync feature (see
 * docs/design/设计卡_双端设置与同步.md). Text-first, matching the bridge's
 * other control commands; every mutating subcommand echoes masked secrets.
 * @module dsh-lark-bridge/sync/bot-command
 */
import type { CommandOutcome } from '../commands.ts';
import { FeishuCloud } from './feishu-cloud.ts';
/** Fixed cloud-slot names (one slot, refreshed on every write). */
export declare const CLOUD_MIGRATION_NAME = "dsh-lark-bridge-migrate.json";
export declare const CLOUD_ARBITRATION_NAME = "dsh-lark-bridge-arbitration.json";
/** One machine's registration in the arbitration file. */
export interface PresenceEntry {
    name: string;
    form: string;
    profile: string;
    version: string;
    /** Epoch ms of the machine's last renewal. */
    lastSeen: number;
}
/** Cloud arbitration document: the active endpoint plus a presence registry. */
export interface Arbitration {
    activeDeviceId: string;
    activeName: string;
    form: string;
    profile: string;
    updatedAt: string;
    /** Every machine seen recently — the presence ledger. */
    devices?: Record<string, PresenceEntry>;
}
/** A machine counts as offline after this much silence (2 renewal periods + slack). */
export declare const PRESENCE_TIMEOUT_MS = 180000;
/** How often a live machine renews its presence line. */
export declare const PRESENCE_INTERVAL_MS = 60000;
/** Read the cloud arbitration file, null when absent/unavailable. */
export declare function readCloudArbitration(ctx: SyncCommandContext): Promise<Arbitration | null>;
export declare function arbitrationForInbound(): Promise<Arbitration | null>;
/** Everything `/bot` needs from the runtime to operate. */
export interface SyncCommandContext {
    /** Shared-home override; defaults to `$DSH_HOME` or `~/.dsh`. */
    home?: string | undefined;
    /** This instance's runtime form. */
    form: 'web' | 'desktop';
    /** Profile name this instance runs under. */
    profile: string;
    bridgeVersion: string;
    /** This instance's control-API port, when listening. */
    controlPort?: number | undefined;
    /** This instance's control-API bearer token, published via heartbeat. */
    controlToken?: string | undefined;
    /** Harness home for reading local profile manifests. */
    harnessHome?: string | undefined;
    /** Feishu app credentials, when onboarded — enables the cloud carrier. */
    credentials?: {
        appId: string;
        appSecret: string;
        domain?: string;
    } | undefined;
    /** Pre-built cloud client (tests inject a fake; production builds on demand). */
    cloud?: FeishuCloud | undefined;
    /** Production command runner for plugin installs; injectable for tests. */
    runCommand?: (command: string) => Promise<void>;
}
/**
 * Publish the runtime-built sync context. The bridge's command dispatcher
 * reads it via {@link getSyncContext}; the module-singleton pattern matches
 * `setRestartScheduler` in commands.ts.
 */
export declare function setSyncContext(context: SyncCommandContext): void;
/** The runtime-published sync context, when the runtime wired one. */
export declare function getSyncContext(): SyncCommandContext | undefined;
/**
 * Handle `/bot [subcommand …]`. Returns the reply for the chat; every secret
 * is masked before it leaves this module.
 */
export declare function runBotCommand(line: string, ctx: SyncCommandContext): Promise<CommandOutcome>;
/**
 * Renew this machine's presence line in the cloud arbitration file — the
 * "login heartbeat" of the three-state model. Read-merge-write on a single
 * cloud slot: concurrent writers may clobber each other's lastSeen, which
 * only blurs presence precision (minutes) and never corrupts the active
 * slot. Failures are swallowed; presence is advisory.
 */
export declare function renewPresence(ctx: SyncCommandContext): Promise<void>;
/**
 * Election: when the arbitration's active machine has gone silent past the
 * presence timeout, the online machine with the lexicographically smallest
 * deviceId claims the slot — deterministic, so concurrent electors converge
 * on one winner even without an atomic test-and-set on the drive. `known`
 * is the caller's (possibly cached) arbitration; a fresh read happens only
 * when an election looks possible, keeping the quiet path API-free.
 */
export declare function claimIfActiveStale(ctx: SyncCommandContext, known: Arbitration | null): Promise<boolean>;
//# sourceMappingURL=bot-command.d.ts.map