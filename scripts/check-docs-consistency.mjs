#!/usr/bin/env node
/**
 * Documentation consistency gate.
 *
 * Why this exists: the README promises things the bridge does not do. Four
 * times now a release went out with the documentation describing a
 * behaviour the code had never had — a "no login needed" line that returned
 * 401, a transcript that only carried one side of the conversation, a
 * harness version floor the code did not support, a test count that was
 * wrong. Nothing failed, because nothing checked.
 *
 * What it checks, and why each one is here:
 *
 *   1. The two READMEs describe the same commands. A reader of the Chinese
 *      one should not find a feature the English one does not mention.
 *   2. Every command the bridge implements appears in both. A command that
 *      works but is not written down is a command nobody finds.
 *   3. The test-count badge matches the number of tests that actually run.
 *      The badge is the number people trust, so it is the number that has
 *      to be right.
 *   4. The two versions of the manual say the same thing. The repository
 *      already has a test for this pair; it is listed here so the gate and
 *      the test agree about what "in step" means.
 *
 * What it cannot check: whether a description is *true*. That takes
 * reading. What it can do is catch the mechanical drift — the count, the
 * missing row, the two files disagreeing with each other — and every one
 * of those has shipped before.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `URL.pathname` keeps the leading slash on Windows (`/D:/…`), so joining it to
// a relative path yields `D:\D:\…` and every read fails with ENOENT — the gate
// then reported "cannot check" instead of checking. `fileURLToPath` knows about
// drive letters.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let failed = 0
const fail = (name, detail) => {
  console.log(`  \u274c ${name}${detail ? ' \u2014 ' + detail : ''}`)
  failed += 1
}
const pass = (name, detail) => {
  console.log(`  \u2705 ${name}${detail ? ' \u2014 ' + detail : ''}`)
}

/** The commands the bridge implements, read from where they are defined. */
function bridgeCommands() {
  const source = read('src/commands.ts')
  const names = [...source.matchAll(/export const [A-Z_]+_COMMAND\s*=\s*'([^']+)'/g)]
  return [...new Set(names.map((m) => m[1]))].sort()
}

/** The commands a README lists in its table, with how it attributes them. */
function documentedCommands(markdown) {
  const rows = [...markdown.matchAll(/^\| `\/([a-z-]+)` \| ([^|]*)\|/gm)]
  const map = new Map()
  for (const [, name, description] of rows) map.set(name, description.trim())
  return map
}

/**
 * The count of tests that run.
 *
 * Counting the call sites in the source is the same number the runner
 * reports, as long as every call is counted: a call that is not at the
 * start of a line — one written inside a loop or a helper — is still a
 * test, and counting only the ones at the start of a line is how the
 * badge came to be one off. The check counts every call site.
 */
