/**
 * The `/bot` command: bridge identity, cross-form settings, and plugin sync —
 * the chat-facing surface of the dual-end sync feature (see
 * docs/design/设计卡_双端设置与同步.md). Text-first, matching the bridge's
 * other control commands; every mutating subcommand echoes masked secrets.
 * @module dsh-lark-bridge/sync/bot-command
 */

import { exec } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { CommandOutcome } from '../commands.ts'
import { maskSecret, readSettings, updateSettings, SHARED_KEYS } from './settings-store.ts'
import type { SharedSettings } from './settings-store.ts'
import { heartbeat, listPeers, selfEntry, PEER_TTL_MS } from './peers.ts'
import type { PeerEntry } from './peers.ts'
import { readProfileManifest } from './profile-manifest.ts'
import { buildSyncPlan, applySyncPlan } from './plugin-sync.ts'
import { fetchPeerManifest } from './control-api.ts'
import { buildMigration, buildImportPlan, crossHostWarning, readMigration, resolveMigrationFile, SECRET_KEYS } from './migrate.ts'
import type { MigrationFile, TraveledProfile } from './migrate.ts'
import fsp from 'node:fs/promises'

/** Everything `/bot` needs from the runtime to operate. */
export interface SyncCommandContext {
  /** Shared-home override; defaults to `$DSH_HOME` or `~/.dsh`. */
  home?: string | undefined
  /** This instance's runtime form. */
  form: 'web' | 'desktop'
  /** Profile name this instance runs under. */
  profile: string
  bridgeVersion: string
  /** This instance's control-API port, when listening. */
  controlPort?: number | undefined
  /** This instance's control-API bearer token, published via heartbeat. */
  controlToken?: string | undefined
  /** Harness home for reading local profile manifests. */
  harnessHome?: string | undefined
  /** Production command runner for plugin installs; injectable for tests. */
  runCommand?: (command: string) => Promise<void>
}

let activeContext: SyncCommandContext | undefined

/**
 * Publish the runtime-built sync context. The bridge's command dispatcher
 * reads it via {@link getSyncContext}; the module-singleton pattern matches
 * `setRestartScheduler` in commands.ts.
 */
export function setSyncContext(context: SyncCommandContext): void {
  activeContext = context
}

/** The runtime-published sync context, when the runtime wired one. */
export function getSyncContext(): SyncCommandContext | undefined {
  return activeContext
}

/** The subcommands `/bot` accepts. */
const SUBCOMMANDS = new Set(['set', 'unset', 'peers', 'sync-plugins', 'export', 'import'])

/**
 * Handle `/bot [subcommand …]`. Returns the reply for the chat; every secret
 * is masked before it leaves this module.
 */
export async function runBotCommand(
  line: string,
  ctx: SyncCommandContext,
): Promise<CommandOutcome> {
  const arg = line.slice(1 + 'bot'.length).trim()
  const [sub, ...rest] = arg.split(/\s+/)
  const subcommand = sub ?? ''

  if (subcommand === '') return statusReply(ctx)
  if (subcommand === 'set') return setReply(ctx, rest)
  if (subcommand === 'unset') return unsetReply(ctx, rest)
  if (subcommand === 'peers') return peersReply(ctx)
  if (subcommand === 'sync-plugins') return syncPluginsReply(ctx, rest)
  if (subcommand === 'export') return exportReply(ctx, rest)
  if (subcommand === 'import') return importReply(ctx, rest)
  return {
    reply: `⚠️ 未知子命令 \`${subcommand}\`。可用：${[...SUBCOMMANDS].map((s) => `\`${s}\``).join(' / ')}（无参数 = 状态面板）`,
    resolved: false,
  }
}

async function statusReply(ctx: SyncCommandContext): Promise<CommandOutcome> {
  const peers = await listPeers(ctx.home)
  const settings = await readSettings(ctx.home)
  const sharedKeys = Object.keys(settings)
  const peerRows = peers.length === 0
    ? '（无其他端在线——对端桥未运行或未装本插件）'
    : peers.map((p) => {
      const age = Math.round((Date.now() - p.ts) / 1000)
      return `- **${p.profile}**（${p.form}）v${p.bridgeVersion} @ ${p.host}${p.port === undefined ? '' : ` :${p.port}`}（心跳 ${age}s 前）`
    }).join('\n')
  const settingRows = sharedKeys.length === 0
    ? '（共享设置为空——双端配置尚未建立）'
    : sharedKeys.map((key) => {
      const value = settings[key as keyof SharedSettings] ?? ''
      const masked = key.toLowerCase().includes('secret') || key.toLowerCase().includes('appid')
        ? maskSecret(value)
        : value
      return `- ${key}: \`${masked}\``
    }).join('\n')
  return {
    reply: [
      `**桥 · 双端状态**`,
      `- 本端：**${ctx.profile}**（${ctx.form}）v${ctx.bridgeVersion}`,
      `- 在线对端（${PEER_TTL_MS / 1000}s 心跳窗口）：`,
      peerRows,
      `- 共享设置（${syncDirHint()}）：`,
      settingRows,
      '',
      '子命令：`/bot set <key> <value>` / `/bot unset <key>` / `/bot peers` / `/bot sync-plugins [apply]` / `/bot export [include-secrets]` / `/bot import [file] [apply]`',
    ].join('\n'),
    resolved: true,
  }
}

