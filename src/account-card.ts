/**
 * The interactive account-switcher card for `/bot account`.
 *
 * Text commands make the operator paste names; a card makes switching two
 * taps: every saved account renders with 使用 / 忘记 buttons, and the click
 * value rides back through the cardAction event. The value payload is
 * namespaced (`kind`) so foreign card actions parse to undefined, and every
 * human-readable string rides `plain_text` so nothing can inject card markup
 * (the same rule as the question cards).
 * @module dsh-lark-bridge/account-card
 */

/** The button value namespace — every account-card button carries it. */
export const ACCOUNT_ACTION = 'bot-account'

/** One roster row on the card. */
export interface AccountCardEntry {
  readonly name: string
  readonly maskedAppId: string
  readonly savedAt?: string | undefined
  readonly active: boolean
}

/** The parsed click payload of one account-card button. */
export interface AccountCardAction {
  readonly act: 'use' | 'forget'
  readonly name: string
}

/**
 * Build the account-switcher card. Cap the roster at eight entries — beyond
 * that the card is a scroll pit and `/bot account save` curation is the
 * better fix.
 */
export function buildAccountCard(data: {
  entries: readonly AccountCardEntry[]
  hint?: string | undefined
}): object {
  const elements: object[] = []
  if (data.hint !== undefined && data.hint !== '') {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: data.hint } })
  }
  for (const entry of data.entries.slice(0, 8)) {
    const flag = entry.active ? '🎖 当前' : ''
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: `**${entry.name}** \`${entry.maskedAppId}\`${entry.savedAt === undefined ? '' : ` · ${entry.savedAt}`}${flag}` },
    })
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 使用' },
          type: entry.active ? 'default' : 'primary',
          value: { kind: ACCOUNT_ACTION, act: 'use', name: entry.name },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🗑 忘记' },
          type: 'default',
          value: { kind: ACCOUNT_ACTION, act: 'forget', name: entry.name },
        },
      ],
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '飞书账号库' } },
    elements,
  }
}

/**
 * Narrow an arbitrary card-action value to this card's payload. Foreign
 * values (approval clicks, question answers, goal cards) parse to undefined.
 */
export function accountCardValue(value: unknown): AccountCardAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { kind?: unknown; act?: unknown; name?: unknown }
  if (raw.kind !== ACCOUNT_ACTION) return undefined
  if (raw.act !== 'use' && raw.act !== 'forget') return undefined
  if (typeof raw.name !== 'string' || raw.name === '') return undefined
  return { act: raw.act, name: raw.name }
}
