#!/usr/bin/env node
/**
 * Newcomer journey eval — the "60-second quick start" measured as a newcomer
 * actually experiences it, in a throwaway environment. This is the baseline
 * instrument for the newcomer-experience pivot: every step is timed, every
 * failure is recorded with its real error, and the report is a funnel.
 *
 * Steps:
 *   S1 install the upstream dsh CLI (default pnpm — ~20s; JOURNEY_PKG=npx for the
 *      npm comparison, which measures ~25min on Windows and OOMs on ≤4GB RAM)
 *   S2 install this bridge into a fresh profile from GitHub
 *   S3 verify the profile composition picked the bridge up
 *   S4 boot `dsh web` on the fresh profile and measure time-to-listen
 *
 * Usage (from the repo root):
 *   node journey/newcomer.mjs [--keep] [--skip S4]
 * Environment:
 *   JOURNEY_KEEP=1     keep the throwaway home for inspection
 *   JOURNEY_HOME=...   reuse a previous throwaway home (resume)
 *   JOURNEY_PKG=pnpm   package manager driving the steps: pnpm (default) | npx
 * Output:
 *   journey/report-<ts>.json + console funnel
 * @module journey/newcomer
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = process.cwd()
const TS = new Date().toISOString().replace(/[:.]/g, '-')
const KEEP = process.env.JOURNEY_KEEP === '1' || process.argv.includes('--keep')
const SKIP = new Set(process.argv.includes('--skip') ? process.argv[process.argv.indexOf('--skip') + 1].split(',') : [])

/** Package manager driving the journey. pnpm is the documented quick path
 * (parallel install, ~20s for the whole dsh tree); npx is the slow control
 * (~25min on Windows, OOM-prone on small RAM) kept for A/B baselining. */
const PKG = process.env.JOURNEY_PKG === 'npx' ? 'npx' : 'pnpm'
/** pnpm dlx needs no -y; npx needs -y to skip its prompt. */
const runner = PKG === 'pnpm' ? ['pnpm', 'dlx'] : ['npx', '-y']
/** S1 install budget: pnpm's parallel path settles well under 10min; give the
 * npm control enough rope to actually finish its ~25min reify. */
const S1_TIMEOUT = PKG === 'pnpm' ? 600_000 : 1_800_000

/** The throwaway environment a newcomer starts from. */
const ROOT = process.env.JOURNEY_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-journey-'))
const HOME = path.join(ROOT, 'home')
const NPM_CACHE = path.join(ROOT, 'npm-cache')
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(NPM_CACHE, { recursive: true })

const report = { startedAt: new Date().toISOString(), root: ROOT, steps: [], env: {
  node: process.version, platform: `${os.type()} ${os.release()}`, user: os.userInfo().username, pkg: PKG,
} }

function run(name, command, args, { timeoutMs = 300_000, cwd = REPO, env = {} } = {}) {
  const step = { name, command: [command, ...args].join(' '), startedAt: new Date().toISOString() }
  const t0 = Date.now()
  console.log(`\n▶ ${name}: ${step.command}`)
  const res = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      HOME,
      npm_config_cache: NPM_CACHE,
      DSH_HOME: path.join(HOME, '.dsh'),
      ...env,
    },
  })
  step.ms = Date.now() - t0
  step.status = res.status === 0 ? 'ok' : (res.error?.code === 'ETIMEDOUT' ? 'timeout' : `exit ${res.status}`)
  step.stdoutTail = (res.stdout ?? '').split('\n').filter(Boolean).slice(-8)
  step.stderrTail = (res.stderr ?? '').split('\n').filter(Boolean).slice(-8)
  report.steps.push(step)
  console.log(`  ${step.status === 'ok' ? '✓' : '✗'} ${step.status} in ${(step.ms / 1000).toFixed(1)}s`)
  if (step.status !== 'ok') {
    for (const line of step.stderrTail) console.log(`    | ${line}`)
  }
  return res
}

