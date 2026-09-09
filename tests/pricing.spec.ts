import { describe, expect, it } from 'vitest'
import { beijingClock, deepseekBillingPhase, pricingHumanLine, pricingPromptLine } from '../src/pricing.ts'

/** UTC instants whose Beijing wall clock is documented per case. */
function utc(hours: number, minutes: number, day: number, month: number, year = 2026): Date {
  return new Date(Date.UTC(year, month - 1, day, hours, minutes))
}

describe('deepseekBillingPhase (Asia/Shanghai wall clock)', () => {
  it('weekday mornings are peak', () => {
    // Wed 2026-09-09, 10:00 Beijing = 02:00 UTC.
    expect(deepseekBillingPhase(utc(2, 0, 9, 9))).toBe('peak')
  })

  it('the 12:00–14:00 lunch break bills off-peak', () => {
    // 13:00 Beijing = 05:00 UTC.
    expect(deepseekBillingPhase(utc(5, 0, 9, 9))).toBe('off-peak')
  })

  it('weekday afternoons are peak until 18:00 sharp', () => {
    expect(deepseekBillingPhase(utc(6, 30, 9, 9))).toBe('peak') // 14:30
    expect(deepseekBillingPhase(utc(9, 59, 9, 9))).toBe('peak') // 17:59
    expect(deepseekBillingPhase(utc(10, 0, 9, 9))).toBe('off-peak') // 18:00
  })

  it('evenings and nights bill off-peak', () => {
    expect(deepseekBillingPhase(utc(14, 0, 9, 9))).toBe('off-peak') // 22:00
    expect(deepseekBillingPhase(utc(17, 0, 9, 9))).toBe('off-peak') // 次日 01:00
  })

  it('weekends bill off-peak all day', () => {
    // Sat 2026-09-12, 10:00 Beijing = 02:00 UTC.
    expect(deepseekBillingPhase(utc(2, 0, 12, 9))).toBe('off-peak')
  })

  it('window edges land on the documented minutes', () => {
    expect(deepseekBillingPhase(utc(0, 59, 9, 9))).toBe('off-peak') // 08:59
    expect(deepseekBillingPhase(utc(1, 0, 9, 9))).toBe('peak') // 09:00
    expect(deepseekBillingPhase(utc(3, 59, 9, 9))).toBe('peak') // 11:59
    expect(deepseekBillingPhase(utc(4, 0, 9, 9))).toBe('off-peak') // 12:00
    expect(deepseekBillingPhase(utc(6, 0, 9, 9))).toBe('peak') // 14:00
  })
})

describe('display lines', () => {
  it('beijingClock renders HH:MM 周X regardless of host timezone', () => {
    expect(beijingClock(utc(2, 5, 9, 9))).toBe('10:05 周三')
  })

  it('the prompt line names the live phase and the scheduling nudge', () => {
    const peak = pricingPromptLine(utc(2, 0, 9, 9))
    expect(peak).toContain('高峰时段（北京时间 10:00 周三）')
    expect(peak).toContain('两倍')
    const offPeak = pricingPromptLine(utc(14, 0, 9, 9))
    expect(offPeak).toContain('空闲时段')
    expect(offPeak).toContain('一半')
  })

  it('the human line states the phase in bold', () => {
    expect(pricingHumanLine(utc(2, 0, 9, 9))).toContain('**高峰（双倍计费）**')
    expect(pricingHumanLine(utc(14, 0, 9, 9))).toContain('**空闲（半价）**')
  })
})
