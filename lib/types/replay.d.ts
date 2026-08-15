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