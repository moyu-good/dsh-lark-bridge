/**
 * Low-frequency session events rendered as one-off chat lines.
 *
 * The remaining events dsh logs that a chat user benefits from hearing are
 * small and one-shot: a subagent child opening, a scheduled task being
 * created or deleted, a DeepSeek search firing, and a model-call retry. Each
 * maps to a single short line — no card, no state — so the chat stays a
 * readable stream. `session/title` is deliberately NOT rendered: the Web UI
 * uses it for its session list, and a messaging chat has no list surface.
 * @module dsh-lark-bridge/notices
 */
/** The `subagent/descriptor` payload fields this module renders. */
export interface SubagentNotice {
    readonly mode: 'one-shot' | 'continuable';
    readonly label?: string;
}
/** A subagent child opening line. */
export declare function subagentLine(descriptor: SubagentNotice): string;
/**
 * Every rule kind the host scheduler accepts.
 *
 * Duplicated as a string union rather than imported from `host.ts` so this
 * module keeps its "no plugin dependencies" shape (it is the rendering layer
 * for notices, and `host.ts` is the type layer for services). The three
 * historical kinds are what `schedule/change` carries; the three wall-clock
 * kinds exist only on a durable record.
 */
export type ScheduleRuleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';
/** The schedule fields this module renders. */
export interface ScheduleView {
    readonly kind?: ScheduleRuleKind;
    readonly title?: string;
    readonly prompt?: string;
    readonly everySeconds?: number;
    readonly time?: string;
    readonly timeZone?: string;
    readonly weekdays?: readonly number[];
    readonly expression?: string;
    /** The next target instant, ISO-8601. */
    readonly scheduledAt?: string;
}
/** The `schedule/change` payload fields this module renders. */
export interface ScheduleNotice extends ScheduleView {
    readonly operation: 'create' | 'delete' | 'dispatch';
}
/**
 * Render one interval in the unit a person would say it in.
 *
 * Seconds are the scheduler's unit and nobody's reading unit: `每 1800 秒`
 * makes the reader divide, and the answer — 30 minutes — is exactly what they
 * wanted. The remainder is kept only when it is not zero, so a clean hour does
 * not read as `1 小时 0 分钟`.
 * @param seconds - the fixed interval.
 * @returns the phrase, or '' when the interval is missing or unusable.
 */
export declare function intervalPhrase(seconds: number | undefined): string;
/**
 * Render the recurring rule of one task as a phrase: `每 30 分钟`, `每天
 * 09:00`, `每周一、三 09:00`, `cron <表达式>`, `定点 11-06 09:00`.
 *
 * This is the answer to "when does this thing run", which the bridge used to
 * answer with the raw kind and a `undefined` interval for anything newer than
 * the three historical kinds. A wall-clock rule is shown in its own zone's
 * wall time — that is what the reader scheduled — and the zone is appended
 * only when it differs from this machine's, so the common case stays short.
 * @param view - the record fields to describe.
 * @returns the phrase, or '' when the record states no rule at all.
 */
export declare function scheduleRuleLabel(view: ScheduleView): string;
/**
 * The name to show for one task: its own title, else the prompt's first line.
 *
 * A title is required by the host's current `schedule_create`, so a task the
 * model made has one. Records written before titles existed, and every
 * historical `schedule/change` create, do not — and a list that shows nothing
 * but a 120-character prompt excerpt is what made the old panel unreadable.
 * @param view - the record.
 * @param limit - code points kept from the prompt's first line.
 * @returns the display name, or '' when the record is empty.
 */
export declare function scheduleName(view: ScheduleView, limit?: number): string;
/**
 * Render one task's next target: `下次 09:57（还有 27 分钟）`.
 *
 * An instant is what the record stores; "how long from now" is what a reader
 * decides with. Both, in that order, because the absolute one is what they
 * compare against a clock and the relative one is what tells them whether to
 * wait.
 * @param view - the record, carrying `scheduledAt` when the host reported it.
 * @param now - the reference instant.
 * @returns the phrase, or '' when there is no target.
 */
export declare function scheduleNextLabel(view: ScheduleView, now: number): string;
/** A schedule mutation line. `dispatch` renders through {@link scheduleDispatchLine}. */
export declare function scheduleLine(notice: ScheduleNotice): string | undefined;
/**
 * The line posted when a scheduled task actually fires.
 *
 * Delivery used to be silent: the host appends the prompt to the session as a
 * user-role message, and the chat saw a block of instructions arrive from
 * nobody. A reader could not tell "the agent decided to do this" from "a timer
 * decided to do this", and the recurring tasks that fire every half hour read
 * as the human repeatedly asking. One line names the task, its rule and its
 * origin, which is the difference between a scheduled check and a stranger
 * shouting into the conversation.
 *
 * It stays one line on purpose: the task's own output follows immediately, and
 * a card here would push that output off the screen for no new information.
 * @param view - the task that fired.
 * @returns the line.
 */
export declare function scheduleDispatchLine(view: ScheduleView): string;
/** A DeepSeek search firing line. */
export declare function webSearchLine(): string;
/** A live subagent settlement line (`subagent/end`). */
export declare function subagentEndLine(info: {
    readonly id: string;
    readonly provider: string;
    readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens';
}): string;
/**
 * The tail of a job's output, normalised for chat.
 *
 * The END of a run is where the answer lands — the head is usually setup noise
 * and progress spam — so a long output is cut from the FRONT and says how much
 * it dropped, rather than being truncated from the back into uselessness.
 */
