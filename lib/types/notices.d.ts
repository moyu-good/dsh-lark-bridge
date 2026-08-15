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
/** A model-call retry line; only the first retry of a failure is announced. */
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
//# sourceMappingURL=notices.d.ts.map