/**
 * 从宿主投影里读当前上下文的三段拆分（聊天内容 / 系统提示 / 工具定义）。
 *
 * 这是 `/context` 和上下文预警共用的读数点：两处都要回答"占在哪"，而投影的
 * 形状（`sessionProjections.stateOf(session, 'contextBreakdown')`）是宿主实现
 * 细节，散在调用方里迟早会有一处忘记"没跑过的会话报零不是测量结果"。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { HostSession } from './host.ts';
import type { ContextBreakdown } from './notices.ts';
/** 投影尚未折叠过任何请求时返回 `undefined`——零不是一次测量。 */
export declare function readContextBreakdown(ctx: Context | undefined, session: HostSession): ContextBreakdown | undefined;
//# sourceMappingURL=context-breakdown.d.ts.map