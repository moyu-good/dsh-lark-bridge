import { describe, expect, it } from 'vitest'
import { describeCommand, helpHeading } from '../src/i18n.ts'
import { resolveLocale } from '../src/config.ts'

describe('i18n command descriptions', () => {
  it('resolves bridge-owned commands in both languages', () => {
    expect(describeCommand('stop', 'zh', 'fallback')).toBe('停止当前任务')
    expect(describeCommand('stop', 'en', 'fallback')).toBe('Stop the current task')
    expect(describeCommand('preset', 'zh', 'fallback')).toContain('查看/切换模式')
    expect(describeCommand('preset', 'en', 'fallback')).toContain('View or switch mode')
  })

  it('resolves dsh host commands in both languages', () => {
    expect(describeCommand('goal', 'zh', 'fallback')).toBe('查看/设置目标')
    expect(describeCommand('goal', 'en', 'fallback')).toBe('Set or view the goal')
    expect(describeCommand('compact', 'en', 'fallback')).toBe('Compact older conversation history')
  })

  it('falls back verbatim for unknown commands', () => {
    expect(describeCommand('mystery-command', 'zh', 'host says this')).toBe('host says this')
    expect(describeCommand('mystery-command', 'en', 'host says this')).toBe('host says this')
  })

  it('provides a localized help heading', () => {
    expect(helpHeading('zh')).toBe('**可用命令**')
    expect(helpHeading('en')).toBe('**Available commands**')
  })
})

describe('locale resolution', () => {
  it('defaults to Chinese for the domestic Feishu domain', () => {
    expect(resolveLocale({})).toBe('zh')
    expect(resolveLocale({ domain: 'https://open.feishu.cn' })).toBe('zh')
  })

  it('picks English for the international Lark domain', () => {
    expect(resolveLocale({ domain: 'https://open.larksuite.com' })).toBe('en')
  })

  it('lets an explicit locale override the domain', () => {
    expect(resolveLocale({ domain: 'https://open.larksuite.com', locale: 'zh' })).toBe('zh')
    expect(resolveLocale({ domain: 'https://open.feishu.cn', locale: 'en' })).toBe('en')
    expect(resolveLocale({ locale: 'auto', domain: 'https://open.larksuite.com' })).toBe('en')
  })
})
