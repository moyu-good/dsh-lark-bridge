import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostAgentHandle } from '../src/host.ts'
import { ConversationSessions, conversationKey, sessionIdFor } from '../src/session.ts'
import { createRotationStore, rotatedSessionId, rotationPath } from '../src/session-rotation.ts'
import type { SessionLadder, SessionScope } from '../src/session.ts'
import { fakeMessage } from './harness.ts'

/** One rung the ladder was asked for, in call order. */
interface LadderCall {
  readonly rung: 'lookup' | 'resume' | 'create'
  readonly sessionId: string
}

/** How the fake host answers each rung; mutable so a test can flip it mid-run. */
interface LadderBehavior {
  /** Session ids the host already runs an agent for, so `lookup` hits. */
  live?: string[]
  /** Session ids `resume` loads; every other id rejects as unstored. */
  resumable?: string[]
  /** Session ids whose stored log is damaged: `resume` rejects the way the host does. */
  corrupt?: string[]
  /** Session ids whose stored log carries a format this build does not read. */
  foreign?: string[]
  /** Session ids whose log exists and is unreadable for a reason that names no class. */
  denied?: string[]
  /** Session ids stored under an id `resume` will not load, so `create` collides. */
  existing?: string[]
  /** Session ids that appear between our `resume` and our `create` (another owner). */
  race?: string[]
  /** Session ids whose every `resume` says plainly that nothing is stored. */
  absent?: string[]
  /**
   * Session ids this chat already wrote under ANOTHER project directory: the
   * host refuses to list its sessions at all while the duplicate exists, so
   * both `resume` (nothing stored here) and `create` (id taken elsewhere)
   * reject — the deadlock behind "无法启动会话".
   */
  duplicate?: string[]
  /** Reject `create` instead of producing an agent. */
  failCreate?: boolean
  /** Reject every produced agent's `dispose`. */
  failDispose?: boolean
}

/**
 * The stored-log failures dsh 0.2.1-rc.2's jsonl backend raises, in the shapes
 * measured from it: a damaged log reports the failing line and the two seqs,
 * and every refusal sets its own class `name`.
 * @param sessionId - the stored id the refusal is about.
 * @returns the rejection the host would raise.
 */
function corruptionError(sessionId: string): Error {
  const cause = new Error('corrupt session log: invalid committed event at line 2520: released v2 row 2519 has seq gap (expected 2519, got 2515)')
  const error = new Error(
    `session "${sessionId}": stored log is corrupt: ${String(cause)} (raw log: /var/dsh/sessions/session.v4.jsonl)`,
    { cause },
  )
  error.name = 'SessionPersistenceCorruptionError'
  return error
}

/** A log written by a newer harness: intact, but this build will not read it. */
function formatRefusal(sessionId: string): Error {
  const error = new Error(
    `session "${sessionId}" uses log format v9, but this harness reads only v4: the log was written by a newer harness — upgrade the harness to open it (raw log: /var/dsh/sessions/session.v9.jsonl)`,
  )
  error.name = 'SessionFormatUnsupportedError'
  return error
}

/** Nothing is stored under this id. */
function absentError(sessionId: string): Error {
  const error = new Error(`session "${sessionId}" not found`)
  error.name = 'SessionPersistenceNotFoundError'
  return error
}

/** A stored session already owns this id. */
function existsError(sessionId: string): Error {
  const error = new Error(`session "${sessionId}" already exists`)
  error.name = 'SessionAlreadyExistsError'
  return error
}

/**
 * The same id is stored under two project directories, which the host refuses
 * to enumerate at all — measured from `listArtifacts` in
 * `dsh-session-persistence-jsonl`, raised the moment two headers agree on id.
 * @param sessionId - the id that turned up twice.
 * @returns the rejection the host would raise.
 */
function duplicateError(sessionId: string): Error {
  return new Error(`duplicate JSONL session id "${sessionId}" appears in multiple project directories`)
}

/**
 * An in-memory {@link SessionLadder} over stub agents, recording every rung,
 * report line, and disposal. Needs no Cordis mount.
 * @param behavior - which rungs answer; by default only `create` does.
 * @returns the ladder, its mutable behavior, and the recorded traffic.
 */
