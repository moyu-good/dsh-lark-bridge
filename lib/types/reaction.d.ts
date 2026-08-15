/**
 * Message reaction feedback: the bot's own emoji reaction on the triggering
 * message, so a human sees that the bot received it and is working, without
 * any chat text. States replace each other: acknowledging, working, then a
 * terminal result (success / failure), or clearing entirely when configured.
 *
 * Feishu lets an app add and remove its own reactions on a message; only the
 * bot's own reactions can be removed. The tracker holds the `reaction_id`
 * each add returns so the same emoji can be swapped for the next one.
 * @module dsh-lark-bridge/reaction
 */
/** The reaction operations one chat's tracker drives. */
export interface ReactionPort {
    /** Add an emoji reaction to a message; resolves the platform reaction id. */
    addReaction(messageId: string, emojiType: string): Promise<string>;
    /** Remove a reaction by the id {@link addReaction} returned. */
    removeReaction(messageId: string, reactionId: string): Promise<void>;
}
/** The lifecycle emojis, in state order. Every field may be empty to skip that state. */
export interface ReactionPreset {
    /** Set on inbound message before the agent runs. */
    readonly ack: string;
    /** Set when the agent starts its turn. */
    readonly working: string;
    /** Set when the turn finishes without an error. */
    readonly success: string;
    /** Set when the turn fails. */
    readonly failure: string;
    /** When true, remove the terminal reaction after a short delay instead of leaving it. */
    readonly clearWhenDone: boolean;
}
/**
 * Default feedback, using Feishu's reaction emoji_type vocabulary (the
 * platform only accepts these codes — arbitrary Unicode emoji are rejected
 * with `231001 reaction type is invalid`):
 * OK 收到 → THINKING 思考 → DONE 完成（失败 ERROR）.
 */
export declare const DEFAULT_REACTION_PRESET: ReactionPreset;
/** A quieter preset for channels that prefer not to stack emoji: only ack + done. */
export declare const QUIET_REACTION_PRESET: ReactionPreset;
/**
 * Track one message's reaction through the lifecycle. Every transition first
 * removes the previous reaction (best-effort) then adds the next one; failures
 * to remove are reported through `onError` and never abort the transition.
 *
 * Only one reaction is ever on the message at a time, so the feedback reads
 * as a single morphing emoji rather than a stack.
 * @param port - reaction operations.
 * @param preset - the emoji lifecycle.
 * @param onError - report a reaction failure to the operator.
 * @returns the tracker.
 */
export declare function createReactionTracker(port: ReactionPort, preset?: ReactionPreset, onError?: (error: unknown) => void): ReactionTracker;
/** The reaction tracker surface the bridge drives. */
export interface ReactionTracker {
    /** The bot received a message; show the acknowledgement emoji. */
    ack(messageId: string): Promise<void>;
    /** The agent began working on the message; show the working emoji. */
    working(messageId: string): Promise<void>;
    /** The agent finished its turn successfully; show the success emoji. */
    done(messageId: string): Promise<void>;
    /** The agent's turn failed; show the failure emoji. */
    fail(messageId: string): Promise<void>;
    /** Forget tracked state for a message (chat disposal). */
    forget(messageId: string): void;
}
//# sourceMappingURL=reaction.d.ts.map