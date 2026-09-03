import { afterAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  fetchPeerHealth,
  fetchPeerManifest,
  startControlApi,
} from '../src/sync/control-api.ts'
import type { ProfileManifest } from '../src/sync/profile-manifest.ts'

const manifest: ProfileManifest = {
  profile: 'web',
  dependencies: {
    '@deepseek-ai/cordis': '^4.0.1',
    '@moyu-good/dsh-lark-bridge': 'file:/tmp/dsh-lark-bridge-fixture',
  },
  bundles: ['@deepseek-ai/dsh-base', '@moyu-good/dsh-lark-bridge'],
  mtimeMs: 1,
}

const servers: { close(): Promise<void> }[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function start(): Promise<{ port: number; token: string }> {
  const token = `tok-${Math.random().toString(36).slice(2)}`
  const server = await startControlApi(
    { profile: 'web', form: 'web', bridgeVersion: '0.4.0', manifest: async () => manifest },
    token,
  )
  servers.push(server)
  return { port: server.port, token }
}

function get(port: number, path: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
}

describe('control api', () => {
  it('serves health and manifest to the bearer', async () => {
    const { port, token } = await start()
    const health = await fetchPeerHealth(port, token)
    expect(health).toMatchObject({ profile: 'web', form: 'web', bridgeVersion: '0.4.0' })
    const remote = await fetchPeerManifest(port, token)
    expect(remote?.bundles).toContain('@moyu-good/dsh-lark-bridge')
  })

  it('rejects missing and wrong tokens', async () => {
    const { port, token } = await start()
    expect((await get(port, '/control/health')).status).toBe(401)
    expect((await get(port, '/control/health', 'wrong')).status).toBe(401)
    expect((await get(port, '/control/health', token)).status).toBe(200)
  })

  it('404s unknown routes and returns null on a dead peer', async () => {
    const { port, token } = await start()
    expect((await get(port, '/control/nope', token)).status).toBe(404)
    const dead = await fetchPeerManifest(1, token, 300)
    expect(dead).toBeNull()
  })
})
