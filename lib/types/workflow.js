/**
 * Workflow run progress as chat messages.
 *
 * dsh's `workflow` tool runs a JS orchestration script that fans out
 * subagents, and appends four event types to the session log: run-start,
 * agent-start, agent-end, run-end. The Web UI has a dedicated workflow-run
 * surface; a messaging client gets the same shape as a short text stream so
 * the human sees the fan-out happening instead of a silent gap followed by a
 * final answer.
 * @module dsh-lark-bridge/workflow
 */
/** The run-opening line. */
export function runStartLine(run) {
    return `🧩 工作流「${run.name}」开始，派出子任务…`;
}
/** The per-member outcome emoji. */
function outcomeMark(outcome) {
    switch (outcome) {
        case 'completed': return '✅';
        case 'failed': return '❌';
        case 'cancelled': return '⏹️';
    }
}
/** One member starting line (deduped by seq). */
export function agentStartLine(agent) {
    return `  · ${agent.label} 启动…`;
}
/** One member settling line. */
export function agentEndLine(agent) {
    return `  · #${agent.seq} ${outcomeMark(agent.outcome)}`;
}
/** The run-closing line. */
export function runEndLine(run) {
    const label = run.stopReason === 'completed' ? '全部完成' : run.stopReason === 'cancelled' ? '已取消' : '出错终止';
    return `🧩 工作流结束：${label}`;
}
//# sourceMappingURL=workflow.js.map