async function setReply(ctx: SyncCommandContext, rest: string[]): Promise<CommandOutcome> {
  const [key, value] = [rest[0], rest.slice(1).join(' ')]
  if (key === undefined || value === '') {
    return {
      reply: `⚠️ 格式：\`/bot set <key> <value>\`。可设键：${SHARED_KEYS.map((k) => `\`${k}\``).join(' / ')}`,
      resolved: false,
    }
  }
  if (!isSharedKey(key)) {
    return { reply: `⚠️ \` ${key} \` 不是可共享键。可用：${SHARED_KEYS.map((k) => `\`${k}\``).join(' / ')}`, resolved: false }
  }
  const next = await updateSettings(ctx.home, (current) => ({ ...current, [key]: value }))
  const transport = key === 'appId' || key === 'appSecret' || key === 'domain'
  const echo = key.toLowerCase().includes('secret') || key.toLowerCase().includes('appid')
    ? maskSecret(value)
    : value
  return {
    reply: [
      `✅ \`${key}\` 已写入共享设置（\`${echo}\`）。`,
      transport
        ? '⚠️ 该字段影响飞书连接——两端桥在下次重启/重连后生效。'
        : '其他端在下次读取时自动生效。',
      `当前共 ${Object.keys(next).length} 个共享键。`,
    ].join('\n'),
    resolved: true,
  }
}

async function unsetReply(ctx: SyncCommandContext, rest: string[]): Promise<CommandOutcome> {
  const key = rest[0]
  if (key === undefined || !isSharedKey(key)) {
    return { reply: `⚠️ 格式：\`/bot unset <key>\`。可用：${SHARED_KEYS.map((k) => `\`${k}\``).join(' / ')}`, resolved: false }
  }
  await updateSettings(ctx.home, (current) => {
    if (!(key in current)) return undefined
    const next: SharedSettings = { ...current }
    delete next[key as keyof SharedSettings]
    return next
  })
  return { reply: `✅ \`${key}\` 已从共享设置移除（本端 profile 注入值将重新生效）。`, resolved: true }
}

async function peersReply(ctx: SyncCommandContext): Promise<CommandOutcome> {
  const mine = selfEntry(ctx.form, ctx.profile, ctx.bridgeVersion, ctx.controlPort, ctx.controlToken)
  const peers = await heartbeat(mine, ctx.home)
  if (peers.length === 0) {
    return { reply: '**在线对端**：无。对端装桥并运行后，30s 内会出现在这里。', resolved: true }
  }
  const rows = peers.map((p: PeerEntry) =>
    `- **${p.profile}**（${p.form}）v${p.bridgeVersion} @ ${p.host}${p.port === undefined ? '' : ` :${p.port}`}${p.token === undefined ? '' : ' 🔑'}`)
  return { reply: `**在线对端**\n${rows.join('\n')}`, resolved: true }
}

