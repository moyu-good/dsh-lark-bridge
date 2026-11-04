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
import type { OutboundPort } from './outbound.ts';
/**
 * The transport surface {@link createReplayPort} wraps: outbound chat sends
 * plus the lifecycle the wrapper must not swallow. `on` stays the underlying
 * transport's (the wrapper adds no inbound events), and connect/disconnect
 * pass through so the caller drives the real connection.
 */
export interface ReplayPort extends OutboundPort {
    updateCard(messageId: string, card: object): Promise<void>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    on(name: string, handler: (...args: never[]) => unknown): () => void;
}
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
export declare const UNDELIVERED_ID_PREFIX = "queued:";
/**
 * Whether a message id came from a queued send that has not been delivered.
 *
 * Callers must not hand such an id to `updateCard`, `addReaction`, or any other
 * Feishu API: it is not a message id.
 * @param messageId - id returned by `send`/`stream`, possibly a placeholder.
 * @returns true when the send is still queued (or was abandoned).
 */
export declare function isUndeliveredId(messageId: string | undefined): boolean;
/** The transport surface {@link createReplayPort} wraps. */
export interface ReplayPort extends OutboundPort {
    updateCard(messageId: string, card: object): Promise<void>;
}
/** A replay-enabled transport: the wrapped port plus the connection-state hook. */
export interface ReplayAwarePort extends ReplayPort {
    /** Tell the wrapper the connection state changed. `true` = live, `false` = down. */
    setConnected(live: boolean): void;
    /** How many calls are queued waiting for a live connection. */
    pending(): number;
    /**
     * Learn the real message id if `messageId` was only queued.
     *
     * A cached placeholder id is unusable: Feishu rejects it with 99992354. A
     * caller that keeps the returned id for a later card update registers here,
     * and repoints its cache at the real id once delivery succeeds. A no-op for
     * ids that already reached Feishu.
     * @param messageId - id returned by `send`/`stream`.
     * @param callback - receives the real id after successful delivery.
     */
    whenDelivered(messageId: string, callback: (realId: string) => void): void;
}
/**
 * Wrap a transport so outbound calls survive a connection gap.
 * @param port - the underlying transport.
 * @param onFlushFailure - report one queued call that failed to re-send.
 * @param notify - operator console line for queue lifecycle.
 * @returns the replay-aware port.
 */
export declare function createReplayPort(port: ReplayPort, onFlushFailure: (error: unknown) => void, notify: (line: string) => void): ReplayAwarePort;
//# sourceMappingURL=replay.d.ts.map