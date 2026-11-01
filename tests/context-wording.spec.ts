/**
 * 上下文占用的两条提醒读同一处数字，且都说人话。
 *
 * 这里管的不是"数字算得对不对"（那是宿主 tokenMeter 的事），而是
 * **桥把它们讲清楚的方式**：总量、其中的聊天内容、其余开销，各自叫什么、
 * 怎么归。说错的后果是读者按错误的办法省钱——比如以为 `/compact` 能
 * 压掉工具说明那几万 token。
 */

import { describe, expect, it } from 'vitest'
import { contextPressureLine, tokenPressureLine } from '../src/notices.ts'

describe('上下文占用的措辞', () => {
  it('把总量拆成"聊天内容 + 其余开销"，而不是丢一个"会话表面"', () => {
    const line = tokenPressureLine({ total: 4_000, surface: 2_500, threshold: 3_000 })
    expect(line).toContain('4,000')
    expect(line).toContain('2,500')
    expect(line).toContain('工具说明')
    // "会话表面"只是宿主字段名的直译，读者看不懂它指的是聊天内容。
    expect(line).not.toContain('会话表面')
  })

  it('按千分位拆出"其余"并说明它压不下去', () => {
    const line = tokenPressureLine({ total: 444_833, surface: 277_312, threshold: 120_000 })
    expect(line).toContain('444,833')
    expect(line).toContain('277,312')
    expect(line).toContain('167,521')
    expect(line).toContain('压不掉')
  })

  it('总量与内容相等时不说"其余 0"，直接给建议', () => {
    const line = tokenPressureLine({ total: 5_000, surface: 5_000, threshold: 3_000 })
    expect(line).toContain('5,000')
    expect(line).not.toContain('其余')
    expect(line).toContain('/compact')
  })

  it('空会话不至于把"其余"算成负数', () => {
    const line = tokenPressureLine({ total: 100, surface: 500, threshold: 3_000 })
    expect(line).not.toContain('-400')
    expect(line).not.toContain('其余')
  })
})

describe('/context 的详细拆解', () => {
  it('有分组时按"聊天内容 / 工具说明 / 系统提示"三行给出', () => {
    const text = contextPressureLine({
      total: 444_833,
      surface: 277_312,
      breakdown: { messageTokens: 200_000, systemTokens: 77_312, toolsTokens: 167_521 },
    })
    expect(text).toContain('上下文占用')
    expect(text).toContain('合计约 444,833')
    expect(text).toContain('聊天内容约 200,000')
    expect(text).toContain('系统提示约 77,312')
    expect(text).toContain('工具说明约 167,521')
    expect(text).not.toContain('会话表面')
  })

  it('没有分组时退回到"合计 + 聊天内容"两行', () => {
    const text = contextPressureLine({ total: 10_000, surface: 6_000 })
    expect(text).toContain('合计约 10,000')
    expect(text).toContain('聊天内容约 6,000')
    expect(text).not.toContain('工具说明')
  })

  it('超过 12 万建议压缩，60 万以上提示更狠的办法', () => {
    expect(contextPressureLine({ total: 130_000, surface: 100_000 })).toContain('/compact')
    const heavy = contextPressureLine({ total: 700_000, surface: 600_000 })
    expect(heavy).toContain('工具说明')
    expect(heavy).toContain('极简模式')
  })

  it('低占用时不催', () => {
    const text = contextPressureLine({ total: 20_000, surface: 15_000 })
    expect(text).not.toContain('/compact')
  })
})
