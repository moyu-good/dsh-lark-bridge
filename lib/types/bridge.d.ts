/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-bridge/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CardActionEvent, CardActionResponse, LarkChannelError, NormalizedMessage, RejectEvent } from '@larksuite/channel';
import type { ResolvedConfig } from './config.ts';
import type { HostUserMessage } from './host.ts';
import type { CotPort } from './cot.ts';
import type { OutboundPort } from './outbound.ts';
import type { Authorization } from './authorization.ts';
import type { CollectedImages, ImagePort } from './images.ts';
import type { SlashPanelPort } from './slash-panel.ts';
/**
 * The transport surface the bridge drives. `LarkChannel` from
 * `@larksuite/channel` satisfies it structurally; tests substitute a fake.
 */
export interface ChannelPort extends OutboundPort, SlashPanelPort, ImagePort, CotPort {
    /** Open the transport (WebSocket long connection by default). */
    connect(): Promise<void>;
    /** Close the transport and release its resources. */
    disconnect(): Promise<void>;
    /** Subscribe one normalized inbound event; returns the unsubscriber. */
    on(name: 'message', handler: (msg: NormalizedMessage) => void | Promise<void>): () => void;
    on(name: 'cardAction', handler: (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>): () => void;
    /**
     * A message the transport's own policy layer refused. Subscribing is the only
     * way to tell "the bot ignored me" apart from "the bot is broken": a refusal
     * never reaches the `message` handler and is reported nowhere else.
     */
    on(name: 'reject', handler: (evt: RejectEvent) => void): () => void;
    /**
     * A transport failure, including one thrown by an inbound handler: those do
     * NOT reject the awaited dispatch, so an unsubscribed channel loses them.
     */
    on(name: 'error', handler: (err: LarkChannelError) => void): () => void;
    /** The long connection dropped; events arriving in the gap are not replayed. */
    on(name: 'reconnecting', handler: () => void): () => void;
    /** The long connection is live again. */
    on(name: 'reconnected', handler: () => void): () => void;
    /** Replace a sent card's content in place. */
    updateCard(messageId: string, card: object): Promise<void>;
    /** Add an emoji reaction to a message; resolves the platform reaction id. */
    addReaction(messageId: string, emojiType: string): Promise<string>;
    /** Remove a reaction by the id {@link addReaction} returned. */
    removeReaction(messageId: string, reactionId: string): Promise<void>;
}
/**
 * Create an identified user message from one chat input. Group messages carry
 * the sender so the model can tell voices apart; direct messages stay verbatim.
 * @param msg - normalized inbound chat message.
 * @returns a frozen user message for `agent.followup()`.
 */
export declare function chatUserMessage(msg: NormalizedMessage, images: CollectedImages): HostUserMessage;
/**
 * Install the bridge on a scoped plugin context. Every registration is owned
 * by the context's fiber: disposal disconnects the transport, disposes every
 * agent this channel owns, and settles pending approvals as `'cancelled'`.
 * @param ctx - scoped plugin context carrying the `agents` service.
 * @param config - resolved plugin configuration.
 * @param port - the transport to drive; production passes the real Lark channel.
 */
export declare function installBridge(ctx: Context, config: ResolvedConfig, port: ChannelPort, notify: (line: string) => void, authorization: Authorization): void;
//# sourceMappingURL=bridge.d.ts.map