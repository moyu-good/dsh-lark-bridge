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
/** One workflow run's identity and display name (from `tool-workflow/run-start`). */
export interface WorkflowRunStart {
    readonly runId: string;
    readonly name: string;
}
/** One workflow member (from `tool-workflow/agent-start`). */
export interface WorkflowAgentStart {
    readonly runId: string;
    readonly seq: number;
    readonly label: string;
}
/** One workflow member settlement (from `tool-workflow/agent-end`). */
export interface WorkflowAgentEnd {
    readonly runId: string;
    readonly seq: number;
    readonly outcome: 'completed' | 'failed' | 'cancelled';
}
/** One workflow run close (from `tool-workflow/run-end`). */
export interface WorkflowRunEnd {
    readonly runId: string;
    readonly stopReason: 'completed' | 'cancelled' | 'error';
}
/** The run-opening line. */
export declare function runStartLine(run: WorkflowRunStart): string;
/** One member starting line (deduped by seq). */
export declare function agentStartLine(agent: WorkflowAgentStart): string;
/** One member settling line. */
export declare function agentEndLine(agent: WorkflowAgentEnd): string;
/** The run-closing line. */
export declare function runEndLine(run: WorkflowRunEnd): string;
//# sourceMappingURL=workflow.d.ts.map