/**
 * DeepSeek open-platform balance query (the `/balance` command's guts).
 *
 * Endpoint: `GET https://api.deepseek.com/user/balance`, Bearer-authed with
 * the SAME key the harness bills through (`DEEPSEEK_API_KEY` in the deploy
 * environment). Verified live 2026-09-09: the payload carries
 * `is_available` plus `balance_infos[]` of {currency, total_balance,
 * granted_balance, topped_up_balance}, all string-typed decimals.
 *
 * The reply always states the query moment and the live peak/off-peak
 * phase — a balance number without "when" is how stale-number accidents
 * happen (行情必须实测).
 * @module dsh-lark-bridge/balance
 */
/** One currency bucket from the balance endpoint. */
export interface DeepseekBalance {
    readonly currency: string;
    readonly total: string;
    readonly granted: string;
    readonly toppedUp: string;
}
export interface DeepseekBalanceResult {
    readonly available: boolean;
    readonly balances: readonly DeepseekBalance[];
}
export type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
}) => Promise<{
    status: number;
    json: () => Promise<unknown>;
}>;
/** Query the platform balance with one API key. Throws on HTTP/shape errors. */
export declare function fetchDeepseekBalance(apiKey: string, fetchImpl?: FetchLike): Promise<DeepseekBalanceResult>;
/**
 * The chat reply: one line per currency (only non-zero buckets get the
 * breakdown; a drained key shows the 0.00 instead of hiding behind it),
 * service availability, the live billing phase, and the query moment.
 */
export declare function formatBalanceReply(result: DeepseekBalanceResult, now?: Date): string;
//# sourceMappingURL=balance.d.ts.map