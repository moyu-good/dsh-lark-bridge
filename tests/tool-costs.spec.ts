/**
 * `/context` 的工具明细：从会话日志里最近一条 `request/header` 拆出逐工具占用。
 *
 * 宿主的 `toolsTokens` 是一个整块数字，公式是
 * `ceil(JSON.stringify(header.tools).length / 4) + 4`；这里按同一密度逐条拆，
 * 所以明细之和必须与那块总数对得上（只差逐条取整的零头）。对不上就说明桥用了
 * 另一套算法，读者会看到"明细加起来比总数大"这种自相矛盾的输出。
 */

import { describe, expect, it } from 'vitest'
import { readToolCosts } from '../src/tool-costs.ts'
import type { HostSession } from '../src/host.ts'

/** 只带 `seq` / `eventAt` 的最小会话替身——正是 token 计量回放需要的那两个成员。 */
function sessionOf(events: readonly unknown[]): HostSession {
  return {
    get seq() { return events.length },
    eventAt(seq: number) { return events[seq] },
  } as unknown as HostSession
}

const tool = (name: string, descriptionLength: number) => ({
  name,
  description: 'x'.repeat(descriptionLength),
  parameters: { type: 'object', properties: {} },
})

const headerEvent = (tools: readonly unknown[]) => ({ type: 'request/header', data: { header: { tools } } })

describe('从请求头拆工具占用', () => {
  it('按占用降序，名称取自工具定义', () => {
    const costs = readToolCosts(sessionOf([
      { type: 'user/message', data: {} },
      headerEvent([tool('small', 10), tool('big', 4_000), tool('mid', 400)]),
    ]))
    expect(costs?.map(cost => cost.name)).toEqual(['big', 'mid', 'small'])
    expect(costs?.[0]!.tokens).toBeGreaterThan(costs?.[1]!.tokens)
  })

  it('明细之和与宿主算出的整块数字对得上', () => {
    const tools = [tool('a', 100), tool('b', 900), tool('c', 40)]
    const costs = readToolCosts(sessionOf([headerEvent(tools)]))!
    const sum = costs.reduce((total, cost) => total + cost.tokens, 0)
    // 宿主：整体 stringify 后除以 4 向上取整，再加 4 的框架开销。
    const hostTotal = Math.ceil(JSON.stringify(tools).length / 4) + 4
    // 逐条取整最多比整体多出 tools.length 个 token。
    expect(sum).toBeLessThanOrEqual(hostTotal)
    expect(hostTotal - sum).toBeLessThanOrEqual(tools.length + 4)
  })

  it('取最近一条请求头，旧的不算', () => {
    const costs = readToolCosts(sessionOf([
      headerEvent([tool('old', 4_000)]),
      { type: 'assistant/message', data: {} },
      headerEvent([tool('current', 40)]),
    ]))
    expect(costs?.map(cost => cost.name)).toEqual(['current'])
  })

  it('会话还没有请求头时返回 undefined，而不是空清单', () => {
    // 「没跑过一轮」和「一个工具都没挂」是两件事，调用方要能区分。
    expect(readToolCosts(sessionOf([{ type: 'user/message', data: {} }]))).toBeUndefined()
  })

  it('请求头里没有工具时返回空清单', () => {
    expect(readToolCosts(sessionOf([headerEvent([])]))).toEqual([])
  })

  it('没有名字的工具不至于让明细崩掉', () => {
    const costs = readToolCosts(sessionOf([headerEvent([{ description: 'x', parameters: {} }])]))
    expect(costs?.[0]!.name).toBe('(未命名工具)')
  })
})
