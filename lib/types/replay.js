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
 * Prefix of the id a queued-but-undelivered send returns.
 *
 * A queued send has no Feishu message yet, but `SendResult.messageId` is a
 * required string, so the wrapper has to return something. It must never look
 * like a real id: callers cache the id and later call `updateCard(cachedId)`,
 * and Feishu rejects the whole request with `99992354 … Invalid ids:
 * [queued-13]`. That single failure used to abort the session log write, so
 * one placeholder id could cost a chat its persisted history. Every caller
 * therefore has to recognise this prefix — see {@link isUndeliveredId}.
 */
export const UNDELIVERED_ID_PREFIX = 'queued:';
/**
 * Whether a message id came from a queued send that has not been delivered.
 *
 * Callers must not hand such an id to `updateCard`, `addReaction`, or any other
 * Feishu API: it is not a message id.
 * @param messageId - id returned by `send`/`stream`, possibly a placeholder.
 * @returns true when the send is still queued (or was abandoned).
 */
export function isUndeliveredId(messageId) {
    return messageId !== undefined && messageId.startsWith(UNDELIVERED_ID_PREFIX);
}
/**
 * The HTTP status the transport attached to a rejection, when it attached one.
 * @param error - whatever the transport threw.
 * @returns the status, or undefined for a refusal raised before any request.
 */
function httpStatusOf(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    const status = error.response?.status;
    return typeof status === 'number' ? status : undefined;
}
/**
 * Message fragments that name a cause no retry can change.
 *
 * These are refusals the transport raises locally, before any request leaves
 * the machine, so the answer is the same however often it is asked. A file
 * path outside `outbound.allowedFileDirs` is the one that bit us: it was
 * queued as if the connection had dropped, and `send_file` reported a delivery
 * that never happened.
 */
const PERMANENT_FAILURE_HINTS = [
    'allowedFileDirs',
    'outside allowed directories',
];
/**
 * Whether a send failed for a reason that repeating it cannot fix.
 *
 * The replay wrapper exists to turn a connection gap into a delay. A permanent
 * refusal is not a gap: queueing it only hides the failure behind a placeholder
 * id until the caller has already told the human the opposite.
 *
 * The split follows the transport's own vocabulary. A 4xx is the platform
 * judging the request — the same request gets the same verdict — except 429,
 * which is the platform asking for a pause rather than rejecting the payload.
 * 5xx, timeouts, and anything with no status at all are the failures a retry
 * was built for.
 * @param error - what `send`/`stream` threw.
 * @returns true when the caller must hear about it now.
 */
