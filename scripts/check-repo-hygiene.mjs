#!/usr/bin/env node
// Repo hygiene check — keeps machine-specific content out of the public tree.
//
// The failure this prevents: a path like a home-directory checkout or a
// personal name in a comment looks harmless on the machine that wrote it, and
// breaks or embarrasses everyone else. It is also invisible in review, so it
// needs to be checked mechanically.
//
// Usage:
//   node scripts/check-repo-hygiene.mjs [repo] [--lib] [--strict] [--patterns-file <path>]
//
// Exit codes: 0 = clean, 1 = findings, 2 = usage error.
//
// Deployment-specific terms (internal project names, personal forms of
// address, private hostnames) are NOT listed here — this file ships publicly,
// so a list of the terms would itself be the leak. Put them in a local file
// and pass it in; .leak-patterns is gitignored for exactly this.
//   node scripts/check-repo-hygiene.mjs . --lib --patterns-file ../.leak-patterns
// or export REPO_HYGIENE_PATTERNS=/path/to/patterns.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative, extname, resolve } from "node:path"

// Universal "you shipped your machine" signals.
const BASE_PATTERNS = [
  // Absolute paths into somebody's home directory.
  [/\/home\/[A-Za-z0-9._-]+\//, "absolute home path"],
  [/\/root\//, "root home path"],
  [/\/Users\/[A-Za-z0-9._-]+\//, "macOS home path"],
  [/\/mnt\/[a-z]\//, "WSL mount path"],
  [/[A-Za-z]:\\\\(?:Users|Projects?|Documents|Desktop)\\\\/i, "Windows user path"],
  // Credentials pasted into source.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
]

// Documentation and tests legitimately spell out placeholder paths
// (/home/user/project, /mnt/c/<win-user>/...). Flagging those trains people
// to ignore the check, so placeholders are skipped.
const PLACEHOLDER_USERS = new Set([
  "user", "username", "yourname", "your-user", "youruser", "you", "me",
  "example", "test", "foo", "bar", "baz", "someone", "somebody",
  "project", "projects", "home", "name", "x", "xxx",
])

function isPlaceholder(line) {
  if (/[<>]/.test(line)) return true // <win-user>, <username> — explicitly generic
  const m = line.match(/(?:\/home\/|\/Users\/|:\\\\(?:Users|Projects?|Documents|Desktop)\\\\)([A-Za-z0-9._-]+)/i)
  if (m && PLACEHOLDER_USERS.has(m[1].toLowerCase())) return true
  return false
}

const SCAN_EXT = new Set([".md", ".yml", ".yaml", ".mjs", ".js", ".ts", ".tsx", ".py", ".json", ".sh", ".txt", ".toml"])
const DEFAULT_DIRS = ["src", "tests", "docs", "scripts", ".github", "config", "bin", "journey", "promo"]
const NON_STRICT_DIRS = ["src", "tests", "docs", "scripts"]
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "dist", "build", "coverage"])

function parseArgs(argv) {
  const args = { repo: ".", lib: false, strict: false, patternsFile: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--lib") args.lib = true
    else if (a === "--strict") args.strict = true
    else if (a === "--patterns-file") args.patternsFile = argv[++i]
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`)
    else positional.push(a)
  }
  if (positional.length) args.repo = positional[0]
  return args
}

function loadLocalPatterns(file) {
  if (!file || !existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .map(l => l.replace(/\s+#.*$/, "").trim()) // allow trailing comments
    .filter(l => l && !l.startsWith("#"))
    .map(l => {
      try {
        return [new RegExp(l), `local pattern: ${l}`]
      } catch {
        console.error(`  warning: skipping invalid regex in ${file}: ${l}`)
        return null
      }
    })
    .filter(Boolean)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (SCAN_EXT.has(extname(name))) out.push(full)
  }
  return out
}

function scanFile(repo, file, patterns, hits) {
  let content
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return
  }
  const lines = content.split("\n")
  for (const [re, label] of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) && !isPlaceholder(lines[i])) {
        hits.push({ path: relative(repo, file), line: i + 1, label, text: lines[i].trim().slice(0, 120) })
        break
      }
    }
  }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`usage: check-repo-hygiene.mjs [repo] [--lib] [--strict] [--patterns-file <path>]\n  ${e.message}`)
    return 2
  }
  const repo = resolve(args.repo)
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    console.error(`not a directory: ${repo}`)
    return 2
  }

  const patternsFile = args.patternsFile || process.env.REPO_HYGIENE_PATTERNS
  const patterns = [...BASE_PATTERNS, ...loadLocalPatterns(patternsFile)]
  const dirs = args.strict ? DEFAULT_DIRS : NON_STRICT_DIRS

  console.log(`checking ${repo}`)
  if (patternsFile && existsSync(patternsFile)) console.log(`  + local patterns from ${patternsFile}`)

  const hits = []
  for (const d of dirs) {
    const base = join(repo, d)
    if (!existsSync(base) || !statSync(base).isDirectory()) continue
    for (const f of walk(base, [])) scanFile(repo, f, patterns, hits)
  }
  // Build output ships to npm, so it is scanned too — but only when asked,
  // since a minified bundle legitimately contains long opaque strings.
  if (args.lib) {
    const lib = join(repo, "lib")
    if (existsSync(lib)) scanFile(repo, lib, patterns, hits)
    for (const f of walk(lib, [])) scanFile(repo, f, patterns, hits)
  }

  if (!hits.length) {
    console.log("clean: no machine-specific content found")
    return 0
  }
  console.log(`found ${hits.length} finding(s):`)
  for (const h of hits) console.log(`  ${h.path}:${h.line}  [${h.label}]  ${h.text}`)
  return 1
}

process.exit(main())
