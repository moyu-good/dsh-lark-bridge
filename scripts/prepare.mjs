#!/usr/bin/env node
/**
 * `prepare` hook: make the package work when installed as a git dependency.
 *
 * The repo now COMMITS the compiled `lib/` output, so npm/pnpm installs (and
 * the published package, whose `files` already lists `lib`) work with zero
 * build steps. This hook only kicks in for the remaining path — someone
 * cloning the source tree without the committed output — and rebuilds it.
 * It exits 0 immediately when the output exists, so a normal install never
 * pays for a build it does not need.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const REQUIRED = ['lib/index.js', 'lib/invariant.js', 'lib/startup.js']

if (REQUIRED.every(path => existsSync(path))) {
  process.exit(0)
}

console.error('[dsh-lark-bridge] prepare: compiled output missing, building…')
const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
if (result.status !== 0) {
  console.error(
    '[dsh-lark-bridge] prepare: build failed. Install devDependencies (npm install) then rerun, '
    + 'or install the package from the npm registry / the GitHub release which ships prebuilt lib/.',
  )
  process.exit(result.status ?? 1)
}
