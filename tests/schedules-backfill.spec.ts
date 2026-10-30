import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * `/schedules` 必须报告「还活着」的提醒，而不是「本进程见过的」提醒。
 *
 * 原来的实现只在 `schedule/change` 事件流过时登记，进程一重启就归零——
 * 而提醒本身活在会话日志里，照常触发。于是出现最糟的组合：提醒还在响，
 * 命令却说没有。这个文件锁住「从日志回填」这条契约。
 */
describe('/schedules 从会话日志回填', () => {
  /** 一条只在日志里、没有 live 事件的 create。 */
  const createEvent = (id: string, prompt: string) => ({
    type: 'schedule/change',
    data: {
      version: 1,
      operation: 'create',
      schedule: { id, kind: 'every', prompt, everySeconds: 1800 },
    },
  })

  /** 发一条命令并取回桥接器发回的第一条匹配文本。 */
  async function command(harness: Awaited<ReturnType<typeof mountChannel>>, line: string): Promise<string> {
    await harness.fake.emitMessage(fakeMessage({ messageId: `om_cmd_${Math.random()}`, content: line }))
    let found = ''
    await vi.waitFor(() => {
      const text = harness.fake.sent
        .map(entry => String((entry.input as { markdown?: string }).markdown ?? ''))
        .find(body => body.includes('定时提醒'))
      if (text === undefined) throw new Error('no /schedules reply yet')
      found = text
    }, { timeout: 10_000, interval: 50 })
    return found
  }

  it('进程启动前创建的提醒仍然列得出来', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session

    // 这条提醒是上一个进程创建的：只有日志，没有任何 live 事件。
    harness.agents.sessionEvents.get(session.id)!.push(createEvent('schedule-old', '推进录像清理流水线'))

    const reply = await command(harness, '/schedules')
    expect(reply).toContain('推进录像清理流水线')
    expect(reply).toContain('1 个活跃')
    await harness.dispose()
  })

  it('日志里创建又删除的提醒不会复活', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session

    const events = harness.agents.sessionEvents.get(session.id)!
    events.push(createEvent('schedule-gone', '这条已经删了'))
    events.push({ type: 'schedule/change', data: { version: 1, operation: 'delete', id: 'schedule-gone' } })

    const reply = await command(harness, '/schedules')
    expect(reply).not.toContain('这条已经删了')
    expect(reply).toContain('没有活跃的提醒')
    await harness.dispose()
  })
})
