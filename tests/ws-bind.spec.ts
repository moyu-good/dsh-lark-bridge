/**
 * `/ws use <目录>` 把一条会话绑到项目目录，`/new` 之后仍从该目录开始。
 *
 * 端到端那条用例是 2026-10-30 的回归：绑定按会话的**基础 id** 记下，而
 * `/new` 交给创建钩子的是带 `:r<戳><尾>` 的**旋转 id**。查表落空就回落到
 * 部署目录——提示说「已绑定」，新会话却还在老地方，用户看到的现象就是
 * 「绑了等于没绑」。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { baseSessionIdOf, rotatedSessionId } from '../src/session-rotation.ts'
import { fakeMessage, mountChannel } from './harness.ts'

/** 入站处理是 fire-and-forget，等它落定；首次组合要读 preset 名单，给足余量。 */
const PATIENCE = { timeout: 5_000, interval: 20 } as const

describe('旋转 id 反解回基础 id', () => {
  it('是 rotatedSessionId 的逆运算', () => {
    const base = 'feishu-oc_abc123'
    expect(baseSessionIdOf(rotatedSessionId(base, 1_700_000_000_000, 'abcd'))).toBe(base)
  })

  it('没带旋转后缀的 id 原样返回', () => {
    expect(baseSessionIdOf('feishu-oc_abc123')).toBe('feishu-oc_abc123')
    expect(baseSessionIdOf('session-342dd390-ab08-4efa-860c-1174ff291fd8'))
      .toBe('session-342dd390-ab08-4efa-860c-1174ff291fd8')
  })
})

describe('/ws use 的绑定要活过 /new', () => {
  it('旋转出来的会话仍从绑定的目录开始', async () => {
    const project = resolve(mkdtempSync(join(tmpdir(), 'ws-bind-proj-')))
    const harness = await mountChannel()
    try {
      const chatId = 'oc_ws_rotate'
      // 第一条消息按部署目录建出基础会话，再把绑定写下；等回执确认绑定已落盘。
      await harness.fake.emitMessage(fakeMessage({ chatId, content: `/ws use ${project}` }))
      await vi.waitFor(() => {
        const said = harness.fake.sent.map(entry => (entry.input as { markdown?: string }).markdown ?? '')
        if (!said.some(line => line.includes('已绑定'))) throw new Error('绑定回执还没到')
      }, PATIENCE)
      expect(harness.agents.created).toHaveLength(1)

      await harness.fake.emitMessage(fakeMessage({ chatId, content: '/new' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) }, PATIENCE)

      const first = harness.agents.created[0]!
      const rotated = harness.agents.created[1]!
      expect(rotated.sessionId).toContain(':r')
      expect(rotated.meta?.cwd).toBe(project)
      // 绑定查的就是这个基础 id：反解不回去，这条用例就该红。
      expect(baseSessionIdOf(rotated.sessionId)).toBe(first.sessionId)
    } finally {
      await harness.dispose()
    }
  })
})
