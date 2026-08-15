/**
 * The model's todo list as a live Feishu progress card.
 *
 * dsh's `todo_write` tool replaces the whole list on every call and appends a
 * `todo/write` snapshot to the session log. This module renders those
 * snapshots as one progress card per session: the first write sends the card,
 * later writes update it in place, and a cleared or finished list settles it
 * with a summary. The Web UI renders the same projection in its sidebar; the
 * chat card is the equivalent surface for a messaging client.
 * @module dsh-lark-bridge/todo
 */
import type { LarkChannelError, SendResult } from '@larksuite/channel';
import type { OutboundPort } from './outbound.ts';
/** The transport surface the todo renderer needs: send + updateCard. */
export interface TodoPort extends OutboundPort {
    /** Replace a sent card's content in place. */
    updateCard(messageId: string, card: object): Promise<void>;
}
/** One todo item as the host session carries it. */
export interface HostTodoItem {
    readonly content: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
}
/** The todo snapshot carried by a `todo/write` event. */
export interface HostTodoWrite {
    readonly todos: readonly HostTodoItem[];
}
/**
 * The bridge's todo renderer: first snapshot sends a card, later snapshots
 * update it in place, and a session with no pending rows leaves the card with
 * a "done" header.
 * @param port - the transport used to send and update cards.
 * @returns the renderer and its failure report hook.
 */
export declare function createTodoRenderer(port: TodoPort, reportSendFailure: (error: unknown) => void): {
    handle(sessionId: string, chatId: string, todos: readonly HostTodoItem[]): Promise<void>;
    dispose(): void;
};
/** Re-exported for the bridge's failure-path typing. */
export type { LarkChannelError, SendResult };
//# sourceMappingURL=todo.d.ts.map