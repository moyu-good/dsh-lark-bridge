/**
 * Inbound admission, transport observability, and durable sessions: which
 * messages reach an agent, which transport facts reach the operator, and which
 * agent a conversation comes back to.
 */

import { LarkChannelError } from '@larksuite/channel'
import type { RejectEvent } from '@larksuite/channel'
import { describe, expect, it, vi } from 'vitest'
import { createFakePresets, fakeMessage, mountChannel } from './harness.ts'
import type { LoggedLine } from './harness.ts'

/** A rejection carrying one reason, with the other fields filled in. */
function rejection(reason: RejectEvent['reason'], overrides: Partial<RejectEvent> = {}): RejectEvent {
  return { messageId: 'om_r1', chatId: 'oc_chat_1', senderId: 'ou_sender_1', reason, ...overrides }
}

/** Notices whose text contains `needle`. */
function matching(notices: readonly string[], needle: string): string[] {
  return notices.filter(line => line.includes(needle))
}

/** Logged lines of one level whose text contains `needle`. */
function logged(logs: readonly LoggedLine[], type: LoggedLine['type'], needle: string): string[] {
  return logs.filter(line => line.type === type && line.text.includes(needle)).map(line => line.text)
}

describe('inbound admission', () => {
  it('never answers a message a bot authored', async () => {
    const harness = await mountChannel()
    try {
      await harness.fake.emitMessage(fakeMessage({ senderIsBot: true, content: 'from another bot' }))
      await new Promise((done) => { setTimeout(done, 30) })
      expect(harness.agents.created).toHaveLength(0)
      // Not even probed for: a bot's message is refused before any session work.
      expect(harness.agents.looked).toEqual([])
      // Nothing reaches the chat either: no process, no message.
      expect(harness.fake.cots).toHaveLength(0)
      expect(harness.fake.sent).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('answers a sender whose kind the event omitted', async () => {
    const harness = await mountChannel()
    try {
      await harness.fake.emitMessage(fakeMessage({ content: 'from a human' }))
      // The inbound path is detached from the emit, and a first-contact chat
      // probes for a stored session before creating one.
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1)
    } finally {
      await harness.dispose()
    }
  })

  it('spends no turn on a mention that carries no text', async () => {
    const harness = await mountChannel()
    try {
      await harness.fake.emitMessage(fakeMessage({ content: '', mentionedBot: true }))
      await harness.fake.emitMessage(fakeMessage({ content: '   \n  ', mentionedBot: true }))
      await new Promise((done) => { setTimeout(done, 30) })
      expect(harness.agents.created).toHaveLength(0)
      // Acknowledging would promise work no turn is doing.
      // Nothing reaches the chat either: no process, no message.
      expect(harness.fake.cots).toHaveLength(0)
      expect(harness.fake.sent).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe('transport observability', () => {
  it('reports a transport failure with its code', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.emitError(new LarkChannelError('rate_limited', 'too many card updates'))
      const reported = matching(harness.notices, 'too many card updates')
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('rate_limited')
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a missing group mention out of the operator console', async () => {
    const harness = await mountChannel()
    try {
      const before = harness.notices.length
      harness.fake.emitReject(rejection('no_mention'))
      // The configured steady state of a group: on the console it would flood,
      // so it is traceable at debug and nowhere louder.
      expect(harness.notices).toHaveLength(before)
      expect(logged(harness.logs, 'debug', 'no_mention')).toHaveLength(1)
      expect(logged(harness.logs, 'info', 'no_mention')).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('logs every other refusal with the message, chat, and sender', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.emitReject(rejection('sender_not_allowed', { messageId: 'om_x', senderId: 'ou_stranger' }))
      const reported = logged(harness.logs, 'info', 'sender_not_allowed')
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('om_x')
      expect(reported[0]).toContain('oc_chat_1')
      expect(reported[0]).toContain('ou_stranger')
      // Only a tripped loop guard is loud enough for the console.
      expect(matching(harness.notices, 'sender_not_allowed')).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('announces a tripped bot loop guard, naming the chat', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.emitReject(rejection('bot_loop', { chatId: 'oc_loop' }))
      const reported = matching(harness.notices, 'loop guard')
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('oc_loop')
    } finally {
      await harness.dispose()
    }
  })

  it('announces a lost connection as a delivery gap, then its recovery', async () => {
    const harness = await mountChannel()
    try {
      harness.fake.emitConnectionState('reconnecting')
      // There is no replay and no cursor, so the gap is a gap in delivery.
      expect(matching(harness.notices, 'not replayed')).toHaveLength(1)
      harness.fake.emitConnectionState('reconnected')
      expect(matching(harness.notices, 'connection restored')).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('stops reporting once the fiber unwinds', async () => {
    const harness = await mountChannel()
    await harness.dispose()
    const after = harness.notices.length
    harness.fake.emitError(new LarkChannelError('unknown', 'late failure'))
    harness.fake.emitReject(rejection('bot_loop'))
    harness.fake.emitConnectionState('reconnecting')
    expect(harness.notices).toHaveLength(after)
    expect(harness.fake.state.subscriptions).toBe(0)
  })
})

describe('durable sessions', () => {
  it('resumes a stored conversation instead of starting an empty one', async () => {
    const harness = await mountChannel()
    try {
      // The chat was served before this process started.
      harness.agents.resumable.add('feishu-oc_chat_1')
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })

      expect(harness.agents.resumed).toEqual(['feishu-oc_chat_1'])
      // A resumed agent carries no meta, and gets the composition a fresh one
      // gets: without it, it would reach the model with no tools.
      const opened = harness.agents.created[0]!
      expect(opened.meta).toBeUndefined()
      expect(opened.setupRan).toBe(true)
      expect(opened.denyReason('ask_user_question')).toBeUndefined()
      expect(opened.agent.followup).toHaveBeenCalledTimes(1)
    } finally {
      await harness.dispose()
    }
  })

  it('reports a resume that reached no stored session', async () => {
    const harness = await mountChannel()
    try {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })

      // The rejection is the registry's only existence probe, so a corrupt
      // session log must not pass silently as a chat nobody ever messaged.
      const reported = logged(harness.logs, 'info', 'no stored session for feishu-oc_chat_1')
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('oc_chat_1')
    } finally {
      await harness.dispose()
    }
  })

  it('adopts an agent another owner published without disposing it', async () => {
    const harness = await mountChannel()
    const adopted = harness.agents.declareLive('feishu-oc_chat_1')
    try {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(adopted.followup).toHaveBeenCalledTimes(1) })
      // Neither rung was walked: the live agent is the conversation's session.
      expect(harness.agents.resumed).toEqual([])
      expect(harness.agents.created).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
    // Its own owner takes it down; disposing it here would be a double free.
    expect(harness.agents.created).toHaveLength(0)
    expect(harness.agents.live.get('feishu-oc_chat_1')).toBe(adopted)
  })

  it('gives each topic thread its own session under the thread scope', async () => {
    const harness = await mountChannel({ sessionScope: 'chat-thread' })
    try {
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_a', threadId: 'omt_a' }))
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_b', threadId: 'omt_b' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
      // Parallel topics would otherwise overwrite each other's context.
      expect(harness.agents.created.map(record => record.sessionId)).toEqual([
        'feishu-oc_chat_1:omt_a',
        'feishu-oc_chat_1:omt_b',
      ])
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_c', threadId: 'omt_a' }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(2)
      })
      expect(harness.agents.created).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  it('shares one session across a chat under the default scope', async () => {
    const harness = await mountChannel()
    try {
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_a', threadId: 'omt_a' }))
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_b', threadId: 'omt_b' }))
      await vi.waitFor(() => {
        expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(2)
      })
      expect(harness.agents.created.map(record => record.sessionId)).toEqual(['feishu-oc_chat_1'])
    } finally {
      await harness.dispose()
    }
  })

  it('reads the preset roster once for a first-contact chat', async () => {
    const presets = createFakePresets()
    const harness = await mountChannel({}, { presets: presets.presets })
    try {
      await harness.fake.emitMessage(fakeMessage())
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      // The resume probe, the create that follows it, and the renderer that
      // describes the session's calls all share one resolution.
      expect(presets.resolved).toEqual([undefined])
      expect(harness.agents.created[0]!.meta?.agentPreset).toBe('default')
    } finally {
      await harness.dispose()
    }
  })

  it('aims the reply at the message that triggered it, inside its thread', async () => {
    const harness = await mountChannel({ showProcess: false })
    try {
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_ask', threadId: 'omt_1' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const session = harness.agents.created[0]!.agent.session
      harness.ctx.emit('session/event', session, {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } },
      })
      // The answer is the text a turn ends on, so the turn has to end.
      harness.ctx.emit('session/event', session, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
      })

      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      // Tied to the message that asked, and kept in the topic it was asked in.
      expect(harness.fake.sent[0]!.opts?.replyTo).toBe('om_ask')
      expect(harness.fake.sent[0]!.opts?.replyInThread).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves a reply outside any thread unthreaded', async () => {
    const harness = await mountChannel({ showProcess: false })
    try {
      await harness.fake.emitMessage(fakeMessage({ messageId: 'om_ask' }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const session = harness.agents.created[0]!.agent.session
      harness.ctx.emit('session/event', session, {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } },
      })
      harness.ctx.emit('session/event', session, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
      })

      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      expect(harness.fake.sent[0]!.opts?.replyTo).toBe('om_ask')
      expect(harness.fake.sent[0]!.opts?.replyInThread).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})
