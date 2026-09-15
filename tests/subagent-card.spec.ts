import { describe, expect, it } from 'vitest'
import {
  addEntry,
  clipActivity,
  createTracker,
  elapsedText,
  markActivity,
  render,
  runningEntries,
  settleEntry,
  settleRunningOneShots,
  ACTIVITY_MAX,
} from '../src/subagent-card.ts'
import { isSubagentCatalogEvent, isSubagentDescriptorEvent, type HostSessionEvent } from '../src/host.ts'

/** Minimal catalog event, shaped like the payload `establishCatalogChild` appends. */
function catalogEvent(childId: string, label: string, mode: 'one-shot' | 'continuable' = 'one-shot'): HostSessionEvent {
  return {
    type: 'subagent/catalog',
    seq: 1,
    time: 1,
    data: { version: 0, childId, childCreatedAt: 1, mode, label },
  } as unknown as HostSessionEvent
}

describe('subagent catalog is the reachable child record', () => {
  // 0.1.5 appends `subagent/descriptor` inside the CHILD's session, so a
  // parent-session subscriber (this bridge) only ever learns about children
  // through `subagent/catalog`. Wiring the panel to the descriptor is exactly
  // the silent drift that made「多代理执行面板」invisible while typecheck,
  // lint and every gate stayed green.
  it('narrows a catalog event and reads the child id out of it', () => {
    const event = catalogEvent('child-1', '日本选址产品数据测绘')
    expect(isSubagentCatalogEvent(event)).toBe(true)
    if (isSubagentCatalogEvent(event)) {
      expect(event.data.childId).toBe('child-1')
      expect(event.data.label).toBe('日本选址产品数据测绘')
      expect(event.data.mode).toBe('one-shot')
    }
  })

  it('does not confuse the two subagent events', () => {
    const event = catalogEvent('child-1', 'x')
    expect(isSubagentCatalogEvent(event)).toBe(true)
    expect(isSubagentDescriptorEvent(event)).toBe(false)
  })
})

describe('multi-agent panel rows', () => {
  it('is idempotent per child id — a replayed catalog must not add a row', () => {
    const state = createTracker()
    addEntry(state, 'child-1', { mode: 'one-shot', label: '纪四' }, 1000)
    addEntry(state, 'child-1', { mode: 'one-shot', label: '纪四' }, 2000)
    expect(state.entries.size).toBe(1)
    expect(state.entries.get('child-1')?.startedAt).toBe(1000)
  })

  it('keeps one row per distinct child', () => {
    const state = createTracker()
    addEntry(state, 'child-1', { mode: 'one-shot', label: '纪四' }, 1)
    addEntry(state, 'child-2', { mode: 'continuable', label: '可续调研' }, 1)
    expect(state.entries.size).toBe(2)
    expect(runningEntries(state)).toHaveLength(2)
  })

  it('labels an unnamed child by position instead of leaving it blank', () => {
    const state = createTracker()
    expect(addEntry(state, 'child-9', { mode: 'one-shot' }, 1).label).toContain('子代理')
  })

  it('records the child\'s latest activity, collapsed to one line', () => {
    const state = createTracker()
    addEntry(state, 'child-1', { mode: 'one-shot', label: '纪四' }, 1)
    const entry = markActivity(state, 'child-1', '读 内容/storylets/v1/纪四_E4-047.yaml\n\n  （正在核对 when）', 5000)
    expect(entry?.lastActivity).toBe('读 内容/storylets/v1/纪四_E4-047.yaml （正在核对 when）')
    expect(entry?.chunks).toBe(1)
    expect(entry?.lastAt).toBe(5000)
  })

  it('clips long activity so the card stays one line', () => {
    expect(clipActivity('x'.repeat(200)).length).toBe(ACTIVITY_MAX)
    expect(clipActivity('x'.repeat(200)).endsWith('…')).toBe(true)
    expect(clipActivity('   ')).toBe('')
  })

  it('ignores activity for an unknown child rather than inventing a row', () => {
    const state = createTracker()
    expect(markActivity(state, 'ghost', 'hello', 1)).toBeUndefined()
    expect(state.entries.size).toBe(0)
  })

  it('keeps the previous label when an activity sample is blank', () => {
    const state = createTracker()
    addEntry(state, 'child-1', { mode: 'one-shot', label: '纪四' }, 1)
    markActivity(state, 'child-1', '第一步', 10)
    markActivity(state, 'child-1', '   ', 20)
    expect(state.entries.get('child-1')?.lastActivity).toBe('第一步')
    expect(state.entries.get('child-1')?.chunks).toBe(2)
  })

  it('settles a row per stop reason', () => {
    const state = createTracker()
    addEntry(state, 'a', { mode: 'one-shot', label: 'a' }, 1)
    addEntry(state, 'b', { mode: 'one-shot', label: 'b' }, 1)
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 1)
    addEntry(state, 'd', { mode: 'one-shot', label: 'd' }, 1)
    settleEntry(state, 'a', 'completed', 100)
    settleEntry(state, 'b', 'aborted', 100)
    settleEntry(state, 'c', 'max-tokens', 100)
    settleEntry(state, 'd', 'weird', 100)
    expect(state.entries.get('a')?.status).toBe('completed')
    expect(state.entries.get('b')?.status).toBe('aborted')
    expect(state.entries.get('c')?.status).toBe('max-tokens')
    expect(state.entries.get('d')?.status).toBe('error')
    expect(state.entries.get('a')?.endedAt).toBe(100)
  })

  it('closes one-shot children at turn end but leaves continuable ones running', () => {
    const state = createTracker()
    addEntry(state, 'one', { mode: 'one-shot', label: 'one' }, 1)
    addEntry(state, 'cont', { mode: 'continuable', label: 'cont' }, 1)
    expect(settleRunningOneShots(state, 777)).toBe(1)
    expect(state.entries.get('one')?.status).toBe('completed')
    expect(state.entries.get('one')?.endedAt).toBe(777)
    expect(state.entries.get('cont')?.status).toBe('running')
  })

  it('renders label, status, elapsed and last activity in one card', () => {
    const state = createTracker()
    addEntry(state, 'child-1', { mode: 'one-shot', label: '纪四复核' }, 0)
    markActivity(state, 'child-1', '跑 自动通关 --era=纪四', 1000)
    const card = render(state, 5000) as { header: { title: { content: string } }, elements: { text: { content: string } }[] }
    const body = card.elements[0]!.text.content
    expect(card.header.title.content).toContain('1 进行中')
    expect(body).toContain('纪四复核')
    expect(body).toContain('进行中')
    expect(body).toContain('5秒')
    expect(body).toContain('跑 自动通关 --era=纪四')
    expect(body).toContain('0 结束 / 1 进行中')
  })

  it('renders an empty panel without a runner count', () => {
    const card = render(createTracker(), 0) as { elements: { text: { content: string } }[] }
    expect(card.elements[0]!.text.content).toBe('（无子任务）')
  })

  it('formats elapsed for seconds, minutes and hours', () => {
    expect(elapsedText(0, 12_000)).toBe('12秒')
    expect(elapsedText(0, 80_000)).toBe('1分20秒')
    expect(elapsedText(0, 120_000)).toBe('2分')
    expect(elapsedText(0, 3_600_000)).toBe('1小时0分')
  })
})
