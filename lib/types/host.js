/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Keeping these structural copies (instead of importing host source
 * packages) lets the package build self-contained; a composed DSH profile
 * supplies the real implementations at runtime. Field shapes mirror
 * `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, and
 * `@deepseek-ai/dsh-user-approval` as of dsh 0.0.1-rc.2.
 * @module dsh-lark-bridge/host
 */
/**
 * Narrow a session event to the assembled assistant message for one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantMessageData}.
 */
export function isAssistantMessageEvent(event) {
    return event.type === 'assistant/message';
}
/**
 * Narrow a session event to a closed turn boundary.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TurnEndData}.
 */
export function isTurnEndEvent(event) {
    return event.type === 'turn/end';
}
/**
 * Narrow a session event to the opening of one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link StepStartData}.
 */
export function isStepStartEvent(event) {
    return event.type === 'step/start';
}
/**
 * Narrow a session event to one todo-list replacement.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TodoWriteData}.
 */
export function isTodoWriteEvent(event) {
    return event.type === 'todo/write';
}
/**
 * Narrow a session event to one goal snapshot mutation.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link GoalChangeData}.
 */
export function isGoalChangeEvent(event) {
    return event.type === 'goal/change';
}
/** Narrow a session event to one workflow run opening. */
export function isWorkflowRunStartEvent(event) {
    return event.type === 'tool-workflow/run-start';
}
/** Narrow a session event to one workflow member publication. */
export function isWorkflowAgentStartEvent(event) {
    return event.type === 'tool-workflow/agent-start';
}
/** Narrow a session event to one workflow member settlement. */
export function isWorkflowAgentEndEvent(event) {
    return event.type === 'tool-workflow/agent-end';
}
/** Narrow a session event to one workflow run closing. */
export function isWorkflowRunEndEvent(event) {
    return event.type === 'tool-workflow/run-end';
}
/** Narrow a session event to a compaction lock opening. */
export function isCompactionStartEvent(event) {
    return event.type === 'compaction/start';
}
/** Narrow a session event to a compaction lock releasing. */
export function isCompactionEndEvent(event) {
    return event.type === 'compaction/end';
}
/** Narrow a session event to a compaction summary (what replaced old history). */
export function isCompactionSummaryEvent(event) {
    return event.type === 'compaction/summary';
}
/** Narrow a session event to a model-free prune of old history. */
export function isCompactionPruneEvent(event) {
    return event.type === 'compaction/prune';
}
/** Narrow a session event to one subagent descriptor. */
export function isSubagentDescriptorEvent(event) {
    return event.type === 'subagent/descriptor';
}
/** Narrow a session event to one schedule mutation. */
export function isScheduleChangeEvent(event) {
    return event.type === 'schedule/change';
}
/** Narrow a session event to one DeepSeek search request. */
export function isWebSearchRequestEvent(event) {
    return event.type === 'web/deepseek-search-llm-request';
}
/** Narrow a session event to one scheduled model-call retry. */
export function isLlmRetryEvent(event) {
    return event.type === 'llm/retry';
}
/**
 * Narrow a session event to one raw assistant stream chunk.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantChunkData}.
 */
export function isAssistantChunkEvent(event) {
    return event.type === 'assistant/chunk';
}
/**
 * Narrow a session event to one completed tool call's result.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolResultData}.
 */
export function isToolResultEvent(event) {
    return event.type === 'tool/result';
}
/**
 * The call one result answers, and the text it produced.
 * @param data - the completed result payload.
 * @returns the call id and its joined text output.
 */
export function toolResultText(data) {
    const block = data.message.content[0];
    const text = (block?.content ?? [])
        .filter(inner => inner.type === 'text' && inner.text !== undefined)
        .map(inner => inner.text)
        .join('');
    return { callId: block?.toolCallId ?? data.message.source?.callId, text };
}
/**
 * Narrow a session event to one model-requested tool invocation.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolCallData}.
 */
export function isToolCallEvent(event) {
    return event.type === 'tool/call';
}
/**
 * Join the text blocks of a committed assistant message.
 * @param data - the committed message payload.
 * @returns the concatenated text, empty when the step produced none.
 */
export function assistantText(data) {
    return data.message.content
        .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
        .map(block => block.text)
        .join('');
}
/**
 * Render a failed turn's reason as one operator-readable line.
 * @param data - the closed turn payload.
 * @returns the error detail, empty when the turn did not fail.
 */
export function turnErrorDetail(data) {
    if (data.reason.kind !== 'error')
        return '';
    const error = data.reason.error;
    return error === undefined ? '' : `${error.code ?? 'error'}: ${error.message ?? ''}`.trimEnd();
}
//# sourceMappingURL=host.js.map