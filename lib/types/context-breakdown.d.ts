/**
 * 从宿主投影里读上下文的两类事实：三段拆分（聊天内容 / 系统提示 / 工具定义）
 * 和模型窗口大小。
 *
 * 这是 `/context`、上下文预警和压缩提示共用的读数点：它们都要回答"占在哪、
 * 还剩多少"，而投影的形状（`sessionProjections.stateOf(session, key)`）是宿主
 * 实现细节，散在调用方里迟早会有一处忘记"没跑过的会话报零不是测量结果"。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { HostSession } from './host.ts';
import type { ContextBreakdown } from './notices.ts';
/** 投影尚未折叠过任何请求时返回 `undefined`——零不是一次测量。 */
export declare function readContextBreakdown(ctx: Context | undefined, session: HostSession): ContextBreakdown | undefined;
/**
 * 模型这一路的上下文窗口有多大。
 *
 * 取自最近一条 `request/context` 记录的 `contextWindow`（token-meter 的
 * `contextPressure` 投影）——它是宿主真正会拿去发请求的那个窗口，比按模型名
 * 查表可靠：同一路由可以换适配器，窗口跟着适配器走。
 * @returns 窗口大小；还没发过请求、或该路由没声明时 `undefined`。
 */
export declare function readContextWindow(ctx: Context | undefined, session: HostSession): number | undefined;
//# sourceMappingURL=context-breakdown.d.ts.map