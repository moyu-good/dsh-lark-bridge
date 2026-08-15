/**
 * The model's current goal as a live Feishu card.
 *
 * dsh's goal tools mutate the session's goal and append a `goal/change`
 * snapshot event (whole-value replace: the newest snapshot is the current
 * goal). This module renders those snapshots as one goal card per session:
 * the first change sends the card, later changes update it in place, and a
 * cleared goal (no snapshot) settles the card with a neutral header. The Web
 * UI renders the same projection in its sidebar; the chat card is the
 * equivalent surface for a messaging client.
 * @module dsh-lark-bridge/goal
 */
import type { OutboundPort } from './outbound.ts';
/** The transport surface the goal renderer needs: send + updateCard. */
export interface GoalPort extends OutboundPort {
    /** Replace a sent card's content in place. */
    updateCard(messageId: string, card: object): Promise<void>;
}
/** One goal snapshot as the host session carries it. */
export interface HostGoal {
    readonly objective: string;
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete';
    readonly blockedReason?: {
        readonly code?: string;
        readonly message?: string;
    };
    readonly maxGoalRounds?: number;
}
/** The `goal/change` payload the bridge consumes. */
export interface HostGoalChange {
    readonly operation: string;
    readonly goal?: HostGoal;
}
/** Marker distinguishing this plugin's goal buttons from other card actions. */
export declare const GOAL_ACTION = "dsh-lark-bridge/goal";
/** Card-button payload carried by a goal control decision. */
export interface GoalActionValue {
    readonly kind: typeof GOAL_ACTION;
    readonly sessionId: string;
    readonly operation: 'pause' | 'resume' | 'clear';
}
/**
 * Narrow an arbitrary card-action value to this plugin's goal payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export declare function goalActionValue(value: unknown): GoalActionValue | undefined;
/**
 * The bridge's goal renderer: first snapshot sends a card, later snapshots
 * update it in place, and a clear (operation `clear`) leaves the last card
 * untouched — the goal is gone, so there is nothing to update.
 * @param port - the transport used to send and update cards.
 * @returns the renderer and its failure report hook.
 */
export declare function createGoalRenderer(port: GoalPort, reportSendFailure: (error: unknown) => void): {
    handle(sessionId: string, chatId: string, change: HostGoalChange): Promise<void>;
    dispose(): void;
};
//# sourceMappingURL=goal.d.ts.map