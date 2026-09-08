import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBotCommand } from '../src/sync/bot-command.ts'
import type { SyncCommandContext } from '../src/sync/bot-command.ts'
import { readAccounts } from '../src/sync/accounts-store.ts'
import { readSettings } from '../src/sync/settings-store.ts'

function home_(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-accounts-'))
}

function ctx(home: string, overrides: Partial<SyncCommandContext> = {}): SyncCommandContext {
  return {
    home,
    form: 'web',
    profile: 'web',
    bridgeVersion: '0.7.0-test',
    credentials: { appId: 'cli_aaaabbbbcccc', appSecret: 'secret-one-111' },
    ...overrides,
  }
}

describe('/bot account', () => {
  it('save stores the current credentials under a name, masked in the reply', async () => {
    const home = home_()
    const out = await runBotCommand('/bot account save personal 工作号', ctx(home))
    expect(out.resolved).toBe(true)
    expect(out.reply).toContain('personal')
    expect(out.reply).toContain('****cccc')
    expect(out.reply).not.toContain('cli_aaaabbbbcccc')
    const book = await readAccounts(home)
    expect(book.accounts['personal']!.appId).toBe('cli_aaaabbbbcccc')
    expect(book.accounts['personal']!.note).toBe('工作号')
  })

  it('save without credentials explains why', async () => {
    const home = home_()
    const out = await runBotCommand('/bot account save x', ctx(home, { credentials: undefined }))
    expect(out.resolved).toBe(false)
    expect(out.reply).toContain('没有可保存的凭证')
  })

  it('use swaps the shared transport keys and marks the account active', async () => {
    const home = home_()
    await runBotCommand('/bot account save one', ctx(home))
    await runBotCommand('/bot account save two', ctx(home, {
      credentials: { appId: 'cli_ddddaaaabbbb', appSecret: 'secret-two-222' },
    }))
    const out = await runBotCommand('/bot account use two', ctx(home))
    expect(out.resolved).toBe(true)
    expect(out.reply).toContain('/restart')
    const settings = await readSettings(home)
    expect(settings.appId).toBe('cli_ddddaaaabbbb')
    expect(settings.appSecret).toBe('secret-two-222')
    const book = await readAccounts(home)
    expect(book.active).toBe('two')
  })

  it('use of an unknown name is refused without touching settings', async () => {
    const home = home_()
    const out = await runBotCommand('/bot account use ghost', ctx(home))
    expect(out.resolved).toBe(false)
    expect(await readSettings(home)).toEqual({})
  })

  it('forget removes the account and clears an active marker', async () => {
    const home = home_()
    await runBotCommand('/bot account save one', ctx(home))
    await runBotCommand('/bot account use one', ctx(home))
    const out = await runBotCommand('/bot account forget one', ctx(home))
    expect(out.resolved).toBe(true)
    const book = await readAccounts(home)
    expect(book.accounts['one']).toBeUndefined()
    expect(book.active).toBeUndefined()
  })

  it('listing shows every saved account with an active tag', async () => {
    const home = home_()
    await runBotCommand('/bot account save one', ctx(home))
    await runBotCommand('/bot account save two', ctx(home, {
      credentials: { appId: 'cli_ddddaaaabbbb', appSecret: 'secret-two-222' },
    }))
    await runBotCommand('/bot account use two', ctx(home))
    const out = await runBotCommand('/bot account', ctx(home))
    expect(out.reply).toContain('**one**')
    expect(out.reply).toContain('**two**')
    expect(out.reply).toContain('🎖 当前')
    expect(out.reply).not.toContain('cli_aaaabbbbcccc')
    expect(out.reply).not.toContain('secret-two-222')
  })
})