function createFakeLadder(behavior: LadderBehavior = {}) {
  const calls: LadderCall[] = []
  const reports: string[] = []
  const disposals: string[] = []
  const handles = new Map<string, HostAgentHandle>()
  /** Resume attempts per id, so a race can answer differently the second time. */
  const attempts = new Map<string, number>()

  /** Whether an archive occupies this id, which is what makes `create` collide. */
  const stored = (sessionId: string): boolean => behavior.existing?.includes(sessionId) === true
    || behavior.resumable?.includes(sessionId) === true
    || behavior.corrupt?.includes(sessionId) === true
    || behavior.foreign?.includes(sessionId) === true
    || behavior.denied?.includes(sessionId) === true
    || behavior.race?.includes(sessionId) === true
    || behavior.duplicate?.includes(sessionId) === true

  /** One stub agent per session id, so a second rung yields the same handle. */
  const handleFor = (sessionId: string): HostAgentHandle => {
    let handle = handles.get(sessionId)
    if (handle === undefined) {
      handle = {
        agent: { id: sessionId, session: { id: sessionId }, followup: () => {}, cancel: () => {} },
        dispose: async () => {
          disposals.push(sessionId)
          if (behavior.failDispose === true) throw new Error(`dispose rejected (fake): ${sessionId}`)
        },
      }
      handles.set(sessionId, handle)
    }
    return handle
  }

  const ladder: SessionLadder = {
    lookup(sessionId) {
      calls.push({ rung: 'lookup', sessionId })
      return behavior.live?.includes(sessionId) === true ? handleFor(sessionId) : undefined
    },
    async resume(sessionId) {
      calls.push({ rung: 'resume', sessionId })
      const attempt = (attempts.get(sessionId) ?? 0) + 1
      attempts.set(sessionId, attempt)
      if (behavior.corrupt?.includes(sessionId) === true) throw corruptionError(sessionId)
      if (behavior.foreign?.includes(sessionId) === true) throw formatRefusal(sessionId)
      if (behavior.denied?.includes(sessionId) === true) throw new Error("EACCES: permission denied, open '/var/dsh/sessions/session.v4.jsonl'")
      // A session another owner created between our resume and our create: the
      // first attempt still sees nothing stored.
      if (behavior.race?.includes(sessionId) === true && attempt === 1) throw absentError(sessionId)
      if (behavior.absent?.includes(sessionId) === true) throw absentError(sessionId)
      // The duplicate lives in another project directory, so nothing is stored
      // HERE — resuming this cwd cannot reach it.
      if (behavior.duplicate?.includes(sessionId) === true) throw absentError(sessionId)
      if (behavior.resumable?.includes(sessionId) !== true && behavior.race?.includes(sessionId) !== true) {
        throw new Error(`no stored session (fake): ${sessionId}`)
      }
      return handleFor(sessionId)
    },
    async create(sessionId) {
      calls.push({ rung: 'create', sessionId })
      if (behavior.failCreate === true) throw new Error(`create rejected (fake): ${sessionId}`)
      // Creating under a duplicated id is refused before any log is touched:
      // the host cannot tell which copy is meant.
      if (behavior.duplicate?.includes(sessionId) === true) throw duplicateError(sessionId)
      // The host's create refuses an id whose log is already on disk, whatever
      // shape that log is in — this is the answer that buried the damage.
      if (stored(sessionId)) throw existsError(sessionId)
      return handleFor(sessionId)
    },
    report(line) { reports.push(line) },
  }

  return {
    ladder,
    behavior,
    calls,
    reports,
    disposals,
    /** Session ids handed to one rung, in call order. */
    asked: (rung: LadderCall['rung']): string[] =>
      calls.filter(call => call.rung === rung).map(call => call.sessionId),
  }
}

