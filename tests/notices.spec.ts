import { describe, expect, it } from 'vitest'
import {
  compactionPruneLine,
  compactionSummaryLine,
  jobDoneLine,
  retryLine,
  scheduleLine,
  subagentEndLine,
  subagentLine,
  tokenPressureLine,
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

  it('renders live subagent settlement per stop reason', () => {
    expect(subagentEndLine({ id: 'sub-1', provider: 'dsh', stopReason: 'completed' })).toContain('✅')
    expect(subagentEndLine({ id: 'sub-1', provider: 'dsh', stopReason: 'aborted' })).toContain('⏹️')
    expect(subagentEndLine({ id: 'sub-2', provider: 'dsh', stopReason: 'error' })).toContain('❌')
    expect(subagentEndLine({ id: 'sub-3', provider: 'dsh', stopReason: 'max-tokens' })).toContain('⛔')
    expect(subagentEndLine({ id: 'sub-3', provider: 'dsh', stopReason: 'max-tokens' })).toContain('token 上限')
    expect(subagentEndLine({ id: 'sub-1', provider: 'dsh', stopReason: 'completed' })).toContain('sub-1')
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

  it('carries the job output into the completion notice', () => {
    // The command alone told the reader nothing they did not already know when
    // the job started — the answer is the output.
    const line = jobDoneLine({
      id: 'bash-1',
      kind: 'bash',
      label: 'grep -rn foo',
      status: 'completed',
      output: 'src/a.ts:12: foo\nsrc/b.ts:40: foo\n',
    })
    expect(line).toContain('grep -rn foo')
    expect(line).toContain('src/b.ts:40: foo')
  })

  it('omits the output block when the job produced nothing', () => {
    const bare = jobDoneLine({ id: 'bash-1', kind: 'bash', label: 'noop', status: 'completed' })
    expect(bare).not.toContain('```')
    // Whitespace-only output is the same as none: an empty fence is noise.
    const blank = jobDoneLine({ id: 'bash-1', kind: 'bash', label: 'noop', status: 'completed', output: '\n   \n\n\n' })
    expect(blank).not.toContain('```')
  })

  it('keeps the tail of a long output, not the head', () => {
    // The end of a run is where the answer lands; the head is setup noise.
    const output = 'START-OF-RUN\n' + 'x'.repeat(2000) + '\nANSWER-AT-END'
    const line = jobDoneLine({ id: 'bash-1', kind: 'bash', label: 'job', status: 'completed', output })
    expect(line).toContain('ANSWER-AT-END')
    expect(line).not.toContain('START-OF-RUN')
    expect(line).toContain('省略')
  })

  it('announces only the first retry', () => {
    // Silent while retries are in flight; loud only at the final attempt.
    expect(retryLine({ retry: 1, maxRetries: 3 })).toBeUndefined()
    expect(retryLine({ retry: 2, maxRetries: 3 })).toBeUndefined()
    expect(retryLine({ retry: 3, maxRetries: 3 })).toContain('最后一次重试')
    expect(retryLine({ retry: 3, maxRetries: 3 })).toContain('3/3')
    // Unknown cap stays silent too — we cannot know it is the last one.
    expect(retryLine({ retry: 1 })).toBeUndefined()
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

  it('renders a token-pressure warning with total, surface, and threshold', () => {
    const line = tokenPressureLine({ total: 145_000, surface: 12_300, threshold: 120_000 })
    expect(line).toContain('145,000')
    expect(line).toContain('12,300')
    expect(line).toContain('120,000')
    expect(line).toContain('/compact')
  })
})
