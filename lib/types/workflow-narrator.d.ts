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
import type { WorkflowAgentEnd, WorkflowAgentStart, WorkflowRunEnd, WorkflowRunStart } from './workflow.ts';
/** How the narrator reaches a chat: one markdown send. */
export interface WorkflowNarratorPort {
    send(chatId: string, input: {
        markdown: string;
    }): Promise<unknown>;
}
/** Tuning for {@link createWorkflowNarrator}. */
export interface WorkflowNarratorOptions {
    /**
     * How long member events are collected before they are sent as one line.
     *
     * Defaults to 2 s: long enough that a fan-out of eight launches or finishes
     * inside it becomes one message, short enough that a reader still watches
     * the run progress.
     */
    readonly coalesceMs?: number;
    /** Labels quoted in one line before it degrades to a count. */
    readonly maxLabels?: number;
    /** Report a send failure. */
    readonly onFailure?: (error: unknown) => void;
}
/** The surface the bridge drives as workflow events arrive. */
export interface WorkflowNarrator {
    /** A run opened: announce it at once, then start coalescing. */
    runStart(run: WorkflowRunStart, chatId: string): void;
    /** A member started. */
    agentStart(agent: WorkflowAgentStart, chatId: string): void;
    /** A member settled. */
    agentEnd(agent: WorkflowAgentEnd, chatId: string): void;
    /**
     * A run closed: flush what is left into the summary instead of sending it as
     * its own line, so a fast run is exactly two messages.
     */
    runEnd(run: WorkflowRunEnd, chatId: string): void;
    /** Cancel every pending window. */
    dispose(): void;
}
/**
 * Build the coalescing narrator.
 * @param port - how to reach a chat.
 * @param options - window length, label budget, failure reporting.
 * @returns the narrator the bridge drives.
 */
export declare function createWorkflowNarrator(port: WorkflowNarratorPort, options?: WorkflowNarratorOptions): WorkflowNarrator;
//# sourceMappingURL=workflow-narrator.d.ts.map