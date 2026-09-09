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
    /**
     * Endpoint-scoped active slot (`deviceId:form:profile`), present on
     * documents written by 0.7.0+. One machine running web AND desktop holds
     * two Feishu connections and both would pass a machine-only check, double
     * replying every message — the active slot answers per ENDPOINT, and this
     * field is what makes the old machine-only field a display fact.
     */
    activeEndpoint?: string | undefined;
    /** Every endpoint seen recently — the presence ledger (keyed by endpoint). */
    devices?: Record<string, PresenceEntry>;
}
/**
 * The presence-ledger key for one endpoint: device + form + profile. Same
 * machine, two forms, two keys — that distinction is the whole point.
 */
export declare function endpointKey(deviceId: string, form: string, profile: string): string;
/**
 * Which ledger key the active slot answers as. Current documents carry it
 * verbatim; pre-0.7 documents only record the machine and its form, so the
 * derived key reconstructs the endpoint that wrote them.
 */
export declare function arbitrationActiveKey(arbitration: Arbitration): string;
/**
 * True when THIS endpoint (device + form + profile) owns the active slot.
 * Pre-0.7 documents fall back to machine + recorded form: their writer was
 * one endpoint, so the endpoint matching that form inherits the slot and the
 * same machine's other form correctly stands down instead of double replying.
 */
export declare function isActiveEndpoint(arbitration: Arbitration, deviceId: string, form: string, profile: string): boolean;
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
 * Election: when the arbitration's active ENDPOINT has gone silent past the
 * presence timeout, the online endpoint with the lexicographically smallest
 * endpoint key claims the slot — deterministic, so concurrent electors
 * converge on one winner even without an atomic test-and-set on the drive.
 * Keys are endpoint-scoped (device+form+profile): on one machine the web and
 * desktop forms are separate contenders, so a silent web form hands the slot
 * to desktop (or another machine) instead of deadlocking on a shared id.
 * `known` is the caller's (possibly cached) arbitration; a fresh read happens
 * only when an election looks possible, keeping the quiet path API-free.
 */
export declare function claimIfActiveStale(ctx: SyncCommandContext, known: Arbitration | null): Promise<boolean>;
/**
 * Switch the shared transport keys to a saved account — the guts of
 * `/bot account use`, exported for the account card's 使用 button.
 * `ok:false` marks a refusal (unknown name) so the command path can flag it
 * unresolved; the text is the human-facing line either way.
 */
export declare function accountUseByName(ctx: SyncCommandContext, name: string): Promise<{
    text: string;
    ok: boolean;
}>;
/** Remove one saved account and clear an active marker — the card's 忘记 button. */
export declare function accountForgetByName(ctx: SyncCommandContext, name: string): Promise<{
    text: string;
    ok: boolean;
}>;
//# sourceMappingURL=bot-command.d.ts.map