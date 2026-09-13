/**
 * Session-start briefing injection: prepend a situation file's contents to
 * the FIRST user message of each session (per process lifetime). This gives
 * every chat agent ambient situational awareness — who the user is, what is
 * in flight across the fleet — without trusting model cooperation to fetch it.
 *
 * Contract: read errors are logged and degrade to "no briefing"; the file is
 * small and re-read per injection so external refreshers are picked up live.
 *
 * The read is ASYNC on purpose. This file can live on a bridged filesystem
 * (a Windows path under /mnt), where a synchronous read stalls the whole event
 * loop — no replies, no logs, no HTTP — until the mount answers. Awaiting it
 * keeps a slow mount from freezing the channel.
 */
import { readFile } from 'node:fs/promises'

const briefedSessions = new Set<string>()

export async function briefingPrefix(
  file: string | undefined,
  sessionId: string,
  log: (line: string) => void,
): Promise<string> {
  if (!file) return ''
  const key = `${file}\u0000${sessionId}`
  if (briefedSessions.has(key)) return ''
  briefedSessions.add(key)
  try {
    const text = (await readFile(file, 'utf-8')).trim()
    if (text === '') return ''
    return `[System briefing — auto-injected context]\n${text}\n[/System briefing]\n\n`
  } catch (e: unknown) {
    log(`dsh-lark-bridge: briefing read failed: ${String(e)}`)
    return ''
  }
}
