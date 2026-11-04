/**
 * 从宿主投影里读当前上下文的三段拆分（聊天内容 / 系统提示 / 工具定义）。
 *
 * 这是 `/context` 和上下文预警共用的读数点：两处都要回答"占在哪"，而投影的
 * 形状（`sessionProjections.stateOf(session, 'contextBreakdown')`）是宿主实现
 * 细节，散在调用方里迟早会有一处忘记"没跑过的会话报零不是测量结果"。
 */
/** 投影尚未折叠过任何请求时返回 `undefined`——零不是一次测量。 */
export function readContextBreakdown(ctx, session) {
    try {
        const projections = ctx?.get('sessionProjections');
        const state = projections?.stateOf?.(session, 'contextBreakdown');
        // `toolsTokens === 0` 意味着这次会话还没跑过一轮请求，三段都是零；
        // 把它当成"没有工具"会让预警文案撒谎。
        if (state?.breakdown !== undefined && state.breakdown.toolsTokens > 0)
            return state.breakdown;
    }
    catch {
        // 拆分是加分项：投影读不到不该拖垮调用方。
    }
    return undefined;
}
//# sourceMappingURL=context-breakdown.js.map