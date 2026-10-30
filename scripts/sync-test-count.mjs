#!/usr/bin/env node
/**
 * Put the test count in the documents where it belongs.
 *
 * Why this exists: the count is written in four places per document —
 * the badge, the repository map, the quality-gate comment — and every
 * test added makes all of them wrong. The gate that checks the count is
 * the gate that fails first, so the fix has to be one command, not four
 * edits. A number that is wrong in one place and right in another is
 * worse than a number that is simply absent.
 *
 * The count comes from the test files themselves, counted the way the
 * runner counts them: every call site, wherever it is written.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `URL.pathname` keeps the leading slash on Windows (`/D:/…`), and joining that
// to a relative path yields `D:\D:\…` — the script then cannot find `tests/` at
// all. `fileURLToPath` is the conversion that knows about drive letters.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let tests = 0
let suites = 0
for (const file of readdirSync(join(ROOT, 'tests'))) {
  if (!file.endsWith('.spec.ts')) continue
  suites += 1
  const source = readFileSync(join(ROOT, 'tests', file), 'utf8')
  // No `\s*` between the name and the paren: prose like "upgrade the harness to
  // open it (raw log: …)" inside a string literal is not a test call, and
  // counting it made this script write a number the docs gate then rejected.
  tests += [...source.matchAll(/\bit(?:\.each)?\(/g)].length
}

const FILES = ['README.md', 'README.zh.md']
const EDITS = [
  [/tests-(\d+)%20passing/g, `tests-${tests}%20passing`],
  [/vitest suites \((\d+)\)/g, `vitest suites (${suites})`],
  [/vitest 套件（\d+ 个）/g, `vitest 套件（${suites} 个）`],
  [/# (\d+) unit\/integration tests/g, `# ${tests} unit/integration tests`],
  [/# (\d+) 单测\/集成/g, `# ${tests} 单测/集成`],
  // The quality-gate comment changed shape after these two patterns were
  // written, and the count gate went on accepting the stale number because
  // nothing rewrote it. Both current shapes are handled here.
  [/# (\d+) tests in (\d+) spec files/g, `# ${tests} tests in ${suites} spec files`],
  [/# (\d+) 条测试 \/ (\d+) 个 spec 文件/g, `# ${tests} 条测试 / ${suites} 个 spec 文件`],
]

for (const file of FILES) {
  const original = read(file)
  let updated = original
  for (const [pattern, replacement] of EDITS) updated = updated.replace(pattern, replacement)
  if (updated === original) {
    console.log(`  ${file}: already says ${tests} tests in ${suites} suites`)
    continue
  }
  writeFileSync(join(ROOT, file), updated, 'utf8')
  console.log(`  ${file}: updated to ${tests} tests in ${suites} suites`)
}
