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
export type BillingPhase = 'peak' | 'off-peak'

/** Beijing wall-clock parts, derived without timezone-dependent host state. */
function beijingParts(now: Date): { weekdayShort: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const weekdayShort = get('weekday')
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  return { weekdayShort, minutes: Number.isNaN(hour) || Number.isNaN(minute) ? 0 : hour * 60 + minute }
}

const PEAK_WINDOWS: readonly [number, number][] = [
  [9 * 60, 12 * 60], // 09:00–12:00
  [14 * 60, 18 * 60], // 14:00–18:00
]
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

/**
 * Which phase the Beijing clock is in. Peak is weekday mornings and
 * afternoons only — the 12:00–14:00 lunch break, evenings, and weekends all
 * bill at the half rate ("其余为空闲时段", official footnote).
 */
export function deepseekBillingPhase(now: Date = new Date()): BillingPhase {
  const { weekdayShort, minutes } = beijingParts(now)
  if (!WEEKDAYS.has(weekdayShort)) return 'off-peak'
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end) ? 'peak' : 'off-peak'
}

/** Beijing wall clock as `HH:MM 周X` for display lines. */
export function beijingClock(now: Date = new Date()): string {
  const { weekdayShort, minutes } = beijingParts(now)
  const names: Record<string, string> = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' }
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm} 周${names[weekdayShort] ?? weekdayShort}`
}

/**
 * The model-facing prompt section: the rule, the current phase, and the
 * scheduling nudge — cheap tokens that save real money on batch work.
 */
export function pricingPromptLine(now: Date = new Date()): string {
  const phase = deepseekBillingPhase(now)
  const phaseLine = phase === 'peak'
    ? `现在是高峰时段（北京时间 ${beijingClock(now)}）——计费为空闲的两倍。`
    : `现在是空闲时段（北京时间 ${beijingClock(now)}）——计费为高峰的一半。`
  return 'DeepSeek 官方 API 分两档计价：高峰时段为北京时间周一至周五 9:00–12:00 与 14:00–18:00，'
    + '其余时间（午休、晚间、周末）为空闲时段，价格是高峰的一半。'
    + phaseLine
    + '当用户关心成本，或安排可延迟的批量任务（大规模重写、批量抓取、夜间跑数）时，'
    + '优先把重活排进空闲时段（北京时间 18:00 后或周末）执行。'
}

/** One human-facing line for the first-contact guide. */
export function pricingHumanLine(now: Date = new Date()): string {
  const phase = deepseekBillingPhase(now)
  const where = phase === 'peak' ? '高峰（双倍计费）' : '空闲（半价）'
  return `- 计费：DeepSeek API 分高峰/空闲两档，空闲半价（高峰=北京时间工作日 9:00–12:00、14:00–18:00）。当前是**${where}**时段（北京时间 ${beijingClock(now)}）——批量重活可留到晚间/周末跑。`
}
