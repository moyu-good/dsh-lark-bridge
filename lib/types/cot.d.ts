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
import type { OutboundRenderer, ToolPresentation } from './outbound.ts';
/** One AG-UI event, as the write API takes it. */
export interface CotEvent {
    readonly event_type: string;
    /** The event's own fields, JSON-encoded; the API caps one at 4096 characters. */
    readonly content: string;
    /** Milliseconds, as a string, used by the client to order events. */
    readonly timestamp: string;
}
/** A created thinking process, addressed by both ids on every write. */
export interface CotHandle {
    readonly cotId: string;
    readonly messageId: string;
}
/** The CoT operations this renderer drives. */
export interface CotPort {
    /** Open a thinking process in one chat, optionally aimed at the message that asked. */
    createCot(chatId: string, options: {
        replyTo?: string;
        hidden: boolean;
    }): Promise<CotHandle>;
    /** Append events to one thinking process, in order. */
    writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void>;
}
/** Options for {@link createCotRenderer}. */
export interface CotRendererOptions {
    /** Whether the agent's reasoning and tool calls appear at all. */
    readonly showProcess: boolean;
    /** Whether the platform hides the process once the run finishes. */
    readonly hidden: boolean;
    /** The tool's own label and kind for one call. */
    readonly presentCall: ToolPresentation;
    /** Report a handled failure to the operator. */
    readonly onFailure: (error: unknown) => void;
    /** Renders the answer itself; the thinking process deliberately carries none. */
    readonly answer: OutboundRenderer;
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
export declare function createCotRenderer(port: CotPort, chatId: string, options: CotRendererOptions): OutboundRenderer;
//# sourceMappingURL=cot.d.ts.map