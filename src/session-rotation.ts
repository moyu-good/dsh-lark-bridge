/**
 * Session rotations: `/new` moves a conversation to a fresh session while the
 * previous one stays stored. The mapping must survive a restart, so the store
 * keeps `conversationKey → current session id` in the harness home; a
 * conversation with no recorded rotation resolves to its original, derived id.
 * @module dsh-lark-bridge/session-rotation
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** The read/write seam {@link createRotationStore} satisfies. */
export interface RotationStore {
  /**
   * The session id one conversation currently runs on.
   * @param key - a conversation key from `conversationKey`.
   * @returns the rotated id, or undefined when the conversation never rotated.
   */
  current(key: string): string | undefined
  /**
   * Persist the conversation's new session id.
   * @param key - a conversation key.
   * @param sessionId - the freshly created session id.
   * @returns false when the mapping could not reach disk (the in-process
   * rotation still holds — only a restart-time fallback is at risk).
   */
  record(key: string, sessionId: string): boolean
}

/**
 * The harness home the rotation file lives in: `DSH_HOME` when set, else
 * `~/.dsh`. Local on purpose — a rotation names an id on this machine.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export function rotationHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh')
}

/**
 * Path of the rotation file.
 * @param home - override for tests.
 * @returns the file path.
 */
export function rotationPath(home?: string): string {
  return path.join(rotationHome(home), 'session-rotation.json')
}

/**
 * The next rotated session id for one conversation: the derived id plus a
 * sortable stamp and a random tail, so every rotation is a fresh id (two
 * /new in the same millisecond must not collide) and the original stays
 * addressable for history lookups.
 * @param baseSessionId - the conversation's derived id (from `sessionIdFor`).
 * @param now - clock override for tests.
 * @param suffix - randomness override for tests.
 * @returns the new session id.
 */
export function rotatedSessionId(
  baseSessionId: string,
  now = Date.now(),
  suffix = randomUUID().replaceAll('-', '').slice(0, 4),
): string {
  return `${baseSessionId}:r${now.toString(36)}${suffix}`
}

/** The stamp-plus-tail a rotation appends, so {@link baseSessionIdOf} can strip it. */
const ROTATION_SUFFIX = /:r[0-9a-z]+$/

/**
 * The conversation id a session id was derived from: the inverse of
 * {@link rotatedSessionId} for the ids it produces, and the identity for every
 * other id.
 *
 * `/new` creates the rotated id, but anything keyed by the conversation — the
 * per-chat cwd binding, for one — was registered under the BASE id before the
 * rotation. Callers that only ever see the session id need this to find it.
 * @param sessionId - any session id.
 * @returns the base id, or the input when it carries no rotation suffix.
 */
export function baseSessionIdOf(sessionId: string): string {
  const suffix = ROTATION_SUFFIX.exec(sessionId)?.[0]
  return suffix === undefined ? sessionId : sessionId.slice(0, -suffix.length)
}

/**
 * A JSON-backed {@link RotationStore}, cached in memory. A missing or
 * unparsable file reads as "no rotations"; writes go through a rename so a
 * crash mid-write cannot truncate the map.
 * @param home - override for tests.
 * @returns the store.
 */
export function createRotationStore(home?: string): RotationStore {
  const file = rotationPath(home)
  let map: Record<string, string> | undefined
  const load = (): Record<string, string> => {
    if (map !== undefined) return map
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      map = typeof parsed === 'object' && parsed !== null ? { ...(parsed as Record<string, string>) } : {}
    } catch {
      map = {}
    }
    return map
  }
  return {
    current(key) {
      const id = load()[key]
      return typeof id === 'string' && id !== '' ? id : undefined
    },
    record(key, sessionId) {
      const next = { ...load(), [key]: sessionId }
      map = next
      try {
        mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(next), 'utf8')
        renameSync(tmp, file)
        return true
      } catch {
        // Best effort: this process still rotates, but the mapping is lost on
        // restart — the boolean lets the caller say so instead of pretending.
        return false
      }
    },
  }
}
