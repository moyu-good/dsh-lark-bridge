/**
 * Tracks subagent children for one chat session and renders them as a single
 * updatable Feishu interactive card. One card shows ALL live children; each
 * status change re-renders the card in place.
 * @module dsh-lark-bridge/subagent-card
 */
export function createTracker() {
    return { entries: new Map() };
}
export function addEntry(state, id, descriptor) {
    state.entries.set(id, {
        id,
        label: descriptor.label ?? `child-${state.entries.size + 1}`,
        mode: descriptor.mode === 'continuable' ? 'continuable' : 'one-shot',
        status: 'running',
    });
}
export function settleEntry(state, id, stopReason) {
    const e = state.entries.get(id);
    if (!e)
        return;
    if (stopReason === 'completed')
        e.status = 'completed';
    else if (stopReason === 'aborted')
        e.status = 'aborted';
    else if (stopReason === 'max-tokens')
        e.status = 'max-tokens';
    else
        e.status = 'error';
}
function statusMark(s) {
    switch (s) {
        case 'completed': return '✅';
        case 'aborted': return '⏹️';
        case 'error': return '❌';
        case 'max-tokens': return '⛔';
        default: return '⏳';
    }
}
export function render(state) {
    const rows = [];
    for (const [, e] of state.entries) {
        const mark = statusMark(e.status);
        rows.push(` ${mark} **${e.label}** — ${e.status}`);
    }
    const body = rows.length > 0 ? rows.join('\n') : '（无子任务）';
    return {
        config: { wide_screen_mode: true },
        header: {
            template: 'purple',
            title: { tag: 'plain_text', content: '🧑‍💻 多代理执行面板' },
        },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: body } },
        ],
    };
}
//# sourceMappingURL=subagent-card.js.map