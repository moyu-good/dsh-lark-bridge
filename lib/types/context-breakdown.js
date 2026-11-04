/**
 * 从宿主投影里读上下文的两类事实：三段拆分（聊天内容 / 系统提示 / 工具定义）
 * 和模型窗口大小。
 *
 * 这是 `/context`、上下文预警和压缩提示共用的读数点：它们都要回答"占在哪、
 * 还剩多少"，而投影的形状（`sessionProjections.stateOf(session, key)`）是宿主
 * 实现细节，散在调用方里迟早会有一处忘记"没跑过的会话报零不是测量结果"。
 */
/** 读一个会话投影的原始 state；投影未组合或抛错时 `undefined`。 */
function projectionState(ctx, session, key) {
    try {
        const projections = ctx?.get('sessionProjections');
        return projections?.stateOf?.(session, key);
    }
    catch {
        // 投影是加分项：读不到不该拖垮调用方。
        return undefined;
    }
}
/** 投影尚未折叠过任何请求时返回 `undefined`——零不是一次测量。 */
export function readContextBreakdown(ctx, session) {
    const state = projectionState(ctx, session, 'contextBreakdown');
    // `toolsTokens === 0` 意味着这次会话还没跑过一轮请求，三段都是零；
    // 把它当成"没有工具"会让预警文案撒谎。
    if (state?.breakdown !== undefined && state.breakdown.toolsTokens > 0)
        return state.breakdown;
    return undefined;
}
/**
 * 模型这一路的上下文窗口有多大。
 *
 * 取自最近一条 `request/context` 记录的 `contextWindow`（token-meter 的
 * `contextPressure` 投影）——它是宿主真正会拿去发请求的那个窗口，比按模型名
 * 查表可靠：同一路由可以换适配器，窗口跟着适配器走。
 * @returns 窗口大小；还没发过请求、或该路由没声明时 `undefined`。
 */
export function readContextWindow(ctx, session) {
    const state = projectionState(ctx, session, 'contextPressure');
    const window = state?.contextWindow;
    return typeof window === 'number' && window > 0 ? window : undefined;
}
//# sourceMappingURL=context-breakdown.js.map