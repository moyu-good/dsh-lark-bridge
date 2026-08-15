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
/**
 * Default feedback, using Feishu's reaction emoji_type vocabulary (the
 * platform only accepts these codes — arbitrary Unicode emoji are rejected
 * with `231001 reaction type is invalid`):
 * OK 收到 → THINKING 思考 → DONE 完成（失败 ERROR）.
 */
export const DEFAULT_REACTION_PRESET = {
    ack: 'OK',
    working: 'THINKING',
    success: 'DONE',
    failure: 'ERROR',
    clearWhenDone: false,
};
/** A quieter preset for channels that prefer not to stack emoji: only ack + done. */
export const QUIET_REACTION_PRESET = {
    ack: 'OK',
    working: '',
    success: 'DONE',
    failure: 'ERROR',
    clearWhenDone: true,
};
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
export function createReactionTracker(port, preset = DEFAULT_REACTION_PRESET, onError = () => { }) {
    const states = new Map();
    const swap = async (messageId, state, emoji) => {
        if (state.currentId !== undefined) {
            await port.removeReaction(messageId, state.currentId).catch(onError);
            state.currentId = undefined;
        }
        if (emoji === '')
            return;
        try {
            state.currentId = await port.addReaction(messageId, emoji);
        }
        catch (error) {
            onError(error);
        }
    };
    const settle = async (messageId, emoji, clearDelayMs) => {
        let state = states.get(messageId);
        if (state === undefined) {
            state = { currentId: undefined, settled: false, acked: false };
            states.set(messageId, state);
        }
        if (state.settled)
            return;
        state.settled = true;
        if (emoji !== '')
            await swap(messageId, state, emoji);
        if (preset.clearWhenDone && state.currentId !== undefined) {
            const id = state.currentId;
            setTimeout(() => {
                void port.removeReaction(messageId, id).catch(onError);
                states.delete(messageId);
            }, clearDelayMs);
        }
    };
    return {
        async ack(messageId) {
            let state = states.get(messageId);
            if (state === undefined) {
                state = { currentId: undefined, settled: false, acked: false };
                states.set(messageId, state);
            }
            if (state.settled || state.acked)
                return;
            state.acked = true;
            if (preset.ack !== '')
                await swap(messageId, state, preset.ack);
        },
        async working(messageId) {
            const state = states.get(messageId);
            if (state === undefined || state.settled)
                return;
            if (preset.working !== '')
                await swap(messageId, state, preset.working);
        },
        done(messageId) {
            return settle(messageId, preset.success, 4000);
        },
        fail(messageId) {
            return settle(messageId, preset.failure, 6000);
        },
        /** Forget a message (its chat was disposed); the reaction stays as it was. */
        forget(messageId) {
            states.delete(messageId);
        },
    };
}
//# sourceMappingURL=reaction.js.map