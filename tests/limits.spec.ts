/**
 * 截断预算（`limits`）：默认值 + 可配置。
 *
 * 背景：这套值原先写死在各个模块里（工具结果 3 行 / 240 字、每个参数 120 字、
 * 后台任务尾部 700 字……），是按「扫一眼就走的聊天」调的。把桥当工作台用
 * 的时候，被砍掉的恰好是「为什么失败」那几行。现在全部变成部署可调的预算，
 * 默认值放大到够用，但仍然有上限——一万行日志不能把一张卡撑成一面墙。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, resolveConfig, resolveLimits } from '../src/config.ts'
import { summariseArguments } from '../src/cot.ts'
import { jobDoneLine } from '../src/notices.ts'
import { runCommandLine } from '../src/commands.ts'
import { quotedPrefix } from '../src/bridge.ts'
import { fakeMessage } from './harness.ts'

describe('limits 默认值与解析', () => {
  it('未配置时全部取默认值', () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS)
  })

  it('只配一项时其余仍是默认值', () => {
    const resolved = resolveLimits({ toolResultLines: 50 })
    expect(resolved.toolResultLines).toBe(50)
    expect(resolved.toolResultChars).toBe(DEFAULT_LIMITS.toolResultChars)
  })

  it('resolveConfig 会把 limits 一起解析出来', () => {
    const resolved = resolveConfig({ limits: { jobTailChars: 1234 } })
    expect(resolved.limits.jobTailChars).toBe(1234)
    expect(resolved.limits.toolArgChars).toBe(DEFAULT_LIMITS.toolArgChars)
  })

  it('默认值比老的写死值宽，但仍有上限', () => {
    // 老值：结果 3 行 / 240 字，参数 120 字，任务尾部 700 字。
    expect(DEFAULT_LIMITS.toolResultLines).toBeGreaterThan(3)
    expect(DEFAULT_LIMITS.toolResultChars).toBeGreaterThan(240)
    expect(DEFAULT_LIMITS.toolArgChars).toBeGreaterThan(120)
    expect(DEFAULT_LIMITS.jobTailChars).toBeGreaterThan(700)
    // 单条 CoT 事件的平台上限是 4096 字符，插话文字必须留在它下面。
    expect(DEFAULT_LIMITS.userMessageChars).toBeLessThan(4096)
  })
})

describe('预算传得到各条渲染路径', () => {
  it('工具参数按调用方给的字符数截断', () => {
    const args = JSON.stringify({ command: 'x'.repeat(500), path: '/a/b' })
    const wide = summariseArguments(args)
    const tight = summariseArguments(args, 20)
    expect(wide).toContain('x'.repeat(100))
    expect(tight).not.toContain('x'.repeat(100))
    expect(tight).toContain('…')
    // 没被截到的那一项仍然可读。
    expect(tight).toContain('/a/b')
  })

  it('后台任务尾部按预算保留', () => {
    const output = `HEAD\n${'y'.repeat(500)}\nTAIL`
    const wide = jobDoneLine({ id: 'j', kind: 'bash', label: 'j', status: 'completed', output }, 2000)
    const tight = jobDoneLine({ id: 'j', kind: 'bash', label: 'j', status: 'completed', output }, 20)
    expect(wide).toContain('HEAD')
    expect(tight).not.toContain('HEAD')
    expect(tight).toContain('TAIL')
  })

  it('引用正文按预算截断', () => {
    const quoted = fakeMessage({ content: 'z'.repeat(400), senderName: '张三' })
    expect(quotedPrefix(quoted, 2000)).toContain('z'.repeat(300))
    const tight = quotedPrefix(quoted, 50)
    expect(tight).toContain('已截断')
    expect(tight.length).toBeLessThan(200)
  })
})

describe('命令回复里的行数上限', () => {
  /** runCommandLine 的尾部参数：workspaces(20)/currentCwd(21)；cwdBound 压尾。 */
  function runWs(entries: ReadonlyArray<{ id: string; path: string }>, currentCwd?: string) {
    const registry = {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'x', path: '/x', attachSession: async () => undefined }),
      list: () => entries.map(e => ({ ...e, attachSession: async () => undefined })),
    }
    const agent = { id: 'a', session: { id: 's', seq: 0, eventAt: () => undefined }, cancel: () => undefined } as never
    return runCommandLine(
      '/ws', agent, undefined, new AbortController().signal,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      registry as never, currentCwd,
      undefined, undefined, undefined, undefined,
    ) as unknown as Promise<{ resolved: boolean; reply: string }>
  }

  it('/ws 只列前 20 个，剩下的说清数量', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `ws_${i}`, path: `/srv/ws-${i}` }))
    const outcome = await runWs(many, '/srv/ws-3')
    expect(outcome.reply).toContain('（45 个）')
    expect(outcome.reply).toContain('还有 25 个未列出')
    const listed = outcome.reply.split('\n').filter(line => line.startsWith('·'))
    expect(listed).toHaveLength(20)
    // 「← 当前」仍出现在被列出的那几行里。
    expect(listed.some(line => line.includes('← 当前'))).toBe(true)
  })

  it('/ws 不超界时不加「还有」一句', async () => {
    const few = Array.from({ length: 3 }, (_, i) => ({ id: `ws_${i}`, path: `/srv/ws-${i}` }))
    const outcome = await runWs(few, '/srv/ws-1')
    expect(outcome.reply).toContain('（3 个）')
    expect(outcome.reply).not.toContain('还有')
  })
})
