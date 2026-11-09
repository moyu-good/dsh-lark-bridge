/**
 * Workflow fan-out as a few chat lines instead of one per subagent.
 *
 * A workflow run appends one `agent-start` and one `agent-end` event per
 * member. A 68-member scan therefore produced 136 near-identical chat
 * messages inside a couple of minutes — enough to trip Feishu's per-chat rate
 * limit on its own, and unreadable on a phone even when it did not.
 *
 * The information a reader actually wants is "it is fanning out, this much is
 * done, this much failed". That is a counter, so this narrator counts: lines
 * that arrive inside one window are folded into a single message, and the run
 * closes with one summary line. Ordering and identity survive as a short label
 * preview; everything else becomes arithmetic.
 * @module dsh-lark-bridge/workflow-narrator
 */

import type {
  WorkflowAgentEnd,
  WorkflowAgentStart,
  WorkflowRunEnd,
  WorkflowRunStart,
} from './workflow.ts'
import { runEndLine, runStartLine } from './workflow.ts'

/** How the narrator reaches a chat: one markdown send. */
export interface WorkflowNarratorPort {
  send(chatId: string, input: { markdown: string }): Promise<unknown>
}

/** Tuning for {@link createWorkflowNarrator}. */
export interface WorkflowNarratorOptions {
  /**
   * How long member events are collected before they are sent as one line.
   *
   * Defaults to 2 s: long enough that a fan-out of eight launches or finishes
   * inside it becomes one message, short enough that a reader still watches
   * the run progress.
   */
  readonly coalesceMs?: number
  /** Labels quoted in one line before it degrades to a count. */
  readonly maxLabels?: number
  /** Report a send failure. */
  readonly onFailure?: (error: unknown) => void
}

/** Totals for one run, kept so the closing line can state the outcome. */
interface RunTotals {
  started: number
  completed: number
  failed: number
  cancelled: number
}

/** What one window collected; cleared every time it is sent. */
interface RunDelta {
  /** Labels of members that started inside this window. */
  readonly started: string[]
  completed: number
  failed: number
  cancelled: number
}

/** Per-run accumulation shared by the event handlers. */
interface RunState {
  readonly chatId: string
  readonly totals: RunTotals
  readonly delta: RunDelta
  timer?: ReturnType<typeof setTimeout> | undefined
}

/** The surface the bridge drives as workflow events arrive. */
export interface WorkflowNarrator {
  /** A run opened: announce it at once, then start coalescing. */
  runStart(run: WorkflowRunStart, chatId: string): void
  /** A member started. */
  agentStart(agent: WorkflowAgentStart, chatId: string): void
  /** A member settled. */
  agentEnd(agent: WorkflowAgentEnd, chatId: string): void
  /**
   * A run closed: flush what is left into the summary instead of sending it as
   * its own line, so a fast run is exactly two messages.
   */
  runEnd(run: WorkflowRunEnd, chatId: string): void
  /** Cancel every pending window. */
  dispose(): void
}

/**
 * Quote at most `max` labels, then state how many were left out.
 * @param labels - labels collected in the window, in arrival order.
 * @param max - how many to quote.
 * @returns one clause, or an empty string when nothing started.
 */
function labelPreview(labels: readonly string[], max: number): string {
  if (labels.length === 0) return ''
  if (labels.length <= max) return labels.join('、')
  return `${labels.slice(0, max).join('、')} 等 ${labels.length} 个`
}

/**
 * Render the delta of one window as chat markdown.
 *
 * Nothing is sent when the window collected nothing, which keeps a run whose
 * members all started in an earlier window from emitting empty lines.
 * @param delta - what the window collected.
 * @param maxLabels - label budget for the start clause.
 * @returns the line, or undefined when there is nothing to say.
 */
