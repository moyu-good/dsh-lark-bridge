/**
 * Outbound rendering: how one owned chat's session events become chat output.
 * Two renderers share the {@link OutboundRenderer} surface — a plain-message
 * renderer that sends one markdown message per completed step, and a streaming
 * renderer that keeps one typewriter card per turn.
 * @module dsh-lark-bridge/outbound
 */
import { assistantText, isAssistantChunkEvent, isAssistantMessageEvent, isStepStartEvent, isToolCallEvent, isTurnEndEvent, turnErrorDetail, } from "./host.js";
/**
 * Off-protocol tool-call markup a model may emit as plain text instead of
 * using the structured tool-call API — DeepSeek's native `DSML` form, whose
 * delimiters use fullwidth vertical bars. Model text is an untrusted boundary,
 * so this presentation guard removes the whole block; an unterminated opener
 * (a truncated stream) cuts to the end of the text.
 */
const TOOL_CALL_MARKUP = /<｜｜DSML｜｜tool_calls>[\s\S]*?(?:<\/｜｜DSML｜｜tool_calls>|$)/g;
/** Appended once when {@link stripToolCallMarkup} removed a block, so a swallowed attempt is not read as a finished thought. */
const MARKUP_NOTICE = '\n\n⚠️ 模型输出了未被识别的工具调用标记，已省略——通常意味着本次请求没有可用工具。';
/**
 * Remove off-protocol tool-call markup from model text.
 * @param text - committed assistant text, exactly as the model produced it.
 * @returns the text without markup blocks, plus one notice when any was removed.
 */
export function stripToolCallMarkup(text) {
    if (!TOOL_CALL_MARKUP.test(text))
        return text;
    TOOL_CALL_MARKUP.lastIndex = 0;
    const stripped = text.replace(TOOL_CALL_MARKUP, '').trimEnd();
    return `${stripped}${MARKUP_NOTICE}`;
}
/**
 * Render one tool invocation as an activity line.
 * @param label - what this call does, from {@link DescribeCall}.
 * @returns the markdown line inserted into a streaming card.
 */
function activityLine(label) {
    return `\n\n🔧 ${label}\n`;
}
/** Final content for a card whose turn ended without producing anything. */
const IDLE_TURN_NOTE = '（本轮没有产生输出）';
/**
 * Guidance appended when a failure will repeat on every later turn.
 *
 * A route that rejects image content rejects the whole request, and by then the
 * image is in the session log — which every later request resends, compaction
 * included. So the turn does not just fail: the conversation does, and saying
 * only the error code leaves someone retrying it forever.
 */
const POISONED_HISTORY_HINT = '\n\n此会话历史中已包含模型无法处理的内容，'
    + '之后每轮都会以同样原因失败。需要换一个会话才能继续。';
/**
 * Render a failed turn as one chat line.
 * @param detail - the rendered failure detail, possibly empty.
 * @returns the operator-facing failure line.
 */
function failureLine(detail) {
    const line = `⚠️ 本轮任务失败 ${detail}`.trimEnd();
    return detail.startsWith('UNSUPPORTED_CONTENT') ? `${line}${POISONED_HISTORY_HINT}` : line;
}
/**
 * Derive the send options one reply target implies. A target inside a topic
 * thread also needs `replyInThread`, or the reply leaves the thread and lands
 * in the chat's main channel.
 * @param target - the aimed reply target, or undefined for plain chat sends.
 * @returns the options every outbound call of that reply carries, or undefined to send with none.
 */
function replyOptions(target) {
    if (target === undefined)
        return undefined;
    return {
        replyTo: target.messageId,
        ...target.threadId === undefined ? {} : { replyInThread: true },
    };
}
/**
 * Renderer that sends one plain markdown message per completed step. Needs no
 * card permissions; tool activity stays off the chat because each line would
 * cost its own message.
 * @param port - outbound transport.
 * @param chatId - the owned chat.
 * @param onFailure - report an outbound failure.
 * @returns the renderer.
 */