async function syncPluginsReply(ctx: SyncCommandContext, rest: string[]): Promise<CommandOutcome> {
  const apply = rest.includes('apply')
  const mine = selfEntry(ctx.form, ctx.profile, ctx.bridgeVersion, ctx.controlPort, ctx.controlToken)
  const peers = await heartbeat(mine, ctx.home)
  const peer = peers.find((p) => p.manifest !== undefined)
    ?? peers.find((p) => p.port !== undefined && p.token !== undefined)
    ?? peers[0]
  if (peer === undefined) {
    return { reply: '⚠️ 无在线对端可同步。对端桥需运行且通过心跳互见。', resolved: false }
  }
  // Manifest travels in-band with the heartbeat; the control API is the
  // fallback for older peers that only expose the endpoint.
  let there = peer.manifest === undefined
    ? null
    : { ...peer.manifest, mtimeMs: peer.ts }
  if (there === null) {
    if (peer.port === undefined || peer.token === undefined) {
      return { reply: `⚠️ 对端 **${peer.profile}** 既无带内清单也未暴露 control API，无法同步。`, resolved: false }
    }
    there = await fetchPeerManifest(peer.port, peer.token)
  }
  if (there === null) {
    return { reply: `⚠️ 对端 **${peer.profile}** 的 control API 不可达（:${peer.port}）。`, resolved: false }
  }
  const here = await readProfileManifest(ctx.harnessHome ?? defaultHarnessHome(), ctx.profile)
  if (here === null) {
    return { reply: `⚠️ 本端 profile \`${ctx.profile}\` 的 package.json 不存在于 ${ctx.harnessHome ?? '~/.dsh'}。`, resolved: false }
  }
  const plan = buildSyncPlan(here, there)
  if (plan.steps.length === 0) {
    return { reply: `✅ 与 **${peer.profile}** 的插件清单已一致（共享 ${plan.inSync.length} 个包）。`, resolved: true }
  }
  const stepRows = plan.steps.map((step) => step.kind === 'add'
    ? `- 安装 \`${step.spec}\`（\`${step.command}\`）`
    : `- 启用 bundle \`${step.bundle}\`（已装未启用——需人工确认）`)
  if (!apply) {
    return {
      reply: [
        `**同步预览（dry-run）**：从 **${peer.profile}** 采纳 ${plan.steps.length} 项变更：`,
        ...stepRows,
        '',
        `确认执行请发：\`/bot sync-plugins apply\``,
      ].join('\n'),
      resolved: true,
    }
  }
  const runner = ctx.runCommand ?? defaultRunner
  const result = await applySyncPlan(plan, runner)
  const lines = [
    `**同步执行完毕**：成功 ${result.ran.length}，跳过 ${result.skipped.length}，失败 ${result.failures.length}`,
    ...result.ran.map((s) => `✅ ${s.spec}`),
    ...result.skipped.map((s) => `⏸ \`${s.bundle}\`（已装未启用，请人工确认）`),
    ...result.failures.map((f) => `⚠️ ${f.step.spec}：${f.error}`),
  ]
  return { reply: lines.join('\n'), resolved: true }
}

/**
 * `/bot export [include-secrets]` — collect the movable state (shared
 * settings + per-profile plugin lists) into a single JSON file in the sync
 * directory. Credentials are masked unless explicitly included; live state
 * (peers, tokens, node_modules) never enters the document by construction.
 */