function progressLine(delta: RunDelta, maxLabels: number): string | undefined {
  const parts: string[] = []
  if (delta.started.length > 0) {
    parts.push(`启动 ${delta.started.length} 个（${labelPreview(delta.started, maxLabels)}）`)
  }
  if (delta.completed > 0) parts.push(`✅ ${delta.completed}`)
  if (delta.failed > 0) parts.push(`❌ ${delta.failed}`)
  if (delta.cancelled > 0) parts.push(`⏹️ ${delta.cancelled}`)
  if (parts.length === 0) return undefined
  return `  · ${parts.join(' · ')}`
}

/**
 * Close a run as one line: the terminal reason plus the counts that make it
 * meaningful, so 68 members do not need 68 lines to say what happened.
 * @param run - the closing event.
 * @param totals - everything the run did.
 * @returns the summary line.
 */
function summaryLine(run: WorkflowRunEnd, totals: RunTotals): string {
  const parts = [`启动 ${totals.started}`]
  if (totals.completed > 0) parts.push(`✅ ${totals.completed}`)
  if (totals.failed > 0) parts.push(`❌ ${totals.failed}`)
  if (totals.cancelled > 0) parts.push(`⏹️ ${totals.cancelled}`)
  return `${runEndLine(run)} · ${parts.join(' ')}`
}

/**
 * Build the coalescing narrator.
 * @param port - how to reach a chat.
 * @param options - window length, label budget, failure reporting.
 * @returns the narrator the bridge drives.
 */
export function createWorkflowNarrator(
  port: WorkflowNarratorPort,
  options: WorkflowNarratorOptions = {},
): WorkflowNarrator {
  const coalesceMs = options.coalesceMs ?? 2_000
  const maxLabels = options.maxLabels ?? 6
  const onFailure = options.onFailure ?? (() => {})

  const runs = new Map<string, RunState>()

  const send = (chatId: string, markdown: string): void => {
    void port.send(chatId, { markdown }).catch(onFailure)
  }

  const clearTimer = (state: RunState): void => {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  const flush = (state: RunState): void => {
    clearTimer(state)
    const line = progressLine(state.delta, maxLabels)
    state.delta.started.length = 0
    state.delta.completed = 0
    state.delta.failed = 0
    state.delta.cancelled = 0
    if (line !== undefined) send(state.chatId, line)
  }

  const schedule = (state: RunState): void => {
    if (state.timer !== undefined) return
    state.timer = setTimeout(() => { flush(state) }, coalesceMs)
    // A pending window must never hold the process open.
    ;(state.timer as unknown as { unref?: () => void }).unref?.()
  }

  const ensure = (runId: string, chatId: string): RunState => {
    const existing = runs.get(runId)
    if (existing !== undefined) return existing
    const state: RunState = {
      chatId,
      totals: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      delta: { started: [], completed: 0, failed: 0, cancelled: 0 },
    }
    runs.set(runId, state)
    return state
  }

  return {
    runStart(run, chatId) {
      // A re-delivered run-start must not restart the counters mid-run.
      if (runs.has(run.runId)) return
      ensure(run.runId, chatId)
      send(chatId, runStartLine(run))
    },
    agentStart(agent, chatId) {
      const state = ensure(agent.runId, chatId)
      state.totals.started += 1
      state.delta.started.push(agent.label)
      schedule(state)
    },
    agentEnd(agent, chatId) {
      const state = ensure(agent.runId, chatId)
      if (agent.outcome === 'completed') { state.totals.completed += 1; state.delta.completed += 1 }
      else if (agent.outcome === 'failed') { state.totals.failed += 1; state.delta.failed += 1 }
      else { state.totals.cancelled += 1; state.delta.cancelled += 1 }
      schedule(state)
    },
    runEnd(run, chatId) {
      const state = runs.get(run.runId) ?? ensure(run.runId, chatId)
      runs.delete(run.runId)
      clearTimer(state)
      send(chatId, summaryLine(run, state.totals))
    },
    dispose() {
      for (const state of runs.values()) clearTimer(state)
      runs.clear()
    },
  }
}
