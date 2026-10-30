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
import { assistantText, isAssistantChunkEvent, isAssistantMessageEvent, isStepStartEvent, isToolCallEvent, isToolResultEvent, isTurnEndEvent, isUserChatMessageEvent, toolResultText, turnErrorDetail, } from "./host.js";
import { stripToolCallMarkup } from "./outbound.js";
import { DEFAULT_LIMITS } from "./config.js";
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
/**
 * What one tool call's arguments are worth showing.
 *
 * The arguments of a file write are the whole file. Putting them in the
 * chat means the file's contents are copied into a conversation that
 * already has the file on disk, and a chat client renders a megabyte of
 * JSON as a wall. What a reader needs from a tool call is which tool ran
 * and on what — the path, the command, the query — not the payload.
 *
 * So the arguments are summarised: the keys whose values identify the
 * call are kept, and the ones that carry bulk are replaced by their size.
 * The full arguments stay in the session log, where the run can be read
 * later.
 */
const SUMMARY_KEYS = [
    'path', 'file_path', 'filePath', 'command', 'cmd', 'query', 'url', 'pattern',
    'pathPattern', 'glob', 'description', 'name', 'prompt', 'old_str', 'new_str',
    'subagent_type', 'description',
];
/**
 * A parameter this large is described by its size instead of its content: the
 * payload is a whole file or a migrated schema, and neither belongs in a card.
 */
const BULK_VALUE_CHARS = 200;
/**
 * Summarise one tool call's arguments for the chat.
 *
 * @param argumentsJson - the arguments as the host delivered them.
 * @param maxValueChars - how much of one kept value to show.
 * @returns a short description of what the call was for.
 */
export function summariseArguments(argumentsJson, maxValueChars = DEFAULT_LIMITS.toolArgChars) {
    let parsed;
    try {
        parsed = JSON.parse(argumentsJson);
    }
    catch {
        // Not JSON: the first line says what it was, which is enough.
        const first = argumentsJson.split('\n')[0]?.trim() ?? '';
        return first.length > maxValueChars ? `${first.slice(0, maxValueChars - 1)}…` : first;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return String(parsed).slice(0, maxValueChars);
    }
    const entries = Object.entries(parsed);
    const kept = [];
    for (const [key, value] of entries) {
        if (!SUMMARY_KEYS.includes(key)) {
            const size = typeof value === 'string' ? value.length : JSON.stringify(value)?.length ?? 0;
            if (size > BULK_VALUE_CHARS)
                kept.push(`${key}: ${size} 字符`);
            continue;
        }
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        kept.push(`${key}: ${text.length > maxValueChars ? `${text.slice(0, maxValueChars - 1)}…` : text}`);
    }
    if (kept.length === 0)
        return `${entries.length} 个参数`;
    return kept.join(' · ');
}
/**
 * What one tool result is worth showing.
 *
 * A command's output is output, not prose: the reader wants to know what
 * came back and whether it worked, not to read a thousand lines of it in
 * the chat. The head carries the answer; the rest stays in the session log.
 * The head is a budget, not a rule — a working session wants enough of it to
 * see why a command failed.
 * @param text - the tool's output.
 * @param lines - how many leading lines to show.
 * @param chars - how many characters those lines may take in total.
 * @returns the preview, with a marker when more lines exist.
 */
function summariseResult(text, lines = DEFAULT_LIMITS.toolResultLines, chars = DEFAULT_LIMITS.toolResultChars) {
    const trimmed = text.trim();
    if (trimmed === '')
        return '（无输出）';
    const head = trimmed.split('\n').slice(0, lines).join('\n');
    const bounded = head.length > chars ? `${head.slice(0, chars - 1)}…` : head;
    const total = trimmed.split('\n').length;
    if (total > lines)
        return `${bounded}\n…（共 ${total} 行，完整结果见会话记录）`;
    return bounded;
}
/**
 * How much of a mid-turn message the process shows before eliding it.
 *
 * A person who pastes a stack trace into a running turn meant it for the
 * model, not for the thinking area — and one event's payload is capped anyway
 * (4096 characters), so the default stays under it. The head is enough to
 * recognise which message turned the run.
 */
/**
 * What one mid-turn message says.
 * @param data - the `user/message` payload.
 * @param maxChars - how much of it the thinking area shows.
 * @returns the message's text, bounded.
 */
function userChatMessageText(data, maxChars = DEFAULT_LIMITS.userMessageChars) {
    const parts = [];
    for (const block of data.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text !== '')
            parts.push(block.text);
    }
    const text = parts.join('\n').trim();
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
/**
 * The closing line, as an event the answer half can send.
 *
 * @param run - the finished run.
 * @param failure - the failure detail, empty when the turn succeeded.
 * @returns the event carrying the line.
 */
function closingEvent(run, failure) {
    const text = failure === undefined ? closingLine(run) : `⚠️ 本轮失败 · ${failure}`;
    return {
        type: 'assistant/message',
        data: {
            turn: run.turn,
            message: { role: 'assistant', content: [{ type: 'text', text }] },
        },
    };
}
/**
 * The line that says the turn is over.
 *
 * A reader watching twenty-six tool calls scroll past has no way to tell
 * that the run ended — the process closes, but nothing says so in words.
 * The count and the elapsed time are the two facts a reader wants at that
 * moment: how much happened, and how long it took.
 */
