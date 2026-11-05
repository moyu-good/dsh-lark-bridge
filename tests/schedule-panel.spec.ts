/**
 * 定时任务面板：规则说人话、触发有署名、面板能动手。
 *
 * 锁住的是一条退化路径：宿主早就会存 `title` / `scheduledAt` / 投递历史，
 * 而桥接器只认三种老规则，把每天 09:00 的任务渲染成「周期(undefineds)」，
 * 触发时又一言不发——聊天里只看到一段没人署名的指令。这里逐条盯住：
 * 规则能不能念出来、下次什么时候、触发时说不说清是谁在说话、能不能改。
 */

import { describe, expect, it, vi } from 'vitest'
import { runCommandLine, SCHEDULES_COMMAND } from '../src/commands.ts'
import type { ScheduleControl } from '../src/commands.ts'
import type { HostAgent, ScheduleEntry } from '../src/host.ts'
import {
  intervalPhrase,
  scheduleDispatchLine,
  scheduleLine,
  scheduleName,
  scheduleNextLabel,
  scheduleRuleLabel,
} from '../src/notices.ts'
import { shortStamp, upcomingPhrase } from '../src/clock.ts'

/** 一个只够 `/schedules` 用的假 agent。 */
function fakeAgent(): HostAgent {
  return {
    id: 'ses_1',
    session: { id: 'ses_1', seq: 0, eventAt: () => undefined },
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as HostAgent
}

/** 一条完整的任务记录。 */
function entry(overrides: Partial<ScheduleEntry> & Pick<ScheduleEntry, 'id' | 'kind' | 'prompt'>): ScheduleEntry {
  return { createdAt: 1_700_000_000_000, ...overrides }
}

/**
 * 发一条命令。
 *
 * 位置参数已经长到 28 个，所以这里只写关心的一头一尾，其余留 `undefined`：
 * 测试要盯的是 `/schedules` 的渲染和它对控制接口的调用，不是别的命令。
 */
function run(
  line: string,
  agent: HostAgent,
  schedules: Map<string, Map<string, ScheduleEntry>>,
  control?: ScheduleControl,
): ReturnType<typeof runCommandLine> {
  return runCommandLine(
    line,
    agent,
    undefined,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    schedules,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { schedule: control },
  )
}

/** 一个记录调用的控制接口。 */
function fakeControl(): ScheduleControl & { removed: string[]; edited: string[] } {
  const removed: string[] = []
  const edited: string[] = []
  return {
    store: {
      history: async () => ({
        records: [{ deliveredAt: new Date(Date.now() - 60_000).toISOString() }],
      }),
    },
    refresh: async () => undefined,
    remove: async (_sessionId, id) => { removed.push(id); return undefined },
    edit: async (_sessionId, id, change) => { edited.push(`${id}:${change.title ?? change.prompt ?? ''}`); return undefined },
    removed,
    edited,
  }
}

describe('规则说人话', () => {
  it('把秒数换成人的单位', () => {
    expect(intervalPhrase(45)).toBe('45 秒')
    expect(intervalPhrase(1800)).toBe('30 分钟')
    expect(intervalPhrase(7200)).toBe('2 小时')
    expect(intervalPhrase(5400)).toBe('1 小时 30 分钟')
    expect(intervalPhrase(172_800)).toBe('2 天')
    expect(intervalPhrase(undefined)).toBe('')
  })

  it('每天/每周/cron 都能念出来', () => {
    expect(scheduleRuleLabel({ kind: 'every', everySeconds: 1800 })).toBe('每 30 分钟')
    expect(scheduleRuleLabel({ kind: 'daily', time: '09:00:00' })).toBe('每天 09:00')
    expect(scheduleRuleLabel({ kind: 'weekly', time: '09:00:00', weekdays: [1, 3] })).toBe('每周一、三 09:00')
    expect(scheduleRuleLabel({ kind: 'cron', expression: '0 9 * * 1-5' })).toBe('cron `0 9 * * 1-5`')
    expect(scheduleRuleLabel({ kind: 'after' })).toBe('延时一次')
  })

  it('标题优先，没有标题才退回第一行 prompt', () => {
    expect(scheduleName({ title: '录像清理健康检查', prompt: '跑一遍' })).toBe('录像清理健康检查')
    expect(scheduleName({ prompt: '\n  第一行\n第二行' })).toBe('第一行')
    expect(scheduleName({ prompt: 'x'.repeat(80) })).toHaveLength(41)
  })

  it('下次触发同时给绝对时间和还剩多久', () => {
    const now = Date.parse('2026-11-05T09:30:00+08:00')
    const label = scheduleNextLabel({ scheduledAt: '2026-11-05T09:57:00+08:00' }, now)
    expect(label).toContain('09:57')
    expect(label).toContain('还有 27 分钟')
  })

  it('跨天的目标带上日期', () => {
    const now = Date.parse('2026-11-05T09:30:00+08:00')
    expect(shortStamp(Date.parse('2026-11-06T20:41:00+08:00'), now)).toBe('11-06 20:41')
    expect(upcomingPhrase(27 * 60_000)).toBe('27 分钟')
    expect(upcomingPhrase(2 * 86_400_000)).toBe('2 天')
  })
})

describe('通知行', () => {
  it('创建时说出名字和规则', () => {
    const line = scheduleLine({ operation: 'create', kind: 'daily', title: '每日巡检', prompt: '检查一遍' })
    expect(line).toContain('已创建定时任务')
    expect(line).toContain('每日巡检')
    expect(line).toContain('每天')
  })

  it('触发时点名是谁在说话', () => {
    const line = scheduleDispatchLine({ kind: 'every', everySeconds: 1800, title: '补漏四段进度' })
    expect(line).toContain('定时任务「补漏四段进度」')
    expect(line).toContain('每 30 分钟')
  })
})

describe('/schedules 面板', () => {
  it('每天任务不再渲染成 undefined', async () => {
    const agent = fakeAgent()
    const schedules = new Map([[agent.session.id, new Map([
      ['s1', entry({ id: 's1', kind: 'daily', title: '每日巡检', prompt: '检查磁盘', time: '09:00:00' })],
    ])]])
    const outcome = await run(`/${SCHEDULES_COMMAND}`, agent, schedules)
    expect(outcome.reply).toContain('每日巡检')
    expect(outcome.reply).toContain('每天 09:00')
    expect(outcome.reply).not.toContain('undefined')
  })

  it('序号进详情，带完整内容', async () => {
    const agent = fakeAgent()
    const schedules = new Map([[agent.session.id, new Map([
      ['s1', entry({ id: 's1', kind: 'every', everySeconds: 1800, title: '进度', prompt: '看四块进度' })],
    ])]])
    const outcome = await run(`/${SCHEDULES_COMMAND} 1`, agent, schedules, fakeControl())
    expect(outcome.reply).toContain('看四块进度')
    expect(outcome.reply).toContain('每 30 分钟')
    expect(outcome.reply).toContain('最近投递')
  })

  it('run 把任务内容排进会话，而不是等下一次触发', async () => {
    const agent = fakeAgent()
    const schedules = new Map([[agent.session.id, new Map([
      ['s1', entry({ id: 's1', kind: 'every', everySeconds: 1800, prompt: '看四块进度' })],
    ])]])
    const outcome = await run(`/${SCHEDULES_COMMAND} run 1`, agent, schedules)
    expect(outcome.reply).toContain('立刻跑一次')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = vi.mocked(agent.followup).mock.calls[0]![0]
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('[手动触发]')
    expect(text).toContain('看四块进度')
  })

  it('delete 与 edit 走宿主服务', async () => {
    const agent = fakeAgent()
    const schedules = new Map([[agent.session.id, new Map([
      ['s1', entry({ id: 's1', kind: 'every', everySeconds: 1800, prompt: '旧内容' })],
    ])]])
    const control = fakeControl()

    const deleted = await run(`/${SCHEDULES_COMMAND} delete 1`, agent, schedules, control)
    expect(deleted.reply).toContain('已删除')
    expect(control.removed).toEqual(['s1'])

    const edited = await run(`/${SCHEDULES_COMMAND} edit 1 新内容`, agent, schedules, control)
    expect(edited.reply).toContain('已更新')
    expect(control.edited).toEqual(['s1:新内容'])
  })

  it('没有控制接口时明确说不能改，但列表照常', async () => {
    const agent = fakeAgent()
    const schedules = new Map([[agent.session.id, new Map([
      ['s1', entry({ id: 's1', kind: 'every', everySeconds: 1800, prompt: '内容' })],
    ])]])
    const outcome = await run(`/${SCHEDULES_COMMAND} delete 1`, agent, schedules)
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('写入接口')
  })

  it('看不懂的子命令给用法，而不是当列表糊过去', async () => {
    const agent = fakeAgent()
    const schedules = new Map([[agent.session.id, new Map([
      ['s1', entry({ id: 's1', kind: 'every', everySeconds: 1800, prompt: '内容' })],
    ])]])
    const outcome = await run(`/${SCHEDULES_COMMAND} 胡乱`, agent, schedules)
    expect(outcome.reply).toContain('用法')
  })
})
