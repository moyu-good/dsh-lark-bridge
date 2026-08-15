/**
 * Outbound replay: a thin transport wrapper that turns a long-connection gap
 * into a delivery delay instead of a loss.
 *
 * The Lark WebSocket has no cursor and no server-side replay, so events that
 * the bridge renders while the connection is down are lost at the transport.
 * This wrapper queues an outbound call when the connection is not live (or
 * when a send fails mid-gap) and flushes the queue in order once the
 * connection is restored — a chat that missed a few minutes of a running
 * agent then catches up instead of seeing a hole.
 *
 * Only chat-facing sends are replayed: `send` (messages/cards), `stream`
 * (cot), and `updateCard` (in-place card edits). Reactions and removals are
 * one-shot feedback — losing one while down is acceptable, and replaying it
 * risks flipping a just-reacted emoji.
 * @module dsh-lark-bridge/replay
 */
/**
 * Wrap a transport so outbound calls survive a connection gap.
 * @param port - the underlying transport.
 * @param onFlushFailure - report one queued call that failed to re-send.
 * @param notify - operator console line for queue lifecycle.
 * @returns the replay-aware port.
 */
export function createReplayPort(port, onFlushFailure, notify) {
    let live = true;
    let queue = [];
    let flushing;
    const queuedSendResult = () => ({ messageId: `queued-${queue.length}` });
    const enqueueSend = (to, input, opts) => {
        queue.push({ kind: 'send', to, input, ...opts === undefined ? {} : { opts } });
        return queuedSendResult();
    };
    const enqueueStream = (to, input, opts) => {
        queue.push({ kind: 'stream', to, input, ...opts === undefined ? {} : { opts } });
        return queuedSendResult();
    };
    const enqueueUpdate = (messageId, card) => {
        queue.push({ kind: 'updateCard', messageId, card });
    };
    const flush = async () => {
        if (!live || flushing !== undefined || queue.length === 0)
            return;
        flushing = (async () => {
            const batch = queue;
            queue = [];
            notify(`dsh-lark-bridge: replaying ${batch.length} queued message(s) after reconnect`);
            for (const call of batch) {
                try {
                    switch (call.kind) {
                        case 'send':
                            await port.send(call.to, call.input, call.opts);
                            break;
                        case 'stream':
                            await port.stream(call.to, call.input, call.opts);
                            break;
                        case 'updateCard':
                            await port.updateCard(call.messageId, call.card);
                            break;
                    }
                }
                catch (error) {
                    // A call that still fails stays queued for the next live window;
                    // the caller sees nothing (fire-and-forget), so only the console does.
                    onFlushFailure(error);
                    queue.push(call);
                }
            }
        })().finally(() => { flushing = undefined; });
        await flushing;
    };
    const wrapped = {
        ...bindPortMethods(port),
        async send(to, input, opts) {
            if (!live)
                return enqueueSend(to, input, opts);
            try {
                return await port.send(to, input, opts);
            }
            catch (error) {
                onFlushFailure(error);
                return enqueueSend(to, input, opts);
            }
        },
        async stream(to, input, opts) {
            if (!live)
                return enqueueStream(to, input, opts);
            try {
                return await port.stream(to, input, opts);
            }
            catch (error) {
                onFlushFailure(error);
                return enqueueStream(to, input, opts);
            }
        },
        async updateCard(messageId, card) {
            if (!live) {
                enqueueUpdate(messageId, card);
                return;
            }
            try {
                await port.updateCard(messageId, card);
            }
            catch (error) {
                onFlushFailure(error);
                enqueueUpdate(messageId, card);
            }
        },
        setConnected(next) {
            live = next;
            if (next)
                void flush().catch(onFlushFailure);
        },
        pending: () => queue.length,
    };
    return wrapped;
}
/**
 * Copy a transport's methods onto a plain object with `this` bound to the
 * transport. A plain spread (`{ ...port }`) copies only own enumerable fields
 * — a class instance (LarkChannel) keeps every method on the prototype, so
 * the spread result has NO `connect`, `send`, or `on`, and the bridge would
 * call `undefined` and die on the first connection. Binding keeps the
 * prototype methods callable without losing the instance state they read.
 * @param port - the transport surface to copy.
 * @returns own fields plus every method bound to the original port.
 */
function bindPortMethods(port) {
    const copy = {};
    for (const key of Object.keys(port)) {
        const value = port[key];
        copy[key] = typeof value === 'function' ? value.bind(port) : value;
    }
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(port))) {
        if (key === 'constructor')
            continue;
        const value = port[key];
        if (typeof value === 'function')
            copy[key] = value.bind(port);
    }
    return copy;
}
//# sourceMappingURL=replay.js.map