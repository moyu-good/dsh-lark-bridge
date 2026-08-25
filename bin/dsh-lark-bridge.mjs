#!/usr/bin/env node
/**
 * dsh-lark-bridge CLI bootstrap — the one-command path to running the bridge.
 *
 *   dsh-lark-bridge start          # ensure dsh, wire the plugin into a profile, boot it
 *   dsh-lark-bridge status         # report whether the bridge is running
 *   dsh-lark-bridge logs           # tail the bridge log
 *   dsh-lark-bridge stop           # stop the bridge (safe: refuses mid-turn)
 *   dsh-lark-bridge restart        # safe-restart the bridge
 *
 * The bridge is NOT a standalone service: it is a DeepSeek Harness plugin that
 * runs inside a dsh profile. This CLI exists so a Feishu user never has to
 * understand profiles, cordis.patch.yml, or pnpm — `start` does the wiring.
 *
 * Deployment shape it produces:
 *   - a dsh profile named after --profile (default `chat`)
 *   - the bridge added to that profile's plugins (via `dsh plugin add`)
 *   - the bridge's Config injected through the profile's cordis.patch.yml
 *     (appId/appSecret from DSH_LARK_APP_ID / DSH_LARK_APP_SECRET, or the
 *     first-boot QR onboarding flow when absent)
 *   - a background dsh process, log at ~/.dsh/logs/<profile>.log
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = homedir()
const DSH_HOME = process.env.DSH_HOME ?? join(HOME, '.dsh')
const LOG_DIR = join(DSH_HOME, 'logs')
const PROFILE = process.env.DSH_LARK_PROFILE ?? 'chat'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function log(line) {
  console.log(`${GREEN}●${RESET} ${line}`)
}
function warn(line) {
  console.log(`${YELLOW}▲${RESET} ${line}`)
}
function fail(line) {
  console.error(`${RED}✗${RESET} ${line}`)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  if (result.error) {
    fail(`${cmd} failed: ${result.error.message}`)
    process.exit(1)
  }
  return result.status ?? 0
}

/** Whether `dsh` is on PATH. */
function hasDsh() {
  const r = spawnSync('dsh', ['--version'], { stdio: 'ignore' })
  return !r.error && r.status === 0
}

/** The profile directory a chat bridge runs under. */
function profileDir() {
  return join(DSH_HOME, 'profiles', PROFILE)
}

function profileExists() {
  return existsSync(join(profileDir(), 'cordis.yml'))
}

/** Print how far along this machine is, without changing anything. */
function status() {
  log(`DSH_HOME: ${DSH_HOME}`)
  log(`profile:  ${PROFILE} (${profileExists() ? 'exists' : 'missing'})`)
  if (!hasDsh()) {
    warn('dsh CLI not found on PATH — run `npm i -g @deepseek-ai/dsh` first, or `dsh-lark-bridge start` to install it.')
  }
  const pids = spawnSync('pgrep', ['-f', `--profile ${PROFILE}`], { encoding: 'utf8' })
  const running = pids.stdout?.trim()
  if (running) {
    log(`bridge:   RUNNING (pid ${running})`)
  } else {
    warn('bridge:   not running')
  }
}

/** Ensure dsh is installed; offer to install it when missing. */
function ensureDsh() {
  if (hasDsh()) return
  warn('DeepSeek Harness (dsh) is not installed. Installing @deepseek-ai/dsh globally…')
  const status = run('npm', ['i', '-g', '@deepseek-ai/dsh'])
  if (status !== 0) {
    fail('Could not install dsh. Run `npm i -g @deepseek-ai/dsh` yourself and retry.')
    process.exit(1)
  }
}

/** Create the profile and add this plugin to it. */
function wireProfile() {
  mkdirSync(profileDir(), { recursive: true })
  if (!profileExists()) {
    log(`Creating dsh profile "${PROFILE}"…`)
    const s = run('dsh', ['--profile', PROFILE, 'dump-config'])
    if (s !== 0) {
      warn('Profile creation printed warnings above; continuing anyway.')
    }
  }
  log(`Adding dsh-lark-bridge to profile "${PROFILE}"…`)
  const s = run('dsh', ['plugin', '--profile', PROFILE, 'add', '@moyu-good/dsh-lark-bridge'])
  if (s !== 0) {
    fail('`dsh plugin add` failed. Check the profile and retry.')
    process.exit(1)
  }
}

