/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-bridge/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CardActionEvent, CardActionResponse, LarkChannelError, NormalizedMessage, RejectEvent } from '@larksuite/channel';
import type { BusyPolicy, ResolvedConfig } from './config.ts';
import type { HostAgent, HostUserMessage } from './host.ts';
import type { CotPort } from './cot.ts';
import type { OutboundPort } from './outbound.ts';
import type { Authorization } from './authorization.ts';
import type { CollectedImages, ImagePort } from './images.ts';
import type { SlashPanelPort } from './slash-panel.ts';
import type { HostUserQuestionRequest, HostQuestionAnswer } from './questions.ts';
/**
 * Host contract mirror: the 0.1.5 `user-questions/request` waterfall.
 *
 * Declared here so the bridge's composition-time listener is type-checked
 * against the same shape the host dispatches. Scope-filtered: an agent-scoped
 * listener only receives that agent's requests.
 */
declare module '@deepseek-ai/cordis' {
    interface Events {
        'user-questions/request'(request: HostUserQuestionRequest, next: () => Promise<HostQuestionAnswer>): Promise<HostQuestionAnswer>;
        /**
         * Live assistant streaming, published by the driving Agent (0.1.5).
         *
         * Frames arrive as `start` (carrying turn and step), a run of `chunk`
         * frames, then `end`. The chunk payload is the same `StreamChunk` the
         * retired `assistant/chunk` session event carried.
         */
        'agent/assistant-stream'(payload: {
            agent: {
                readonly session: {
                    readonly id: string;
                };
            };
            frame: {
                readonly type: 'start';
                readonly attemptId: string;
                readonly turn: number;
                readonly step: number;
            } | {
                readonly type: 'chunk';
                readonly attemptId: string;
                readonly chunk: StreamChunkLike;
            } | {
                readonly type: 'end';
                readonly attemptId: string;
            };
        }): void;
    }
}
/** The subset of the host's `StreamChunk` the renderer reads. */
interface StreamChunkLike {
    readonly type: string;
    readonly text?: string;
    readonly index?: number;
    readonly block?: {
        readonly type?: string;
        readonly text?: string;
    };
}
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
    /**
     * Read one message back as a normalized message.
     *
     * Optional on purpose: the transport is the only thing that can fetch one,
     * and a test double that does not model the API must still satisfy the port.
     * When absent, a reply-quoted message simply reaches the model without its
     * quote — degraded, not broken.
     */
    fetchMessage?(messageId: string): Promise<NormalizedMessage | undefined>;
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
 * How much of a quoted message the model is shown.
 *
 * A quote can be an entire bot answer. Repeating it verbatim buys nothing the
 * session history does not already hold, and a long one would push the actual
 * question out of the model's attention — so the head, and a marker.
 */
/**
 * Render the message a chat message quotes back, as a block to prepend.
 *
 * 飞书的「引用」不是正文的一部分：入站事件只带 `parent_id`，被引用的那条要
 * 另外调 `im.v1.message.get` 才能读到。不取它，模型看到的就是一句「这个你再
 * 改改」加一片空白——它只能猜「这个」是什么，而人会以为它当然看得见。
 *
 * @param quoted - the referenced message, already fetched.
 * @returns the block and its trailing newline, or '' when there is nothing to show.
 */
export declare function quotedPrefix(quoted: NormalizedMessage | undefined, maxChars?: number): string;
/** What one chat message becomes, and what the chat is told about it. */
export interface BusyDelivery {
    /** The inbox boundary the message actually takes. */
    readonly policy: BusyPolicy;
    /** One line telling the chat where the message went; '' when it needs none. */
    readonly receipt: string;
}
/**
 * Choose the inbox boundary for one chat message (issue #5).
 *
 * A message that lands while a turn is running used to be queued
 * unconditionally: the chat read the wait as a hang, and the only way to change
 * direction was `/stop`, which throws the running turn's work away. `steer`
 * lands the message at the running driver's next step boundary, so a
 * correction takes effect inside the turn it corrects.
 *
 * An idle agent keeps the original semantics — an ordinary follow-up turn that
 * opens one — whatever the policy says, because there is nothing to steer.
 *
 * A policy the host cannot honour (an agent double with no `steer`, a host old
 * enough to predate it) degrades to `queue` and says so: the message must still
 * arrive, one turn later.
 *
 * @param busy - whether a turn is running (`agent.status === 'running'`).
 * @param policy - the deployment's `busyPolicy`.
 * @param agent - the live agent, inspected for the boundary it accepts.
 * @returns the policy to apply and the receipt line for it.
 */
export declare function busyDelivery(busy: boolean, policy: BusyPolicy, agent: Pick<HostAgent, 'steer' | 'inject'>): BusyDelivery;
/**
 * Install the bridge on a scoped plugin context. Every registration is owned
 * by the context's fiber: disposal disconnects the transport, disposes every
 * agent this channel owns, and settles pending approvals as `'cancelled'`.
 * @param ctx - scoped plugin context carrying the `agents` service.
 * @param config - resolved plugin configuration.
 * @param port - the transport to drive; production passes the real Lark channel.
 */
export declare function installBridge(ctx: Context, config: ResolvedConfig, port: ChannelPort, notify: (line: string) => void, authorization: Authorization): void;
export {};
//# sourceMappingURL=bridge.d.ts.map