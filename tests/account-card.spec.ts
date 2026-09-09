import { describe, expect, it } from 'vitest'
import { accountCardValue, buildAccountCard, ACCOUNT_ACTION } from '../src/account-card.ts'

describe('buildAccountCard', () => {
  it('renders one button pair per account with the active flag', () => {
    const card = buildAccountCard({
      entries: [
        { name: 'personal', maskedAppId: 'cli_****cccc', savedAt: '2026-09-09', active: true },
        { name: 'test', maskedAppId: 'cli_****bbbb', active: false },
      ],
      hint: '点按钮切换',
    }) as { header: { title: { content: string } }; elements: { tag: string; actions?: { value: { kind: string; act: string; name: string } }[]; text?: { content: string } }[] }

    expect(card.header.title.content).toBe('飞书账号库')
    const texts = card.elements.filter((e) => e.tag === 'div').map((e) => e.text?.content ?? '')
    expect(texts[0]).toBe('点按钮切换')
    expect(texts.some((t) => t.includes('personal') && t.includes('🎖 当前'))).toBe(true)
    const actions = card.elements.filter((e) => e.tag === 'action')
    expect(actions).toHaveLength(2)
    expect(actions[0]!.actions!.map((a) => a.value.name)).toEqual(['personal', 'personal'])
    expect(actions[0]!.actions!.map((a) => a.value.act)).toEqual(['use', 'forget'])
    expect(actions[0]!.actions!.every((a) => a.value.kind === ACCOUNT_ACTION)).toBe(true)
  })

  it('caps the roster at eight entries', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `acct-${i}`,
      maskedAppId: 'cli_****xxxx',
      active: false,
    }))
    const card = buildAccountCard({ entries }) as { elements: { tag: string }[] }
    expect(card.elements.filter((e) => e.tag === 'action')).toHaveLength(8)
  })
})

describe('accountCardValue', () => {
  it('round-trips a use click', () => {
    expect(accountCardValue({ kind: ACCOUNT_ACTION, act: 'use', name: 'personal' })).toEqual({
      act: 'use',
      name: 'personal',
    })
  })

  it('rejects foreign, malformed, and empty payloads', () => {
    expect(accountCardValue({ kind: 'approval', id: 'x' })).toBeUndefined()
    expect(accountCardValue({ kind: ACCOUNT_ACTION, act: 'reboot', name: 'x' })).toBeUndefined()
    expect(accountCardValue({ kind: ACCOUNT_ACTION, act: 'use', name: '' })).toBeUndefined()
    expect(accountCardValue({ kind: ACCOUNT_ACTION, act: 'use' })).toBeUndefined()
    expect(accountCardValue('use personal')).toBeUndefined()
    expect(accountCardValue(undefined)).toBeUndefined()
  })
})
