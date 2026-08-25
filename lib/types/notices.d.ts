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
/** A background job's terminal line (from `JobRegistry.onJobDone`). */
export declare function jobDoneLine(job: {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly status: 'completed' | 'killed' | 'failed';
    readonly detail?: string;
}): string;
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
 * A proactive token-pressure warning: the session's context has climbed past
 * the compaction advice threshold. Unlike the compaction notices (which fire
 * after the fact), this is a heads-up the bridge polls for while a long task
 * is running, so the chat hears about pressure before the model degrades.
 * @param total - current measured total tokens.
 * @param surface - the session-surface portion of the total.
 * @param threshold - the configured warning threshold.
 * @returns the markdown line for the chat.
 */
export declare function tokenPressureLine(data: {
    readonly total: number;
    readonly surface: number;
    readonly threshold: number;
}): string;
//# sourceMappingURL=notices.d.ts.map