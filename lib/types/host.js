/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Keeping these structural copies (instead of importing host source
 * packages) lets the package build self-contained; a composed DSH profile
 * supplies the real implementations at runtime. Field shapes mirror
 * `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, and
 * `@deepseek-ai/dsh-user-approval` as of dsh main 2026-08-20 (was 0.0.1-rc.2).
 * P1 alignment: cancel signature, GoalChange clear-tombstone, and Cordis event
 * guards expanded for perfect-plugin roadmap.
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
/**
 * Whether the event declares files the model wants delivered.
 *
 * The guard checks the shape, not just the name: a host that emits the
 * event with a different payload should leave the bridge's delivery path
 * closed rather than deliver something it cannot read.
 */
export function isPresentedEvent(event) {
    if (event.type !== 'deliverables/presented')
        return false;
    const data = event.data;
    if (typeof data !== 'object' || data === null)
        return false;
    const candidate = data;
    if (typeof candidate.turn !== 'number' || typeof candidate.callId !== 'string')
        return false;
    if (!Array.isArray(candidate.files))
        return false;
    return candidate.files.every((file) => {
        if (typeof file !== 'object' || file === null)
            return false;
        const entry = file;
        if (typeof entry.path !== 'string' || entry.path === '')
            return false;
        return entry.description === undefined || typeof entry.description === 'string';
    });
}
export function isSubagentDescriptorEvent(event) {
    return event.type === 'subagent/descriptor';
}
export function isSubagentCatalogEvent(event) {
    return event.type === 'subagent/catalog';
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
/**
 * Narrow a Cordis event to agent lifecycle status.
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
    // The host sends the blocks flat, so the text sits beside the type. The
    // older host nested them, so both are read — reading only the nested shape
    // leaves every tool result card blank.
    const flat = block?.text ?? '';
    const nested = (block?.content ?? [])
        .filter(inner => inner.type === 'text' && inner.text !== undefined)
        .map(inner => inner.text)
        .join('');
    return { callId: block?.toolCallId ?? data.message.source?.callId, text: flat !== '' ? flat : nested };
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
/**
 * Whether an event carries a team member.
 *
 * The version is checked, not just the name: a payload that does not carry
 * version 2 is another shape, and rendering it as a member would show fields
 * that are not there.
 * @param event - the session event.
 * @returns true when the event is a `team/member` event.
 */
export function isTeamMemberEvent(event) {
    const data = event.data;
    return event.type === 'team/member'
        && data !== undefined && data !== null
        && data.version === 2
        && typeof data.teamId === 'string'
        && data.member !== undefined && data.member !== null
        && typeof data.member.id === 'string'
        && typeof data.member.name === 'string';
}
/**
 * Whether an event carries a shared team task.
 * @param event - the session event.
 * @returns true when the event is a `team/task` event.
 */
export function isTeamTaskEvent(event) {
    const data = event.data;
    return event.type === 'team/task'
        && data !== undefined && data !== null
        && data.version === 2
        && typeof data.teamId === 'string'
        && data.task !== undefined && data.task !== null
        && typeof data.task.id === 'string'
        && typeof data.task.subject === 'string';
}
/**
 * Whether an event carries a queued mailbox message.
 * @param event - the session event.
 * @returns true when the event is a `team/message/queued` event.
 */
export function isTeamMessageEvent(event) {
    const data = event.data;
    return event.type === 'team/message/queued'
        && data !== undefined && data !== null
        && data.version === 2
        && typeof data.teamId === 'string'
        && data.message !== undefined && data.message !== null
        && typeof data.message.id === 'string';
}
/**
 * Whether an event acknowledges a queued mailbox message.
 * @param event - the session event.
 * @returns true when the event is a `team/message/delivered` event.
 */
export function isTeamMessageDeliveredEvent(event) {
    const data = event.data;
    return event.type === 'team/message/delivered'
        && data !== undefined && data !== null
        && data.version === 2
        && typeof data.teamId === 'string'
        && typeof data.messageId === 'string'
        && typeof data.targetId === 'string';
}
/**
 * Narrow a session event to a message the human at the chat typed.
 *
 * Only the human's own words qualify. The same event carries instruction,
 * context, goal and reminder messages the host writes itself — all of them
 * `source.kind` values other than `user` — and none of them are something a
 * reader of the thinking process would recognise as their own sentence.
 *
 * @param event - any session event.
 * @returns whether the event is a message the human sent.
 */
export function isUserChatMessageEvent(event) {
    if (event.type !== 'user/message')
        return false;
    const raw = event.data;
    if (raw === undefined || raw === null)
        return false;
    const message = raw.message ?? raw;
    if (typeof message.id !== 'string')
        return false;
    if (!Array.isArray(message.content))
        return false;
    return message.source?.kind === 'user';
}
/**
 * Narrow a session event to a message relayed from a teammate.
 *
 * @param event - any session event.
 * @returns whether the event is a `user/message` a teammate sent.
 */
export function isTeamRelayMessageEvent(event) {
    if (event.type !== 'user/message')
        return false;
    const data = event.data;
    if (data === undefined || data === null)
        return false;
    const message = data.message;
    if (message === undefined || message === null)
        return false;
    if (typeof message.id !== 'string')
        return false;
    if (!Array.isArray(message.content))
        return false;
    const source = message.source;
    if (source === undefined || source === null)
        return false;
    return source.kind === 'agent-message';
}
//# sourceMappingURL=host.js.map