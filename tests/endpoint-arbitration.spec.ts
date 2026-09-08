import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  arbitrationActiveKey,
  claimIfActiveStale,
  endpointKey,
  isActiveEndpoint,
} from '../src/sync/bot-command.ts'
import type { Arbitration, SyncCommandContext } from '../src/sync/bot-command.ts'
import { PRESENCE_TIMEOUT_MS } from '../src/sync/bot-command.ts'
import { writeDeviceState } from '../src/sync/migrate.ts'
import type { FeishuCloud } from '../src/sync/feishu-cloud.ts'

const FRESH = Date.now()
const STALE = FRESH - PRESENCE_TIMEOUT_MS - 60_000

/** One isolated fake home with a PINNED device identity (never the real one). */
function seededHome(deviceId = 'dev-test0000-abc123'): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-endpoint-'))
  fs.mkdirSync(path.join(home, 'dsh-lark-bridge'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'dsh-lark-bridge', 'device-state.json'),
    JSON.stringify({ deviceId, deviceName: 'TEST-BOX' }) + '\n',
  )
  return home
}

/** A 0.7.0+ document: the active slot is endpoint-scoped. */
const newDoc = (activeEndpoint: string, activeSeen: number): Arbitration => ({
  activeDeviceId: activeEndpoint.split(':')[0]!,
  activeName: 'writer',
  form: activeEndpoint.split(':')[1]!,
  profile: activeEndpoint.split(':')[2]!,
  activeEndpoint,
  updatedAt: new Date(FRESH).toISOString(),
  devices: {
    [activeEndpoint]: { name: 'writer', form: 'web', profile: 'web', version: '0.7.0', lastSeen: activeSeen },
  },
})

/** A pre-0.7 document: machine-level active, form/profile describe the writer. */
const oldDoc = (deviceId: string, activeSeen: number): Arbitration => ({
  activeDeviceId: deviceId,
  activeName: 'writer',
  form: 'web',
  profile: 'web',
  updatedAt: new Date(activeSeen).toISOString(),
  devices: {
    [deviceId]: { name: 'writer', form: 'web', profile: 'web', version: '0.6.1', lastSeen: activeSeen },
  },
})

describe('endpointKey / arbitrationActiveKey', () => {
  it('endpoint keys separate the two forms of one machine', () => {
    expect(endpointKey('dev-1', 'web', 'web')).toBe('dev-1:web:web')
    expect(endpointKey('dev-1', 'desktop', 'desktop')).not.toBe(endpointKey('dev-1', 'web', 'web'))
  })

  it('current documents answer with their endpoint verbatim', () => {
    expect(arbitrationActiveKey(newDoc('dev-1:web:web', FRESH))).toBe('dev-1:web:web')
  })

  it('pre-0.7 documents derive the endpoint from machine + recorded form', () => {
    expect(arbitrationActiveKey(oldDoc('dev-1', FRESH))).toBe('dev-1:web:web')
  })
})

describe('isActiveEndpoint', () => {
  it('matches the exact endpoint on current documents', () => {
    const doc = newDoc('dev-1:web:web', FRESH)
    expect(isActiveEndpoint(doc, 'dev-1', 'web', 'web')).toBe(true)
    expect(isActiveEndpoint(doc, 'dev-1', 'desktop', 'desktop')).toBe(false)
    expect(isActiveEndpoint(doc, 'dev-2', 'web', 'web')).toBe(false)
  })

  it('pre-0.7 fallback: same machine AND recorded form is active; the sibling form stands down', () => {
    const doc = oldDoc('dev-1', FRESH)
    expect(isActiveEndpoint(doc, 'dev-1', 'web', 'web')).toBe(true)
    // The regression this guards: same machine, second Feishu connection.
    expect(isActiveEndpoint(doc, 'dev-1', 'desktop', 'desktop')).toBe(false)
  })
})

describe('claimIfActiveStale (endpoint-scoped election)', () => {
  const DEVICE = 'dev-test0000-abc123'

  function ctxFor(doc: Arbitration, form: 'web' | 'desktop', profile: string): {
    ctx: SyncCommandContext
    written: () => string | undefined
  } {
    let captured: string | undefined
    const fakeCloud = {
      getJson: async () => JSON.stringify(doc),
      putJson: async (_name: string, content: string) => { captured = content },
    } as unknown as FeishuCloud
    return {
      ctx: {
        home: seededHome(DEVICE),
        form,
        profile,
        bridgeVersion: '0.7.0-test',
        cloud: fakeCloud,
      },
      written: () => captured,
    }
  }

  it('does not claim when this endpoint already owns the slot', async () => {
    const doc = newDoc(`${DEVICE}:web:web`, FRESH)
    const { ctx } = ctxFor(doc, 'web', 'web')
    expect(await claimIfActiveStale(ctx, doc)).toBe(false)
  })

  it('the sibling form of a silent active endpoint claims the slot', async () => {
    const doc = newDoc(`${DEVICE}:web:web`, STALE)
    const { ctx, written } = ctxFor(doc, 'desktop', 'desktop')
    expect(await claimIfActiveStale(ctx, doc)).toBe(true)
    const next = JSON.parse(written()!) as Arbitration
    expect(next.activeEndpoint).toBe(`${DEVICE}:desktop:desktop`)
    expect(next.activeDeviceId).toBe(DEVICE)
  })

  it('a fresh active endpoint is never claimed', async () => {
    const doc = newDoc(`${DEVICE}:web:web`, FRESH)
    const { ctx } = ctxFor(doc, 'desktop', 'desktop')
    expect(await claimIfActiveStale(ctx, doc)).toBe(false)
  })

  it('a pre-0.7 doc whose recorded form matches a fresh writer blocks the sibling claim', async () => {
    // Renewal on 0.7+ writes endpoint-keyed entries; the derived active key
    // for the old doc hits the writer's fresh endpoint entry → no claim.
    const doc = oldDoc(DEVICE, FRESH)
    doc.devices![`${DEVICE}:web:web`] = { name: 'TEST-BOX', form: 'web', profile: 'web', version: '0.7.0', lastSeen: FRESH }
    const { ctx } = ctxFor(doc, 'desktop', 'desktop')
    expect(await claimIfActiveStale(ctx, doc)).toBe(false)
  })

  it('a pre-0.7 doc whose writer went silent hands the slot over (upgrade path)', async () => {
    const doc = oldDoc(DEVICE, STALE)
    const { ctx, written } = ctxFor(doc, 'desktop', 'desktop')
    expect(await claimIfActiveStale(ctx, doc)).toBe(true)
    const next = JSON.parse(written()!) as Arbitration
    expect(next.activeEndpoint).toBe(`${DEVICE}:desktop:desktop`)
  })
})

describe('seeded identity', () => {
  it('ensureDeviceId reads the pinned id from the seeded home', async () => {
    const { ensureDeviceId } = await import('../src/sync/migrate.ts')
    const home = seededHome()
    const identity = await ensureDeviceId(home)
    expect(identity.deviceId).toBe('dev-test0000-abc123')
    void writeDeviceState // keep the import meaningful for readers
  })
})