function actualTestCount() {
  let total = 0
  for (const file of readdirSync(join(ROOT, 'tests'))) {
    if (!file.endsWith('.spec.ts')) continue
    const source = readFileSync(join(ROOT, 'tests', file), 'utf8')
    // No `\s*` between the name and the paren: prose like "upgrade the
    // harness to open it (raw log: …)" inside a string literal was being
    // counted as a test, which is how this gate spent months asserting 594
    // while the runner enumerated 593. A real call has no space after `it`.
    total += [...source.matchAll(/\bit(?:\.each)?\(/g)].length
  }
  return { count: total, source: 'source' }
}

function badgeCount(markdown) {
  // The badge URL encodes the space, so the number is followed by "%20".
  const badge = markdown.match(/tests-(\d+)%20passing/)
  if (badge !== null) return Number(badge[1])
  const plain = markdown.match(/tests-(\d+)\s+passing/)
  if (plain !== null) return Number(plain[1])
  // A shell comment inside the quality-gate block. The Chinese README writes
  // this comment in Chinese, so both spellings have to be recognised — a gate
  // that only reads one language silently stops checking the other.
  const comment = markdown.match(/#\s*(\d+)\s+(?:unit\/integration tests|test cases declared|tests in \d+ spec files)/)
  if (comment !== null) return Number(comment[1])
  const zhComment = markdown.match(/#\s*(\d+)\s+(?:单测\/集成|条测试用例声明|条测试 \/ \d+ 个 spec 文件)/)
  return zhComment === null ? undefined : Number(zhComment[1])
}

const commands = bridgeCommands()
const en = read('README.md')
const zh = read('README.zh.md')

console.log('\u2500\u2500 documentation consistency \u2500\u2500')

// 1. The two READMEs list the same commands.
const enCommands = documentedCommands(en)
const zhCommands = documentedCommands(zh)
const enNames = [...enCommands.keys()].sort()
const zhNames = [...zhCommands.keys()].sort()
if (JSON.stringify(enNames) === JSON.stringify(zhNames)) {
  pass('the two READMEs list the same commands', `${enNames.length} commands`)
} else {
  fail('the two READMEs list the same commands',
    `english has [${enNames.filter((c) => !zhNames.includes(c)).join(', ')}], `
    + `chinese has [${zhNames.filter((c) => !enNames.includes(c)).join(', ')}]`)
}

// 2. Every command the bridge implements is written down.
for (const [label, listed] of [['README.md', enCommands], ['README.zh.md', zhCommands]]) {
  const missing = commands.filter((c) => !listed.has(c))
  if (missing.length === 0) {
    pass(`${label} documents every command the bridge implements`, `${commands.length} commands`)
  } else {
    fail(`${label} documents every command the bridge implements`, `missing: ${missing.join(', ')}`)
  }
}

// 2b. Every command a README lists is one the bridge has, or one the host
//     provides. A command that is written down but does not exist teaches
//     the reader to try it and then to distrust the listing.
for (const [label, listed] of [['README.md', enCommands], ['README.zh.md', zhCommands]]) {
  const unattributed = [...listed.entries()]
    // The mark for "the host provides this" is written in the language the
    // document is written in, so both forms are accepted.
    .filter(([name, description]) => !commands.includes(name)
      && !/\(host\)|（宿主）|\(宿主\)/.test(description))
    .map(([name]) => name)
  if (unattributed.length === 0) {
    pass(`${label} lists no command that does not exist`, `${listed.size} commands`)
  } else {
    fail(`${label} lists no command that does not exist`,
      `not a bridge command and not marked as the host's: ${unattributed.join(', ')}`)
  }
}

// 2e. The `/bot` subcommands the bridge implements are written down. This
//     one is not a table row — it is a sentence — so the table check above
//     cannot see it, and a subcommand that exists but is not written down
//     is a subcommand nobody finds.
function botSubcommands() {
  const source = read('src/sync/bot-command.ts')
  const match = source.match(/const SUBCOMMANDS = new Set\(\[([^\]]+)\]/)
  if (match === null) return []
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
}

function documentedBotSubcommands(markdown) {
  const line = markdown.split('\n').find((l) => l.includes('`/bot` subcommands') || l.includes('`/bot` 子命令'))
  if (line === undefined) return []
  const names = [...line.matchAll(/`([a-z-]+)`/g)].map((m) => m[1])
  return [...new Set(names)].sort()
}

const botCommands = botSubcommands()
for (const [label, markdown] of [['README.md', en], ['README.zh.md', zh]]) {
  const documented = documentedBotSubcommands(markdown)
  const missing = botCommands.filter((c) => !documented.includes(c))
  if (missing.length === 0) {
    pass(`${label} writes down every /bot subcommand`, `${botCommands.length} subcommands`)
  } else {
    fail(`${label} writes down every /bot subcommand`, `missing: ${missing.join(', ')}`)
  }
}

// 2c. The suite count in the repository map matches the number of test
//     files. The badge is not the only place a number is written down,
//     and a number that says zero is worse than one that is merely
//     stale: it tells the reader the tests do not exist.
function suiteCount(markdown) {
  const english = markdown.match(/vitest suites \((\d+)\)/)
  if (english !== null) return Number(english[1])
  const chinese = markdown.match(/vitest 套件（(\d+) 个）/)
  return chinese === null ? undefined : Number(chinese[1])
}

const suiteFiles = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.spec.ts')).length
for (const [label, markdown] of [['README.md', en], ['README.zh.md', zh]]) {
  const suites = suiteCount(markdown)
  if (suites === undefined) {
    fail(`${label} states how many test suites there are`, 'no suite count in the repository map')
  } else if (suites === suiteFiles) {
    pass(`${label} suite count matches the test files`, `${suites}`)
  } else {
    fail(`${label} suite count matches the test files`,
      `says ${suites}, there are ${suiteFiles}`)
  }
}

// 2d. The two documents have the same sections. A section that exists in
//     one and not the other is a promise the other language never made.
function sections(markdown) {
  return [...markdown.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].trim())
}

const enSections = sections(en)
const zhSections = sections(zh)
if (enSections.length === zhSections.length) {
  pass('the two documents have the same number of sections', `${enSections.length} each`)
} else {
  fail('the two documents have the same number of sections',
    `english has ${enSections.length}, chinese has ${zhSections.length}`)
}

// 3. The badge matches the number of tests that run.
const { count, source } = actualTestCount()
for (const [label, markdown] of [['README.md', en], ['README.zh.md', zh]]) {
  const badge = badgeCount(markdown)
  if (badge === undefined) {
    fail(`${label} carries a test count`, 'no badge and no count in the test comment')
  } else if (badge === count) {
    pass(`${label} test count matches the declared cases`, `${count} (${source})`)
  } else {
    fail(`${label} test count matches the declared cases`,
      `says ${badge}, there are ${count} (${source})`)
  }
}

// 4. The manual and the chat copy of it say the same thing.
const manual = read('docs/\u7528\u6237\u624b\u518c.md')
const guide = read('src/user-guide.ts')
// The chat copy is a template string, so the backticks around a command
// are escaped there and plain here. Unescape before comparing, or the two
// never line up and the check cannot tell a real difference from the
// escaping.
// The chat copy is a template string inside a module that also carries
// comments and other exports. Taking the whole file would compare the
// manual against the module's documentation, not against the text a user
// actually receives. The template string is the text.
function templateBody(source) {
  const marker = 'export const USER_GUIDE = `'
  const start = source.indexOf(marker)
  if (start < 0) return source
  const from = start + marker.length
  let end = from
  for (;;) {
    end = source.indexOf('`', end)
    if (end < 0) return source.slice(from)
    if (source[end - 1] !== '\\') break
    end += 1
  }
  return source.slice(from, end).replace(/\\`/g, '`')
}
const guideText = templateBody(guide)
// The manual has a title and an introduction of its own; the chat copy
// starts at the first heading. Comparing from the first heading is what
// the two are actually meant to agree on — the rest is the repository
// reader's framing, not the guide.
const BODY_START = '**\u4e00\u3001\u8fd9\u662f\u4ec0\u4e48**'
const manualBody = manual.slice(manual.indexOf(BODY_START)).trim()
const guideBody = guideText.slice(guideText.indexOf(BODY_START)).trim()
const normalise = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
const manualLines = normalise(manualBody)
const guideLines = normalise(guideBody)
const onlyInManual = manualLines.filter((l) => !guideLines.includes(l))
const onlyInGuide = guideLines.filter((l) => !manualLines.includes(l))
if (onlyInManual.length === 0 && onlyInGuide.length === 0) {
  pass('the manual and the chat copy of it agree', `${manualLines.length} lines, word for word`)
} else {
  fail('the manual and the chat copy of it agree',
    `manual only: [${onlyInManual.slice(0, 2).map((l) => l.slice(0, 60)).join(' | ')}], `
    + `chat only: [${onlyInGuide.slice(0, 2).map((l) => l.slice(0, 60)).join(' | ')}]`)
}

console.log(failed === 0
  ? '\ndocumentation is in step with the code'
  : `\n${failed} documentation check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
