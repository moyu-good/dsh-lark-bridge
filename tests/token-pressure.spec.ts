import { describe, expect, it, vi } from 'vitest'
import type { HostSession, HostTokenMeter } from '../src/host.ts'
import { tokenPressureLine } from '../src/notices.ts'
import { fakeMessage, mountChannel } from './harness.ts'

const THRESHOLD = 3_000
/** The schema floor; polls run on the production cadence, driven by fake timers. */
const INTERVAL_MS = 60_000

/**
 * A `tokenMeter` that prices a session the way the host's does: replay the
 * session log through `seq` + `eventAt(seq)` and add up what each event costs.
 *
 * The replay loop is written against `session.seq` in the same shape as the
 * upstream `_sync` (its `while (consumed < session.seq)`), which is what makes
 * this double worth having: handed something that merely carries an `id`, the
 * comparison is against `undefined`, the loop never runs, and every session
 * prices at zero — silently, because nothing throws. That is the production
 * failure this spec pins; a double that reads `id` and looks up a total in a
 * fixture table could never see it.
 */
function createFakeTokenMeter() {
  /** Every session object the bridge handed `measure`, in call order. */
  const priced: HostSession[] = []
  const service: HostTokenMeter = {
    measure(session: HostSession) {
      priced.push(session)
      let totalTokens = 0
      let surfaceTokens = 0
      for (let seq = 0; seq < session.seq; seq += 1) {
        const event = session.eventAt(seq) as { tokens?: number; surface?: number } | undefined
        totalTokens += event?.tokens ?? 0
        surfaceTokens += event?.surface ?? 0
      }
      return { totalTokens, surfaceTokens }
    },
  }
  return { service, priced }
}

/**
 * The context-pressure warnings this run posted, in send order.
 *
 * Matched on the advice tail rather than a nickname. The old matcher looked for
 * the words 「上下文压力」, which were also the message's opening — when the
 * wording was rewritten to say what the number is made of, the matcher stopped
 * matching, and the test failed for a text change it was never about. The tail
 * is the part every variant keeps.
 */
function pressureWarnings(harness: Awaited<ReturnType<typeof mountChannel>>) {
  return harness.fake.sent.filter(
    sent => 'markdown' in sent.input && sent.input.markdown.includes('/compact'),
  )
}

/** Hold until exactly `count` pressure warnings went out; a quiet sweep fails loudly. */
async function waitForWarnings(harness: Awaited<ReturnType<typeof mountChannel>>, count: number) {
  await vi.waitFor(() => {
    const warnings = pressureWarnings(harness)
    if (warnings.length !== count) {
      throw new Error(`expected ${count} context-pressure warning(s), got ${warnings.length} of ${harness.fake.sent.length} send(s)`)
    }
  }, { timeout: 10_000, interval: 50 })
}

/**
 * Mount the bridge, drive one inbound message so a session is bound, and hand
 * back that session's log. The log is the only input the fake meter prices, so
 * a test grows the context by appending to it.
 */
async function mountWithLiveSession() {
  const meter = createFakeTokenMeter()
  const harness = await mountChannel(
    { onboarding: false, tokenPressure: { enabled: true, intervalMs: INTERVAL_MS, threshold: THRESHOLD } },
    { tokenMeter: meter.service },
  )
  await harness.fake.emitMessage(fakeMessage({ content: '长任务' }))
  // The inbound handler is fire-and-forget (the bridge voids it), so the agent
  // and its binding land after `emitMessage` returns. The 1 s default timeout
  // is what the suite's own config calls out as the flake on a loaded machine.
  await vi.waitFor(() => {
    if (harness.agents.created.length === 0) throw new Error('the inbound message created no agent')
  }, { timeout: 30_000, interval: 50 })
  const session = harness.agents.created[0]!.agent.session
  const events = harness.agents.sessionEvents.get(session.id)!
  return { harness, meter, session, events }
}

