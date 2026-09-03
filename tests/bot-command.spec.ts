import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runBotCommand } from '../src/sync/bot-command.ts'
import type { SyncCommandContext } from '../src/sync/bot-command.ts'
import { startControlApi } from '../src/sync/control-api.ts'
import { heartbeat, selfEntry } from '../src/sync/peers.ts'
import { writeSettings } from '../src/sync/settings-store.ts'

const servers: { close(): Promise<void> }[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function ctx(home: string, overrides: Partial<SyncCommandContext> = {}): SyncCommandContext {
  return {
    home,
    form: 'web',
    profile: 'web',
    bridgeVersion: '0.4.0-test',
    ...overrides,
  }
}

describe('runBotCommand', () => {
  it('shows status with masked secrets', async () => {
    const home = home_()
    await writeSettings({ appId: 'cli_aabbccddeeff', appSecret: 'supersecretvalue', locale: 'zh' }, home)
    const out = await runBotCommand('/bot', ctx(home))
    expect(out.resolved).toBe(true)
    expect(out.reply).toContain('****eeff')
    expect(out.reply).toContain('****alue')
    expect(out.reply).not.toContain('supersecretvalue')
    expect(out.reply).not.toContain('cli_aabbccddeeff')
  })

  it('set writes the shared file and unset removes it', async () => {
    const home = home_()
    const out = await runBotCommand('/bot set model deepseek-v4-pro', ctx(home))
    expect(out.resolved).toBe(true)
    const settings = await import('../src/sync/settings-store.ts')
    expect((await settings.readSettings(home)).model).toBe('deepseek-v4-pro')

    const unset = await runBotCommand('/bot unset model', ctx(home))
    expect(unset.resolved).toBe(true)
    expect((await settings.readSettings(home)).model).toBeUndefined()
  })

  it('rejects unknown keys and unknown subcommands', async () => {
    const home = home_()
    const badKey = await runBotCommand('/bot set notakey x', ctx(home))
    expect(badKey.resolved).toBe(false)
    const badSub = await runBotCommand('/bot wat', ctx(home))
    expect(badSub.resolved).toBe(false)
  })

  it('reports no peer when the other end is silent', async () => {
    const home = home_()
    const out = await runBotCommand('/bot sync-plugins', ctx(home))
    expect(out.reply).toContain('无在线对端')
  })

  it('dry-runs the plan against a live peer control API', async () => {
    const home = home_()
    const token = 'peer-token-1'
    const server = await startControlApi(
      {
        profile: 'desktop',
        form: 'desktop',
        bridgeVersion: '0.4.0-test',
        manifest: async () => ({
          profile: 'desktop',
          dependencies: {
            '@deepseek-ai/cordis': '^4.0.1',
            'community/cool-skill': '1.2.3',
          },
          bundles: ['@deepseek-ai/cordis'],
          mtimeMs: 1,
        }),
      },
      token,
    )
    servers.push(server)
    // The peer heartbeats with its control endpoint and token.
    await heartbeat(
      selfEntry('desktop', 'desktop', '0.4.0-test', server.port, token),
      home,
    )
    // This end has the bridge but not the community plugin.
    const { writeSettings: ws } = await import('../src/sync/settings-store.ts')
    await ws({ appId: 'cli_web' }, home)

    const out = await runBotCommand('/bot sync-plugins', ctx(home))
    expect(out.resolved).toBe(true)
    expect(out.reply).toContain('dry-run')
    expect(out.reply).toContain('community/cool-skill@1.2.3')
    expect(out.reply).toContain('/bot sync-plugins apply')
  })

  it('applies the plan through the injected runner', async () => {
    const home = home_()
    const token = 'peer-token-2'
    const server = await startControlApi(
      {
        profile: 'desktop',
        form: 'desktop',
        bridgeVersion: '0.4.0-test',
        manifest: async () => ({
          profile: 'desktop',
          dependencies: {
            '@deepseek-ai/cordis': '^4.0.1',
            'community/cool-skill': '1.2.3',
          },
          bundles: ['@deepseek-ai/cordis'],
          mtimeMs: 1,
        }),
      },
      token,
    )
    servers.push(server)
    await heartbeat(selfEntry('desktop', 'desktop', '0.4.0-test', server.port, token), home)

    const ran: string[] = []
    const out = await runBotCommand('/bot sync-plugins apply', ctx(home, {
      runCommand: async (command: string) => {
        ran.push(command)
      },
    }))
    expect(ran).toEqual(['dsh plugin --profile web add community/cool-skill@1.2.3'])
    expect(out.reply).toContain('成功 1')
  })
})

/** One isolated fake home per test. */
function home_(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bot-cmd-'))
}

