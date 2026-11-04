/**
 * 外勤会话镜像：不属于任何群的会话，动静推给谁。
 *
 * 2026-11-04 的现场：`D:\Desktop` 下有个子代理会话（父会话在网页端，桥收不到
 * `subagent/catalog`，所以没被认成子代理），于是每个飞书群都收到一串
 *
 *   ⚙️ [会话 21ffe969] T1 进行中
 *
 * 一个群都没派过它，人人挨一发；内容和「T1」「21ffe969」这种内部叫法也
 * 看不出是在说什么。
 *
 * 修法有两层，这个文件两层都盯：
 *   1. 不再向所有群广播——只在显式配置了接收群时推，默认 ''（关）。
 *   2. 推送用能读懂的话，不是哈希和轮次号。
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/** 挂起一个绑定着会话的聊天，返回那个聊天的 chatId 和会话对象。 */
async function boundChat(harness: Awaited<ReturnType<typeof mountChannel>>) {
  await harness.fake.emitMessage(fakeMessage({ content: 'bind me' }))
  await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
  return harness.agents.created[0]!.agent.session
}

describe('外勤会话镜像', () => {
  it('默认不发进度：不属于任何群的会话不往群里推进度', async () => {
    const harness = await mountChannel()
    try {
      await boundChat(harness)
      const before = harness.fake.sent.length
      // 一个完全没有绑定的会话在动，就像 D:\Desktop 下那个子代理。
      harness.ctx.emit('session/event', { id: 'stray-session' }, {
        type: 'step/start',
        data: { turn: 1, step: 1 },
      })
      // 给异步推送留出窗口，再确认没有进度播报。
      await new Promise(resolve => setTimeout(resolve, 200))
      const after = harness.fake.sent.slice(before)
      expect(after.map(m => JSON.stringify(m.input))).not.toContain('轮')
      expect(after.map(m => JSON.stringify(m.input))).not.toContain('stray-session')
    } finally {
      await harness.dispose()
    }
  })

  it('交付文件照样通知，但只发一个群', async () => {
    // 进度可以关，交付文件不能关：文件是实体，沉默会让人以为没这回事。
    // 但它同样不该向所有群广播。
    const harness = await mountChannel()
    try {
      await boundChat(harness)
      const before = harness.fake.sent.length
      harness.ctx.emit('session/event', { id: 'stray-session' }, {
        type: 'deliverables/presented',
        data: { turn: 2, callId: 'call-x', files: [{ path: 'D:\\tmp\\report.html', description: '产物' }] },
      })
      await vi.waitFor(() => {
        expect(harness.fake.sent.length).toBeGreaterThan(before)
      }, { timeout: 5_000, interval: 20 })
      const pushed = harness.fake.sent.slice(before)
      // 只发一个群，不是每个绑定的群各发一份。
      expect(pushed).toHaveLength(1)
      expect(JSON.stringify(pushed[0]!.input)).toContain('交付文件')
    } finally {
      await harness.dispose()
    }
  })

  it('配了接收群就只推那一个群，且说人话', async () => {
    const watcher = 'oc_watcher'
    const harness = await mountChannel({ externalMirrorChatId: watcher })
    try {
      await boundChat(harness)
      const before = harness.fake.sent.length
      harness.ctx.emit('session/event', { id: 'stray-session' }, {
        type: 'step/start',
        data: { turn: 1, step: 1 },
      })
      await vi.waitFor(() => {
        expect(harness.fake.sent.length).toBeGreaterThan(before)
      }, { timeout: 5_000, interval: 20 })
      const pushed = harness.fake.sent.slice(before)
      // 只推给配置的那一个群，其余群一条都没有。
      expect(pushed.every(m => m.to === watcher)).toBe(true)
      const text = JSON.stringify(pushed[0]!.input)
      // 「T1」「会话 21ffe969」这种内部叫法不该出现在给人看的话里。
      expect(text).not.toContain('T1')
      expect(text).not.toContain('stray-session')
      expect(text).toContain('第 1 轮开始')
    } finally {
      await harness.dispose()
    }
  })

  it('同一会话 60 秒内只推一次，不刷屏', async () => {
    const watcher = 'oc_watcher'
    const harness = await mountChannel({ externalMirrorChatId: watcher })
    try {
      await boundChat(harness)
      const before = harness.fake.sent.length
      // 同一会话连发三次 step/start，节流窗口内只该出一条。
      for (let i = 0; i < 3; i++) {
        harness.ctx.emit('session/event', { id: 'stray-session' }, {
          type: 'step/start',
          data: { turn: 1, step: i + 1 },
        })
      }
      await vi.waitFor(() => {
        expect(harness.fake.sent.length).toBeGreaterThan(before)
      }, { timeout: 5_000, interval: 20 })
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(harness.fake.sent.slice(before)).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})
