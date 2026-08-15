/**
 * The thinking process as a native CoT message.
 *
 * Feishu carries an agent's process as its own message, driven by AG-UI events,
 * and renders it the way the platform's own agents look: reasoning streams into
 * a thinking area, each tool call gets an icon and a title, each result gets a
 * code block. That vocabulary lines up with the host's session events almost
 * one to one, so this renderer translates rather than draws — and the final
 * answer goes where the platform says it belongs, in an ordinary message.
 * @module dsh-lark-bridge/cot
 */
import { assistantText, isAssistantChunkEvent, isAssistantMessageEvent, isStepStartEvent, isToolCallEvent, isToolResultEvent, isTurnEndEvent, toolResultText, turnErrorDetail, } from "./host.js";
import { stripToolCallMarkup } from "./outbound.js";
/** How many events one write call may carry, per the API's own bound. */
const MAX_EVENTS_PER_WRITE = 50;
/** How long one event's JSON may be, per the API's own bound. */
const MAX_EVENT_CONTENT_CHARS = 4096;
/**
 * Tool-call kinds the host reports, mapped to the platform's icon vocabulary.
 * A kind with no counterpart falls through to the platform default rather than
 * guessing at a shape the icon set does not carry.
 */
const TOOL_ICONS = {
    read: 'read',
    edit: 'write',
    delete: 'write',
    move: 'write',
    search: 'search',
    fetch: 'search',
    execute: 'bash',
};
/** Tool names that spawn or drive subagents; their calls deserve a distinct label. */
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_report', 'subagent_control', 'send_message', 'interrupt_agent', 'list_agents']);
/** Prefix a subagent call's title so the chat reads it as a delegation, not a local tool. */
function subagentTitle(name, title) {
    return SUBAGENT_TOOLS.has(name) ? `🧑💻 ${title}` : title;
}
/**
 * The last timestamp handed out, so the next one is strictly greater.
 *
 * The client ORDERS events by this value, and a run emits many within one
 * millisecond — a burst of reasoning deltas sharing a timestamp is free to be
 * reordered, which is how one sentence arrives interleaved with the next.
 */
let lastTimestamp = 0;
/**
 * Encode one AG-UI event, bounding its payload and stamping it after every
 * event already handed out.
 * @param eventType - the AG-UI event name.
 * @param content - the event's own fields.
 * @returns the event ready to write.
 */
