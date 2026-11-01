/**
 * 时间是给人看还是给模型看，格式不同但必须自洽。
 *
 * 为什么要盯这条：同一场对话里，思考区的「22:31:07」、消息前的
 * 「2026-11-01 22:31:07 (+08:00)」和模型读到的「距上一轮 8 小时前」指的是
 * 同一个瞬间。三处各写一份格式化，迟早会漂——尤其耗时格式化，8ms 和 8 分钟
 * 是两件事，单位选错就把它们压成同一个「0s」。
 */

import { describe, expect, it } from 'vitest'
import { clockTime, duration, elapsedPhrase, messageTimeStamp } from '../src/clock.ts'

describe('clockTime', () => {
  it('只给钟点，不带日期和偏移', () => {
    // 2026-11-01 00:29:00 +08:00
    expect(clockTime(1793464140000)).toBe('00:29:00')
  })

  it('精确到秒，同一分钟里能分出先后', () => {
    const base = 1793464140000
    expect(clockTime(base)).not.toBe(clockTime(base + 1_500))
  })

  it('没有时间就返回 undefined，不留空位', () => {
    expect(clockTime(undefined)).toBeUndefined()
    expect(clockTime(0)).toBeUndefined()
    expect(clockTime(Number.NaN)).toBeUndefined()
  })
})

describe('duration', () => {
  it('亚秒保留毫秒，否则会被压成 0s', () => {
    expect(duration(8)).toBe('8ms')
    expect(duration(999)).toBe('999ms')
  })

  it('秒级保留一位小数，读得出快慢差别', () => {
    expect(duration(1000)).toBe('1.0s')
    expect(duration(18_240)).toBe('18.2s')
  })

  it('分钟级换成中文说法', () => {
    expect(duration(252_000)).toBe('4 分 12 秒')
  })

  it('拿不到数就返回空串，由调用方决定不显示', () => {
    expect(duration(undefined)).toBe('')
    expect(duration(-1)).toBe('')
    expect(duration(Number.NaN)).toBe('')
  })
})

describe('elapsedPhrase', () => {
  it('越久越粗，粗到「几天前」就够用了', () => {
    expect(elapsedPhrase(30_000)).toBe('刚刚')
    expect(elapsedPhrase(5 * 60_000)).toBe('5 分钟前')
    expect(elapsedPhrase(2 * 3_600_000)).toBe('2 小时前')
    expect(elapsedPhrase(8 * 3_600_000 + 30 * 60_000)).toBe('8 小时 30 分钟前')
    expect(elapsedPhrase(3 * 86_400_000)).toBe('3 天前')
  })

  it('负数和不给数都不编造', () => {
    expect(elapsedPhrase(-1)).toBe('')
    expect(elapsedPhrase(undefined)).toBe('')
  })
})

describe('同一瞬间在三个地方说法一致', () => {
  it('思考区的钟点包含在消息时间戳里', () => {
    const at = 1793464140000
    expect(messageTimeStamp(at)).toContain(clockTime(at)!)
  })
})
