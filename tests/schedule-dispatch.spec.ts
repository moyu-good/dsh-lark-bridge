/**
 * 定时器触发时，聊天里必须先有一句「这是谁在说话」。
 *
 * 宿主投递任务的方式是把 prompt 当成一条普通用户消息塞进会话，所以桥接器
 * 不说话时，聊天里只有一段没人署名的指令——每半小时一次的任务尤其像人在
 * 反复催。这里锁住两件事：触发有署名行，且那行能说明任务名和规则；配置关掉
 * 时则一声不出，因为「任务自己的输出已经足够明显」也是一种合理的部署选择。
 */

import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

describe('定时任务触发提示', () => {
  /** 起一个渠道，等它开出第一个会话，并返回事件发射器。 */
  async function boot(overrides: Parameters<typeof mountChannel>[0] = {}) {
    const harness = await mountChannel(overrides)
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const emit = (type: string, data: unknown) => harness.ctx.emit('session/event', session, { type, data })
    return { harness, emit }
  }

  it('触发时点名任务和规则', async () => {
    const { harness, emit } = await boot()
    emit('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: { id: 's1', kind: 'every', prompt: '检查补漏四段进度', everySeconds: 1800 },
    })
    // 真实宿主会在 dispatch 里带上记录；这里故意只给 id，验证桥接器从登记表
    // 里补出名字和规则——旧事件、老版本都只有这么多信息。
    emit('schedule/change', { version: 1, operation: 'dispatch', id: 's1' })

    await vi.waitFor(() => {
      expect(harness.fake.sent.some(entry => {
        const markdown = (entry.input as { markdown?: string }).markdown ?? ''
        return markdown.includes('定时任务「检查补漏四段进度」') && markdown.includes('每 30 分钟')
      })).toBe(true)
    }, { timeout: 10_000, interval: 50 })
    await harness.dispose()
  })

  it('配置关掉后一声不出', async () => {
    const { harness, emit } = await boot({ notifyOnScheduleDispatch: false })
    emit('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: { id: 's1', kind: 'every', prompt: '检查补漏四段进度', everySeconds: 1800 },
    })
    const before = harness.fake.sent.length
    emit('schedule/change', { version: 1, operation: 'dispatch', id: 's1' })
    // 给事件处理留出跑完的时间，再断言「什么都没发」。
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(harness.fake.sent.slice(before).some(entry => {
      const markdown = (entry.input as { markdown?: string }).markdown ?? ''
      return markdown.includes('定时任务「检查补漏四段进度」')
    })).toBe(false)
    await harness.dispose()
  })
})
