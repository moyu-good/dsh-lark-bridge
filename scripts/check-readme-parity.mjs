#!/usr/bin/env node
/**
 * README parity guard.
 *
 * The two READMEs are written in parallel — not translated — so they drift
 * silently. This checks the two things that must never drift:
 *
 *   1. the `##` heading sequence, in order
 *   2. the line-count ratio (Chinese is denser; a 1:1 match is not the goal)
 *
 * Content is deliberately NOT compared: the Chinese version is written as
 * Chinese, not as a rendering of the English one.
 *
 * Usage:  node scripts/check-readme-parity.mjs [--verbose]
 * Exit:   0 in step, 1 drifted. Any drift prints the offending line.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

// Chinese runs shorter per idea. A ratio outside this band means one side
// gained or lost a whole section, which the heading check would already catch —
// this catches subtler wholesale bloat.
const RATIO_MIN = 0.65
const RATIO_MAX = 1.10

function load(name) {
  const text = readFileSync(resolve(ROOT, name), 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
  // Folding blocks are where most of the reference material lives — the
  // capability table, the command list, the config table, the FAQ. They are
  // invisible to the `##` check, so a whole FAQ could vanish from one
  // language and the heading check would still pass.
  const details = (text.match(/<details>/g) ?? []).length
  // Body mass, ignoring blank lines and headings: catches the case where one
  // side is emptied out but keeps its line count by padding with blanks.
  const bodyChars = lines
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .join('\n').length
  return { name, lines, headings, lineCount: lines.length, details, bodyChars }
}

const en = load('README.en.md')
const zh = load('README.md')

const problems = []

// Body mass, not line count: a side can be emptied out (every line replaced by
// a placeholder) and keep both its line count and its `<details>` count if the
// placeholder fills in the text but leaves the markup alone. Chinese runs
// denser than English, so the band is one-sided and loose — it is here to
// catch a collapse, not to police translation length.
const BODY_RATIO_MIN = 0.45
const bodyRatio = zh.bodyChars / en.bodyChars
if (bodyRatio < BODY_RATIO_MIN) {
  problems.push(
    `body text has collapsed: README.md carries ${zh.bodyChars} chars of body text ` +
      `against README.en.md's ${en.bodyChars} (ratio ${bodyRatio.toFixed(2)}, floor ${BODY_RATIO_MIN})`,
  )
}

// Per-section body mass. A global ratio cannot see one section emptied out:
// the other sections carry the average. Split both documents by `##` and
// compare the body weight of each pair — a section that lost most of its text
// on one side shows up here even when the heading survives and the totals look
// plausible.
function sectionBodies(markdown) {
  const out = []
  let current = null
  for (const line of markdown.split('\n')) {
    // A section starts at a `##` heading OR at a `<summary>` — most of the
    // reference material is folded, and a folded section has no heading at
    // all. Splitting only on `##` meant a whole folded section could be
    // emptied out and this comparison never saw it.
    const summary = /^<summary>(.*)<\/summary>/.exec(line.trim())
    if (line.startsWith('## ') || summary !== null) {
      current = { title: summary !== null ? summary[1] : line.slice(3).trim(), chars: 0 }
      out.push(current)
      continue
    }
    if (current && line.trim() !== '' && !line.startsWith('#') && !line.startsWith('<')) {
      current.chars += line.length
    }
  }
  return out
}

// A section may legitimately run shorter in one language, but not by an order
// of magnitude: below this floor either side means the section lost its body.
const SECTION_RATIO_MIN = 0.30
const enBodies = sectionBodies(en.lines.join('\n'))
const zhBodies = sectionBodies(zh.lines.join('\n'))
const pairs = Math.min(enBodies.length, zhBodies.length)
for (let i = 0; i < pairs; i++) {
  const a = enBodies[i]
  const b = zhBodies[i]
  const big = Math.max(a.chars, b.chars)
  const small = Math.min(a.chars, b.chars)
  if (big > 200 && small / big < SECTION_RATIO_MIN) {
    problems.push(
      `section ${i + 1} lost its body on one side: ` +
        `"${a.title}" = ${a.chars} chars, "${b.title}" = ${b.chars} chars ` +
        `(ratio ${(small / big).toFixed(2)}, floor ${SECTION_RATIO_MIN})`,
    )
  }
}

// Section numbers inside headings differ by language; compare only what follows
// the emoji/number prefix, case-insensitively, so "🤔 What it does" and
// "🤔 它是干什么的" pair up as the k-th section, which is what matters.
if (en.headings.length !== zh.headings.length) {
  problems.push(
    `heading count differs: README.en.md has ${en.headings.length}, README.md has ${zh.headings.length}`,
  )
}

// A `<details>` block is content the heading check cannot see. One side losing
// a folding block is the exact drift this file exists to stop.
const FOLDED_SLACK = 0
if (Math.abs(en.details - zh.details) > FOLDED_SLACK) {
  problems.push(
    `folded-block count differs: README.en.md has ${en.details}, README.md has ${zh.details} ` +
      `(tolerance ${FOLDED_SLACK})`,
  )
}

const worst = Math.min(en.headings.length, zh.headings.length)
for (let i = 0; i < worst; i++) {
  const a = en.headings[i]
  const b = zh.headings[i]
  const sameEmoji = a.split(' ')[0] === b.split(' ')[0]
  if (VERBOSE || !sameEmoji) {
    console.log(`  [${String(i + 1).padStart(2, '0')}] ${a}  |  ${b}${sameEmoji ? '' : '   <-- emoji differs'}`)
  }
  if (!sameEmoji) {
    problems.push(`section ${i + 1} does not line up: "${a}" vs "${b}"`)
  }
}

const ratio = zh.lineCount / en.lineCount
if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
  problems.push(
    `line-count ratio ${ratio.toFixed(2)} is outside [${RATIO_MIN}, ${RATIO_MAX}] ` +
      `(README.en.md ${en.lineCount}, README.md ${zh.lineCount})`,
  )
}

// Every image the README points at has to exist, or GitHub renders a broken box.
const imgProblems = []
for (const doc of [en, zh]) {
  const text = doc.lines.join('\n')
  const refs = [
    ...[...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ]
  for (const ref of refs) {
    if (/^https?:\/\//.test(ref)) continue
    try {
      readFileSync(resolve(ROOT, ref))
    } catch {
      imgProblems.push(`${doc.name}: missing image ${ref}`)
    }
  }
}
problems.push(...imgProblems)

console.log('')
console.log(`  README.en.md     ${en.lineCount} lines, ${en.headings.length} sections`)
console.log(`  README.md  ${zh.lineCount} lines, ${zh.headings.length} sections, ratio ${ratio.toFixed(2)}`)
console.log('')

if (problems.length) {
  console.error('README parity FAILED:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('README parity OK')
