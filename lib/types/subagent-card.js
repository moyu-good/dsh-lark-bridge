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
export function createTracker() {
    return { entries: new Map() };
}
/** Longest activity snippet kept per child — one card line, not a transcript. */
export const ACTIVITY_MAX = 68;
/** How many distinct lines a child's delivery block remembers (and quotes ≤3). */
export const RECENT_MAX = 5;
/** Collapse whitespace and clip, so one line stays one line on a phone. */
export function clipActivity(text, max = ACTIVITY_MAX) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/**
 * Register (or refresh) one child. Idempotent: `subagent/catalog` may be
 * re-delivered on replay/reconnect, and re-adding must not spawn a second row.
 */
export function addEntry(state, id, descriptor, now = Date.now()) {
    const existing = state.entries.get(id);
    if (existing !== undefined) {
        return existing;
    }
    const entry = {
        id,
        label: descriptor.label ?? `子代理 ${state.entries.size + 1}`,
        mode: descriptor.mode === 'continuable' ? 'continuable' : 'one-shot',
        status: 'running',
        startedAt: now,
        recent: [],
        chunks: 0,
    };
    state.entries.set(id, entry);
    return entry;
}
/**
 * Fold one observed activity sample into a child's row. Returns the entry, or
 * undefined when the id is unknown (an unattributable frame must not invent a
 * row — see the attribution rule in bridge.ts).
 */
export function markActivity(state, id, text, now = Date.now()) {
    const entry = state.entries.get(id);
    if (entry === undefined)
        return undefined;
    const clipped = clipActivity(text);
    if (clipped !== '') {
        entry.lastActivity = clipped;
        // Consecutive duplicates are the same sentence still streaming — only a new
        // line is worth quoting in the delivery block.
        if (entry.recent[entry.recent.length - 1] !== clipped) {
            entry.recent.push(clipped);
            if (entry.recent.length > RECENT_MAX)
                entry.recent.splice(0, entry.recent.length - RECENT_MAX);
        }
    }
    entry.chunks += 1;
    entry.lastAt = now;
    return entry;
}
export function settleEntry(state, id, stopReason, now = Date.now()) {
    const e = state.entries.get(id);
    if (!e)
        return undefined;
    if (stopReason === 'completed')
        e.status = 'completed';
    else if (stopReason === 'aborted')
        e.status = 'aborted';
    else if (stopReason === 'max-tokens')
        e.status = 'max-tokens';
    else
        e.status = 'error';
    e.endedAt = now;
    return e;
}
/**
 * The one-message summary a finished child posts.
 *
 * The panel row already answers「还在跑吗」; this answers「它到底做出了什么」,
 * which is the question the reader actually has (and what the old bare
 * `✅ 子任务结束 [id]` line never did). Deliberately bounded to the last few
 * lines — a child is summarised, never replayed.
 */
export function deliveryText(entry, now = Date.now()) {
    const head = `${statusMark(entry.status)}【子代理${statusText(entry.status)}】${entry.label}`
        + ` · ${entry.chunks} 条动作 · ${elapsedText(entry.startedAt, entry.endedAt ?? now)}`;
    const tail = entry.recent.slice(-3).map(l => `　　↳ ${l}`);
    return [head, ...tail].join('\n');
}
/** Children still running — the window an unattributable frame may fall into. */
export function runningEntries(state) {
    return [...state.entries.values()].filter(e => e.status === 'running');
}
/** Settle every still-running one-shot child once the spawning turn is over.
 *
 * One-shot children are driven inside the tool call that spawned them, so a
 * parent `turn/end` means they can no longer progress. `continuable` children
 * survive between turns by design — their status is left alone.
 */
export function settleRunningOneShots(state, now = Date.now()) {
    let n = 0;
    for (const e of state.entries.values()) {
        if (e.status !== 'running' || e.mode !== 'one-shot')
            continue;
        e.status = 'completed';
        e.endedAt = now;
        n += 1;
    }
    return n;
}
function statusMark(s) {
    switch (s) {
        case 'completed': return '✅';
        case 'aborted': return '⏹️';
        case 'error': return '❌';
        case 'max-tokens': return '⛔';
        default: return '⏳';
    }
}
function statusText(s) {
    switch (s) {
        case 'completed': return '完成';
        case 'aborted': return '已中止';
        case 'error': return '出错';
        case 'max-tokens': return '超长截断';
        default: return '进行中';
    }
}
export function elapsedText(from, to) {
    const sec = Math.max(0, Math.round((to - from) / 1000));
    if (sec < 60)
        return `${sec}秒`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60)
        return s === 0 ? `${m}分` : `${m}分${s}秒`;
    const h = Math.floor(m / 60);
    return `${h}小时${m % 60}分`;
}
export function render(state, now = Date.now()) {
    const rows = [];
    for (const [, e] of state.entries) {
        const mark = statusMark(e.status);
        const end = e.endedAt ?? now;
        const line = ` ${mark} **${e.label}** · ${statusText(e.status)} · ${elapsedText(e.startedAt, end)}`;
        rows.push(e.lastActivity === undefined ? line : `${line}\n　　↳ ${e.lastActivity}`);
    }
    const running = runningEntries(state).length;
    const body = rows.length > 0 ? rows.join('\n') : '（无子任务）';
    const total = state.entries.size;
    const summary = total === 0 ? '' : `\n\n${total - running} 结束 / ${running} 进行中`;
    return {
        config: { wide_screen_mode: true },
        header: {
            template: running > 0 ? 'purple' : 'grey',
            title: { tag: 'plain_text', content: `🧑‍💻 多代理执行面板（${running} 进行中）` },
        },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: body + summary } },
        ],
    };
}
//# sourceMappingURL=subagent-card.js.map