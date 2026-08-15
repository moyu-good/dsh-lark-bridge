import { describe, expect, it } from 'vitest'
import {
  retryLine,
  scheduleLine,
  subagentLine,
  webSearchLine,
} from '../src/notices.ts'

describe('notice lines', () => {
  it('labels a subagent child', () => {
    expect(subagentLine({ mode: 'one-shot', label: '爬虫' })).toContain('子任务')
    expect(subagentLine({ mode: 'one-shot', label: '爬虫' })).toContain('爬虫')
  })

  it('labels a continuable child', () => {
    expect(subagentLine({ mode: 'continuable', label: '调研' })).toContain('可续')
  })

  it('renders schedule creation with kind and prompt', () => {
    const line = scheduleLine({ operation: 'create', kind: 'every', prompt: '每天早上发简报' })
    expect(line).toContain('周期')
    expect(line).toContain('每天早上发简报')
  })

  it('renders schedule deletion and stays silent on dispatch', () => {
    expect(scheduleLine({ operation: 'delete' })).toContain('已删除')
    expect(scheduleLine({ operation: 'dispatch' })).toBeUndefined()
  })

  it('announces a web search', () => {
    expect(webSearchLine()).toContain('搜索网络')
  })

  it('announces only the first retry', () => {
    expect(retryLine({ retry: 1, maxRetries: 3 })).toContain('重试')
    expect(retryLine({ retry: 1, maxRetries: 3 })).toContain('最多 3 次')
    expect(retryLine({ retry: 2, maxRetries: 3 })).toBeUndefined()
  })
})
