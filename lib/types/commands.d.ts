/**
 * Slash commands in a chat. A line beginning with `/` is a control, not a
 * prompt: the host runs it WITHOUT a model turn, so routing it here is what
 * keeps a `/clear` from reaching the model as prose for it to improvise on.
 *
 * Two commands are the channel's own rather than the host's. `/stop` cancels
 * the running turn — cancellation is an agent method, not a registered command
 * — and `/help` lists what this chat accepts, which no host command provides.
 * @module dsh-lark-bridge/commands
 */
import type { AuditStats, HostAgent, HostAgentPresets, HostCommands, HostDefaultModel, HostJobs, HostLoaderEntry, HostMessageFeedback, HostSessionPersistence, HostSessionQuery, HostSkills, HostTokenMeter, HostWorkspaceRegistry, ScheduleEntry } from './host.ts';
import type { ResolvedConfig } from './config.ts';
import type { SyncCommandContext } from './sync/bot-command.ts';
/** Cancel the running turn. Not a host command: cancellation is an agent method. */
export declare const STOP_COMMAND = "stop";
/**
 * Restart the host process from the chat. Only registered when the deployment
 * configures {@link Config.restartCommand} — restarting a process is a
 * deployment concern (systemd unit name, container runtime, process manager),
 * so the bridge ships the command shape and the deployment supplies the how.
 * The command runs detached after a short delay: the reply must reach the
 * chat before the process that would send it goes away.
 */
export declare const RESTART_COMMAND = "restart";
/**
 * Fires the configured restart shell in a detached child that outlives this
 * process, after a delay long enough for the command's reply to reach the
 * chat. Exported for tests to stub; production always spawns `/bin/sh`.
 */
export declare let scheduleRestart: (shell: string) => void;
/** Test seam: replace the restart scheduler. Returns the previous one. */
export declare function setRestartScheduler(fn: (shell: string) => void): (shell: string) => void;
/** List what this chat accepts. Not a host command: the list is per surface. */
export declare const HELP_COMMAND = "help";
/** Switch the agent's preset (standard / code / minimal / cordis). */
export declare const PRESET_COMMAND = "preset";
/** List this chat's stored sessions. */
export declare const SESSIONS_COMMAND = "sessions";
/** Bridge dual-end status, settings, and plugin sync. */
export declare const BOT_COMMAND = "bot";
/** View or toggle the chat's denied tools at runtime. */
export declare const TOOLS_COMMAND = "tools";
/** List the chat's active schedules (reminders). */
export declare const SCHEDULES_COMMAND = "schedules";
/** List this session's background jobs. */
export declare const JOBS_COMMAND = "jobs";
/** Rate the chat's most recent assistant answer. */
export declare const FEEDBACK_COMMAND = "feedback";
/** Show the session's current context pressure. */
export declare const CONTEXT_COMMAND = "context";
/** Show the session's operation audit summary. */
export declare const AUDIT_COMMAND = "audit";
/** List / inspect the workspace's discoverable skills. */
export declare const SKILLS_COMMAND = "skills";
/** Show the chat bridge's live configuration. */
export declare const CONFIG_COMMAND = "config";
/** View or switch the deployment's default model. */
export declare const MODEL_COMMAND = "model";
/** List the registry's workspaces (the chat surfaces of `workspaceRegistry`). */
export declare const WS_COMMAND = "ws";
/** List the deployed plugin tree with live status (the chat face of the web inventory). */
export declare const PLUGINS_COMMAND = "plugins";
/** The four shipped preset ids, for the listing and for argument validation. */
export declare const SHIPPED_PRESET_IDS: readonly ["standard", "code", "minimal", "cordis"];
/** Human names for the shipped presets, matching the deployment's preset.yml. */
export declare const PRESET_NAMES: Record<string, string>;
/** Display names for presets not in the shipped set fall back to the id. */
export declare function presetDisplayName(preset: {
    readonly id: string;
    readonly name?: string;
}): string;
/**
 * The command one line names, if it names one.
 * @param text - the message text exactly as received.
 * @returns the lowercase name without its slash, or undefined for prose.
 */
export declare function commandName(text: string): string | undefined;
/**
 * Whether one inbound line addresses the channel as a command.
 * @param text - the message text exactly as received.
 * @returns whether it opens with a slash and names something.
 */
export declare function isCommandLine(text: string): boolean;
/** What a command line did, for the chat to report. */
export interface CommandOutcome {
    /** Text to send back, empty when the command's own events already tell the story. */
    readonly reply: string;
    /** Whether the line resolved at all; an unresolved one is a typo worth naming. */
    readonly resolved: boolean;
}
/**
 * Render the help listing for one agent's available commands.
 * @param commands - the host command runtime, when composed.
 * @param agent - the agent whose scope decides what is available.
 * @returns the markdown listing.
 */
/**
 * The `/help` listing, in the bridge's resolved language.
 * @param commands - the host command runtime, when composed.
 * @param agent - the agent whose scope decides what is available.
 * @param locale - the resolved display language.
 * @returns the markdown listing.
 */
export declare function helpText(commands: HostCommands | undefined, agent: HostAgent, locale?: 'zh' | 'en', config?: ResolvedConfig): string;
/**
 * Run one command line for a chat's agent.
 *
 * `/stop`, `/preset`, and `/help` are answered here; everything else goes to
 * the host runtime, whose `undefined` means the name never resolved — reported
 * as such with the listing, because silently feeding a typo to the model is
 * how `/stop` became a message the bot ignored.
 * @param line - the complete line, leading slash included.
 * @param agent - the chat's agent.
 * @param commands - the host command runtime, when composed.
 * @param signal - cancellation for the host execution.
 * @param presets - the agent-preset roster, when composed (for `/preset`).
 * @param persistence - the session store, when composed (for `/sessions`).
 * @param chatId - the conversation facet key this chat's sessions belong to.
 * @param deniedTools - the live denied-tool set (for `/tools`).
 * @param schedules - live schedule registry by session id (for `/schedules`).
 * @param audits - live audit counters by session id (for `/audit`).
 * @param config - the bridge's live configuration (for `/config`).
 * @param sessionPresets - per-session preset choices (for `/preset` persistence).
 * @returns what to report to the chat.
 */
export declare function runCommandLine(line: string, agent: HostAgent, commands: HostCommands | undefined, signal: AbortSignal, presets?: HostAgentPresets | undefined, persistence?: HostSessionPersistence | undefined, chatId?: string | undefined, deniedTools?: ReadonlySet<string> | undefined, schedules?: ReadonlyMap<string, ReadonlyMap<string, ScheduleEntry>> | undefined, audits?: ReadonlyMap<string, AuditStats> | undefined, config?: ResolvedConfig | undefined, sessionPresets?: Map<string, string> | undefined, sessionQuery?: HostSessionQuery | undefined, jobs?: HostJobs | undefined, feedback?: HostMessageFeedback | undefined, lastAssistantMessageId?: string | undefined, tokenMeter?: HostTokenMeter | undefined, skills?: HostSkills | undefined, defaultModel?: HostDefaultModel | undefined, configModel?: {
    readonly provider?: string;
    readonly model?: string;
} | undefined, workspaces?: HostWorkspaceRegistry | undefined, currentCwd?: string | undefined, loaderEntries?: readonly HostLoaderEntry[] | undefined, sync?: SyncCommandContext | undefined): Promise<CommandOutcome>;
//# sourceMappingURL=commands.d.ts.map