import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildImportPlan,
  buildMigration,
  crossHostWarning,
  readMigration,
  resolveMigrationFile,
  validateMigration,
  MIGRATION_KIND,
} from '../src/sync/migrate.ts'
import { runBotCommand } from '../src/sync/bot-command.ts'
import type { SyncCommandContext } from '../src/sync/bot-command.ts'
import { readSettings, writeSettings } from '../src/sync/settings-store.ts'
import { writeProfileManifest } from './helpers/profile-manifest.ts'

/** One isolated fake DSH home per test; removed afterwards. */
const homes: string[] = []
function track(): { home: string; harnessHome: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lark-mig-'))
  homes.push(home)
  return { home, harnessHome: path.join(home, 'dsh-home') }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fsp.rm(home, { recursive: true, force: true })))
})

function makeCtx(home: string, harnessHome: string, overrides?: Partial<SyncCommandContext>): SyncCommandContext {
  return {
    home,
    harnessHome,
    form: 'web',
    profile: 'web',
    bridgeVersion: '0.4.0',
    runCommand: async () => {},
    ...overrides,
  }
}

describe('migration export', () => {
  it('masks credentials by default and includes them verbatim on request', async () => {
    const { home, harnessHome } = track()
    await writeSettings({ appId: 'cli_abc', appSecret: 's3cret-value' }, home)
    const masked = await buildMigration(home, harnessHome, 'web', 'web')
    expect(masked.settings.appSecret).toBe('****alue')
    expect(masked.settings.appId).toBe('cli_abc')
    const open = await buildMigration(home, harnessHome, 'web', 'web', { includeSecrets: true })
    expect(open.settings.appSecret).toBe('s3cret-value')
  })

  it('captures the running profile plus any extra profiles that exist', async () => {
    const { home, harnessHome } = track()
    writeProfileManifest(harnessHome, 'web', {
      profile: 'web',
      dependencies: { '@moyu-good/dsh-lark-bridge': '^0.3.1' },
      bundles: ['@moyu-good/dsh-lark-bridge'],
      mtimeMs: 1,
    })
    const file = await buildMigration(home, harnessHome, 'web', 'web', { profiles: ['desktop'] })
    expect(file.profiles.web?.dependencies).toEqual({ '@moyu-good/dsh-lark-bridge': '^0.3.1' })
    // Missing profile (desktop not installed here) is a legitimate empty list.
    expect(file.profiles.desktop).toEqual({ dependencies: {}, bundles: [] })
    expect(file.kind).toBe(MIGRATION_KIND)
  })

  it('round-trips through the sync directory', async () => {
    const { home, harnessHome } = track()
    await writeSettings({ appId: 'cli_abc' }, home)
    const file = await buildMigration(home, harnessHome, 'web', 'web')
    const landing = resolveMigrationFile(undefined, home)
    fs.mkdirSync(path.dirname(landing), { recursive: true })
    fs.writeFileSync(landing, JSON.stringify(file))
    const read = await readMigration(undefined, home)
    expect(read.settings.appId).toBe('cli_abc')
  })
})

describe('migration validation', () => {
  it('rejects wrong kind, wrong version, and broken JSON with readable errors', async () => {
    const { home } = track()
    const dir = path.join(home, 'dsh-lark-bridge')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'bad-kind.json'), JSON.stringify({ kind: 'other', version: 1 }))
    fs.writeFileSync(path.join(dir, 'bad-version.json'), JSON.stringify({ kind: MIGRATION_KIND, version: 99 }))
    fs.writeFileSync(path.join(dir, 'not-json.json'), '{ nope')
    await expect(readMigration('bad-kind.json', home)).rejects.toThrow(/不是桥的迁移文件/)
    await expect(readMigration('bad-version.json', home)).rejects.toThrow(/版本/)
    await expect(readMigration('not-json.json', home)).rejects.toThrow(/合法 JSON/)
  })

  it('confines import file names to the sync directory', () => {
    const { home } = track()
    expect(() => resolveMigrationFile('../evil.json', home)).toThrow(/裸文件名/)
    expect(() => resolveMigrationFile('sub/dir.json', home)).toThrow(/裸文件名/)
    expect(resolveMigrationFile('migrate.json', home)).toContain('migrate.json')
  })

  it('validateMigration demands the from.host field', () => {
    expect(() => validateMigration({ kind: MIGRATION_KIND, version: 1 })).toThrow(/from\.host/)
  })
})

describe('import planning', () => {
  it('installs what is missing and skips what already matches', () => {
    const local = {
      profile: 'web',
      dependencies: { '@moyu-good/dsh-lark-bridge': '^0.3.1', '@deepseek-ai/cordis': '^4.0.1' },
      bundles: [],
      mtimeMs: 1,
    }
    const plan = buildImportPlan(local, 'web', {
      dependencies: { '@moyu-good/dsh-lark-bridge': '^0.3.1', '@deepseek-ai/dsh-base': '^0.1.1' },
      bundles: [],
    })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.kind).toBe('add')
    if (plan.steps[0]?.kind === 'add') expect(plan.steps[0]?.spec).toContain('@deepseek-ai/dsh-base@')
    expect(plan.inSync).toEqual(['@moyu-good/dsh-lark-bridge'])
  })

  it('warns when the file came from another host, stays quiet otherwise', () => {
    const doc = { kind: MIGRATION_KIND, version: 1, exportedAt: 't', from: { profile: 'web', form: 'web', host: 'other-box' }, settings: {}, profiles: {} }
    expect(crossHostWarning(doc as never)).toMatch(/双投递/)
    const same = { ...doc, from: { ...doc.from, host: os.hostname() } }
    expect(crossHostWarning(same as never)).toBeNull()
  })
})

describe('/bot export + /bot import integration', () => {
  it('exports masked, previews, and applies without clobbering secrets', async () => {
    const { home, harnessHome } = track()
    await writeSettings({ appId: 'cli_abc', appSecret: 's3cret-value', locale: 'zh' }, home)
    writeProfileManifest(harnessHome, 'web', {
      profile: 'web',
      dependencies: { '@moyu-good/dsh-lark-bridge': '^0.3.1' },
      bundles: ['@moyu-good/dsh-lark-bridge'],
      mtimeMs: 1,
    })
    const ctx = makeCtx(home, harnessHome)

    const exported = await runBotCommand('/bot export', ctx)
    expect(exported.resolved).toBe(true)
    expect(exported.reply).toMatch(/迁移文件已导出/)
    expect(exported.reply).not.toMatch(/s3cret-value/)

    const preview = await runBotCommand('/bot import apply', ctx)
    expect(preview.reply).toMatch(/导入执行完毕/)
    const settings = await readSettings(home)
    // Masked secret must NOT clobber the real local value; plain keys land.
    expect(settings.appSecret).toBe('s3cret-value')
    expect(settings.locale).toBe('zh')
    expect(preview.reply).toMatch(/重新 `\/bot set appSecret`|补录凭证/)
  })

  it('surfaces the cross-host warning for files from another machine', async () => {
    const { home, harnessHome } = track()
    const file = await buildMigration(home, harnessHome, 'web', 'web')
    file.from.host = 'old-laptop'
    const dir = path.join(home, 'dsh-lark-bridge')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'migrate.json'), JSON.stringify(file))
    const preview = await runBotCommand('/bot import', makeCtx(home, harnessHome))
    expect(preview.reply).toMatch(/旧机的桥仍在运行|双投递/)
  })
})
