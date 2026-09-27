/**
 * Tracks subagent children for one chat session and renders them as a single
 * updatable Feishu interactive card. One card shows ALL live children; each
 * status change re-renders the card in place.
 *
 * 2026-09-15 — live content. Before this, the card only ever showed
 * `label — status`, and in practice it never appeared at all: the bridge built
 * it from `subagent/descriptor`, which 0.1.5 appends **into the child's own
 * session** (`subagent-in-process-driver/src/index.ts` attachDescriptorAppend),
 * so a parent-session subscriber never sees it. What the parent session does
 * receive is `subagent/catalog` (`subagent/src/catalog.ts` establishCatalogChild
 * → `parent.append`), carrying `childId / childCreatedAt / mode / label`.
 * This module is keyed by that `childId`, and carries the child's latest
 * observed activity so a reader can tell what a subagent is doing without
 * leaving the chat.
 * @module dsh-lark-bridge/subagent-card
 */
export type SubagentStatus = 'running' | 'completed' | 'aborted' | 'error' | 'max-tokens';
export interface SubagentEntry {
    /** The child's session id (`subagent/catalog.childId`). */
    readonly id: string;
    readonly label: string;
    readonly mode: 'one-shot' | 'continuable';
    status: SubagentStatus;
    /** Epoch ms when the child was first seen. */
    readonly startedAt: number;
    /** Epoch ms of the last activity we observed for this child. */
    lastAt?: number;
    /** Short「最近在做的事」— the child's own latest output snippet. */
    lastActivity?: string;
    /** Last few distinct output lines (oldest first). The delivery block quotes
     * the tail of this, so one child reports WHAT it produced, not just that it
     * finished. Bounded — a child is not a transcript. */
    recent: string[];
    /** How many activity samples have been folded into {@link lastActivity}. */
    chunks: number;
    /** Epoch ms when it settled. */
    endedAt?: number;
}
export interface SubagentCardState {
    readonly entries: Map<string, SubagentEntry>;
    /** The message ID of the sent card, for updateCard calls. */
    messageId?: string;
    /** Epoch ms of the last in-place card update (throttling). */
    updatedAt?: number;
}
export declare function createTracker(): SubagentCardState;
/** Longest activity snippet kept per child — one card line, not a transcript. */
export declare const ACTIVITY_MAX = 68;
/** How many distinct lines a child's delivery block remembers (and quotes ≤3). */
export declare const RECENT_MAX = 5;
/** Collapse whitespace and clip, so one line stays one line on a phone. */
export declare function clipActivity(text: string, max?: number): string;
/**
 * Register (or refresh) one child. Idempotent: `subagent/catalog` may be
 * re-delivered on replay/reconnect, and re-adding must not spawn a second row.
 */
export declare function addEntry(state: SubagentCardState, id: string, descriptor: {
    mode?: string;
    label?: string;
}, now?: number): SubagentEntry;
/**
 * Fold one observed activity sample into a child's row. Returns the entry, or
 * undefined when the id is unknown (an unattributable frame must not invent a
 * row — see the attribution rule in bridge.ts).
 */
export declare function markActivity(state: SubagentCardState, id: string, text: string, now?: number): SubagentEntry | undefined;
export declare function settleEntry(state: SubagentCardState, id: string, stopReason: string, now?: number): SubagentEntry | undefined;
/**
 * The one-message summary a finished child posts.
 *
 * The panel row already answers「还在跑吗」; this answers「它到底做出了什么」,
 * which is the question the reader actually has (and what the old bare
 * `✅ 子任务结束 [id]` line never did). Deliberately bounded to the last few
 * lines — a child is summarised, never replayed.
 */
export declare function deliveryText(entry: SubagentEntry, now?: number): string;
/** Children still running — the window an unattributable frame may fall into. */
export declare function runningEntries(state: SubagentCardState): SubagentEntry[];
/** Settle every still-running one-shot child once the spawning turn is over.
 *
 * One-shot children are driven inside the tool call that spawned them, so a
 * parent `turn/end` means they can no longer progress. `continuable` children
 * survive between turns by design — their status is left alone.
 */
export declare function settleRunningOneShots(state: SubagentCardState, now?: number): number;
export declare function elapsedText(from: number, to: number): string;
export declare function render(state: SubagentCardState, now?: number): object;
//# sourceMappingURL=subagent-card.d.ts.map