function closingLine(run) {
    const seconds = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
    const duration = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    const calls = run.toolCalls === 0 ? '无工具调用' : `${run.toolCalls} 次工具调用`;
    return `✅ 本轮完成 · ${calls} · 用时 ${duration}`;
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
    const { showProcess, hidden, presentCall, onFailure, answer, limits = DEFAULT_LIMITS } = options;
    let live;
    let aimed;
    /** A target that arrived mid-run; it owns the NEXT turn, never the live one. */
    let pendingAim;
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
    /**
     * Open a fresh reasoning block for this run and announce it.
     *
     * The id is per block, not per turn: the protocol creates one reasoning
     * message per START carrying that id, so reusing a turn-wide id turns every
     * later thought into an edit of the first one. The reader then sees the whole
     * turn's thinking piled up at the top, far from the tool call it explains.
     * @param run - the run the block belongs to.
     * @returns the id its deltas must carry.
     */
    const openReasoning = (run) => {
        run.reasoningBlocks += 1;
        run.reasoningId = `reasoning-${run.turn}-${run.reasoningBlocks}`;
        run.reasoningOpen = true;
        enqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId: run.reasoningId, role: 'reasoning' }));
        return run.reasoningId;
    };
    /** Close the open reasoning block, if any; a no-op otherwise. */
    const closeReasoning = (run) => {
        if (!run.reasoningOpen)
            return;
        run.reasoningOpen = false;
        enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: run.reasoningId }));
    };
    /** The run for `turn`, opening one when the turn is new. */
    const ensure = (turn) => {
        if (live !== undefined && live.turn === turn)
            return live;
        if (live !== undefined)
            closeRun(live);
        if (pendingAim !== undefined) {
            aimed = pendingAim;
            pendingAim = undefined;
            answer.aim(aimed);
        }
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
            reasoningId: '',
            reasoningBlocks: 0,
            finished: false,
            startedAt: Date.now(),
            toolCalls: 0,
            userMessages: 0,
        };
        enqueue(live, cotEvent('RUN_STARTED', { threadId: chatId, runId: `turn-${turn}` }));
        return live;
    };
    /** Finish one run, closing whatever it left open. */
    const closeRun = (run, failure) => {
        if (run.finished)
            return;
        run.finished = true;
        closeReasoning(run);
        // The line that says the run is over goes to the answer half, NOT into
        // the process: the platform hides the process when the run ends, so a
        // closing line written there would vanish with it. A reader who watched
        // twenty-six calls scroll past needs to be told, in a message that
        // stays, that the run finished.
        answer.handle(closingEvent(run, failure));
        enqueue(run, failure === undefined
            ? cotEvent('RUN_FINISHED', { threadId: chatId, runId: `turn-${run.turn}`, status: 'done' })
            : cotEvent('RUN_ERROR', { message: failure, code: 'TURN_FAILED' }));
        const settled = run.draining;
        closing.add(settled);
        void settled.finally(() => closing.delete(settled));
    };
    return {
        aim(target) {
            // Mid-run re-aim deferral (P141): the running turn must keep answering
            // where it was asked — its process is already open under that target and
            // its answer is still owed there. The new target owns the NEXT turn.
            if (live !== undefined && !live.finished) {
                pendingAim = target;
                return;
            }
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
            if (isUserChatMessageEvent(event)) {
                if (!showProcess)
                    return;
                // Only a message that lands MID-turn belongs here. The message that
                // opened the turn has a bubble of its own in the chat, and the process
                // for it opens a step later; showing it again would put the same
                // sentence twice in one screen.
                //
                // A mid-turn message is different: the chat answers it with a receipt
                // line ("已插话…"), never with the words themselves. The reader then
                // watches the agent change direction and has no way to tell what turned
                // it. This is the only place those words can appear, and it appears
                // exactly where the driver admitted them — between two steps of the
                // turn they redirected.
                if (live === undefined || live.finished)
                    return;
                const text = userChatMessageText(event.data, limits.userMessageChars);
                if (text === '')
                    return;
                const run = live;
                // The message ends whatever the agent was thinking; the next reasoning
                // block opens on its own.
                closeReasoning(run);
                run.userMessages += 1;
                const messageId = `user-${run.turn}-${run.userMessages}`;
                enqueue(run, cotEvent('TEXT_MESSAGE_START', { messageId, role: 'user' }), cotEvent('TEXT_MESSAGE_CONTENT', { messageId, delta: text }), cotEvent('TEXT_MESSAGE_END', { messageId }));
                return;
            }
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
                    const messageId = run.reasoningOpen ? run.reasoningId : openReasoning(run);
                    enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: chunk.text }));
                    return;
                }
                if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning') {
                    const text = chunk.block.text ?? '';
                    if (text === '')
                        return;
                    const run = ensure(event.data.turn);
                    // A whole block in one event: close whatever was open, then open a
                    // block of its own so it lands at this point in the process.
                    closeReasoning(run);
                    const messageId = openReasoning(run);
                    enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: text }));
                    closeReasoning(run);
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
                run.toolCalls += 1;
                closeReasoning(run);
                enqueue(run, cotEvent('TOOL_CALL_START', {
                    toolCallId,
                    icon: TOOL_ICONS[shown.kind ?? ''] ?? 'default',
                    title: subagentTitle(event.data.name, shown.title),
                    toolCallName: event.data.name,
                }), 
                // The summary, not the arguments: a file write's arguments are
                // the whole file, and the chat already has the file.
                cotEvent('TOOL_CALL_ARGS', { toolCallId, delta: summariseArguments(event.data.arguments, limits.toolArgChars) }), cotEvent('TOOL_CALL_END', { toolCallId }));
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
                    // A command's output reads as output, not prose — and not a
                    // thousand lines of it either. The head carries the answer; the
                    // rest is in the session log.
                    content: { type: 'code', code: summariseResult(text, limits.toolResultLines, limits.toolResultChars) },
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
                // The ended turn's target is spent; a mid-run re-aim now owns the next
                // turn (P141).
                if (pendingAim !== undefined) {
                    aimed = pendingAim;
                    pendingAim = undefined;
                    answer.aim(aimed);
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