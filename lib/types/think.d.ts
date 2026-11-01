/**
 * Per-session reasoning effort: `/think`.
 *
 * The effort a turn runs at is not something the bridge can set on the agent.
 * The loop resolves it as `options.reasoningEffort ?? persisted header`, and
 * the options come from the deployment's default at creation time — so
 * rewriting that default, which is all `/model` can do, reaches the NEXT
 * session and leaves every running one where it was. A chat needs two things a
 * command can give it: a way to READ what the next request will actually send,
 * and a way to CHANGE it without opening a new session.
 *
 * The change rides the host's own `agent/request` waterfall — the same seam the
 * web UI's model picker uses (`installModelSelection`): the resolved envelope
 * is rewritten on its way to the adapter, so a switch lands on the next step
 * rather than the next session. The choice is recorded as a durable
 * `model/selection` event, the exact event shape that surface writes, so a
 * resumed session and a web-UI client read the same fact instead of two.
 * @module dsh-lark-bridge/think
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandOutcome } from './commands.ts';
import type { HostAgent, HostDefaultModel, HostLlm, HostSession } from './host.ts';
/**
 * Levels offered when no adapter publishes its own.
 *
 * These are the levels the DeepSeek adapters ship (off/low/high/max). The list
 * is a fallback, not the truth: a route that describes itself wins, because
 * offering a level the provider rejects turns a settings command into a failed
 * turn.
 */
export declare const FALLBACK_EFFORTS: readonly string[];
/** One selectable level. */
export interface EffortLevel {
    readonly id: string;
    /** Adapter-provided display name, when it has one. */
    readonly name?: string;
}
/** The levels one route accepts, and where that list came from. */
export interface EffortCatalog {
    readonly levels: readonly EffortLevel[];
    /** The adapter's own default, materialized when a request omits an effort. */
    readonly defaultEffort?: string;
    /** `adapter` when the route described itself, `fallback` otherwise. */
    readonly source: 'adapter' | 'fallback';
}
/** What one `/think` line asked for. */
export type ThinkIntent = {
    readonly kind: 'show';
} | {
    readonly kind: 'set';
    readonly effort: string;
} | {
    readonly kind: 'reset';
};
/** A recorded model selection, as the session log stores it. */
export interface ModelSelection {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
}
/** The parts of one resolved request envelope the override touches. */
export interface RequestEnvelope {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/**
 * Parse one `/think` line.
 * @param line - the trimmed command line, leading slash included.
 * @returns what the line asked for; an empty argument means "show".
 */
export declare function parseThinkLine(line: string): ThinkIntent;
/**
 * Read the last model selection one session recorded.
 *
 * The scan is a plain array walk — the host serves `eventAt` straight out of
 * the loaded log — so it costs nothing measurable on the path that opens a
 * session, and it keeps the choice in the session instead of in a second store
 * that could drift from it.
 * @param session - the session whose log to scan.
 * @returns the newest recorded selection, or undefined when none exists.
 */
export declare function lastSelection(session: HostSession): ModelSelection | undefined;
/**
 * Resolve the levels one route accepts.
 * @param llm - the llm runtime, when composed.
 * @param provider - the route's provider.
 * @param model - the route's model.
 * @returns the adapter's own list when it has one, the fallback otherwise.
 */
export declare function effortCatalog(llm: HostLlm | undefined, provider: string | undefined, model: string | undefined): Promise<EffortCatalog>;
/**
 * The live per-session effort choices, and the request hook that applies them.
 *
 * One instance serves the whole bridge: every agent's `setup` installs a hook
 * that reads this table by session id, so a choice made in a chat applies to
 * that chat's agent and to no other.
 */
export declare class EffortOverrides {
    private readonly bySession;
    /** Advertised levels per route, so the capability lookup runs once per model. */
    private readonly accepted;
    private readonly ctx;
    /**
     * @param ctx - the bridge's context, used to reach the llm runtime lazily —
     *   a profile that mounts the llm row later still gets a correct answer.
     */
    constructor(ctx: Context);
    /**
     * The override in force for one session.
     * @param sessionId - the session to look up.
     * @returns the chosen effort, or undefined when the session follows the default.
     */
    get(sessionId: string): string | undefined;
    /**
     * Re-read one session's choice from its own log.
     *
     * Called when an agent is composed: a resumed session must come back at the
     * effort its human chose, not at the deployment default.
     * @param session - the session being opened.
     */
    restore(session: HostSession): void;
    /**
     * Record one session's choice, durably when the host can append.
     * @param session - the session the choice belongs to.
     * @param selection - the provider/model it applies to, plus the effort
     *   (`undefined` clears the override and returns the session to the default).
     */
    set(session: HostSession, selection: ModelSelection): void;
    /**
     * Install the request-side override on one agent's scope.
     * @param agentCtx - the agent's scoped context.
     * @param sessionId - the session this agent drives.
     */
    install(agentCtx: Context, sessionId: string): void;
    /**
     * Whether one route advertises an effort.
     *
     * Unknown routes pass: a provider that publishes no reasoning metadata may
     * still accept the field, and refusing on silence would make the command
     * useless on exactly the deployments that need it.
     */
    private accepts;
}
/**
 * Handle `/think [level|reset]`: show or change this session's reasoning effort.
 * @param line - the trimmed command line.
 * @param agent - the chat's agent (owns the session being changed).
 * @param overrides - the live override table, when the bridge wired one.
 * @param llm - the llm runtime, when composed (for the route's own levels).
 * @param defaultModel - the deployment default, for the "follow the default" line.
 * @returns the reply for the chat.
 */
export declare function runThinkCommand(line: string, agent: HostAgent, overrides: EffortOverrides | undefined, llm: HostLlm | undefined, defaultModel: HostDefaultModel | undefined): Promise<CommandOutcome>;
//# sourceMappingURL=think.d.ts.map