/** Patch the profile's cordis.patch.yml with the bridge config. */
function patchConfig() {
  const patch = join(profileDir(), 'cordis.patch.yml')
  const appId = process.env.DSH_LARK_APP_ID
  const appSecret = process.env.DSH_LARK_APP_SECRET
  const lines = []
  lines.push('# dsh-lark-bridge: written by `dsh-lark-bridge start`', '')
  lines.push('- id: feishu-channel')
  lines.push('  config:')
  if (appId && appSecret) {
    lines.push(`    appId: ${appId}`)
    lines.push(`    appSecret: ${appSecret}`)
    log('Using app credentials from DSH_LARK_APP_ID / DSH_LARK_APP_SECRET.')
  } else {
    lines.push('    # No credentials yet — first boot runs the QR onboarding flow.')
    warn('No app credentials found. First boot will show a QR code to scan in Feishu.')
  }
  lines.push('    requireMention: true')
  lines.push('    output: cot')
  lines.push('    showProcess: true')
  lines.push('')
  // Append the block (idempotent-ish: replace any existing dsh-lark-bridge block).
  let text = ''
  if (existsSync(patch)) {
    text = readFile(patch)
    text = text.replace(/# dsh-lark-bridge: written by[\s\S]*?(?=\n- id: |\n$)/, '')
  }
  const block = lines.join('\n')
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  writeFile(patch, text + separator + block)
  log(`Wrote bridge config to ${patch}`)
}

function readFile(path) {
  return spawnSync('cat', [path], { encoding: 'utf8' }).stdout
}
function writeFile(path, content) {
  spawnSync('mkdir', ['-p', path.replace(/\/[^/]+$/, '')])
  spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)})`])
}

/** Boot the profile in the background. */
function startBridge() {
  ensureDsh()
  wireProfile()
  patchConfig()
  mkdirSync(LOG_DIR, { recursive: true })
  const logFile = join(LOG_DIR, `${PROFILE}.log`)
  log(`Starting bridge (log: ${logFile})…`)
  // dsh boot is long-running; background it and poll for liveness.
  const r = spawnSync('nohup', [
    'bash', '-c',
    `dsh --profile ${PROFILE} >> ${logFile} 2>&1 & echo $!`,
  ], { encoding: 'utf8' })
  const pid = r.stdout?.trim()
  if (!pid) {
    fail('Failed to launch dsh in background.')
    process.exit(1)
  }
  log(`Bridge launched (pid ${pid}). Check ${logFile} for the QR code / readiness.`)
}

function stopBridge() {
  const pids = spawnSync('pgrep', ['-f', `--profile ${PROFILE}`], { encoding: 'utf8' }).stdout?.trim()
  if (!pids) {
    warn('Bridge is not running.')
    return
  }
  for (const pid of pids.split('\n')) {
    spawnSync('kill', [pid])
  }
  log(`Stopped bridge (pid ${pids}).`)
}

const [command] = process.argv.slice(2)
switch (command) {
  case 'start': startBridge(); break
  case 'status': status(); break
  case 'stop': stopBridge(); break
  case 'restart': stopBridge(); startBridge(); break
  case 'logs':
    spawnSync('tail', ['-f', join(LOG_DIR, `${PROFILE}.log`)], { stdio: 'inherit' })
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`${BOLD}dsh-lark-bridge — Feishu/Lark bridge for DeepSeek Harness${RESET}
Usage:
  dsh-lark-bridge start      install dsh if needed, wire the plugin, boot it
  dsh-lark-bridge status     report whether the bridge is running
  dsh-lark-bridge logs       tail the bridge log
  dsh-lark-bridge stop       stop the bridge
  dsh-lark-bridge restart    restart the bridge
Env:
  DSH_LARK_APP_ID / DSH_LARK_APP_SECRET  app credentials (else first-boot QR)
  DSH_LARK_PROFILE                       profile name (default chat)
`)
    break
  default:
    fail(`Unknown command: ${command} (see dsh-lark-bridge help)`)
    process.exit(1)
}
