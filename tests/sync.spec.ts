import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  maskSecret,
  mergeSettings,
  readSettings,
  updateSettings,
  withLock,
  writeSettings,
} from '../src/sync/settings-store.ts'
import { heartbeat, listPeers, selfEntry } from '../src/sync/peers.ts'

/** One isolated fake DSH home per test; removed afterwards. */
function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lark-sync-'))
}

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fsp.rm(home, { recursive: true, force: true })))
})

function track(): string {
  const home = makeHome()
  homes.push(home)
  return home
}

describe('settings store', () => {
  it('round-trips a document and drops empty values', async () => {
    const home = track()
    await writeSettings({ appId: 'cli_abc', appSecret: 's3cret', locale: undefined as never }, home)
    const read = await readSettings(home)
    expect(read.appId).toBe('cli_abc')
    expect(read.appSecret).toBe('s3cret')
    expect('locale' in read).toBe(false)
  })

  it('returns an empty document when none was written', async () => {
    const home = track()
    expect(await readSettings(home)).toEqual({})
  })

  it('quarantines a corrupt file instead of trusting it', async () => {
    const home = track()
    const file = path.join(home, 'dsh-lark-bridge', 'settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')
    expect(await readSettings(home)).toEqual({})
    const quarantined = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
  })

  it('overlay merge lets the shared file win per key', () => {
    const merged = mergeSettings(
      { appId: 'from_profile', locale: 'zh' },
      { appId: 'from_shared' },
    )
    expect(merged.appId).toBe('from_shared')
    expect(merged.locale).toBe('zh')
  })

  it('updateSettings mutates under the lock and persists', async () => {
    const home = track()
    const next = await updateSettings(home, () => ({ appId: 'cli_x', provider: 'deepseek' }))
    expect(next.appId).toBe('cli_x')
    expect((await readSettings(home)).provider).toBe('deepseek')
  })

  it('updateSettings keeps the document when the mutator abstains', async () => {
    const home = track()
    await writeSettings({ appId: 'cli_keep' }, home)
    await updateSettings(home, () => undefined)
    expect((await readSettings(home)).appId).toBe('cli_keep')
  })

  it('serializes concurrent writers through the lock', async () => {
    const home = track()
    const file = path.join(home, 'dsh-lark-bridge', 'settings.json')
    await writeSettings({ appId: 'start' }, home)
    await Promise.all([
      updateSettings(home, (cur) => ({ ...cur, provider: 'a' })),
      updateSettings(home, (cur) => ({ ...cur, model: 'b' })),
    ])
    const final = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    expect(final.appId).toBe('start')
    expect(final.provider).toBe('a')
    expect(final.model).toBe('b')
  })

  it('takes over a stale lock left by a dead writer', async () => {
    const home = track()
    const lock = path.join(home, 'dsh-lark-bridge', 'settings.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    const stale = Date.now() - 60_000
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: stale }))
    fs.utimesSync(lock, new Date(stale), new Date(stale))
    await expect(withLock(home, async () => 'ran')).resolves.toBe('ran')
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('masks secrets to their tail', () => {
    expect(maskSecret('cli_abcdefghijkl')).toBe('****ijkl')
    expect(maskSecret('abc')).toBe('****')
    expect(maskSecret(undefined)).toBe('')
  })
})

describe('peers', () => {
  it('heartbeats and discovers the other end', async () => {
    const home = track()
    const web = selfEntry('web', 'web', '0.4.0', 18787)
    const desktop = selfEntry('desktop', 'desktop', '0.4.0', 18788)
    await heartbeat(web, home)
    const seenByWeb = await heartbeat(desktop, home)
    expect(seenByWeb).toHaveLength(1)
    expect(seenByWeb[0].form).toBe('web')
    expect(seenByWeb[0].profile).toBe('web')
    const seenByDesktop = await listPeers(home)
    expect(seenByDesktop.map((p) => p.form).sort()).toEqual(['desktop', 'web'])
  })

  it('does not list itself', async () => {
    const home = track()
    const mine = selfEntry('web', 'web', '0.4.0')
    await heartbeat(mine, home)
    expect(await listPeers(home, { profile: mine.profile, pid: mine.pid, host: mine.host })).toHaveLength(0)
  })

  it('expires peers whose heartbeat stopped', async () => {
    const home = track()
    const web = selfEntry('web', 'web', '0.4.0')
    const desktop = selfEntry('desktop', 'desktop', '0.4.0')
    // Plant a stale entry directly: a peer whose heartbeat stopped 60s ago.
    const dir = path.join(home, 'dsh-lark-bridge')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'peers.json'),
      JSON.stringify({ peers: [{ ...web, ts: Date.now() - 60_000 }] }),
    )
    await heartbeat(desktop, home)
    const alive = await listPeers(home, { profile: web.profile, pid: web.pid, host: web.host })
    expect(alive.map((p) => p.form)).toEqual(['desktop'])
  })
})
