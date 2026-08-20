import { describe, expect, it } from 'vitest'
import {
  compactionPruneLine,
  compactionSummaryLine,
  jobDoneLine,
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

  it('renders job terminal lines per outcome', () => {
    expect(jobDoneLine({ id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'completed' })).toContain('✅')
    expect(jobDoneLine({ id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'completed' })).toContain('pnpm build')
    expect(jobDoneLine({ id: 'bash-2', kind: 'bash', label: 'watch', status: 'killed' })).toContain('⏹️')
    expect(jobDoneLine({ id: 'subagent-3', kind: 'subagent', label: '调研', status: 'failed', detail: 'exit code: 3' })).toContain('❌')
    expect(jobDoneLine({ id: 'subagent-3', kind: 'subagent', label: '调研', status: 'failed', detail: 'exit code: 3' })).toContain('exit code: 3')
  })

  it('announces only the first retry', () => {
    expect(retryLine({ retry: 1, maxRetries: 3 })).toContain('重试')
    expect(retryLine({ retry: 1, maxRetries: 3 })).toContain('最多 3 次')
    expect(retryLine({ retry: 2, maxRetries: 3 })).toBeUndefined()
  })

  it('renders a compaction summary with its text and released tokens', () => {
    const line = compactionSummaryLine({
      summary: [
        { type: 'text', text: '用户在做飞书桥的 i18n 开发。' },
        { type: 'text', text: '第二轮：修面板描述漂移。' },
        { type: 'reasoning', text: '忽略这行思考。' },
      ],
      shadowedTokenCount: 12345,
    })
    expect(line).toContain('压缩完成')
    expect(line).toContain('12345')
    expect(line).toContain('飞书桥的 i18n 开发')
    expect(line).toContain('面板描述漂移')
    // Reasoning blocks are not user-visible summary text.
    expect(line).not.toContain('忽略这行思考')
  })

  it('renders a compaction summary without text blocks too', () => {
    const line = compactionSummaryLine({ summary: [{ type: 'image' }], shadowedTokenCount: 0 })
    expect(line).toContain('压缩完成')
    expect(line).toContain('0 tokens')
  })

  it('renders a prune with its trimmed message count and released tokens', () => {
    const line = compactionPruneLine({ shadowedSeqs: [1, 2, 3, 4, 5], shadowedTokenCount: 4321 })
    expect(line).toContain('5 条旧消息')
    expect(line).toContain('4321')
  })
})
