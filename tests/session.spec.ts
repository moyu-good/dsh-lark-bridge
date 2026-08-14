import { describe, expect, it } from 'vitest'
import type { HostAgentHandle } from '../src/host.ts'
import { ConversationSessions, conversationKey, sessionIdFor } from '../src/session.ts'
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
  /** Reject `create` instead of producing an agent. */
  failCreate?: boolean
  /** Reject every produced agent's `dispose`. */
  failDispose?: boolean
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
      if (behavior.resumable?.includes(sessionId) !== true) throw new Error(`no stored session (fake): ${sessionId}`)
      return handleFor(sessionId)
    },
    async create(sessionId) {
      calls.push({ rung: 'create', sessionId })
      if (behavior.failCreate === true) throw new Error(`create rejected (fake): ${sessionId}`)
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
      expect(sessionIdFor('oc_chat_1')).toBe('lark-oc_chat_1')
      expect(sessionIdFor('oc_chat_1:omt_a')).toBe('lark-oc_chat_1:omt_a')
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