describe('context-pressure polling', () => {
  it('prices the bound session object and warns once per crossing', async () => {
    vi.useFakeTimers()
    try {
      const { harness, meter, session, events } = await mountWithLiveSession()
      // Two events well past the advice line, with only a sliver of it being聊 content: the warning must repeat the numbers it measured.
      events.push({ tokens: 90_000, surface: 4_000 }, { tokens: 55_000, surface: 1_200 })

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // What the meter was handed: the host's own session object, with the
      // fields the replay needs. Soft, so a run that hands it an id reports
      // this AND the missing warning below instead of stopping at the first.
      // Every poll is checked rather than a count assumed: waiting out a slow
      // agent creation can advance the clock far enough for an early poll.
      const priced = meter.priced.at(-1)
      expect.soft(meter.priced.length).toBeGreaterThan(0)
      for (const seen of meter.priced) expect.soft(seen).toBe(session)
      expect.soft(priced?.seq).toBe(2)
      expect.soft(typeof priced?.eventAt).toBe('function')

      await waitForWarnings(harness, 1)

      // The measured total — not a threshold constant — is what the chat reads.
      expect(pressureWarnings(harness)[0]!.input).toEqual({
        markdown: tokenPressureLine({ total: 145_000, surface: 5_200, threshold: THRESHOLD }),
      })

      // Still over the line: the next poll must not repeat itself. The zero
      // advance lets the poll's fire-and-forget send land before counting, so a
      // duplicate is caught here rather than reported as a passing quiet step.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(1)

      // Compaction drops the session back under the line: no new warning, and
      // the crossing is re-armed.
      events.length = 0
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(1)

      // A fresh climb warns again.
      events.push({ tokens: 130_000, surface: 2_000 })
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      // 她只被提醒两次：一次在 token 涨过线，一次在压缩后重新涨过线。
      await waitForWarnings(harness, 2)
      // 掉回线下不算"再次跨线"：等待期间不重复提醒，重新爬上来才算。
      events.push({ tokens: 20_000, surface: 500 })
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(2)

      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet while the session prices below the threshold', async () => {
    vi.useFakeTimers()
    try {
      const { harness, events } = await mountWithLiveSession()
      events.push({ tokens: 2_000, surface: 1_000 })

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(0)

      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the number it measured, so the sweep cannot be silent', async () => {
    // A sweep that succeeds says nothing, and "the meter was handed the
    // wrong thing" looks exactly like "no session is under pressure" -
    // the failure this spec exists to catch would be invisible from
    // outside. The poll therefore leaves a line with the number it
    // measured.
    vi.useFakeTimers()
    try {
      const { harness, meter, events } = await mountWithLiveSession()
      events.push({ tokens: 90_000, surface: 4_000 })

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      await vi.waitFor(() => {
        const lines = harness.notices.filter(line => line.includes('token pressure poll'))
        expect(lines.length).toBeGreaterThan(0)
        // The line carries the total the meter returned, so a non-zero
        // total is proof that the meter read the session rather than an id.
        expect(lines.some(line => /total=[1-9]/.test(line))).toBe(true)
      }, { timeout: 30_000, interval: 50 })

      const first = harness.notices.filter(line => line.includes('token pressure poll'))
      // A second poll with an unchanged number adds no line: the log is
      // not allowed to become a stream of identical lines.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      const second = harness.notices.filter(line => line.includes('token pressure poll'))
      expect(second.length).toBe(first.length)

      // A changed number speaks again.
      events.push({ tokens: 5_000, surface: 200 })
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      const third = harness.notices.filter(line => line.includes('token pressure poll'))
      expect(third.length).toBe(first.length + 1)

      expect(meter.priced.length).toBeGreaterThan(0)
      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a session whose meter throws, and says so', async () => {
    // One session with an unusable meter must not stall the sweep for the
    // others, and the failure must leave a trace - a session that is
    // silently skipped is a session nobody knows is unmeasured.
    vi.useFakeTimers()
    try {
      const harness = await mountChannel(
        { onboarding: false, tokenPressure: { enabled: true, intervalMs: INTERVAL_MS, threshold: THRESHOLD } },
        {
          tokenMeter: {
            measure() {
              throw new Error('the meter is not ready')
            },
          },
        },
      )
      await harness.fake.emitMessage(fakeMessage({ content: '长任务' }))
      await vi.waitFor(() => {
        if (harness.agents.created.length === 0) throw new Error('the inbound message created no agent')
      }, { timeout: 30_000, interval: 50 })

      // The sweep runs, the throw is caught, and the session is skipped.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)

      // Nothing was posted about pressure: the measurement failed, so the
      // chat is not told a number that was never measured.
      expect(pressureWarnings(harness)).toHaveLength(0)

      // And the failure is on the record.
      const logged = harness.logs.filter(line => line.text.includes('token pressure measure failed'))
      expect(logged.length).toBeGreaterThan(0)
      expect(logged.some(line => line.text.includes('the meter is not ready'))).toBe(true)

      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
