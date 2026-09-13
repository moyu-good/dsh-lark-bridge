import { describe, expect, it } from 'vitest'
import { briefingPrefix } from '../src/briefing.ts'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = () => join(mkdtempSync(join(tmpdir(),'bf-')), 'brief.md')

describe('briefing prefix', () => {
  it('returns empty when disabled', async () => {
    expect(await briefingPrefix(undefined, 's1', () => {})).toBe('')
    expect(await briefingPrefix('', 's2', () => {})).toBe('')
  })
  it('wraps file content once per session', async () => {
    const f = file(); writeFileSync(f, '# 简报内容')
    const p1 = await briefingPrefix(f, 'sessA', () => {})
    expect(p1).toContain('# 简报内容')
    expect(p1).toContain('System briefing')
    // 同会话第二次不再注入
    expect(await briefingPrefix(f, 'sessA', () => {})).toBe('')
    // 新会话重新注入
    expect(await briefingPrefix(f, 'sessB', () => {})).toContain('# 简报内容')
  })
  it('logs and degrades on unreadable file', async () => {
    const log: string[] = []
    const p = await briefingPrefix('/nonexistent/brief.md', 's3', m => log.push(m))
    expect(p).toBe('')
    expect(log.length).toBe(1)
  })
})
