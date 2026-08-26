/**
 * Outbound rendering: how one owned chat's session events become chat output.
 * Two renderers share the {@link OutboundRenderer} surface — a plain-message
 * renderer that sends one markdown message per completed step, and a streaming
 * renderer that keeps one typewriter card per turn.
 * @module dsh-lark-bridge/outbound
 */
import type { MarkdownStreamController, SendInput, SendOptions, SendResult } from '@larksuite/channel';
import type { HostSessionEvent } from './host.ts';
export type { HostSessionEvent };
/** The outbound half of the transport, as the renderers use it. */
export interface OutboundPort {
    send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>;
    stream(to: string, input: {
        markdown: (controller: MarkdownStreamController) => Promise<void>;
    }, opts?: SendOptions): Promise<SendResult>;
}
/** Where one reply is delivered inside its chat. */
export interface ReplyTarget {
    /** The message being replied to. */
    readonly messageId: string;
    /** Present when the trigger sat inside a topic thread, so the reply stays in it. */
    readonly threadId?: string;
}
/** Renders one owned chat's session events as chat output. */
export interface OutboundRenderer {
    /** Handle one session event of the owned chat. */
    handle(event: HostSessionEvent): void;
    /** Settle every open output; awaited during disposal. */
    close(): Promise<void>;
    /**
     * Aim subsequent output at the message that triggered it; `undefined` returns
     * to plain chat sends. A renderer outlives one turn, so the target moves with
     * every inbound message.
     */
    aim(target: ReplyTarget | undefined): void;
}
export declare function stripToolCallMarkup(text: string): string;
/**
 * Describe one pending tool call in a few words — the tool's own presentation
 * title where it has one, so a chat log line says what a call does instead of
 * repeating its name.
 */
/** What a tool's own presenter says about one call: its label and its category. */
export interface PresentedCall {
    /** Short, always-visible label describing what THIS call does. */
    readonly title: string;
    /** The host's tool-call kind, when the tool declared one; drives icon choice. */
    readonly kind?: string;
}
/** Describe one pending call for a surface that shows an icon beside it. */
export type ToolPresentation = (name: string, argumentsJson: string) => PresentedCall;
/**
 * Renderer that sends one plain markdown message per completed step. Needs no
 * card permissions; tool activity stays off the chat because each line would
 * cost its own message.
 * @param port - outbound transport.
 * @param chatId - the owned chat.
 * @param onFailure - report an outbound failure.
 * @returns the renderer.
 */
export declare function createMessageRenderer(port: OutboundPort, chatId: string, onFailure: (error: unknown) => void): OutboundRenderer;
/** Options for {@link createStreamRenderer}. */
export interface StreamRendererOptions {
    /** Whether the agent's reasoning and tool calls appear in the card. */
    readonly showProcess: boolean;
    /** Names what one tool call does, for the activity line. */
    readonly presentCall: ToolPresentation;
    /** Report an outbound failure. */
    readonly onFailure: (error: unknown) => void;
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
export declare function createStreamRenderer(port: OutboundPort, chatId: string, options: StreamRendererOptions): OutboundRenderer;
//# sourceMappingURL=outbound.d.ts.map