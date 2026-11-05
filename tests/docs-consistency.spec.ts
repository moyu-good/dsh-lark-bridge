import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The documentation gate is a script; a script nobody runs on purpose is a
 * script that only runs when something else breaks. These tests keep the
 * gate honest from both sides: it passes on the repository as it stands,
 * and it still catches each kind of drift it is there to catch.
 *
 * The gate reads the repository, so the drift has to be introduced into a
 * copy — not into the repository itself. Editing the real files would
 * mean two runs of this suite at the same time could overwrite each
 * other's changes, and a test that damages the working tree when it
 * fails is a test that costs more than it saves.
 */
const ROOT = path.resolve(import.meta.dirname ?? '.', '..')
const GATE = 'scripts/check-docs-consistency.mjs'

/** A throwaway copy of the parts of the repository the gate reads. */
function copyForGate(): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-docs-gate-'))
  fs.mkdirSync(path.join(copy, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(copy, 'src', 'sync'), { recursive: true })
  fs.mkdirSync(path.join(copy, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(copy, 'tests'), { recursive: true })
  for (const file of ['README.en.md', 'README.md', 'docs/\u7528\u6237\u624b\u518c.md', 'src/commands.ts', 'src/sync/bot-command.ts', 'src/user-guide.ts']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(copy, file))
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'tests'))) {
    if (file.endsWith('.spec.ts')) fs.copyFileSync(path.join(ROOT, 'tests', file), path.join(copy, 'tests', file))
  }
  fs.copyFileSync(path.join(ROOT, GATE), path.join(copy, GATE))
  return copy
}

const copies: string[] = []
afterEach(() => {
  for (const copy of copies.splice(0)) fs.rmSync(copy, { recursive: true, force: true })
})

function runGate(copy: string) {
  try {
    const stdout = execFileSync('node', [GATE], { cwd: copy, encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (error) {
    const e = error as { status?: number, stdout?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '' }
  }
}

/** Copy the repository, change one file in the copy, and run the gate there. */
function withChanged(relative: string, change: (text: string) => string, assertion: (result: { code: number, stdout: string }) => void) {
  const copy = copyForGate()
  copies.push(copy)
  const file = path.join(copy, relative)
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')), 'utf8')
  assertion(runGate(copy))
}

describe('the documentation gate', () => {
  it('passes on the repository as it stands', () => {
    const copy = copyForGate()
    copies.push(copy)
    const result = runGate(copy)
    expect(result.stdout).toContain('documentation is in step with the code')
    expect(result.code).toBe(0)
  })

  it('catches a test count that no longer matches', () => {
    // The number is not written down here on purpose: the badge moves every
    // time a test is added, and a test that replaces one fixed number
    // silently stops replacing anything once the badge has moved past it.
    //
    // So this matches whatever count the README currently carries and bumps
    // it, rather than hard-coding the rendering of the day. It used to pin
    // the shields.io badge; when the badge was replaced by a plain comment in
    // the quality-gate block, that replace became a no-op, the gate stayed
    // green, and this test — the only thing watching the count door — went
    // red instead. Bumping whatever is there survives either spelling.
    withChanged(
      'README.en.md',
      (text) =>
        text
          .replace(/(tests-)(\d+)(%20passing)/, (_m, a, n, b) => `${a}${Number(n) + 1}${b}`)
          .replace(/(#\s*)(\d+)(\s+unit\/integration tests|\s+test cases declared|\s+tests in \d+ spec files)/, (_m, a, n, b) => `${a}${Number(n) + 1}${b}`),
      (result) => {
        expect(result.code).not.toBe(0)
        expect(result.stdout).toContain('test count')
      },
    )
  })

  it('catches a command that is written down but does not exist', () => {
    withChanged('README.en.md', (text) => `${text}\n| \`/nosuchcommand\` | Does not exist |\n`, (result) => {
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('lists no command that does not exist')
    })
  })

  it('catches a command the bridge implements but no README mentions', () => {
    withChanged('README.en.md', (text) => text.split('\n').filter((line) => !line.startsWith('| `/tools` |')).join('\n'), (result) => {
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('documents every command the bridge implements')
    })
  })

  it('catches a suite count that says zero', () => {
    withChanged('README.md', (text) => text.replace(/vitest 套件（\d+ 个）/, 'vitest 套件（0 个）'), (result) => {
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('suite count')
    })
  })

  it('catches a suite count that is the test count rather than the file count', () => {
    withChanged('README.en.md', (text) => text.replace(/vitest suites \(\d+\)/, 'vitest suites (999)'), (result) => {
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('suite count')
    })
  })

  it('catches one document having a section the other does not', () => {
    withChanged('README.md', (text) => `${text}\n## 另一个小节\n\n多出来的一节。\n`, (result) => {
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('same number of sections')
    })
  })

  it('catches a /bot subcommand that is not written down', () => {
    // Inject by dropping one name from whichever line the gate reads, not by
    // matching a fixed prefix of that line: the prefix changed once already
    // (`**\`/bot\` subcommands** (bridge admin):` became `**\`/bot\`
    // subcommands**:`) and the fixed-prefix replace silently stopped injecting.
    withChanged(
      'README.en.md',
      (text) =>
        text
          .split('\n')
          .map((line) => (line.includes('`/bot` subcommands') ? line.replace('`set` / ', '') : line))
          .join('\n'),
      (result) => {
        expect(result.code).not.toBe(0)
        expect(result.stdout).toContain('/bot subcommand')
      },
    )
  })

  it('catches the manual and the chat copy of it drifting apart', () => {
    withChanged('docs/\u7528\u6237\u624b\u518c.md', (text) => text.replace('\u53cd\u9988\uff1a`/feedback`', '\u53cd\u9988\uff1a`/feedback`\uff08\u53e6\u52a0\u4e00\u53e5\uff09'), (result) => {
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('agree')
    })
  })
})
