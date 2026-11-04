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
    /**
     * 收尾原因原文（`stopReason`）。
     *
     * 只标一个 ❌ 回答不了「为什么失败」——读者还得去翻会话记录。把原文留下来，
     * 失败行就能直接说清楚是超时、是拒绝、还是子代理自己抛的错。
     */
    stopReason?: string;
    /**
     * 失败或截断时的那句话。
     *
     * 取自子代理最后一条助手消息或报错的工具结果：这是「它卡在哪」的直接证据，
     * 比 `stopReason` 的枚举字面量有用得多。
     */
    failureDetail?: string;
    /**
     * 工具调用次数。
     *
     * 面板原来只报「N 条动作」，那是个把工具调用和发言混在一起的口径，
     * 读不出「它到底干了多少活」。分开数，进度感才有来源。
     */
    toolCalls: number;
    /** 已经发出的助手消息条数，代表这一路产出了多少段文字。 */
    messages: number;
    /**
     * 显式进度（`8/23` 这种），从子代理自己的话里认出来。
     *
     * 认不出来是常态——子代理不一定用「x/y」的口吻报进度——所以它只是补充，
     * 不是必需。认出来了就比「已跑 6 分钟」有用得多。
     */
    progress?: {
        readonly done: number;
        readonly total: number;
    };
}
export interface SubagentCardState {
    readonly entries: Map<string, SubagentEntry>;
    /** The message ID of the sent card, for updateCard calls. */
    messageId?: string;
    /** Epoch ms of the last in-place card update (throttling). */
    updatedAt?: number;
    /**
     * Whether a send/update is in flight.
     *
     * The panel is the ONLY place a child's progress is visible once the chat
     * stops echoing each step, so two concurrent writes that both read the same
     * pre-update state must not race: the later one would overwrite the earlier
     * with a stale render, and Feishu would see duplicate updates in one window.
     */
    sending?: boolean;
    /** An update requested while one was in flight; sent once it settles. */
    pending?: boolean;
    /**
     * Consecutive failed updates.
     *
     * The card is the sole channel now, so a silent stall means the reader sees
     * a frozen panel and no way to know it stopped moving. Counting lets the
     * caller say so out loud instead of failing quietly.
     */
    failures?: number;
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
 * 从一句话里认出 `8/23`、`12 / 40`、`已完成 3/7` 这样的进度。
 *
 * 只在两部分都像「小数目」时才认，避免把 `2026/11` 这样的日期、`8/23 区`
 * 之外的比例数字（比如 URL、版本号、分数）误当进度。取最后出现的那一个，
 * 因为子代理通常把最新进度放在句末。
 * @param text - 子代理的一句话。
 * @returns 认出来的进度，认不出时为 undefined。
 */
export declare function parseProgress(text: string): {
    done: number;
    total: number;
} | undefined;
/**
 * Fold one observed activity sample into a child's row. Returns the entry, or
 * undefined when the id is unknown (an unattributable frame must not invent a
 * row — see the attribution rule in bridge.ts).
 */
export declare function markActivity(state: SubagentCardState, id: string, text: string, now?: number, kind?: 'tool' | 'message'): SubagentEntry | undefined;
export declare function settleEntry(state: SubagentCardState, id: string, stopReason: string, now?: number, failureDetail?: string): SubagentEntry | undefined;
/** 失败原因最多留多少字：够说清是什么错，又不至于把卡片撑爆。 */
export declare const FAILURE_MAX = 100;
/**
 * 从结束事件里捞出「它最后说了什么」，作为失败原因。
 *
 * `SubagentEndData.lastAssistantMessage` 是子代理最后一轮助手消息的原始内容
 * 块数组；失败时这段文字通常就是错误原文或它卡住的地方。取不到就退回
 * `stopReason` 的枚举字面量——有总比只标一个 ❌ 强。
 * @param info - `subagent/end` 的载荷。
 * @returns 可以直接写进面板的一行话；没有任何线索时为空串。
 */
export declare function failureText(info: {
    readonly stopReason?: string;
    readonly lastAssistantMessage?: readonly unknown[];
}): string;
/**
 * 一个子代理多久没动静就算「疑似卡住」。
 *
 * 子代理跑长工具（构建、批量抓取）时安静几分钟是正常的，所以这个阈值不能
 * 太小；但也不能太大，否则面板对「真卡死」的反应比人还慢。两分钟是折中：
 * 大多数工具调用都在这个时间内回来，超过它值得被标出来。
 */
export declare const STALL_MS = 120000;
/**
 * 一行「做过多少事」的纵深，避免每个子代理看起来都一样厚。
 * @param entry - 一个子代理。
 * @returns 形如 `已做 42 步 · 3 段发言`；刚开始时为空串。
 */
export declare function volumeText(entry: SubagentEntry): string;
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
/** 五格进度条：一眼看出大概走到哪，不追求精确。 */
export declare function progressBar(done: number, total: number, width?: number): string;
/**
 * 收尾统计。
 *
 * 原来只写「N 结束 / M 进行中」，五个里两个失败扫一眼以为三个都好。失败必须
 * 单独报，它跟「完成」不是一回事。
 * @param state - 面板状态。
 * @returns 形如 `3 完成 · 1 失败 · 2 在跑`。
 */
export declare function summaryText(state: SubagentCardState): string;
/** 超过这个数量，已结束的子代理收进一行，不让面板无限拉长。 */
export declare const DONE_COLLAPSE_AFTER = 3;
export declare function render(state: SubagentCardState, now?: number): object;
//# sourceMappingURL=subagent-card.d.ts.map