export function createMessageRenderer(port, chatId, onFailure) {
    /** Options carried by every send while a reply target is aimed. */
    let aimed;
    const send = (input) => {
        void port.send(chatId, input, aimed).catch(onFailure);
    };
    return {
        handle(event) {
            if (isAssistantMessageEvent(event)) {
                const text = stripToolCallMarkup(assistantText(event.data));
                if (text !== '')
                    send({ markdown: text });
                return;
            }
            if (isTurnEndEvent(event) && event.data.reason.kind === 'error') {
                send({ text: failureLine(turnErrorDetail(event.data)) });
            }
        },
        close: () => Promise.resolve(),
        aim(target) {
            aimed = replyOptions(target);
        },
    };
}
/**
 * Open one streaming card. Ops queue while the SDK producer drains them, so
 * event handlers never block. When the transport rejects the stream — a
 * deployment without card permissions, for example — the accumulated text is
 * sent once as a plain markdown message instead, so the answer still arrives.
 * @param port - outbound transport.
 * @param chatId - the owned chat.
 * @param opts - reply options fixed when the card opens; the fallback reuses
 * them, so a card and the message standing in for it land in the same place.
 * @param onFailure - report the stream failure that triggered the fallback.
 * @returns the handle its owner drives and settles.
 */
function openStream(port, chatId, opts, onFailure) {
    const ops = [];
    /** Everything the card should hold, for the plain-message fallback. */
    let full = '';
    let done = false;
    let wake;
    const release = () => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    const settled = port.stream(chatId, {
        markdown: async (controller) => {
            for (;;) {
                const op = ops.shift();
                if (op === undefined) {
                    if (done)
                        return;
                    await new Promise((resolve) => { wake = resolve; });
                    continue;
                }
                if (op.kind === 'append')
                    await controller.append(op.text);
                else
                    await controller.setContent(op.text);
            }
        },
    }, opts).then(() => true, (error) => {
        onFailure(error);
        return false;
    });
    return {
        append(text) {
            full += text;
            ops.push({ kind: 'append', text });
            release();
        },
        set(text) {
            full = text;
            ops.push({ kind: 'set', text });
            release();
        },
        async finish() {
            done = true;
            release();
            if (await settled)
                return;
            if (full === '')
                return;
            await port.send(chatId, { markdown: full }, opts).catch(onFailure);
        },
    };
}
/**
 * Renderer that keeps one streaming typewriter card per turn.
 *
 * The card is created at the step boundary, because opening it costs two
 * sequential transport round trips and a fast model would otherwise finish its
 * answer inside that window — every delta would arrive buffered and the whole
 * reply would land at once. Text then streams as it is produced, tool activity
 * appears inline, reasoning streams until the answer replaces it, and each
 * committed step corrects the card when the model's raw text carried markup the
 * chat must not show.
 * @param port - outbound transport.
 * @param chatId - the owned chat.
 * @param options - presentation choices and failure reporting.
 * @returns the renderer.
 */
