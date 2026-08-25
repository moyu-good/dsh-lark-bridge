import { describe, expect, it } from 'vitest'
import { briefingPrefix } from '../src/briefing.ts'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = () => join(mkdtempSync(join(tmpdir(),'bf-')), 'brief.md')

describe('briefing prefix', () => {
  it('returns empty when disabled', () => {
    expect(briefingPrefix(undefined, 's1', () => {})).toBe('')
    expect(briefingPrefix('', 's2', () => {})).toBe('')
  })
  it('wraps file content once per session', () => {
    const f = file(); writeFileSync(f, '# 简报内容')
    const p1 = briefingPrefix(f, 'sessA', () => {})
    expect(p1).toContain('# 简报内容')
    expect(p1).toContain('System briefing')
    // 同会话第二次不再注入
    expect(briefingPrefix(f, 'sessA', () => {})).toBe('')
    // 新会话重新注入
    expect(briefingPrefix(f, 'sessB', () => {})).toContain('# 简报内容')
  })
  it('logs and degrades on unreadable file', () => {
    const log: string[] = []
    const p = briefingPrefix('/nonexistent/brief.md', 's3', m => log.push(m))
    expect(p).toBe('')
    expect(log.length).toBe(1)
  })
})