describe('conversation sessions', () => {
  describe('conversation keys', () => {
    it('keys the chat scope by chat id alone', () => {
      expect(conversationKey('chat', fakeMessage({ threadId: 'omt_a', senderId: 'ou_alice' }))).toBe('oc_chat_1')
      expect(conversationKey('chat', fakeMessage({ chatId: 'oc_chat_2' }))).toBe('oc_chat_2')
    })

    it('separates threads and falls back to the chat when a message carries none', () => {
      const inThread = conversationKey('chat-thread', fakeMessage({ chatId: 'oc_topic', threadId: 'omt_a' }))
      expect(inThread).toBe('oc_topic:omt_a')
      expect(conversationKey('chat-thread', fakeMessage({ chatId: 'oc_topic', threadId: 'omt_b' })))
        .not.toBe(inThread)
      // An ordinary group carries no thread; the whole chat is the facet there.
      expect(conversationKey('chat-thread', fakeMessage({ chatId: 'oc_topic' }))).toBe('oc_topic')
    })

    it('separates senders within one chat', () => {
      const alice = conversationKey('chat-sender', fakeMessage({ chatId: 'oc_group', senderId: 'ou_alice' }))
      expect(alice).toBe('oc_group:ou_alice')
      expect(conversationKey('chat-sender', fakeMessage({ chatId: 'oc_group', senderId: 'ou_bob' })))
        .toBe('oc_group:ou_bob')
      // The same person in another chat is another conversation.
      expect(conversationKey('chat-sender', fakeMessage({ chatId: 'oc_other', senderId: 'ou_alice' })))
        .not.toBe(alice)
      // A thread never leaks into the sender facet.
      expect(conversationKey(
        'chat-sender',
        fakeMessage({ chatId: 'oc_group', senderId: 'ou_alice', threadId: 'omt_a' }),
      )).toBe(alice)
    })

    it('throws for a scope outside the union', () => {
      expect(() => conversationKey('chat-group' as unknown as SessionScope, fakeMessage()))
        .toThrow('unknown session scope')
    })
  })

  describe('session ids', () => {
    it('brands a key with the channel prefix', () => {
      expect(sessionIdFor('oc_chat_1')).toBe('feishu-oc_chat_1')
      expect(sessionIdFor('oc_chat_1:omt_a')).toBe('feishu-oc_chat_1:omt_a')
    })

    it('is deterministic and never collides across facets', () => {
      expect(sessionIdFor('oc_chat_1:omt_a')).toBe(sessionIdFor('oc_chat_1:omt_a'))
      const keys = [
        'oc_chat_1',
        'oc_chat_2',
        'oc_chat_1:omt_a',
        'oc_chat_1:omt_b',
        'oc_chat_1:ou_alice',
        'oc_chat_1-omt_a',
      ]
      expect(new Set(keys.map(key => sessionIdFor(key))).size).toBe(keys.length)
    })
  })

  describe('binding sessions', () => {
    it('binds one session per key and reuses it', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)

      const first = await sessions.acquire(fakeMessage({ content: 'first' }))
      const second = await sessions.acquire(fakeMessage({ content: 'second' }))
      expect(second).toBe(first)
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1')])
      // A second lookup would mean the cache was consulted too late.
      expect(host.asked('lookup')).toEqual([sessionIdFor('oc_chat_1')])

      await sessions.acquire(fakeMessage({ chatId: 'oc_chat_2' }))
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_2')])
      expect(sessions.sessionIds).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_2')])
      expect(sessions.keyOf(sessionIdFor('oc_chat_2'))).toBe('oc_chat_2')
      expect(sessions.keyOf(sessionIdFor('oc_chat_3'))).toBeUndefined()
      await sessions.close()
    })

    it('binds one session per thread under the thread scope', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat-thread', host.ladder)

      await sessions.acquire(fakeMessage({ threadId: 'omt_a' }))
      await sessions.acquire(fakeMessage({ threadId: 'omt_a', content: 'again' }))
      await sessions.acquire(fakeMessage({ threadId: 'omt_b' }))
      expect(host.asked('create')).toEqual([
        sessionIdFor('oc_chat_1:omt_a'),
        sessionIdFor('oc_chat_1:omt_b'),
      ])
      await sessions.close()
    })

    it('opens exactly one session for a concurrent burst on one key', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)

      const [first, second, third] = await Promise.all([
        sessions.acquire(fakeMessage({ content: 'a' })),
        sessions.acquire(fakeMessage({ content: 'b' })),
        sessions.acquire(fakeMessage({ content: 'c' })),
      ])
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1')])
      // A raced second session would have to be disposed to stay consistent.
      expect(host.disposals).toEqual([])
      await sessions.close()
    })

    it('clears the slot after a failed create so the next message retries', async () => {
      const host = createFakeLadder({ failCreate: true })
      const sessions = new ConversationSessions('chat', host.ladder)

      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('create rejected (fake)')
      host.behavior.failCreate = false
      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(true)
      expect(host.asked('create')).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_1')])
      await sessions.close()
    })

    it('adopts a live agent without owning its disposal', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ live: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(false)
      expect(opened.handle.agent.session.id).toBe(sessionId)
      expect(host.asked('resume')).toEqual([])
      expect(host.asked('create')).toEqual([])

      await sessions.close()
      // Its own owner takes it down; disposing it here would be a double free.
      expect(host.disposals).toEqual([])
    })

    it('owns a resumed agent', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ resumable: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(true)
      expect(host.asked('resume')).toEqual([sessionId])
      expect(host.asked('create')).toEqual([])
      expect(host.reports).toEqual([])

      await sessions.close()
      expect(host.disposals).toEqual([sessionId])
    })

    it('reports a failed resume and then creates', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat-sender', host.ladder)
      const sessionId = sessionIdFor('oc_chat_1:ou_sender_1')

      const opened = await sessions.acquire(fakeMessage())
      expect(opened.owned).toBe(true)
      expect(host.asked('resume')).toEqual([sessionId])
      expect(host.asked('create')).toEqual([sessionId])
      // Key and reason both reach the operator: an unreadable log must not pass
      // as a chat nobody ever messaged.
      expect(host.reports).toHaveLength(1)
      expect(host.reports[0]!).toContain('oc_chat_1:ou_sender_1')
      expect(host.reports[0]!).toContain('no stored session (fake)')
      await sessions.close()
    })

    it('propagates the create failure when resume failed too', async () => {
      const host = createFakeLadder({ failCreate: true })
      const sessions = new ConversationSessions('chat', host.ladder)

      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('create rejected (fake)')
      expect(host.reports).toHaveLength(1)
      expect(host.disposals).toEqual([])
    })

    it('says the log is damaged instead of replaying the create collision', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ corrupt: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const failure = await sessions.acquire(fakeMessage()).then(() => undefined, (error: unknown) => error as Error)

      // The chat reads the record that failed, not the collision it caused.
      expect(failure?.message).toContain('会话存档损坏')
      expect(failure?.message).toContain('第 2520 行')
      expect(failure?.message).toContain('seq gap (expected 2519, got 2515)')
      expect(failure?.message).not.toContain('already exists')
      // create() is never asked: its only possible answer is what buried the cause.
      expect(host.asked('create')).toEqual([])
      expect(host.reports.join('\n')).toContain(`session ${sessionId} cannot be opened (corrupt)`)
      expect(host.reports.join('\n')).toContain('seq gap (expected 2519, got 2515)')
      await sessions.close()
    })

    it('moves a conversation off its damaged session so the next message works', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ corrupt: [sessionId] })
      const home = mkdtempSync(join(tmpdir(), 'dsh-quarantine-'))
      const sessions = new ConversationSessions('chat', host.ladder, createRotationStore(home))

      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('会话存档损坏')

      // The escape: the conversation now lives on a fresh id, and the damaged
      // log is left exactly where it was.
      const opened = await sessions.acquire(fakeMessage())
      const moved = opened.handle.agent.session.id
      expect(moved).not.toBe(sessionId)
      expect(moved.startsWith(`${sessionId}:r`)).toBe(true)
      expect(host.asked('resume')).toEqual([sessionId, moved])
      expect(host.asked('create')).toEqual([moved])
      await sessions.close()

      // A restart reads the move back, so the deadlock does not return with it.
      const restarted = new ConversationSessions('chat', host.ladder, createRotationStore(home))
      const again = await restarted.acquire(fakeMessage())
      expect(again.handle.agent.session.id).toBe(moved)
      expect(again.handle.agent.session.id).not.toBe(sessionId)
      await restarted.close()
    })

    it('moves a conversation off an id duplicated across project directories', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      // The chat was pointed at a new cwd: the same id is now stored under two
      // project directories, so the host refuses to list or create it.
      const host = createFakeLadder({ duplicate: [sessionId] })
      const home = mkdtempSync(join(tmpdir(), 'dsh-duplicate-'))
      const sessions = new ConversationSessions('chat', host.ladder, createRotationStore(home))

      const failure = await sessions.acquire(fakeMessage()).then(() => undefined, (error: unknown) => error as Error)

      // The chat reads a plain explanation, not the raw host refusal.
      expect(failure?.message).toContain('换过工作目录')
      expect(failure?.message).toContain('原样保留')
      expect(failure?.message).not.toContain('already exists')
      expect(failure?.message).not.toContain('duplicate JSONL session id')
      expect(host.reports.join('\n')).toContain(`session ${sessionId} cannot be opened (duplicate)`)

      // The escape: the conversation lives on a fresh id and works again — the
      // old copy is left where it is, still addressable.
      const opened = await sessions.acquire(fakeMessage())
      const moved = opened.handle.agent.session.id
      expect(moved).not.toBe(sessionId)
      expect(moved.startsWith(`${sessionId}:r`)).toBe(true)
      expect(host.asked('create')).toEqual([sessionId, moved])
      await sessions.close()

      // A restart reads the move back, so the duplicate cannot deadlock it.
      const restarted = new ConversationSessions('chat', host.ladder, createRotationStore(home))
      const again = await restarted.acquire(fakeMessage())
      expect(again.handle.agent.session.id).toBe(moved)
      await restarted.close()
    })

    it('reports a log format this build cannot read as such, not as absence', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ foreign: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const failure = await sessions.acquire(fakeMessage()).then(() => undefined, (error: unknown) => error as Error)

      expect(failure?.message).toContain('读不了的格式')
      expect(failure?.message).toContain('upgrade the harness')
      expect(failure?.message).not.toContain('already exists')
      expect(host.asked('create')).toEqual([])
      await sessions.close()
    })

    it('falls back to the resume rejection when a taken id names no class', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ denied: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const failure = await sessions.acquire(fakeMessage()).then(() => undefined, (error: unknown) => error as Error)

      // `create` proved an archive is there, so its `already exists` must not be
      // the last word: the permission failure is.
      expect(failure?.message).toContain('会话存档存在但打不开')
      expect(failure?.message).toContain('permission denied')
      expect(failure?.message).not.toContain('already exists')
      // And the conversation still escapes on the next message.
      const opened = await sessions.acquire(fakeMessage())
      expect(opened.handle.agent.session.id).not.toBe(sessionId)
      await sessions.close()
    })

    it('still creates when the host says the session is absent', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ absent: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const opened = await sessions.acquire(fakeMessage())

      expect(opened.owned).toBe(true)
      expect(opened.handle.agent.session.id).toBe(sessionId)
      expect(host.asked('create')).toEqual([sessionId])
      // The benign rejection is still reported: an unreadable log we cannot
      // classify must not pass silently as first contact.
      expect(host.reports).toHaveLength(1)
      await sessions.close()
    })

    it('takes the agent when the session appeared between resume and create', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ race: [sessionId] })
      const sessions = new ConversationSessions('chat', host.ladder)

      const opened = await sessions.acquire(fakeMessage())

      // Another owner created the session after our resume said absent: adopt
      // it rather than move a healthy conversation onto a fresh id.
      expect(opened.handle.agent.session.id).toBe(sessionId)
      expect(host.asked('resume')).toEqual([sessionId, sessionId])
      expect(host.asked('create')).toEqual([sessionId])
      expect(host.reports.join('\n')).not.toContain('cannot be opened')
      await sessions.close()
    })

    it('leaves a healthy stored session alone', async () => {
      const sessionId = sessionIdFor('oc_chat_1')
      const host = createFakeLadder({ resumable: [sessionId] })
      const home = mkdtempSync(join(tmpdir(), 'dsh-healthy-'))
      const rotation = createRotationStore(home)
      const sessions = new ConversationSessions('chat', host.ladder, rotation)

      const opened = await sessions.acquire(fakeMessage())

      expect(opened.handle.agent.session.id).toBe(sessionId)
      expect(host.asked('resume')).toEqual([sessionId])
      expect(host.asked('create')).toEqual([])
      expect(host.reports).toEqual([])
      // Nothing moved: a store that reports a session and quietly rotates it
      // would cost every restart its history.
      expect(rotation.current('oc_chat_1')).toBeUndefined()
      await sessions.close()
    })

    it('disposes owned agents once and refuses later acquisitions', async () => {
      const host = createFakeLadder({ live: [sessionIdFor('oc_chat_2')] })
      const sessions = new ConversationSessions('chat', host.ladder)
      await sessions.acquire(fakeMessage())
      await sessions.acquire(fakeMessage({ chatId: 'oc_chat_2' }))

      await sessions.close()
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(sessions.sessionIds).toEqual([])
      expect(sessions.keyOf(sessionIdFor('oc_chat_1'))).toBeUndefined()

      await sessions.close()
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      await expect(sessions.acquire(fakeMessage())).rejects.toThrow('sessions are closed')
    })

    it('surfaces disposal failures as an AggregateError', async () => {
      const host = createFakeLadder({ failDispose: true })
      const sessions = new ConversationSessions('chat', host.ladder)
      await sessions.acquire(fakeMessage())
      await sessions.acquire(fakeMessage({ chatId: 'oc_chat_2' }))

      const failure = await sessions.close().then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(2)
      // Every agent was still asked to go down, not just the first.
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1'), sessionIdFor('oc_chat_2')])
    })

    it('disposes a session that opens after close', async () => {
      const host = createFakeLadder()
      const sessions = new ConversationSessions('chat', host.ladder)
      const opening = sessions.acquire(fakeMessage())

      await sessions.close()
      await expect(opening).rejects.toThrow('closed while opening')
      // The sweep already ran, so nothing else would ever take this agent down.
      expect(host.disposals).toEqual([sessionIdFor('oc_chat_1')])
      expect(sessions.sessionIds).toEqual([])
    })
  })
})

