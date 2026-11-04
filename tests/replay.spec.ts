import { describe, expect, it, vi } from 'vitest'
import { createReplayPort, isUndeliveredId } from '../src/replay.ts'
import type { ReplayPort } from '../src/replay.ts'
import type { SendResult } from '@larksuite/channel'

/** A fake transport recording outbound calls, with a switch to fail sends. */
function fakePort() {
  const sent: { to: string; input: { markdown?: string }; opts?: object }[] = []
  const updated: { messageId: string; card: object }[] = []
  let fail = false
  const port = {
    sent,
    updated,
    failSends() { fail = true },
    restoreSends() { fail = false },
    async send(to: string, input: { markdown?: string }, opts?: object): Promise<SendResult> {
      if (fail) throw new Error('connection down')
      sent.push({ to, input, opts })
      return { messageId: `om_${sent.length}` }
    },
    async stream(to: string, input: { markdown: () => Promise<void> }) {
      if (fail) throw new Error('connection down')
      sent.push({ to, input })
      return { messageId: `om_${sent.length}` }
    },
    async updateCard(messageId: string, card: object) {
      if (fail) throw new Error('connection down')
      updated.push({ messageId, card })
    },
    async connect() {},
    async disconnect() {},
    on() { return () => {} },
  } as unknown as ReplayPort
  return port
}

describe('replay port', () => {
  it('passes sends through while connected', async () => {
    const inner = fakePort()
    const port = createReplayPort(inner, () => {}, () => {})
    await port.send('oc_1', { markdown: 'hi' })
    expect(inner.sent).toHaveLength(1)
    expect(port.pending()).toBe(0)
  })

  it('queues outbound while disconnected and flushes on reconnect', async () => {
    const inner = fakePort()
    const port = createReplayPort(inner, () => {}, () => {})
    port.setConnected(false)
    await port.send('oc_1', { markdown: 'first' })
    await port.send('oc_1', { markdown: 'second' })
    expect(inner.sent).toHaveLength(0)
    expect(port.pending()).toBe(2)
    port.setConnected(true)
    await vi.waitFor(() => { expect(inner.sent).toHaveLength(2) })
    expect(inner.sent.map(s => (s.input as { markdown?: string }).markdown)).toEqual(['first', 'second'])
    expect(port.pending()).toBe(0)
  })

  it('queues a failed send and replays it once live again', async () => {
    const inner = fakePort()
    const raw = inner as unknown as { sent: { to: string; input: { markdown?: string }; opts?: object }[]; failSends(): void; restoreSends(): void }
    const port = createReplayPort(inner, () => {}, () => {})
    // Connection drops AFTER the wrapper thinks it is live: a send fails and
    // must be queued rather than lost.
    raw.failSends()
    await port.send('oc_1', { markdown: 'lost' })
    expect(raw.sent).toHaveLength(0)
    expect(port.pending()).toBe(1)
    // Restore delivery and reconnect; the queued call flushes.
    raw.restoreSends()
    port.setConnected(false)
    port.setConnected(true)
    await vi.waitFor(() => { expect(raw.sent).toHaveLength(1) })
    expect((raw.sent[0]!.input as { markdown?: string }).markdown).toBe('lost')
    expect(port.pending()).toBe(0)
  })

  it('queues updateCard while disconnected', async () => {
    const inner = fakePort()
    const port = createReplayPort(inner, () => {}, () => {})
    port.setConnected(false)
    await port.updateCard('om_1', { header: {} })
    expect(inner.updated).toHaveLength(0)
    port.setConnected(true)
    await vi.waitFor(() => { expect(inner.updated).toHaveLength(1) })
    expect(inner.updated[0]!.messageId).toBe('om_1')
  })

  it('reports a flush failure and keeps the call queued', async () => {
    const inner = fakePort()
    const failures: unknown[] = []
    const port = createReplayPort(inner, (error) => { failures.push(error) }, () => {})
    port.setConnected(false)
    await port.send('oc_1', { markdown: 'sticky' })
    inner.failSends()
    port.setConnected(true)
    await vi.waitFor(() => { expect(failures.length).toBeGreaterThan(0) })
    // Still queued for the next live window.
    expect(port.pending()).toBe(1)
  })

  it('keeps prototype methods callable when wrapping a class instance', async () => {
    // LarkChannel is a class: methods live on the prototype, so a plain
    // `{ ...port }` spread yields NO connect/send/on. The wrapper must bind
    // them, or the bridge calls undefined and dies on the first connection.
    class ClassPort {
      calls: string[] = []
      connect() { this.calls.push('connect'); return Promise.resolve() }
      disconnect() { this.calls.push('disconnect'); return Promise.resolve() }
      on() { return () => {} }
      async send() { return { messageId: 'om_class' } }
      async stream() { return { messageId: 'om_class' } }
      async updateCard() {}
      // 引用卡片要用它读原始 JSON：和 send/on 一样长在原型上，
      // wrapper 不绑过去的话，引用卡片会静默退回占位词。
      async fetchRawMessage(messageId: string) {
        this.calls.push(`raw:${messageId}`)
        return [{ message_id: messageId }]
      }
    }
    const inner = new ClassPort() as unknown as ReplayPort
    const port = createReplayPort(inner, () => {}, () => {})
    // Prototype methods must survive the wrapper, bound to the instance.
    expect(typeof port.connect).toBe('function')
    expect(typeof port.send).toBe('function')
    expect(typeof port.on).toBe('function')
    await port.connect()
    await port.disconnect()
    expect((inner as unknown as { calls: string[] }).calls).toEqual(['connect', 'disconnect'])
    await port.send('oc_1', { markdown: 'hi' })
    expect(port.pending()).toBe(0)
    const raw = await port.fetchRawMessage!('om_raw_1')
    expect(raw[0]?.message_id).toBe('om_raw_1')
    expect((inner as unknown as { calls: string[] }).calls).toContain('raw:om_raw_1')
  })
})