export function isPermanentSendFailure(error) {
    const status = httpStatusOf(error);
    if (status !== undefined) {
        if (status === 429)
            return false;
        return status >= 400 && status < 500;
    }
    const message = error instanceof Error ? error.message : String(error);
    return PERMANENT_FAILURE_HINTS.some(hint => message.includes(hint));
}
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
    let queueSeq = 0;
    /**
     * Placeholder id → callback that receives the real message id once the
     * message finally reaches Feishu.
     *
     * A caller caches `send()`'s result and later calls `updateCard(cached)`. If
     * that send only got queued, the cached id is a placeholder; the flush swaps
     * in the real id here rather than leaving the caller holding a dead one.
     * Keyed by placeholder because the caller only knows the placeholder.
     */
    const pendingDeliveries = new Map();
    /**
     * Queue one chat-facing send and return the placeholder result for it.
     *
     * The counter, not `queue.length`: the length shrinks as the queue drains, so
     * two different queued sends would otherwise hand out the same id.
     * @param kind - which transport call was deferred.
     * @param to - target chat.
     * @param input - the deferred call's argument.
     * @param opts - the deferred call's options.
     * @returns a result whose `messageId` is a recognisable placeholder.
     */
    const enqueueDelivery = (kind, to, input, opts) => {
        queueSeq += 1;
        const placeholderId = `${UNDELIVERED_ID_PREFIX}${queueSeq}`;
        queue.push({
            kind,
            to,
            input,
            ...opts === undefined ? {} : { opts },
            // Carried on the queued call so the flush can report the real id.
            placeholderId,
        });
        return { messageId: placeholderId };
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
                        case 'stream': {
                            const result = call.kind === 'send'
                                ? await port.send(call.to, call.input, call.opts)
                                : await port.stream(call.to, call.input, call.opts);
                            const placeholderId = call.placeholderId;
                            if (placeholderId !== undefined) {
                                const waiter = pendingDeliveries.get(placeholderId);
                                pendingDeliveries.delete(placeholderId);
                                waiter?.(result.messageId);
                            }
                            break;
                        }
                        case 'updateCard':
                            // A card queued against a placeholder id can never be applied —
                            // the message it wanted to edit was never sent. Re-sending it as
                            // a new card would duplicate the panel, so drop it and log why.
                            if (isUndeliveredId(call.messageId)) {
                                notify(`dsh-lark-bridge: dropping card update for undelivered id ${call.messageId}`);
                                break;
                            }
                            await port.updateCard(call.messageId, call.card);
                            break;
                    }
                }
                catch (error) {
                    // A permanent refusal re-queued would sit at the head of the queue
                    // and fail again on every reconnect, blocking the messages behind it
                    // while its own caller was told minutes ago that it went out. Drop it
                    // and say so: the console line is the only trace left.
                    if (call.kind !== 'updateCard' && isPermanentSendFailure(error)) {
                        const detail = error instanceof Error ? error.message : String(error);
                        notify(`dsh-lark-bridge: dropping undeliverable queued ${call.kind}: ${detail}`);
                        continue;
                    }
                    // A call that still fails stays queued for the next live window;
                    // the caller sees nothing (fire-and-forget), so only the console does.
                    onFlushFailure(error);
                    queue.push(call);
                }
            }
        })().finally(() => { flushing = undefined; });
        await flushing;
    };
    /**
     * Learn the real message id once a queued send is finally delivered.
     *
     * Callers that cache an id and edit that message later should either register
     * here (the cache is repaired on delivery) or skip the edit while
     * {@link isUndeliveredId} is true. Withdrawal is per placeholder, so several
     * waiters on one placeholder all get told.
     * @param messageId - the id returned by `send`/`stream`.
     * @param callback - receives the real id when delivery succeeds.
     */
    const whenDelivered = (messageId, callback) => {
        if (!isUndeliveredId(messageId))
            return;
        const existing = pendingDeliveries.get(messageId);
        pendingDeliveries.set(messageId, existing === undefined
            ? callback
            : (realId) => { existing(realId); callback(realId); });
    };
    const wrapped = {
        ...bindPortMethods(port),
        async send(to, input, opts) {
            if (!live)
                return enqueueDelivery('send', to, input, opts);
            try {
                return await port.send(to, input, opts);
            }
            catch (error) {
                // A refusal the transport would repeat verbatim has to reach the
                // caller. Queueing it hands back a placeholder id, and a caller that
                // reads that as delivery — `send_file` does — tells the human a file
                // arrived that never left the machine.
                if (isPermanentSendFailure(error))
                    throw error;
                onFlushFailure(error);
                return enqueueDelivery('send', to, input, opts);
            }
        },
        async stream(to, input, opts) {
            if (!live)
                return enqueueDelivery('stream', to, input, opts);
            try {
                return await port.stream(to, input, opts);
            }
            catch (error) {
                if (isPermanentSendFailure(error))
                    throw error;
                onFlushFailure(error);
                return enqueueDelivery('stream', to, input, opts);
            }
        },
        async updateCard(messageId, card) {
            // Never forward a placeholder id to Feishu: it answers 99992354
            // "Invalid ids" and the caller's whole write path can fail with it.
            if (isUndeliveredId(messageId)) {
                notify(`dsh-lark-bridge: skipping card update for undelivered id ${messageId}`);
                return;
            }
            if (!live) {
                enqueueUpdate(messageId, card);
                return;
            }
            try {
                await port.updateCard(messageId, card);
            }
            catch (error) {
                // Deliberately unlike `send`: a card edit is a decoration on a message
                // that already arrived, so a queued retry costs nothing and no caller
                // reads it as delivery. Queueing every failure is the safer default.
                onFlushFailure(error);
                enqueueUpdate(messageId, card);
            }
        },
        whenDelivered,
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