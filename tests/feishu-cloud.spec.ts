import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FeishuCloud } from '../src/sync/feishu-cloud.ts'
import { runBotCommand } from '../src/sync/bot-command.ts'
import type { SyncCommandContext } from '../src/sync/bot-command.ts'
import { writeSettings } from '../src/sync/settings-store.ts'
import { writeProfileManifest } from './helpers/profile-manifest.ts'
import type { MigrationFile } from '../src/sync/migrate.ts'

const homes: string[] = []
function track(): { home: string; harnessHome: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lark-cloud-'))
  homes.push(home)
  return { home, harnessHome: path.join(home, 'dsh-home') }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fsp.rm(home, { recursive: true, force: true })))
})

/** Scripted fetch: one queued JSON reply per call, recorded for asserts. */
function scriptedFetch(replies: unknown[]): { fetch: Parameters<typeof FeishuCloud.prototype.getToken>[0] extends never ? never : any; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  let i = 0
  const fetch = async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const reply = replies[Math.min(i, replies.length - 1)]!
    i += 1
    return { status: 200, json: async () => reply, text: async () => JSON.stringify(reply) }
  }
  return { fetch: fetch as never, calls }
}

describe('feishu cloud client', () => {
  it('mints the token once and reuses it across calls', async () => {
    const { fetch, calls } = scriptedFetch([
      { code: 0, tenant_access_token: 't-x', expire: 7200 },
      { code: 0, data: { token: 'fld-root' } },
      { code: 0, data: { token: 'fld-root' } },
      { code: 0, data: { token: 'fld-root' } },
    ])
    const cloud = new FeishuCloud({ appId: 'cli_a', appSecret: 's' }, fetch)
    await cloud.rootFolder()
    await cloud.rootFolder()
    const mints = calls.filter((call) => call.url.includes('tenant_access_token'))
    expect(mints).toHaveLength(1)
  })

  it('putJson uploads fresh then removes same-named predecessors', async () => {
    const uploads: string[] = []
    const removed: string[] = []
    let calls = 0
    const fetch = async (url: string, init?: { method?: string }) => {
      calls += 1
      if (url.includes('tenant_access_token')) {
        return { status: 200, json: async () => ({ code: 0, tenant_access_token: 't-x', expire: 7200 }), text: async () => '' }
      }
      if (url.includes('/root_folder/meta')) {
        return { status: 200, json: async () => ({ code: 0, data: { token: 'fld-root' } }), text: async () => '' }
      }
      if (url.includes('upload_all')) {
        uploads.push('file')
        return { status: 200, json: async () => ({ code: 0, data: { file_token: `fresh-${calls}` } }), text: async () => '' }
      }
      if (init?.method === 'DELETE') {
        removed.push(url)
        return { status: 200, json: async () => ({ code: 0 }), text: async () => '' }
      }
      // list
      return {
        status: 200,
        json: async () => ({ code: 0, data: { files: [{ name: 'dsh-lark-bridge-migrate.json', token: 'old-1', modified_time: '111' }] } }),
        text: async () => '',
      }
    }
    const cloud = new FeishuCloud({ appId: 'cli_a', appSecret: 's' }, fetch as never)
    await cloud.putJson('dsh-lark-bridge-migrate.json', '{}')
    expect(uploads).toHaveLength(1)
    expect(removed.some((url) => url.includes('old-1'))).toBe(true)
  })
})

/** A fake cloud that records writes into the given map and serves canned reads. */
function fakeCloud(files: Map<string, string>): { cloud: FeishuCloud; written: Map<string, string> } {
  const cloud = {
    putJson: async (name: string, content: string) => { files.set(name, content) },
    getJson: async (name: string) => files.get(name) ?? null,
    removeByName: async () => {},
  } as unknown as FeishuCloud
  return { cloud, written: files }
}

function cloudCtx(home: string, harnessHome: string, cloud: FeishuCloud): SyncCommandContext {
  return {
    home,
    harnessHome,
    form: 'web',
    profile: 'web',
    bridgeVersion: '0.5.0-test',
    credentials: { appId: 'cli_a', appSecret: 's' },
    cloud,
    runCommand: async () => {},
  }
}

describe('cloud migration flow via /bot', () => {
  it('export --to-feishu lands in the cloud slot; import --from-feishu applies it', async () => {
    const old = track()
    await writeSettings({ appId: 'cli_old', locale: 'zh' }, old.home)
    writeProfileManifest(old.harnessHome, 'web', {
      profile: 'web',
      dependencies: { '@moyu-good/dsh-lark-bridge': '^0.4.0' },
      bundles: ['@moyu-good/dsh-lark-bridge'],
      mtimeMs: 1,
    })
    const files = new Map<string, string>()
    const oldCloud = fakeCloud(files)
    const exported = await runBotCommand('/bot export --to-feishu', cloudCtx(old.home, old.harnessHome, oldCloud.cloud))
    expect(exported.reply).toMatch(/已上传飞书云空间/)
    expect(files.has('dsh-lark-bridge-migrate.json')).toBe(true)

    // A NEW machine: empty local state, cloud slot readable.
    const fresh = track()
    writeProfileManifest(fresh.harnessHome, 'web', {
      profile: 'web',
      dependencies: {},
      bundles: [],
      mtimeMs: 1,
    })
    const newCloud = fakeCloud(files)
    const preview = await runBotCommand('/bot import --from-feishu', cloudCtx(fresh.home, fresh.harnessHome, newCloud.cloud))
    expect(preview.reply).toMatch(/导入预览/)
    expect(preview.reply).toMatch(/cli_old|将写入/)

    const applied = await runBotCommand('/bot import --from-feishu apply', cloudCtx(fresh.home, fresh.harnessHome, newCloud.cloud))
    expect(applied.reply).toMatch(/导入执行完毕/)
    expect(applied.reply).toMatch(/1 个?包|成功 1/)
  })

  it('activate publishes the local device as the cloud-active endpoint', async () => {
    const { home, harnessHome } = track()
    const files = new Map<string, string>()
    const { cloud, written } = fakeCloud(files)
    await runBotCommand('/bot retire', cloudCtx(home, harnessHome, cloud))
    const activated = await runBotCommand('/bot activate', cloudCtx(home, harnessHome, cloud))
    expect(activated.reply).toMatch(/云端仲裁已更新/)
    const arbitration = JSON.parse(written.get('dsh-lark-bridge-arbitration.json')!) as { activeDeviceId: string }
    expect(arbitration.activeDeviceId).toMatch(/^dev-/)
  })

  it('exported documents never carry the per-machine device id', async () => {
    const { home, harnessHome } = track()
    const exported = await runBotCommand('/bot export', cloudCtx(home, harnessHome, fakeCloud(new Map()).cloud))
    expect(exported.reply).toMatch(/迁移文件已导出/)
    const local = path.join(home, 'dsh-lark-bridge', 'migrate.json')
    const doc = JSON.parse(fs.readFileSync(local, 'utf8')) as MigrationFile
    expect(doc.deviceId).toBeUndefined()
    expect(Object.keys(doc)).not.toContain('deviceState')
  })
})
