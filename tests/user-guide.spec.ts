import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { USER_GUIDE, USER_GUIDE_SECTIONS } from '../src/user-guide.ts'

describe('USER_GUIDE', () => {
  it('carries every section a user needs', () => {
    for (const section of USER_GUIDE_SECTIONS) {
      expect(USER_GUIDE).toContain(section)
    }
  })

  it('names the surfaces users actually touch', () => {
    for (const command of ['/balance', '/manual', '/bot account', '/bot devices', '/restart', '/stop']) {
      expect(USER_GUIDE).toContain(command)
    }
  })

  it('never hardcodes a secret-shaped string', () => {
    expect(USER_GUIDE).not.toMatch(/cli_[a-z0-9]{12,}/)
    expect(USER_GUIDE).not.toMatch(/sk-[a-z0-9]{16,}/)
  })

  it('the repo mirror doc stays in step with the chat source', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dirname ?? '.', '../docs/用户手册.md'), 'utf8')
    for (const section of USER_GUIDE_SECTIONS) {
      expect(doc).toContain(section)
    }
    for (const command of ['/balance', '/manual', '/bot account', '/bot devices']) {
      expect(doc).toContain(command)
    }
  })
})
