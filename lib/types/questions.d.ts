/**
 * The model-to-human question flow as a Feishu card.
 *
 * dsh's `ctx.userQuestions` seam pauses a tool call until a human answers;
 * the UI side is a single registered provider. This module is that provider
 * for the bridge: the model's `ask_user_question` becomes an interactive
 * Feishu card (option buttons, or a free-text prompt), the human's click or
 * text resolves the pending promise, and the structured answer rides back
 * into the agent loop as the tool result — the exact round trip the Web UI's
 * question composer performs.
 * @module dsh-lark-bridge/questions
 */
import type { CardActionEvent, CardActionResponse } from '@larksuite/channel';
import type { OutboundPort } from './outbound.ts';
/** One question, as the host's seam carries it (subset the bridge needs). */
export interface HostQuestion {
    readonly id: string;
    readonly question: string;
    readonly detail?: string;
    readonly header?: string;
    readonly options?: readonly {
        readonly label: string;
        readonly description?: string;
    }[];
    readonly multiSelect?: boolean;
}
/** The answer shape the host seam expects back. */
export interface HostQuestionAnswer {
    readonly answers: readonly {
        readonly id: string;
        readonly selected: readonly string[];
        readonly custom?: string;
    }[];
}
/** The subset of the host user-questions seam the bridge consumes. */
export interface HostUserQuestions {
    registerProvider(provider: {
        ask(request: {
            readonly questions: readonly HostQuestion[];
            /** The exact live calling agent, when the request came from a tool call. */
            readonly agent?: {
                readonly session: {
                    readonly id: string;
                };
            };
            readonly signal?: AbortSignal;
        }): Promise<HostQuestionAnswer>;
    }): () => void;
}
/** Card-button payload carried by an option selection. */
declare const QUESTION_ACTION = "dsh-lark-bridge/question";
/**
 * The bridge's user-questions provider: render questions as Feishu cards and
 * resolve them on button clicks.
 * @param port - the transport used to send cards.
 * @param chatFor - resolve the chat a session's question belongs to; keyed by
 *   the agent's session id (the host seam validates the caller is the exact
 *   live root before it reaches us).
 * @returns the provider and its card-action handler.
 */
export declare function createQuestionProvider(port: OutboundPort, chatFor: (sessionId: string) => {
    chatId: string;
    threadId?: string;
} | undefined): {
    provider: {
        ask(request: {
            readonly questions: readonly HostQuestion[];
            readonly agent?: {
                readonly session: {
                    readonly id: string;
                };
            };
            readonly signal?: AbortSignal;
        }): Promise<HostQuestionAnswer>;
    };
    handleCardAction(evt: CardActionEvent): CardActionResponse | undefined;
};
/** Re-export for the bridge's card-action dispatch. */
export type { CardActionEvent, CardActionResponse };
export { QUESTION_ACTION };
//# sourceMappingURL=questions.d.ts.map