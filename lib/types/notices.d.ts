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
/** The `schedule/change` payload fields this module renders. */
export interface ScheduleNotice {
    readonly operation: 'create' | 'delete' | 'dispatch';
    readonly kind?: 'after' | 'at' | 'every';
    readonly prompt?: string;
}
/** A schedule mutation line. `dispatch` stays silent — it fires on schedule and is noise. */
export declare function scheduleLine(notice: ScheduleNotice): string | undefined;
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
 * A compaction summary line: what replaced the old history, and at what cost.
 * @param data - the `compaction/summary` payload.
 * @returns the markdown line for the chat.
 */
export declare function compactionSummaryLine(data: {
    readonly summary: readonly unknown[];
    readonly shadowedTokenCount: number;
}): string;
/**
 * A prune line: old history was trimmed without a model call.
 * @param data - the `compaction/prune` payload.
 * @returns the markdown line for the chat.
 */
export declare function compactionPruneLine(data: {
    readonly shadowedSeqs: readonly number[];
    readonly shadowedTokenCount: number;
}): string;
/**
 * 上下文占用的预警文案。
 *
 * 原来写的是「总量 X tokens / 会话表面 Y」——「会话表面」是宿主字段
 * `surfaceTokens` 的直译，读者从中看不出它指的是"你俩聊过的内容"，更看不出
 * 总量与它之间的差额是工具说明这类常驻开销。差额恰恰是关键：真正超线时，
 * 压历史能降的是前半段，压不掉的是后半段。
 * @param data - 当前总量、其中的聊天内容、以及预警线。
 * @returns 发到聊天里的那一段。
 */
export declare function tokenPressureLine(data: {
    readonly total: number;
    readonly surface: number;
    readonly threshold: number;
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
/**
 * `/context` 的回复：占用多少，以及占在哪。
 *
 * 一行总数对"要不要压缩"够用，对"压了有没有用"不够：一台挂满 MCP 的机器，
 * 工具说明就能占掉小一半，这时压历史是白费力气。所以有分组就摊开说。
 * @param data - 总量、聊天内容、可选的三段拆分。
 * @returns 回复正文（markdown）。
 */
export declare function contextPressureLine(data: {
    readonly total: number;
    readonly surface: number;
    readonly breakdown?: ContextBreakdown | undefined;
}): string;
//# sourceMappingURL=notices.d.ts.map