function cotEvent(eventType, content) {
    const encoded = JSON.stringify(content);
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    return {
        event_type: eventType,
        content: encoded.length <= MAX_EVENT_CONTENT_CHARS
            ? encoded
            // Dropping the payload would lose the event; a truncation marker keeps
            // its shape valid while saying that something was cut.
            : JSON.stringify({ ...content, truncated: true, delta: undefined }),
        timestamp: String(lastTimestamp),
    };
}
/** Bound a value a tool produced before it rides an event. */
function boundResult(text) {
    const limit = 1500;
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
/**
 * Renderer that shows the process as a native CoT message and leaves the answer
 * to `answer`. Falling back is the caller's job: when {@link CotPort.createCot}
 * rejects, this renderer reports it and the turn still answers, because the
 * answer never depended on the thinking process existing.
 * @param port - the CoT operations.
 * @param chatId - the owned chat.
 * @param options - what to show, and where the answer goes.
 * @returns the renderer.
 */
export function createCotRenderer(port, chatId, options) {
    const { showProcess, hidden, presentCall, onFailure, answer } = options;
    let live;
    let aimed;
    /**
     * The turn's latest committed text, held because only the LAST one is the
     * answer. An agent narrates between tool calls — "let me look at the packages
     * first" — and every one of those commits would otherwise become its own
     * chat message, which is a wall of replies to a single question. Held at the
     * renderer, not on a run: the answer does not depend on a process existing.
     */
    let held;
    const closing = new Set();
    /** Drain one run's queue, respecting the API's per-call event bound. */
    const drain = async (run) => {
        const handle = await run.opening;
        if (handle === undefined) {
            run.pending.length = 0;
            return;
        }
        while (run.pending.length > 0) {
            const batch = run.pending.splice(0, MAX_EVENTS_PER_WRITE);
            await port.writeCotEvents(handle, batch).catch(onFailure);
        }
    };
    const enqueue = (run, ...events) => {
        run.pending.push(...events);
        run.draining = run.draining.then(() => drain(run)).catch(onFailure);
    };
    /** The run for `turn`, opening one when the turn is new. */
    const ensure = (turn) => {
        if (live !== undefined && live.turn === turn)
            return live;
        if (live !== undefined)
            closeRun(live);
        const opening = port
            .createCot(chatId, { ...aimed === undefined ? {} : { replyTo: aimed.messageId }, hidden })
            .catch((error) => {
            // The process is presentation; the answer still arrives without it.
            onFailure(error);
            return undefined;
        });
        live = {
            turn,
            opening,
            pending: [],
            draining: Promise.resolve(),
            reasoningOpen: false,
            finished: false,
        };
        enqueue(live, cotEvent('RUN_STARTED', { threadId: chatId, runId: `turn-${turn}` }));
        return live;
    };
    /** Finish one run, closing whatever it left open. */
    const closeRun = (run, failure) => {
        if (run.finished)
            return;
        run.finished = true;
        if (run.reasoningOpen) {
            enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${run.turn}` }));
            run.reasoningOpen = false;
        }
        enqueue(run, failure === undefined
            ? cotEvent('RUN_FINISHED', { threadId: chatId, runId: `turn-${run.turn}`, status: 'done' })
            : cotEvent('RUN_ERROR', { message: failure, code: 'TURN_FAILED' }));
        const settled = run.draining;
        closing.add(settled);
        void settled.finally(() => closing.delete(settled));
    };
    return {
        aim(target) {
            aimed = target;
            answer.aim(target);
        },
        handle(event) {
            if (isAssistantMessageEvent(event)) {
                const text = stripToolCallMarkup(assistantText(event.data));
                if (text === '')
                    return;
                const superseded = held?.turn === event.data.turn ? held.event : undefined;
                held = { turn: event.data.turn, event };
                // The text this one replaces was narration, not an answer: it belongs
                // in the process, where the platform shows it as the agent's own words.
                if (superseded === undefined || !showProcess || !isAssistantMessageEvent(superseded))
                    return;
                const run = ensure(event.data.turn);
                const messageId = `text-${run.turn}-${run.pending.length}`;
                enqueue(run, cotEvent('TEXT_MESSAGE_START', { messageId, role: 'assistant' }), cotEvent('TEXT_MESSAGE_CONTENT', {
                    messageId,
                    delta: stripToolCallMarkup(assistantText(superseded.data)),
                }), cotEvent('TEXT_MESSAGE_END', { messageId }));
                return;
            }
            // Failures reach the chat through the answer half.
            if (isTurnEndEvent(event))
                answer.handle(event);
            if (isStepStartEvent(event)) {
                // With the process off, nothing here is ever shown — so no process is
                // opened either, and the chat carries answers alone.
                if (!showProcess)
                    return;
                // Opening the process here overlaps its round trip with the model's
                // time to first token. No STEP event is written: a step is one
                // iteration of the agent's own loop, and a reader who sees "step 1
                // … step 8" listed above the work learns nothing from the numbering
                // that the reasoning and tool calls do not already say.
                ensure(event.data.turn);
                return;
            }
            if (isAssistantChunkEvent(event)) {
                const { chunk } = event.data;
                // Only reasoning belongs here: the platform reserves this message for
                // the process, and the answer is sent as its own message.
                if (!showProcess)
                    return;
                // Two wire shapes arrive from the host: streaming models emit
                // `reasoning-delta` deltas; non-streaming adapters (pi-ai's deepseek
                // route in particular) emit a whole `block-end` with the reasoning
                // block's complete text and NO deltas in between. Both must render,
                // otherwise the thinking area stays empty for block-delivered runs.
                if (chunk.type === 'reasoning-delta') {
                    if (chunk.text === undefined || chunk.text === '')
                        return;
                    const run = ensure(event.data.turn);
                    const messageId = `reasoning-${run.turn}`;
                    if (!run.reasoningOpen) {
                        run.reasoningOpen = true;
                        enqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }));
                    }
                    enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: chunk.text }));
                    return;
                }
                if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning') {
                    const text = chunk.block.text ?? '';
                    if (text === '')
                        return;
                    const run = ensure(event.data.turn);
                    const messageId = `reasoning-${run.turn}`;
                    if (run.reasoningOpen) {
                        run.reasoningOpen = false;
                        enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId }));
                    }
                    enqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }));
                    enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: text }));
                    enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId }));
                    return;
                }
                return;
            }
            if (isToolCallEvent(event)) {
                if (!showProcess)
                    return;
                const run = ensure(event.data.turn);
                const shown = presentCall(event.data.name, event.data.arguments);
                const toolCallId = event.data.callId;
                if (run.reasoningOpen) {
                    run.reasoningOpen = false;
                    enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${run.turn}` }));
                }
                enqueue(run, cotEvent('TOOL_CALL_START', {
                    toolCallId,
                    icon: TOOL_ICONS[shown.kind ?? ''] ?? 'default',
                    title: subagentTitle(event.data.name, shown.title),
                    toolCallName: event.data.name,
                }), cotEvent('TOOL_CALL_ARGS', { toolCallId, delta: event.data.arguments }), cotEvent('TOOL_CALL_END', { toolCallId }));
                return;
            }
            if (isToolResultEvent(event)) {
                if (!showProcess)
                    return;
                const { callId, text } = toolResultText(event.data);
                if (callId === undefined)
                    return;
                const run = ensure(event.data.turn);
                enqueue(run, cotEvent('TOOL_CALL_RESULT', {
                    messageId: `result-${callId}`,
                    toolCallId: callId,
                    role: 'tool',
                    // A command's output reads as output, not prose.
                    content: { type: 'code', code: boundResult(text) },
                    ...event.data.error === undefined ? {} : { error: event.data.error.code },
                }));
                return;
            }
            if (isTurnEndEvent(event)) {
                // One message per turn: the text the turn ended on.
                if (held?.turn === event.data.turn) {
                    answer.handle(held.event);
                    held = undefined;
                }
                if (live === undefined || live.turn !== event.data.turn)
                    return;
                const run = live;
                live = undefined;
                const detail = turnErrorDetail(event.data);
                closeRun(run, detail === '' ? undefined : detail);
            }
        },
        async close() {
            if (held !== undefined) {
                answer.handle(held.event);
                held = undefined;
            }
            if (live !== undefined) {
                const run = live;
                live = undefined;
                closeRun(run);
            }
            await Promise.allSettled([...closing, answer.close()]);
        },
    };
}
//# sourceMappingURL=cot.js.map