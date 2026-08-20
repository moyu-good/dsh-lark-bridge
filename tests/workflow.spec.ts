import { describe, expect, it } from 'vitest'
import {
  agentEndLine,
  agentStartLine,
  phaseLine,
  runEndLine,
  runStartLine,
  workflowLogLine,
} from '../src/workflow.ts'

describe('workflow progress lines', () => {
  it('opens a run with its display name', () => {
    expect(runStartLine({ runId: 'r1', name: '调研' })).toContain('工作流')
    expect(runStartLine({ runId: 'r1', name: '调研' })).toContain('调研')
  })

  it('labels a starting member', () => {
    expect(agentStartLine({ runId: 'r1', seq: 1, label: '爬虫' })).toContain('爬虫')
  })

  it('marks each settlement outcome', () => {
    expect(agentEndLine({ runId: 'r1', seq: 1, outcome: 'completed' })).toContain('✅')
    expect(agentEndLine({ runId: 'r1', seq: 2, outcome: 'failed' })).toContain('❌')
    expect(agentEndLine({ runId: 'r1', seq: 3, outcome: 'cancelled' })).toContain('⏹️')
  })

  it('closes a run with the terminal reason', () => {
    expect(runEndLine({ runId: 'r1', stopReason: 'completed' })).toContain('全部完成')
    expect(runEndLine({ runId: 'r1', stopReason: 'cancelled' })).toContain('已取消')
    expect(runEndLine({ runId: 'r1', stopReason: 'error' })).toContain('出错终止')
  })

  it('renders a phase-change line', () => {
    expect(phaseLine('爬取数据')).toContain('阶段')
    expect(phaseLine('爬取数据')).toContain('爬取数据')
  })

  it('renders a narration line', () => {
    expect(workflowLogLine('正在抓取 100 页')).toContain('正在抓取 100 页')
  })
})
