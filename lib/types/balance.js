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
import { pricingHumanLine } from "./pricing.js";
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** Query the platform balance with one API key. Throws on HTTP/shape errors. */
export async function fetchDeepseekBalance(apiKey, fetchImpl = fetch) {
    const res = await fetchImpl(BALANCE_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}${res.status === 401 ? '（key 无效或已过期）' : ''}`);
    }
    const data = (await res.json());
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const balances = infos
        .filter((info) => typeof info.currency === 'string')
        .map((info) => ({
        currency: info.currency,
        total: info.total_balance ?? '?',
        granted: info.granted_balance ?? '?',
        toppedUp: info.topped_up_balance ?? '?',
    }));
    if (balances.length === 0)
        throw new Error('响应里没有余额条目');
    return { available: data.is_available === true, balances };
}
/**
 * The chat reply: one line per currency (only non-zero buckets get the
 * breakdown; a drained key shows the 0.00 instead of hiding behind it),
 * service availability, the live billing phase, and the query moment.
 */
export function formatBalanceReply(result, now = new Date()) {
    const stamp = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(now);
    const rows = result.balances.map((balance) => {
        if (balance.granted !== '0.00' && balance.granted !== '0') {
            return `- ${balance.currency}：**${balance.total}**（赠送 ${balance.granted} + 充值 ${balance.toppedUp}）`;
        }
        return `- ${balance.currency}：**${balance.total}**`;
    });
    const state = result.available ? '✅ 可用' : '⛔ 平台标记不可用';
    return [
        `**DeepSeek 余额**（查询于北京时间 ${stamp} · 服务${state}）`,
        ...rows,
        '',
        pricingHumanLine(now),
    ].join('\n');
}
//# sourceMappingURL=balance.js.map