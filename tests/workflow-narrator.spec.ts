import { describe, expect, it, vi } from 'vitest'
import { createWorkflowNarrator } from '../src/workflow-narrator.ts'

/** A port that records what would reach the chat. */
function fakePort() {
  const sent: { chatId: string; markdown: string }[] = []
  return {
    sent,
    async send(chatId: string, input: { markdown: string }) {
      sent.push({ chatId, markdown: input.markdown })
      return { messageId: `om_${sent.length}` }
    },
  }
}

/** Everything one window of a fan-out looks like on the wire. */
function startMany(narrator: ReturnType<typeof createWorkflowNarrator>, count: number, chatId = 'oc_1'): void {
  for (let seq = 1; seq <= count; seq += 1) {
    narrator.agentStart({ runId: 'r1', seq, label: `chunk-${String(seq).padStart(2, '0')}.txt` }, chatId)
  }
}

describe('workflow narrator', () => {
  it('announces the run at once and folds its members into one line', async () => {
    const port = fakePort()
    const narrator = createWorkflowNarrator(port, { coalesceMs: 20 })
    narrator.runStart({ runId: 'r1', name: '扫描' }, 'oc_1')
    startMany(narrator, 8)
    await vi.waitFor(() => { expect(port.sent).toHaveLength(2) })
    expect(port.sent[0]!.markdown).toContain('扫描')
    // Eight member events, one line — the whole point.
    expect(port.sent[1]!.markdown).toContain('启动 8 个')
    narrator.dispose()
  })

  it('caps the label preview instead of printing every member', async () => {
    const port = fakePort()
    const narrator = createWorkflowNarrator(port, { coalesceMs: 10, maxLabels: 3 })
    startMany(narrator, 12)
    await vi.waitFor(() => { expect(port.sent).toHaveLength(1) })
    expect(port.sent[0]!.markdown).toContain('等 12 个')
    expect(port.sent[0]!.markdown).not.toContain('chunk-12')
    narrator.dispose()
  })

  it('reports settlements as counts, not one line each', async () => {
    const port = fakePort()
    const narrator = createWorkflowNarrator(port, { coalesceMs: 10 })
    startMany(narrator, 4)
    // Let the start window close first: settlements are a later window, and the
    // point of this test is that four of them become one line, not eight.
    await vi.waitFor(() => { expect(port.sent).toHaveLength(1) })
    for (let seq = 1; seq <= 4; seq += 1) {
      narrator.agentEnd({ runId: 'r1', seq, outcome: seq === 4 ? 'failed' : 'completed' }, 'oc_1')
    }
    await vi.waitFor(() => { expect(port.sent).toHaveLength(2) })
    expect(port.sent[1]!.markdown).toContain('✅ 3')
    expect(port.sent[1]!.markdown).toContain('❌ 1')
    narrator.dispose()
  })

  it('closes a fast run as exactly two messages', async () => {
    const port = fakePort()
    const narrator = createWorkflowNarrator(port, { coalesceMs: 5_000 })
    narrator.runStart({ runId: 'r1', name: '扫描' }, 'oc_1')
    startMany(narrator, 8)
    for (let seq = 1; seq <= 8; seq += 1) {
      narrator.agentEnd({ runId: 'r1', seq, outcome: 'completed' }, 'oc_1')
    }
    // The run ends before the window elapses: the pending counts fold into the
    // summary, and nothing arrives afterwards.
    narrator.runEnd({ runId: 'r1', stopReason: 'completed' }, 'oc_1')
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    expect(port.sent).toHaveLength(2)
    expect(port.sent[1]!.markdown).toContain('全部完成')
    expect(port.sent[1]!.markdown).toContain('启动 8')
    expect(port.sent[1]!.markdown).toContain('✅ 8')
    narrator.dispose()
  })

  it('keeps two concurrent runs apart', async () => {
    const port = fakePort()
    const narrator = createWorkflowNarrator(port, { coalesceMs: 10 })
    narrator.runStart({ runId: 'r1', name: '甲' }, 'oc_1')
    narrator.runStart({ runId: 'r2', name: '乙' }, 'oc_2')
    narrator.agentStart({ runId: 'r1', seq: 1, label: 'a' }, 'oc_1')
    narrator.agentStart({ runId: 'r2', seq: 1, label: 'b' }, 'oc_2')
    await vi.waitFor(() => { expect(port.sent).toHaveLength(4) })
    expect(port.sent.filter(m => m.chatId === 'oc_1')).toHaveLength(2)
    expect(port.sent.filter(m => m.chatId === 'oc_2')).toHaveLength(2)
    narrator.dispose()
  })

  it('ignores a re-delivered run-start so counters do not restart', async () => {
    const port = fakePort()
    const narrator = createWorkflowNarrator(port, { coalesceMs: 10 })
    narrator.runStart({ runId: 'r1', name: '扫描' }, 'oc_1')
    startMany(narrator, 3)
    narrator.runStart({ runId: 'r1', name: '扫描' }, 'oc_1')
    await vi.waitFor(() => { expect(port.sent).toHaveLength(2) })
    expect(port.sent.filter(m => m.markdown.includes('工作流「'))).toHaveLength(1)
    narrator.dispose()
  })
})