export function createStreamRenderer(port, chatId, options) {
    const { showProcess, presentCall, onFailure } = options;
    let live;
    /** Options carried by every card opened, and every send made, while a reply target is aimed. */
    let aimed;
    /** Settlements of turns already closed, awaited by {@link OutboundRenderer.close}. */
    const closing = new Set();
    const track = (settling) => {
        closing.add(settling);
        void settling.finally(() => closing.delete(settling));
    };
    /** The card's authoritative content: everything committed, plus this step's text. */
    const render = (turn) => turn.segments.join('') + turn.liveText;
    /**
     * Drop the reasoning currently on the card, which is what makes the answer
     * replace the thinking rather than follow it.
     * @param turn - the live turn whose reasoning is pending.
     * @returns whether the card now diverges from {@link render} and must be rewritten.
     */
    const settleReasoning = (turn) => {
        if (turn.pendingReasoning === '')
            return false;
        turn.pendingReasoning = '';
        return true;
    };
    /** The card for `turn`, opened lazily so a turn with no content sends nothing. */
    const ensure = (turn) => {
        if (live !== undefined && live.turn === turn)
            return live;
        if (live !== undefined)
            track(live.handle.finish());
        live = {
            turn,
            handle: openStream(port, chatId, aimed, onFailure),
            segments: [],
            liveText: '',
            pendingReasoning: '',
            dirty: false,
            produced: false,
        };
        return live;
    };
    return {
        handle(event) {
            // Warming up here overlaps the card's setup round trips with the model's
            // own time to first token. Nothing is written: an empty card is the
            // placeholder the transport already shows.
            if (isStepStartEvent(event)) {
                ensure(event.data.turn);
                return;
            }
            if (isAssistantChunkEvent(event)) {
                const { chunk } = event.data;
                if (chunk.text === undefined || chunk.text === '')
                    return;
                if (chunk.type === 'reasoning-delta') {
                    if (!showProcess)
                        return;
                    const turn = ensure(event.data.turn);
                    turn.pendingReasoning += chunk.text;
                    turn.handle.append(chunk.text);
                    return;
                }
                // Tool-call deltas are raw JSON fragments; `tool/call` reports them.
                if (chunk.type !== 'text-delta')
                    return;
                const turn = ensure(event.data.turn);
                turn.produced = true;
                turn.liveText += chunk.text;
                // One rewrite at the thinking-to-answer transition, then plain appends.
                if (settleReasoning(turn))
                    turn.handle.set(render(turn));
                else
                    turn.handle.append(chunk.text);
                return;
            }
            if (isAssistantMessageEvent(event)) {
                const raw = assistantText(event.data);
                const clean = stripToolCallMarkup(raw);
                const turn = ensure(event.data.turn);
                turn.produced = true;
                if (settleReasoning(turn))
                    turn.dirty = true;
                turn.segments.push(clean);
                turn.liveText = '';
                // The card streamed the raw deltas; only a strip makes it wrong.
                if (clean !== raw)
                    turn.dirty = true;
                return;
            }
            if (isToolCallEvent(event)) {
                if (!showProcess)
                    return;
                const turn = ensure(event.data.turn);
                turn.produced = true;
                const line = activityLine(presentCall(event.data.name, event.data.arguments).title);
                const rewrite = settleReasoning(turn);
                turn.segments.push(line);
                if (rewrite)
                    turn.handle.set(render(turn));
                else
                    turn.handle.append(line);
                return;
            }
            if (isTurnEndEvent(event)) {
                const failure = event.data.reason.kind === 'error' ? failureLine(turnErrorDetail(event.data)) : '';
                // A turn that opened no card needs none; a failure still reaches the
                // chat as a plain message rather than opening an empty stream for it.
                if (live === undefined || live.turn !== event.data.turn) {
                    if (failure !== '')
                        void port.send(chatId, { text: failure }, aimed).catch(onFailure);
                    return;
                }
                const turn = live;
                live = undefined;
                if (settleReasoning(turn))
                    turn.dirty = true;
                if (failure !== '') {
                    turn.segments.push(`\n\n${failure}`);
                    turn.dirty = true;
                }
                // A warmed-up card whose turn produced nothing would otherwise sit on
                // its placeholder, or on thinking the answer never replaced.
                if (!turn.produced && failure === '' && turn.segments.length === 0) {
                    turn.segments.push(IDLE_TURN_NOTE);
                    turn.dirty = true;
                }
                if (turn.dirty)
                    turn.handle.set(render(turn));
                track(turn.handle.finish());
            }
        },
        async close() {
            const pending = [...closing];
            if (live !== undefined) {
                const turn = live;
                live = undefined;
                pending.push(turn.handle.finish());
            }
            await Promise.allSettled(pending);
        },
        aim(target) {
            aimed = replyOptions(target);
        },
    };
}
//# sourceMappingURL=outbound.js.map