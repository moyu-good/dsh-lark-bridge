/**
 * Tracks subagent children for one chat session and renders them as a single
 * updatable Feishu interactive card. One card shows ALL live children; each
 * status change re-renders the card in place.
 * @module dsh-lark-bridge/subagent-card
 */
export interface SubagentEntry {
    readonly id: string;
    readonly label: string;
    readonly mode: 'one-shot' | 'continuable';
    status: 'running' | 'completed' | 'aborted' | 'error' | 'max-tokens';
}
export interface SubagentCardState {
    readonly entries: Map<string, SubagentEntry>;
    /** The message ID of the sent card, for updateCard calls. */
    messageId?: string;
}
export declare function createTracker(): SubagentCardState;
export declare function addEntry(state: SubagentCardState, id: string, descriptor: {
    mode: string;
    label?: string;
}): void;
export declare function settleEntry(state: SubagentCardState, id: string, stopReason: string): void;
export declare function render(state: SubagentCardState): object;
//# sourceMappingURL=subagent-card.d.ts.map