// A queued send has no Feishu message, but the caller caches the returned id
// and later edits that message. The old wrapper returned `queued-<n>`, which
// Feishu rejects as an invalid id (99992354) — and that failure aborted a
// session log write, costing a chat its persisted history.
describe('undelivered placeholders', () => {
  it('never returns an id that looks like a real message', async () => {
    const inner = fakePort()
    const port = createReplayPort(inner, () => {}, () => {})
    port.setConnected(false)
    const first = await port.send('oc_1', { markdown: 'a' })
    const second = await port.send('oc_1', { markdown: 'b' })
    expect(isUndeliveredId(first.messageId)).toBe(true)
    expect(isUndeliveredId(second.messageId)).toBe(true)
    // Distinct, so a drain that shrinks the queue cannot collide two callers.
    expect(first.messageId).not.toBe(second.messageId)
    expect(first.messageId).not.toMatch(/^om_/)
  })

  it('refuses to push a placeholder id to updateCard', async () => {
    const inner = fakePort()
    const lines: string[] = []
    const port = createReplayPort(inner, () => {}, (line) => { lines.push(line) })
    port.setConnected(false)
    const sent = await port.send('oc_1', { markdown: 'a' })
    // The caller cached the placeholder and edits "its" card while down.
    await port.updateCard(sent.messageId, { header: {} })
    // Reconnecting must not replay that edit: the message never existed.
    port.setConnected(true)
    await vi.waitFor(() => { expect(inner.sent).toHaveLength(1) })
    expect(inner.updated).toHaveLength(0)
    expect(lines.some(line => line.includes('undelivered id'))).toBe(true)
  })

  it('reports the real id once a queued send is delivered', async () => {
    const inner = fakePort()
    const port = createReplayPort(inner, () => {}, () => {})
    port.setConnected(false)
    const sent = await port.send('oc_1', { markdown: 'a' })
    let realId: string | undefined
    port.whenDelivered(sent.messageId, (id) => { realId = id })
    port.setConnected(true)
    await vi.waitFor(() => { expect(realId).toBeDefined() })
    expect(isUndeliveredId(realId)).toBe(false)
    expect(realId).toBe('om_1')
  })

  it('ignores whenDelivered for an id that was already live', async () => {
    const inner = fakePort()
    const port = createReplayPort(inner, () => {}, () => {})
    const sent = await port.send('oc_1', { markdown: 'a' })
    let called = false
    port.whenDelivered(sent.messageId, () => { called = true })
    port.setConnected(false)
    port.setConnected(true)
    await vi.waitFor(() => { expect(port.pending()).toBe(0) })
    expect(called).toBe(false)
  })
})
