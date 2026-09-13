import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CHECK = join(REPO, "scripts/check-repo-hygiene.mjs")

// Fixture strings are assembled at runtime rather than written literally:
// this file is itself inside the scanned tree, so a literal sample path would
// be reported by the very check it is testing.
const F = (...parts: string[]) => parts.join("")
const WSL_PATH = F("/mnt/", "d/PROJECT/real/lib")
const HOME_PATH = F("/home/", "realuser/work/x")
const FAKE_TOKEN = F("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
const PRIVATE_TERM = F("Internal", "ProjectCodename")

/** Run the checker and return its exit code — the contract is the exit code,
 *  so it must not be swallowed by a pipe. */
function runCheck(args: string[]): number {
  try {
    execFileSync("node", [CHECK, ...args], { stdio: "pipe" })
    return 0
  } catch (e) {
    return (e as { status?: number }).status ?? -1
  }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-"))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

function withFixture(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = fixture(files)
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("repo hygiene check", () => {
  // Uses the operator's own patterns when present, so this asserts the same
  // thing CI does rather than a weaker subset.
  it("passes on this repository", () => {
    const local = join(REPO, ".leak-patterns")
    const args = [REPO, "--lib"]
    if (existsSync(local)) args.push("--patterns-file", local)
    expect(runCheck(args)).toBe(0)
  })

  it("reports a real WSL mount path", () => {
    withFixture({ "src/a.ts": `const LIB = "${WSL_PATH}"` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  it("reports a real home path", () => {
    withFixture({ "src/a.ts": `const h = "${HOME_PATH}"` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  it("reports a pasted credential", () => {
    withFixture({ "src/a.ts": `const t = "${FAKE_TOKEN}"` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  // Docs and tests spell out placeholder paths on purpose. Flagging them
  // teaches everyone to ignore the check, which is worse than not having one.
  it("does not report placeholder paths", () => {
    withFixture(
      {
        "src/a.ts": [
          'const p = "/home/user/project-a"',
          'const q = "/mnt/c/<win-user>/.dsh"',
          'const r = "C:\\\\Users\\\\username\\\\docs"',
        ].join("\n"),
      },
      dir => {
        expect(runCheck([dir])).toBe(0)
      },
    )
  })

  // Deployment-specific terms must stay out of this repo, so they arrive as a
  // local patterns file rather than a hardcoded list.
  it("applies terms from a local patterns file", () => {
    withFixture({ "src/a.ts": `const o = "${PRIVATE_TERM}"`, ".leak-patterns": `${PRIVATE_TERM}\n` }, dir => {
      expect(runCheck([dir, "--patterns-file", join(dir, ".leak-patterns")])).toBe(1)
      expect(runCheck([dir])).toBe(0)
    })
  })

  it("exits 2 on an unknown flag", () => {
    expect(runCheck([REPO, "--bogus"])).toBe(2)
  })
})
