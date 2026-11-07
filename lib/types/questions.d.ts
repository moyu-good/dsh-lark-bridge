/**
 * The model-to-human question flow as a Feishu card.
 *
 * dsh's `ctx.userQuestions` seam pauses a tool call until a human answers;
 * the UI side is a single registered provider. This module is that provider
 * for the bridge: the model's `ask_user_question` becomes an interactive
 * Feishu card, the human's click or typed text resolves the pending promise,
 * and the structured answer rides back into the agent loop as the tool result
 * — the exact round trip the Web UI's question composer performs.
 *
 * The card is CardKit JSON 2.0, because only 2.0 has a form container: that is
 * what lets one click both choose and submit, and what carries the free-text
 * answer back as `action.formValue`. Every answerable question is its own
 * `form` (they cannot nest and cannot sit inside a column), so a batch of
 * questions is a batch of independent forms, each settling on its own and
 * leaving a receipt behind.
 *
 * Untrusted model text (question/detail/option labels) rides `plain_text`
 * elements only — never markdown — so nothing it writes can inject card
 * markup or a link.
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
/**
 * The host's `user-questions/request` waterfall, as 0.1.5 declares it.
 *
 * Earlier harness versions exposed a `ctx.userQuestions.registerProvider`
 * registry; 0.1.5 replaced it with a Cordis waterfall where a listener claims
 * the request by returning an answer and delegates through `next()`. The
 * request/answer payloads are unchanged, so the bridge's provider plugs
 * straight in.
 */
export interface HostUserQuestionRequest {
    readonly questions: readonly HostQuestion[];
    /** The exact live calling agent, when the request came from a tool call. */
    readonly agent?: {
        readonly session: {
            readonly id: string;
        };
    };
    readonly signal?: AbortSignal;
}
/**
 * The transport surface the question provider needs.
 *
 * `updateCard` is optional because a test double that does not model the API
 * must still satisfy the port: without it the card simply stays clickable and
 * no receipt replaces the answered question.
 */
export interface QuestionPort extends OutboundPort {
    /** Replace a sent card's content in place. */
    updateCard?(messageId: string, card: object): Promise<void>;
}
/**
 * The bridge's user-questions provider: render questions as Feishu cards and
 * resolve them as their controls are used.
 * @param port - the transport used to send and update cards.
 * @param chatFor - resolve the chat a session's question belongs to; keyed by
 *   the agent's session id (the host seam validates the caller is the exact
 *   live root before it reaches us).
 * @returns the provider and its card-action handler.
 */
export declare function createQuestionProvider(port: QuestionPort, chatFor: (sessionId: string) => {
    chatId: string;
    threadId?: string;
} | undefined): {
    provider: {
        ask(request: HostUserQuestionRequest): Promise<HostQuestionAnswer>;
    };
    handleCardAction(evt: CardActionEvent): CardActionResponse | undefined;
};
/** Re-export for the bridge's card-action dispatch. */
export type { CardActionEvent, CardActionResponse };
//# sourceMappingURL=questions.d.ts.map