describe('session rotation', () => {
  /** An in-memory rotation store, shared across store instances like the file. */
  function memoryStore() {
    const map = new Map<string, string>()
    return {
      map,
      store: {
        current: (key: string): string | undefined => map.get(key),
        record: (key: string, sessionId: string): boolean => { map.set(key, sessionId); return true },
      },
    }
  }

  it('rotates a conversation to a stamped session and takes the old agent down', async () => {
    const host = createFakeLadder()
    const { map, store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r1' })

    const first = await sessions.acquire(msg)
    expect(first.handle.agent.session.id).toBe(sessionIdFor('oc_chat_r1'))

    const rotated = await sessions.rotate(msg)
    expect(rotated.handle.agent.session.id).toMatch(/^feishu-oc_chat_r1:r/)
    expect(map.get('oc_chat_r1')).toBe(rotated.handle.agent.session.id)
    expect(host.disposals).toContain(sessionIdFor('oc_chat_r1'))

    const again = await sessions.acquire(msg)
    expect(again.handle.agent.session.id).toBe(rotated.handle.agent.session.id)
  })

  it('resumes the rotated session after a restart (store outlives the process)', async () => {
    const { map, store } = memoryStore()
    const rotatedId = 'feishu-oc_chat_r2:rstamp'
    map.set('oc_chat_r2', rotatedId)
    const host = createFakeLadder({ resumable: [rotatedId] })
    const sessions = new ConversationSessions('chat', host.ladder, store)

    const opened = await sessions.acquire(fakeMessage({ chatId: 'oc_chat_r2' }))
    expect(opened.handle.agent.session.id).toBe(rotatedId)
    expect(host.asked('resume')).toEqual([rotatedId])
  })

  it('keeps the previous binding when creating the fresh session fails', async () => {
    const host = createFakeLadder()
    const { store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r3' })
    await sessions.acquire(msg)

    host.behavior.failCreate = true
    await expect(sessions.rotate(msg)).rejects.toThrow('create rejected (fake)')
    const again = await sessions.acquire(msg)
    expect(again.handle.agent.session.id).toBe(sessionIdFor('oc_chat_r3'))
  })

  it('records the mapping before disposing, so a dispose failure cannot strand it', async () => {
    const host = createFakeLadder({ failDispose: true })
    const { map, store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r4' })
    await sessions.acquire(msg)

    const rotated = await sessions.rotate(msg)
    expect(map.get('oc_chat_r4')).toBe(rotated.handle.agent.session.id)
    expect(host.reports.some(line => line.includes('pre-rotation'))).toBe(true)
  })

  /** Make `create` slow so a rotation can be observed mid-flight. */
  function slowCreate(host: ReturnType<typeof createFakeLadder>, delayMs = 25): void {
    const original = host.ladder.create.bind(host.ladder)
    host.ladder.create = async (sessionId: string): Promise<HostAgentHandle> => {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return original(sessionId)
    }
  }

  it('refuses a second /new while the first is still rotating', async () => {
    const host = createFakeLadder()
    const { store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r5' })
    await sessions.acquire(msg)

    slowCreate(host)
    const first = sessions.rotate(msg)
    await expect(sessions.rotate(msg)).rejects.toThrow('还在进行中')
    const rotated = await first
    // The first rotation is the one that binds.
    expect(rotated.handle.agent.session.id).toContain(':r')
  })

  it('a message landing mid-rotation waits and lands on the new session', async () => {
    const host = createFakeLadder()
    const { store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r6' })
    await sessions.acquire(msg)

    slowCreate(host)
    const rotating = sessions.rotate(msg)
    const arriving = sessions.acquire(msg)
    const [rotated, opened] = await Promise.all([rotating, arriving])
    expect(opened.handle.agent.session.id).toBe(rotated.handle.agent.session.id)
  })

  it('a message landing on a failing rotation falls back to the old session', async () => {
    const host = createFakeLadder()
    const { store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r7' })
    await sessions.acquire(msg)

    // Only the ROTATION's create fails; the first bind above needed a working one.
    host.behavior.failCreate = true
    slowCreate(host)
    const rotating = sessions.rotate(msg)
    const opened = await sessions.acquire(msg)
    expect(opened.handle.agent.session.id).toBe(sessionIdFor('oc_chat_r7'))
    await expect(rotating).rejects.toThrow('create rejected')
  })

  it('reports a failed rotation record to the caller', async () => {
    const host = createFakeLadder()
    const store = { current: () => undefined, record: () => false }
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r8' })
    await sessions.acquire(msg)

    const rotated = await sessions.rotate(msg)
    expect(rotated.persisted).toBe(false)
  })

  it('rotate racing close() leaves no stranded agent', async () => {
    const host = createFakeLadder()
    const { store } = memoryStore()
    const sessions = new ConversationSessions('chat', host.ladder, store)
    const msg = fakeMessage({ chatId: 'oc_chat_r9' })
    await sessions.acquire(msg)

    slowCreate(host)
    const rotating = sessions.rotate(msg)
    await sessions.close()
    await expect(rotating).rejects.toThrow('closed')
    // The agent the rotation created went down with it.
    const created = host.asked('create').at(-1)!
    expect(host.disposals).toContain(created)
  })
})

describe('rotation store (file-backed)', () => {
  it('round-trips a mapping through the file, surviving a restart', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-rot-'))
    const store = createRotationStore(home)
    expect(store.current('oc_x')).toBeUndefined()
    expect(store.record('oc_x', 'feishu-oc_x:rabc')).toBe(true)
    // A fresh store reads it back — the mapping outlives the process.
    expect(createRotationStore(home).current('oc_x')).toBe('feishu-oc_x:rabc')
  })

  it('reads a corrupt file as no rotations', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-rot-'))
    writeFileSync(rotationPath(home), '{oops')
    expect(createRotationStore(home).current('oc_x')).toBeUndefined()
  })

  it('reports a failed write instead of pretending', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-rot-'))
    // Occupy the home path with a file: mkdir under it must fail.
    const blocked = join(home, 'blocked')
    writeFileSync(blocked, 'x')
    expect(createRotationStore(blocked).record('oc_x', 'id')).toBe(false)
  })

  it('gives every rotation a distinct id even in the same millisecond', () => {
    expect(rotatedSessionId('base', 123)).not.toBe(rotatedSessionId('base', 123))
  })
})
