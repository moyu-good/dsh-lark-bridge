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
import type { FetchImpl } from './sync/feishu-cloud.ts';
export { messageTimeStamp } from './clock.ts';
/** 一条原始消息里我们实际要读的字段（`im.v1.message.get` 的 `data.items[]`）。 */
export interface RawCardMessage {
    readonly message_id?: string;
    readonly msg_type?: string;
    readonly body?: {
        readonly content?: string;
    };
    readonly create_time?: string | number;
    readonly sender?: {
        readonly id?: string;
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
    /**
     * Read one message back as the transport's raw `data.items[]`.
     *
     * 和 {@link fetchMessage} 的区别只有一处，但很关键：`fetchMessage` 调
     * `im.v1.message.get` 时**没带** `card_msg_content_type`，2.0 卡片拿回来是被降级的
     * v1 占位（模型只看到 `[interactive card]`）。`fetchRawMessage` 默认带
     * `user_card_content`，返回的是发送时的原始卡片 JSON，引用一块卡片才有内容可读。
     *
     * 同样可选：测试替身不必建模这个接口。
     */
    fetchRawMessage?(messageId: string, opts?: {
        cardContentType?: string | null;
    }): Promise<RawCardMessage[]>;
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
 * How long the chat was quiet before this turn, as a phrase for the model.
 *
 * Only the GAP comes from here. The absolute time belongs to the message
 * stamp beside it (`showMessageTime`), and saying the same instant twice put
 * two timestamps three seconds apart at the top of every message — which
 * leaves the model to guess which one is "now". One line, one time, one gap:
 * the gap is the part the stamp cannot carry, and it is the part that
 * actually changes behaviour. A model resuming after eight hours should
 * re-check state it assumed; one resuming after three minutes should not
 * spend a turn doing it.
 * @param sessionId - the session this turn belongs to.
 * @param now - epoch milliseconds at turn start.
 * @returns the phrase (e.g. `4 分钟前`), or '' when the gap is unknown or
 *   too small to be worth a word.
 */
export declare function sessionGapPhrase(sessionId: string, now: number): string;
/**
 * Pull the readable text out of a card JSON whose shape may be 1.0 or 2.0.
 *
 * 飞书的卡片消息有两种结构：1.0 是 `title` + `elements`，2.0 是 `schema: "2.0"`
 * + `header` + `body.elements`。这里的任务只有一个——把卡片里**人能看到的那几行字**
 * 按阅读顺序取出来，拼成纯文本。
 *
 * 为什么不能直接用 `im.v1.message.get` 的默认返回：不带 `card_msg_content_type`
 * 时，2.0 卡片会降级成 v1 占位（`[interactive card]` 就是这么来的），引用一块面板卡
 * 时模型只拿到一个括号词组。带上 `user_card_content` 才拿得到原始 JSON。
 *
 * 取舍：这里只认 `plain_text` / `lark_md` / `markdown` 三种文本节点，其余结构一律
 * 靠遍历找下去。卡片里本来就没有别的可读文字，认多了只会把样式当内容吐出来。
 *
 * @param card - the parsed card JSON (`body.content` of an interactive message).
 * @param maxChars - how much text to keep; truncation is marked, never silent.
 * @returns the readable text, '' when the card carries none.
 */
export declare function cardText(card: unknown, maxChars?: number): string;
/**
 * Render the message a chat message quotes back, as a block to prepend.
 *
 * 飞书的「引用」不是正文的一部分：入站事件只带 `parent_id`，被引用的那条要
 * 另外调 `im.v1.message.get` 才能读到。不取它，模型看到的就是一句「这个你再
 * 改改」加一片空白——它只能猜「这个」是什么，而人会以为它当然看得见。
 *
 * @param quoted - the referenced message, already fetched.
 * @param maxChars - how much of its text to keep.
 * @param showTime - whether to stamp when the quoted message was sent. A quote
 *   read without its time turns "你引用的那条" into "whatever that was" — the
 *   model cannot tell a reply to a two-minute-old message from a six-hour one.
 * @returns the block and its trailing newline, or '' when there is nothing to show.
 */
export declare function quotedPrefix(quoted: NormalizedMessage | undefined, maxChars?: number, showTime?: boolean): string;
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
 * @param deps - injectable seams for tests; production leaves it empty.
 */
export declare function installBridge(ctx: Context, config: ResolvedConfig, port: ChannelPort, notify: (line: string) => void, authorization: Authorization, deps?: {
    readonly fetchImpl?: FetchImpl | undefined;
}): void;
//# sourceMappingURL=bridge.d.ts.map