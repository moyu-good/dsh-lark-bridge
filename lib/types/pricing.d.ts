/**
 * DeepSeek API peak/off-peak billing awareness.
 *
 * DeepSeek's official API bills in two phases: peak hours cost DOUBLE the
 * off-peak ("空闲") rate. Peak = Beijing-time weekdays 09:00–12:00 and
 * 14:00–18:00; everything else — lunch break, evenings, weekends — bills at
 * the half rate (official pricing page footnote, verified 2026-09-09 against
 * api-docs.deepseek.com/zh-cn/quick_start/pricing).
 *
 * The fleet runs on this billing, so the model and the human should both see
 * which phase is live RIGHT NOW: the model gets it as a prompt section (it
 * can schedule deferrable heavy work into the off-peak windows), and the
 * first-contact guide states it in one line. All math runs in Asia/Shanghai
 * wall clock regardless of the host machine's timezone.
 * @module dsh-lark-bridge/pricing
 */
/** The billing phase Beijing clock is currently in. */
export type BillingPhase = 'peak' | 'off-peak';
/**
 * Which phase the Beijing clock is in. Peak is weekday mornings and
 * afternoons only — the 12:00–14:00 lunch break, evenings, and weekends all
 * bill at the half rate ("其余为空闲时段", official footnote).
 */
export declare function deepseekBillingPhase(now?: Date): BillingPhase;
/** Beijing wall clock as `HH:MM 周X` for display lines. */
export declare function beijingClock(now?: Date): string;
/**
 * The model-facing prompt section: the rule, the current phase, and the
 * scheduling nudge — cheap tokens that save real money on batch work.
 */
export declare function pricingPromptLine(now?: Date): string;
/** One human-facing line for the first-contact guide. */
export declare function pricingHumanLine(now?: Date): string;
//# sourceMappingURL=pricing.d.ts.map