/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-lark-bridge/config
 */
import z from '@deepseek-ai/schemastery';
import type { SessionScope } from './session.ts';
/** Plugin configuration supplied by the profile composition. */
export interface Config {
    /** Lark/Feishu app id (`cli_…`); absent (with no stored credential) starts first-boot QR registration. */
    appId?: string;
    /** Lark/Feishu app secret paired with {@link appId}. */
    appSecret?: string;
    /** Open-platform domain: `https://open.feishu.cn` (default) or `https://open.larksuite.com`. */
    domain?: string;
    /**
     * Panel and help language. `auto` (default) picks English for the
     * international Lark domain (`open.larksuite.com`) and Chinese for the
     * domestic Feishu domain (`open.feishu.cn`); `zh`/`en` force one.
     */
    locale?: 'auto' | 'zh' | 'en';
    /** Absolute workspace directory for chat-driven agents; defaults to the host process cwd. */
    cwd?: string;
    /** Provider route override for chat agents; defaults to the host `agentDefaultModel` selection. */
    provider?: string;
    /** Model id override for chat agents; defaults to the host `agentDefaultModel` selection. */
    model?: string;
    /**
     * Agent preset chat agents join, when the deployment composes a roster.
     * Absent joins the roster default. A deployment WITH a roster keeps every
     * model-facing row on the agent plane, so joining nothing would reach the
     * model with no tools at all.
     */
    preset?: string;
    /**
     * Which conversation facet owns one agent session. The session id is derived
     * from that facet alone, so a restarted process reaches the conversation's
     * stored session instead of starting it over. `chat` gives a group one shared
     * agent; `chat-thread` gives each topic thread its own, so parallel topics
     * stop overwriting each other's context; `chat-sender` gives each person in a
     * shared chat their own.
     */
    sessionScope?: SessionScope;
    /**
     * How assistant output reaches the chat. `cot` (default) shows the process as
     * a native thinking-process message — reasoning, tool calls with icons,
     * results as code — and sends the answer as an ordinary message, which is
     * where the platform says a final answer belongs. It needs a client new
     * enough to render one (PC 7.70, mobile 7.74); `stream` keeps the whole turn
     * in one typewriter card, for clients older than that surface.
     */
    output?: 'cot' | 'stream';
    /**
     * Show what the agent did on its way to an answer: its reasoning and the
     * tools it called. Off sends the answer alone.
     */
    showProcess?: boolean;
    /**
     * Pass images a chat sends on to the model.
     *
     * Off by default, and deliberately: a route that cannot take images rejects
     * the whole request, the image is already in the session log by then, and
     * every later turn resends it — so one screenshot ends the conversation for
     * good, with no way back from the chat, because compaction sends that history
     * too. The host exposes no way to ask a route whether it accepts images, so
     * the deployment that knows its route is a vision one says so here.
     */
    attachImages?: boolean;
    /**
     * Let the platform drop the process once its run finishes, leaving only the
     * answer in the conversation. `cot` output only.
     */
    hideProcessWhenDone?: boolean;
    /**
     * Register this channel's commands on the bot so Feishu offers them when a
     * user types `/`. Reconciling: the panel ends up offering exactly what this
     * channel accepts, so an entry it no longer offers is removed rather than
     * left to answer "unknown command". Off means commands still work, typed
     * from memory, and a hand-curated panel is left untouched.
     */
    syncSlashCommands?: boolean;
    /** Send a one-time first-contact guide when a brand-new session starts. */
    onboarding?: boolean;
    /**
     * Tools chat agents may not call, denied per agent at execution with a
     * reason that redirects the model to the chat.
     *
     * The default names the two human-interaction tools whose answers cannot
     * reach this channel: `ctx.userQuestions` admits ONE provider per context,
     * so when any other UI registered it (the Web app's BFF claims every
     * agent-owned question) a chat agent's question would wait on a surface its
     * human is not watching. Asking in the chat is the native equivalent — a
     * reply is an ordinary message this bridge already turns into the next turn.
     */
    denyTools?: string[];
    /** In group chats, only respond when the bot is @-mentioned. */
    requireMention?: boolean;
    /**
     * Show lifecycle feedback as emoji reactions on the triggering message:
     * 👀 收到 → 🧠 思考 → ✅ 完成 / ⚠️ 失败. Off sends no reactions at all.
     * The app needs the `im:message.reactions:read` (and create) scope.
     */
    reactionFeedback?: boolean;
    /**
     * Open ids (`ou_…`) allowed to send direct messages, when a deployment wants
     * to narrow them further. Empty serves anyone who can reach the bot at all,
     * which the platform already decides: an app's visibility scope is what says
     * who in the tenant may open a conversation with it, and that decision
     * belongs in the developer console rather than duplicated here.
     */
    senderAllowlist?: string[];
    /**
     * When non-empty, only these group chat ids (`oc_…`) are served. Empty serves
     * any group the bot is added to. Group members are NOT gated individually:
     * a group is a room someone deliberately put the bot in, so the gate that
     * matters is which rooms, and {@link requireMention} decides what counts as
     * addressing it.
     */
    groupAllowlist?: string[];
    /**
     * Open ids (`ou_…`) allowed to answer approval questions. Empty lets whoever
     * may drive that chat answer it too, which in a group is the room; the
     * settled card names who decided either way. Set this when an escalation
     * should need a named human — it grants more power than the sandbox allows.
     */
    approvers?: string[];
    /**
     * Automatically resume an active goal when its session comes back after a
     * bridge restart. dsh's goal phase is durable (survives restarts) but the
     * continuation authority (activation) is process-local and resets to
     * disarmed — a human re-arms it with /goal resume. With this on, the bridge
     * re-arms an active goal itself when the chat speaks to the session again,
     * so a task interrupted by a deploy keeps running instead of silently
     * stopping. Off keeps dsh's default (goal pauses until asked to resume).
     */
    autoResumeGoals?: boolean;
    /**
     * Milliseconds before an unanswered approval card gets a nudge message.
     * `0` (default) disables reminders. Set e.g. 120000 to ping the chat two
     * minutes after a card was published and still unanswered — the agent is
     * waiting on it, and a chat that has no visual "pending" surface otherwise
     * looks like it stopped.
     */
    approvalReminderMs?: number;
}
/** Configuration after defaults have been resolved; credentials may still be pending onboarding. */
export interface ResolvedConfig {
    appId?: string | undefined;
    appSecret?: string | undefined;
    domain?: string | undefined;
    cwd?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    preset?: string | undefined;
    locale: 'zh' | 'en';
    sessionScope: SessionScope;
    output: 'cot' | 'stream';
    showProcess: boolean;
    attachImages: boolean;
    hideProcessWhenDone: boolean;
    syncSlashCommands: boolean;
    onboarding: boolean;
    denyTools: string[];
    requireMention: boolean;
    reactionFeedback: boolean;
    senderAllowlist: string[];
    groupAllowlist: string[];
    approvers: string[];
    autoResumeGoals: boolean;
    approvalReminderMs: number;
}
/** Loader-visible configuration schema and defaults. */
export declare const Config: z<Config>;
/**
 * Resolve the panel/help language. Explicit `zh`/`en` wins; `auto` (and
 * absent) follows the platform domain — the international Lark console lives
 * at `open.larksuite.com`, the domestic Feishu one at `open.feishu.cn`.
 * @param config - serialized configuration.
 * @returns the resolved language.
 */
export declare function resolveLocale(config: Config): 'zh' | 'en';
/**
 * Resolve the same defaults for direct callers that bypass Cordis Loader.
 * @param config - Serialized configuration with the required credentials.
 * @returns Configuration with all schema defaults applied.
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map