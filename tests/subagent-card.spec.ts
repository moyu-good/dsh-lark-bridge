import { describe, expect, it } from 'vitest'
import {
  addEntry,
  clipActivity,
  createTracker,
  deliveryText,
  elapsedText,
  failureText,
  markActivity,
  parseProgress,
  RECENT_MAX,
  render,
  runningEntries,
  settleEntry,
  settleRunningOneShots,
  STALL_MS,
  summaryText,
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
    const card = render(state, 5000) as { header: { title: { content: string } }, elements: { text?: { content: string } }[] }
    const body = cardText(card)
    expect(card.header.title.content).toContain('1 在跑')
    expect(body).toContain('纪四复核')
    expect(body).toContain('进行中')
    expect(body).toContain('5秒')
    expect(body).toContain('跑 自动通关 --era=纪四')
    // 只报有内容的：0 完成不占位。
    expect(body).toContain('1 在跑')
    expect(body).not.toContain('0 完成')
  })

  it('remembers only distinct lines — one streaming sentence is quoted once', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 1)
    markActivity(state, 'c', '正在读文件', 1)
    markActivity(state, 'c', '正在读文件', 2)
    markActivity(state, 'c', '读完了，开始跑测试', 3)
    expect(state.entries.get('c')?.recent).toEqual(['正在读文件', '读完了，开始跑测试'])
  })

  it('caps remembered lines so a long child cannot blow up the block', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 1)
    for (let i = 0; i < RECENT_MAX + 4; i += 1) markActivity(state, 'c', `第 ${i} 步`, i)
    expect(state.entries.get('c')?.recent).toHaveLength(RECENT_MAX)
    expect(state.entries.get('c')?.recent.at(-1)).toBe(`第 ${RECENT_MAX + 3} 步`)
  })

  it('delivery block names the child, counts its actions and quotes its last lines', () => {
    const state = createTracker()
    addEntry(state, 'c1', { mode: 'one-shot', label: '纪四复核' }, 0)
    for (let i = 0; i < 5; i += 1) markActivity(state, 'c1', `第 ${i} 步`, i)
    settleEntry(state, 'c1', 'completed', 60_000)
    const text = deliveryText(state.entries.get('c1')!, 60_000)
    expect(text).toContain('【子代理完成】纪四复核')
    // 工具调用和发言分开数：合成一个「N 条动作」读不出工作量的区别。
    expect(text).toContain('已做 5 步')
    expect(text).toContain('1分')
    expect(text).toContain('↳ 第 4 步')
    expect(text).not.toContain('↳ 第 1 步')   // only the tail is quoted
    expect(text.split('\n')).toHaveLength(4)  // head + 3 lines, never a dump
  })

  it('delivery block still identifies a child that produced nothing', () => {
    const state = createTracker()
    addEntry(state, 'c2', { mode: 'one-shot', label: '空跑' }, 0)
    settleEntry(state, 'c2', 'aborted', 1000)
    // 没干活就不写「0 步」，别让空跑的行看起来像报过错。
    expect(deliveryText(state.entries.get('c2')!, 1000)).toBe('⏹️【子代理已中止】空跑 · 1秒')
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

/** 取卡片里所有文本元素拼起来，方便断言顺序和内容。 */
function cardText(card: object): string {
  const elements = (card as { elements: { text?: { content: string } }[] }).elements
  return elements.map(element => element.text?.content ?? '').filter(content => content !== '').join('\n')
}

describe('面板排序：谁需要你看，谁排前面', () => {
  it('失败的排在进行中的前面', () => {
    const state = createTracker()
    addEntry(state, 'run', { mode: 'one-shot', label: '还在跑的' }, 1)
    addEntry(state, 'bad', { mode: 'one-shot', label: '炸了的' }, 2)
    settleEntry(state, 'bad', 'error', 100)
    const body = cardText(render(state, 200))
    expect(body.indexOf('炸了的')).toBeLessThan(body.indexOf('还在跑的'))
  })

  it('进行中的排在完成的上面——原来按加入顺序排，跑完的会压在还在跑的上面', () => {
    const state = createTracker()
    addEntry(state, 'done', { mode: 'one-shot', label: '早就跑完的' }, 1)
    addEntry(state, 'run', { mode: 'one-shot', label: '现在还在跑的' }, 2)
    settleEntry(state, 'done', 'completed', 100)
    const body = cardText(render(state, 200))
    expect(body.indexOf('现在还在跑的')).toBeLessThan(body.indexOf('早就跑完的'))
  })

  it('已结束的收起第二行，进行中的展开', () => {
    const state = createTracker()
    addEntry(state, 'run', { mode: 'one-shot', label: '在跑的' }, 1)
    markActivity(state, 'run', '正在读第三十个文件', 50)
    addEntry(state, 'done', { mode: 'one-shot', label: '跑完的' }, 1)
    markActivity(state, 'done', '这是跑完那条的旧动作', 50)
    settleEntry(state, 'done', 'completed', 100)
    const body = cardText(render(state, 200))
    expect(body).toContain('正在读第三十个文件')
    expect(body).not.toContain('这是跑完那条的旧动作')
  })

  it('已结束超过三条就折叠，并说明还有几个', () => {
    const state = createTracker()
    for (let i = 0; i < 6; i += 1) {
      addEntry(state, `d${i}`, { mode: 'one-shot', label: `完成 ${i}` }, i)
      settleEntry(state, `d${i}`, 'completed', 100 + i)
    }
    const body = cardText(render(state, 500))
    expect(body).toContain('另有 3 个已结束的子代理未列出')
    expect(body).toContain('完成 5')
    expect(body).not.toContain('完成 0')
  })
})

describe('失败必须说清为什么', () => {
  it('失败行带上错误原文', () => {
    const state = createTracker()
    addEntry(state, 'bad', { mode: 'one-shot', label: '接口文档整理' }, 1)
    settleEntry(state, 'bad', 'error', 100, '语法错误：openapi.json 第 47 行缺少逗号')
    const body = cardText(render(state, 200))
    expect(body).toContain('语法错误：openapi.json 第 47 行缺少逗号')
  })

  it('没有原文时退回 stopReason，而不是只标一个叉', () => {
    const state = createTracker()
    addEntry(state, 'bad', { mode: 'one-shot', label: 'x' }, 1)
    settleEntry(state, 'bad', 'max-tokens', 100)
    expect(cardText(render(state, 200))).toContain('max-tokens')
  })

  it('从结束事件里捞最后一条助手消息作失败原因', () => {
    expect(failureText({ stopReason: 'error', lastAssistantMessage: [{ type: 'text', text: '连不上数据库' }] }))
      .toBe('连不上数据库')
  })

  it('结束事件没有助手消息时返回空串', () => {
    expect(failureText({ stopReason: 'error' })).toBe('')
    expect(failureText({ stopReason: 'error', lastAssistantMessage: [] })).toBe('')
  })

  it('失败项的失败行不会被折叠掉', () => {
    const state = createTracker()
    addEntry(state, 'bad', { mode: 'one-shot', label: '炸的' }, 1)
    settleEntry(state, 'bad', 'error', 100, '磁盘写满了')
    // 再塞六个成功的，把失败项挤出「最近三条」的常规视野。
    for (let i = 0; i < 6; i += 1) {
      addEntry(state, `ok${i}`, { mode: 'one-shot', label: `成功 ${i}` }, i)
      settleEntry(state, `ok${i}`, 'completed', 200 + i)
    }
    expect(cardText(render(state, 500))).toContain('磁盘写满了')
  })

  it('统计里失败和完成分开报', () => {
    const state = createTracker()
    addEntry(state, 'a', { mode: 'one-shot', label: 'a' }, 1)
    settleEntry(state, 'a', 'completed', 10)
    addEntry(state, 'b', { mode: 'one-shot', label: 'b' }, 1)
    settleEntry(state, 'b', 'error', 10)
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 1)
    expect(summaryText(state)).toBe('1 完成 · 1 失败 · 1 在跑')
  })
})

describe('进度与卡死', () => {
  it('从子代理的话里认出 8/23 这样的进度', () => {
    expect(parseProgress('正在抓取，已处理 8/23 区')).toEqual({ done: 8, total: 23 })
    expect(parseProgress('完成 3 / 7 项')).toEqual({ done: 3, total: 7 })
  })

  it('不把日期、版本号、URL 当进度', () => {
    expect(parseProgress('2026/11/04 的报表')).toBeUndefined()
    expect(parseProgress('升级到 v1/2')).toBeUndefined()
    expect(parseProgress('取 5/2 的平均')).toBeUndefined()
    expect(parseProgress('已完成 1/1')).toBeUndefined()
  })

  it('进度只增不减，换个话题说别的数字不会把进度抹掉', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 0)
    markActivity(state, 'c', '已处理 8/23 区', 10)
    markActivity(state, 'c', '接下来换个角度', 20)
    expect(state.entries.get('c')?.progress).toEqual({ done: 8, total: 23 })
  })

  it('有进度时画进度条代替纯时长', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 0)
    markActivity(state, 'c', '已处理 8/23 区', 100)
    const body = cardText(render(state, 200))
    expect(body).toContain('▓▓░░░ 8/23')
  })

  it('长时间没动静标黄并写明多久', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 0)
    markActivity(state, 'c', '正在跑测试', 1_000)
    const body = cardText(render(state, 1_000 + STALL_MS + 60_000))
    expect(body).toContain('🟡')
    expect(body).toContain('无新动静')
  })

  it('刚安静一会儿只说「最近动作 N 前」，不报警', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 0)
    markActivity(state, 'c', '正在跑测试', 1_000)
    const body = cardText(render(state, 1_000 + 45_000))
    expect(body).not.toContain('🟡')
    expect(body).toContain('最近动作 45秒前')
  })

  it('卡住时标题报警并转黄，但不冒充失败', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 0)
    markActivity(state, 'c', '正在跑测试', 1_000)
    const card = render(state, 1_000 + STALL_MS + 1_000) as {
      header: { template: string, title: { content: string } }
    }
    expect(card.header.title.content).toContain('1 疑似卡住')
    // 黄不是红：它还在跑，只是没动静，跟真出错不该同色。
    expect(card.header.template).toBe('orange')
  })

  it('真失败时标题转红，优先级高于卡住', () => {
    const state = createTracker()
    addEntry(state, 'stuck', { mode: 'one-shot', label: 'stuck' }, 0)
    markActivity(state, 'stuck', '卡着呢', 1_000)
    addEntry(state, 'bad', { mode: 'one-shot', label: 'bad' }, 0)
    settleEntry(state, 'bad', 'error', 2_000)
    const card = render(state, 1_000 + STALL_MS + 1_000) as { header: { template: string } }
    expect(card.header.template).toBe('red')
  })

  it('一个子代理干了多少活看得出来', () => {
    const state = createTracker()
    addEntry(state, 'c', { mode: 'one-shot', label: 'c' }, 0)
    for (let i = 0; i < 42; i += 1) markActivity(state, 'c', `第 ${i} 步`, i, 'tool')
    for (let i = 0; i < 3; i += 1) markActivity(state, 'c', `第 ${i} 段结论`, i, 'message')
    expect(cardText(render(state, 100))).toContain('已做 42 步 · 3 段发言')
  })
})