async function waitUntil(predicate, { timeoutMs = 120_000, intervalMs = 1000, label = '' }) {
  const t0 = Date.now()
  for (;;) {
    if (predicate()) return Date.now() - t0
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function summary() {
  const failed = report.steps.filter((step) => step.status !== 'ok' && !step.expectedFailure)
  const totalMs = report.steps.reduce((sum, step) => sum + (step.ms ?? 0), 0)
  report.summary = {
    totalSeconds: Math.round(totalMs / 100) / 10,
    failedSteps: failed.map((step) => step.name),
    verdict: failed.length === 0 ? 'funnel intact' : `funnel breaks at: ${failed[0].name}`,
  }
}

function writeReport() {
  summary()
  const file = path.join(REPO, 'journey', `report-${TS}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n═══ 新手旅程基线 ═══`)
  for (const step of report.steps) {
    console.log(`${step.status === 'ok' ? '✓' : '✗'} ${step.name.padEnd(28)} ${((step.ms ?? 0) / 1000).toFixed(1)}s`)
  }
  console.log(`总耗时 ${report.summary.totalSeconds}s — ${report.summary.verdict}`)
  console.log(`报告: ${file}`)
  return file
}

// ── S1: 上游 CLI 安装（全新缓存/全新 store） ──
if (!SKIP.has('S1')) {
  const res = run(`S1 upstream dsh CLI via ${PKG}`, runner[0], [...runner.slice(1), '@deepseek-ai/dsh', '--version'], { timeoutMs: S1_TIMEOUT })
  if (res.status !== 0) { writeReport(); process.exit(1) }
}

// ── S2: bridge plugin from npm registry. pnpm 11 blocks the protobufjs
//    (Feishu SDK dep) postinstall — a no-op script — so the FIRST attempt
//    fails with ERR_PNPM_IGNORED_BUILDS. The dsh profile template ships an
//    `allowBuilds: protobufjs: set this to true or false` placeholder; the
//    documented newcomer fix is to flip it to `true` and re-run. S2 records
//    both the first failure and the retry, so the funnel shows the real cost. ──
if (!SKIP.has('S2')) {
  const first = run('S2 bridge plugin from npm registry (first attempt)', runner[0], [
    ...runner.slice(1), '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', '@moyu-good/dsh-lark-bridge',
  ], { timeoutMs: 600_000 })
  if (first.status !== 0 && /IGNORED_BUILDS|Ignored build scripts/i.test(`${first.stderr ?? ''}${first.stdout ?? ''}`)) {
    report.steps.at(-1).expectedFailure = true // the documented pnpm-11 wall, not a funnel break
    const wsFile = path.join(HOME, '.dsh', 'profiles', 'web', 'pnpm-workspace.yaml')
    const ws = fs.readFileSync(wsFile, 'utf8')
    if (ws.includes('protobufjs: set this to true or false')) {
      fs.writeFileSync(wsFile, ws.replace('protobufjs: set this to true or false', 'protobufjs: true'))
      report.notes = { ...(report.notes ?? {}), s2_allowBuilds_intervention: 'flipped template placeholder to protobufjs: true (documented newcomer fix)' }
      console.log('  ↺ applied documented allowBuilds fix, retrying')
      const retry = run('S2b retry after allowBuilds flip', runner[0], [
        ...runner.slice(1), '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', '@moyu-good/dsh-lark-bridge',
      ], { timeoutMs: 600_000 })
      if (retry.status !== 0) { writeReport(); process.exit(1) }
    } else {
      writeReport(); process.exit(1)
    }
  } else if (first.status !== 0) { writeReport(); process.exit(1) }
}

// ── S3: profile 组装验证 ──
if (!SKIP.has('S3')) {
  const res = run('S3 verify profile composition', runner[0], [
    ...runner.slice(1), '@deepseek-ai/dsh', '--profile', 'web', '--dump-config',
  ], { timeoutMs: 120_000 })
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
  step3_note(text)
  if (res.status !== 0) { writeReport(); process.exit(1) }
}
function step3_note(text) {
  const step = report.steps.at(-1)
  step.notes = {
    bridgeInDeps: text.includes('dsh-lark-bridge'),
    feishuChannelPatched: /feishu-channel/i.test(text),
  }
}

// ── S4: `dsh web` 启动 + 监听测量（无飞书凭证，预期走 onboarding） ──
if (!SKIP.has('S4')) {
  const port = 18999
  const child = spawn(runner[0], [...runner.slice(1), '@deepseek-ai/dsh', 'web', '--port', String(port)], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME,
      npm_config_cache: NPM_CACHE,
      DSH_HOME: path.join(HOME, '.dsh'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const step = { name: 'S4 boot dsh web (fresh profile)', command: 'dsh web --port <port>', startedAt: new Date().toISOString() }
  report.steps.push(step)
  const t0 = Date.now()
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  try {
    step.ms = await waitUntil(() => out.includes('listening') || out.includes(`:${port}`) || out.includes('ready'), {
      timeoutMs: 180_000, label: 'dsh web to listen',
    })
    step.status = 'ok'
    step.bootTail = out.split('\n').filter(Boolean).slice(-6)
    // Onboarding expectation: no Feishu credentials configured → QR/first-boot surface.
    step.onboardingExpected = !out.includes('ws client ready')
  } catch (error) {
    step.status = 'timeout'
    step.error = error.message
    step.bootTail = out.split('\n').filter(Boolean).slice(-10)
  }
  console.log(`  ${step.status === 'ok' ? '✓' : '✗'} ${step.status} in ${((step.ms ?? 0) / 1000).toFixed(1)}s`)
  child.kill('SIGTERM')
}

const file = writeReport()
if (!KEEP && process.env.JOURNEY_HOME === undefined) {
  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`(throwaway env cleaned: ${ROOT})`)
} else {
  console.log(`(kept for inspection: ${ROOT})`)
}
process.exit(0)
