import { describe, expect, it, vi } from 'vitest'
import { createReplayPort } from '../src/replay.ts'
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
})