async function exportReply(ctx: SyncCommandContext, rest: string[]): Promise<CommandOutcome> {
  const includeSecrets = rest.includes('include-secrets')
  const harnessHome = ctx.harnessHome ?? defaultHarnessHome()
  const file = await buildMigration(ctx.home, harnessHome, ctx.profile, ctx.form, { includeSecrets })
  // One fixed landing slot: `/bot import` finds it without arguments, and a
  // re-export just refreshes it (the document is reproducible from live state).
  const target = resolveMigrationFile('migrate.json', ctx.home)
  await fsp.writeFile(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  const profileRows = Object.entries(file.profiles)
    .map(([name, p]) => `- profile \`${name}\`：${Object.keys(p.dependencies).length} 个包，${p.bundles.length} 个 bundle`)
  return {
    reply: [
      `**迁移文件已导出**：\`${target}\``,
      `- 共享设置 ${Object.keys(file.settings).length} 个键${includeSecrets ? '' : '（凭证已掩码）'}`,
      ...profileRows,
      '',
      includeSecrets
        ? '⚠️ 此文件**含明文凭证**——只经可信渠道带到新机，导入后建议删除。'
        : '导入端需重新 `/bot set appSecret <值>`（掩码值不会被导入）。',
      '会话历史在 `~/.dsh`（上游管理）——整目录拷贝即可带走，本文件不含。',
    ].join('\n'),
    resolved: true,
  }
}

/**
 * `/bot import [file] [apply]` — restore from a migration file. Preview by
 * default (settings to write + plugin plan + cross-host double-delivery
 * warning); `apply` executes. Masked secret values are never written — the
 * operator re-enters them via `/bot set`.
 */
async function importReply(ctx: SyncCommandContext, rest: string[]): Promise<CommandOutcome> {
  const apply = rest.includes('apply')
  const nameArg = rest.find((token) => token !== 'apply')
  let file: MigrationFile
  try {
    file = await readMigration(nameArg, ctx.home)
  } catch (error) {
    return { reply: `⚠️ ${error instanceof Error ? error.message : String(error)}`, resolved: false }
  }
  const warning = crossHostWarning(file)
  // Masked credentials stay out of local settings: `****last4` would clobber
  // the real value. They surface as a re-enter list instead.
  const writable: Record<string, string> = {}
  const reenter: string[] = []
  for (const [key, value] of Object.entries(file.settings)) {
    if ((SECRET_KEYS as readonly string[]).includes(key) && typeof value === 'string' && value.startsWith('****')) {
      reenter.push(key)
      continue
    }
    writable[key] = value
  }
  const harnessHome = ctx.harnessHome ?? defaultHarnessHome()
  const plans: { profile: string; plan: ReturnType<typeof buildImportPlan> }[] = []
  for (const [profile, traveled] of Object.entries(file.profiles)) {
    const local = await readProfileManifest(harnessHome, profile)
    plans.push({ profile, plan: buildImportPlan(local, profile, traveled as TraveledProfile) })
  }
  const totalSteps = plans.reduce((sum, entry) => sum + entry.plan.steps.length, 0)
  if (!apply) {
    const settingRows = Object.keys(writable).map((key) => `- \`${key}\``)
    const planRows = plans.flatMap(({ profile, plan }) => plan.steps.map((step) => step.kind === 'add'
      ? `- 安装 \`${profile}\` ← ${step.spec}`
      : `- 启用 bundle \`${profile}\` ← ${step.bundle}`))
    return {
      reply: [
        `**导入预览**（来自 **${file.from.host}** · ${file.exportedAt}）：`,
        `- 将写入共享设置：${settingRows.length === 0 ? '（无）' : ''}`,
        ...settingRows,
        ...planRows,
        ...(reenter.length > 0 ? [`- ⚠️ 凭证已掩码，导入后需重设：${reenter.map((key) => `\`${key}\``).join('、')}`] : []),
        ...(totalSteps === 0 && settingRows.length === 0 ? ['- 本机已是目标状态，无需变更'] : []),
        ...(warning !== null ? ['', warning] : []),
        '',
        `确认执行请发：\`/bot import apply${nameArg !== undefined && nameArg !== '' ? ` ${nameArg}` : ''}\``,
      ].join('\n'),
      resolved: true,
    }
  }
  if (Object.keys(writable).length > 0) {
    await updateSettings(ctx.home, (current) => ({ ...current, ...writable }))
  }
  const runner = ctx.runCommand ?? defaultRunner
  const lines: string[] = [`**导入执行完毕**（来自 **${file.from.host}**）：`]
  lines.push(`- ✅ 共享设置写入 ${Object.keys(writable).length} 个键`)
  for (const { profile, plan } of plans) {
    if (plan.steps.length === 0) {
      lines.push(`- ✅ profile \`${profile}\`：插件清单已一致`)
      continue
    }
    const result = await applySyncPlan(plan, runner)
    lines.push(`- profile \`${profile}\`：成功 ${result.ran.length}，失败 ${result.failures.length}`)
    for (const step of result.ran) lines.push(`  - ✅ ${step.spec}`)
    for (const failure of result.failures) lines.push(`  - ⚠️ ${failure.step.spec}：${failure.error}`)
  }
  if (reenter.length > 0) {
    lines.push(`- ⚠️ 请补录凭证：${reenter.map((key) => `\`/bot set ${key} <值>\``).join('、')}`)
  }
  if (warning !== null) lines.push('', warning)
  return { reply: lines.join('\n'), resolved: true }
}

function isSharedKey(key: string): boolean {
  return (SHARED_KEYS as readonly string[]).includes(key)
}

function syncDirHint(): string {
  return '`~/.dsh/dsh-lark-bridge/settings.json`'
}

function defaultHarnessHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}


/** Production runner: upstream CLI, 2-minute ceiling per package. */
const defaultRunner = (command: string): Promise<void> => new Promise((resolve, reject) => {
  exec(command, { timeout: 120_000 }, (error) => {
    if (error !== null) reject(error)
    else resolve()
  })
})
