/**
 * Workflow fan-out as a few chat lines instead of one per subagent.
 *
 * A workflow run appends one `agent-start` and one `agent-end` event per
 * member. A 68-member scan therefore produced 136 near-identical chat
 * messages inside a couple of minutes — enough to trip Feishu's per-chat rate
 * limit on its own, and unreadable on a phone even when it did not.
 *
 * The information a reader actually wants is "it is fanning out, this much is
 * done, this much failed". That is a counter, so this narrator counts: lines
 * that arrive inside one window are folded into a single message, and the run
 * closes with one summary line. Ordering and identity survive as a short label
 * preview; everything else becomes arithmetic.
 * @module dsh-lark-bridge/workflow-narrator
 */
import { runEndLine, runStartLine } from "./workflow.js";
/**
 * Quote at most `max` labels, then state how many were left out.
 * @param labels - labels collected in the window, in arrival order.
 * @param max - how many to quote.
 * @returns one clause, or an empty string when nothing started.
 */
function labelPreview(labels, max) {
    if (labels.length === 0)
        return '';
    if (labels.length <= max)
        return labels.join('、');
    return `${labels.slice(0, max).join('、')} 等 ${labels.length} 个`;
}
/**
 * Render the delta of one window as chat markdown.
 *
 * Nothing is sent when the window collected nothing, which keeps a run whose
 * members all started in an earlier window from emitting empty lines.
 * @param delta - what the window collected.
 * @param maxLabels - label budget for the start clause.
 * @returns the line, or undefined when there is nothing to say.
 */
function progressLine(delta, maxLabels) {
    const parts = [];
    if (delta.started.length > 0) {
        parts.push(`启动 ${delta.started.length} 个（${labelPreview(delta.started, maxLabels)}）`);
    }
    if (delta.completed > 0)
        parts.push(`✅ ${delta.completed}`);
    if (delta.failed > 0)
        parts.push(`❌ ${delta.failed}`);
    if (delta.cancelled > 0)
        parts.push(`⏹️ ${delta.cancelled}`);
    if (parts.length === 0)
        return undefined;
    return `  · ${parts.join(' · ')}`;
}
/**
 * Close a run as one line: the terminal reason plus the counts that make it
 * meaningful, so 68 members do not need 68 lines to say what happened.
 * @param run - the closing event.
 * @param totals - everything the run did.
 * @returns the summary line.
 */
function summaryLine(run, totals) {
    const parts = [`启动 ${totals.started}`];
    if (totals.completed > 0)
        parts.push(`✅ ${totals.completed}`);
    if (totals.failed > 0)
        parts.push(`❌ ${totals.failed}`);
    if (totals.cancelled > 0)
        parts.push(`⏹️ ${totals.cancelled}`);
    return `${runEndLine(run)} · ${parts.join(' ')}`;
}
/**
 * Build the coalescing narrator.
 * @param port - how to reach a chat.
 * @param options - window length, label budget, failure reporting.
 * @returns the narrator the bridge drives.
 */
export function createWorkflowNarrator(port, options = {}) {
    const coalesceMs = options.coalesceMs ?? 2_000;
    const maxLabels = options.maxLabels ?? 6;
    const onFailure = options.onFailure ?? (() => { });
    const runs = new Map();
    const send = (chatId, markdown) => {
        void port.send(chatId, { markdown }).catch(onFailure);
    };
    const clearTimer = (state) => {
        if (state.timer === undefined)
            return;
        clearTimeout(state.timer);
        state.timer = undefined;
    };
    const flush = (state) => {
        clearTimer(state);
        const line = progressLine(state.delta, maxLabels);
        state.delta.started.length = 0;
        state.delta.completed = 0;
        state.delta.failed = 0;
        state.delta.cancelled = 0;
        if (line !== undefined)
            send(state.chatId, line);
    };
    const schedule = (state) => {
        if (state.timer !== undefined)
            return;
        state.timer = setTimeout(() => { flush(state); }, coalesceMs);
        state.timer.unref?.();
    };
    const ensure = (runId, chatId) => {
        const existing = runs.get(runId);
        if (existing !== undefined)
            return existing;
        const state = {
            chatId,
            totals: { started: 0, completed: 0, failed: 0, cancelled: 0 },
            delta: { started: [], completed: 0, failed: 0, cancelled: 0 },
        };
        runs.set(runId, state);
        return state;
    };
    return {
        runStart(run, chatId) {
            // A re-delivered run-start must not restart the counters mid-run.
            if (runs.has(run.runId))
                return;
            ensure(run.runId, chatId);
            send(chatId, runStartLine(run));
        },
        agentStart(agent, chatId) {
            const state = ensure(agent.runId, chatId);
            state.totals.started += 1;
            state.delta.started.push(agent.label);
            schedule(state);
        },
        agentEnd(agent, chatId) {
            const state = ensure(agent.runId, chatId);
            if (agent.outcome === 'completed') {
                state.totals.completed += 1;
                state.delta.completed += 1;
            }
            else if (agent.outcome === 'failed') {
                state.totals.failed += 1;
                state.delta.failed += 1;
            }
            else {
                state.totals.cancelled += 1;
                state.delta.cancelled += 1;
            }
            schedule(state);
        },
        runEnd(run, chatId) {
            const state = runs.get(run.runId) ?? ensure(run.runId, chatId);
            runs.delete(run.runId);
            clearTimer(state);
            send(chatId, summaryLine(run, state.totals));
        },
        dispose() {
            for (const state of runs.values())
                clearTimer(state);
            runs.clear();
        },
    };
}
//# sourceMappingURL=workflow-narrator.js.map