export declare function outputTail(output: string | undefined, limit?: number): string;
export declare function jobDoneLine(job: {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly status: 'completed' | 'killed' | 'failed';
    readonly detail?: string;
    readonly durationMs?: number;
    readonly output?: string;
}, tailChars?: number): string;
/**
 * A model-call retry line. Transient upstream failures self-heal through the
 * retry policy in the vast majority of cases — announcing the first retry
 * only taught users to expect noise on every hiccup. The chat stays silent
 * while retries are in flight (the turn either completes or ends with an
 * error event either way); we speak up only at the LAST attempt, when the
 * next failure would actually kill the turn — the moment a human may want
 * to look at the route.
 */
export declare function retryLine(retry: {
    readonly retry: number;
    readonly maxRetries?: number;
}): string | undefined;
/**
 * What the shadowed records were, counted by source.
 *
 * A compaction event only carries sequence numbers, so the line used to say
 * "trimmed 1 message" and leave the reader guessing which one. The bridge
 * resolves those numbers against the session log and hands the counts here;
 * "1 条工具输出" answers the question the bare count raised.
 */
export interface ShadowedBreakdown {
    /** The human's own prompts. */
    readonly user: number;
    /** The assistant's replies. */
    readonly assistant: number;
    /** Tool invocations (the call, not its output). */
    readonly toolCall: number;
    /** Tool outputs — usually the bulk of what a prune removes. */
    readonly toolResult: number;
    /** Anything else: step markers, goal changes, other bookkeeping. */
    readonly other: number;
}
/** 压缩之后还剩多少上下文可用。 */
export interface CompactionUsage {
    /** 压缩完成时的当前总占用（token）。 */
    readonly total: number;
    /** 这一路的上下文窗口；拿不到就不提"还剩多少"。 */
    readonly window?: number | undefined;
}
/**
 * A compaction summary line: what replaced the old history, and at what cost.
 *
 * The summary text itself is deliberately NOT rendered. It is a model-written
 * digest — often in English, always full of goal ids and paths — and pasting
 * its first 200 characters made the notice read like a debug dump (the
 * 2026-11-04 complaint). The chat only needs to know that history was folded,
 * how much it was worth, and which kinds of records went into it.
 *
 * @param data - the `compaction/summary` payload.
 * @param breakdown - what the shadowed seqs were, when the caller resolved them.
 * @param usage - post-compaction occupancy and window, when the caller measured it.
 * @returns the markdown line for the chat.
 */
export declare function compactionSummaryLine(data: {
    readonly shadowedSeqs?: readonly number[];
    readonly shadowedTokenCount: number;
}, breakdown?: ShadowedBreakdown, usage?: CompactionUsage): string;
/**
 * A prune line: old history was trimmed without a model call.
 * @param data - the `compaction/prune` payload.
 * @param breakdown - what the shadowed seqs were, when the caller resolved them.
 * @param usage - post-prune occupancy and window, when the caller measured it.
 * @returns the markdown line for the chat.
 */
export declare function compactionPruneLine(data: {
    readonly shadowedSeqs: readonly number[];
    readonly shadowedTokenCount: number;
}, breakdown?: ShadowedBreakdown, usage?: CompactionUsage): string;
/**
 * 上下文占用的预警文案。
 *
 * 原来写的是「总量 X tokens / 会话表面 Y」——「会话表面」是宿主字段
 * `surfaceTokens` 的直译，读者从中看不出它指的是"你俩聊过的内容"，更看不出
 * 总量与它之间的差额是工具说明这类常驻开销。差额恰恰是关键：真正超线时，
 * 压历史能降的是前半段，压不掉的是后半段。
 *
 * 差额曾被称为「固定开销」，这个说法是错的，2026-11-05 被当场问住：差额是
 * 系统提示 + 工具定义，两者都会变——MCP 工具挂载/卸载、技能目录增减、
 * goal 状态、工作目录都会改它，而且宿主是按字符估 token，不是精确分词。
 * 现在如实说"不是固定值"，并列出会改变它的东西，免得读者以为桥在乱报数。
 * @param data - 当前总量、其中的聊天内容、以及预警线。
 * @returns 发到聊天里的那一段。
 */
export declare function tokenPressureLine(data: {
    readonly total: number;
    readonly surface: number;
    readonly threshold: number;
    /** 三段拆分，拿到时就报细分——差额里哪一块在变才看得见。 */
    readonly breakdown?: ContextBreakdown | undefined;
}): string;
/** 上下文占用的构成，来自宿主的 `contextBreakdown` 投影。 */
export interface ContextBreakdown {
    /** 存活消息（一轮轮对话本身）。 */
    readonly messageTokens: number;
    /** 系统提示。 */
    readonly systemTokens: number;
    /** 工具定义。 */
    readonly toolsTokens: number;
}
/** 一个工具在上下文里占的 token，按宿主的估算公式拆出来的。 */
export interface ToolCost {
    readonly name: string;
    readonly tokens: number;
}
/**
 * `/context` 的回复：占用多少，以及占在哪。
 *
 * 一行总数对"要不要压缩"够用，对"压了有没有用"不够：一台挂满 MCP 的机器，
 * 工具说明就能占掉小一半，这时压历史是白费力气。所以有分组就摊开说。
 * @param data - 总量、聊天内容、可选的三段拆分，以及可选的逐工具占用。
 * @returns 回复正文（markdown）。
 */
export declare function contextPressureLine(data: {
    readonly total: number;
    readonly surface: number;
    readonly breakdown?: ContextBreakdown | undefined;
    /** 逐工具占用；拿到时把「工具说明」那行摊开成明细。 */
    readonly toolCosts?: readonly ToolCost[] | undefined;
    /** 明细最多列几个工具；`Infinity` 表示全列（`/context all`）。 */
    readonly toolLimit?: number | undefined;
}): string;
//# sourceMappingURL=notices.d.ts.map