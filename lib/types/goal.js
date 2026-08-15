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
/** Emoji and label per lifecycle phase. */
const PHASE_META = {
    active: { emoji: '🎯', label: '进行中' },
    paused: { emoji: '⏸️', label: '已暂停' },
    blocked: { emoji: '🚧', label: '受阻' },
    complete: { emoji: '✅', label: '已完成' },
};
/** Bound one untrusted line so it cannot inflate a card payload. */
function boundLine(text) {
    return text.length <= 160 ? text : `${text.slice(0, 159)}…`;
}
/** Marker distinguishing this plugin's goal buttons from other card actions. */
export const GOAL_ACTION = 'dsh-lark-bridge/goal';
/**
 * Narrow an arbitrary card-action value to this plugin's goal payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function goalActionValue(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (record.kind !== GOAL_ACTION)
        return undefined;
    if (typeof record.sessionId !== 'string' || record.sessionId === '')
        return undefined;
    if (record.operation !== 'pause' && record.operation !== 'resume' && record.operation !== 'clear')
        return undefined;
    return { kind: GOAL_ACTION, sessionId: record.sessionId, operation: record.operation };
}
/**
 * Build the goal card for one snapshot.
 * @param goal - the current goal snapshot.
 * @param sessionId - the session the buttons drive, carried in their values.
 * @returns a Feishu card object for `send({ card })` / `updateCard`.
 */
function goalCard(goal, sessionId) {
    const meta = PHASE_META[goal.phase];
    const lines = [`**目标** ${boundLine(goal.objective)}`, `${meta.emoji} ${meta.label}`];
    if (goal.phase === 'blocked' && goal.blockedReason?.message !== undefined && goal.blockedReason.message !== '') {
        lines.push(`原因：${boundLine(goal.blockedReason.message)}`);
    }
    if (goal.maxGoalRounds !== undefined) {
        lines.push(`轮次上限：${goal.maxGoalRounds}`);
    }
    const button = (operation, text, type) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        type,
        value: { kind: GOAL_ACTION, sessionId, operation },
    });
    const actions = [];
    if (goal.phase === 'active') {
        actions.push(button('pause', '⏸️ 暂停', 'default'));
    }
    else if (goal.phase === 'paused' || goal.phase === 'blocked') {
        actions.push(button('resume', '▶️ 继续', 'primary'));
    }
    if (goal.phase !== 'complete') {
        actions.push(button('clear', '⏹ 清除', 'danger'));
    }
    return {
        config: { wide_screen_mode: true },
        header: { template: 'turquoise', title: { tag: 'plain_text', content: `${meta.emoji} 目标 ${meta.label}` } },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
            ...actions.length === 0 ? [] : [{ tag: 'action', actions }],
        ],
    };
}
/**
 * The bridge's goal renderer: first snapshot sends a card, later snapshots
 * update it in place, and a clear (operation `clear`) leaves the last card
 * untouched — the goal is gone, so there is nothing to update.
 * @param port - the transport used to send and update cards.
 * @returns the renderer and its failure report hook.
 */
export function createGoalRenderer(port, reportSendFailure) {
    const cards = new Map();
    const sendOrUpdate = async (sessionId, chatId, goal) => {
        const existing = cards.get(sessionId);
        const card = goalCard(goal, sessionId);
        if (existing === undefined || existing.chatId !== chatId) {
            try {
                const sent = await port.send(chatId, { card });
                cards.set(sessionId, { chatId, messageId: sent.messageId });
            }
            catch (error) {
                reportSendFailure(error);
            }
            return;
        }
        try {
            await port.updateCard(existing.messageId, card);
        }
        catch (error) {
            reportSendFailure(error);
        }
    };
    return {
        async handle(sessionId, chatId, change) {
            // A clear operation carries no snapshot: the goal is gone, keep the
            // last card as the historical record.
            if (change.goal === undefined)
                return;
            await sendOrUpdate(sessionId, chatId, change.goal);
        },
        dispose() {
            cards.clear();
        },
    };
}
//# sourceMappingURL=goal.js.map