/**
 * The `/bot` command: bridge identity, cross-form settings, and plugin sync —
 * the chat-facing surface of the dual-end sync feature (see
 * docs/design/设计卡_双端设置与同步.md). Text-first, matching the bridge's
 * other control commands; every mutating subcommand echoes masked secrets.
 * @module dsh-lark-bridge/sync/bot-command
 */
import type { CommandOutcome } from '../commands.ts';
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
//# sourceMappingURL=bot-command.d.ts.map