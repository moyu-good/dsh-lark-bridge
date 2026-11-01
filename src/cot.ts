/**
 * The thinking process as a native CoT message.
 *
 * Feishu carries an agent's process as its own message, driven by AG-UI events,
 * and renders it the way the platform's own agents look: reasoning streams into
 * a thinking area, each tool call gets an icon and a title, each result gets a
 * code block. That vocabulary lines up with the host's session events almost
 * one to one, so this renderer translates rather than draws — and the final
 * answer goes where the platform says it belongs, in an ordinary message.
 * @module dsh-lark-bridge/cot
 */

import {
  assistantText,
  isAssistantChunkEvent,
  isAssistantMessageEvent,
  isStepStartEvent,
  isToolCallEvent,
  isToolResultEvent,
  isTurnEndEvent,
  isUserChatMessageEvent,
  toolResultText,
  turnErrorDetail,
} from './host.ts'
import { stripToolCallMarkup } from './outbound.ts'
import type { HostSessionEvent, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'
import { DEFAULT_LIMITS } from './config.ts'
import type { Limits } from './config.ts'
import { clockTime, duration } from './clock.ts'

/** One AG-UI event, as the write API takes it. */
export interface CotEvent {
  readonly event_type: string
  /** The event's own fields, JSON-encoded; the API caps one at 4096 characters. */
  readonly content: string
  /** Milliseconds, as a string, used by the client to order events. */
  readonly timestamp: string
}

/** A created thinking process, addressed by both ids on every write. */
export interface CotHandle {
  readonly cotId: string
  readonly messageId: string
}

/** The CoT operations this renderer drives. */
export interface CotPort {
  /** Open a thinking process in one chat, optionally aimed at the message that asked. */
  createCot(chatId: string, options: { replyTo?: string; hidden: boolean }): Promise<CotHandle>
  /** Append events to one thinking process, in order. */
  writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void>
}

/** How many events one write call may carry, per the API's own bound. */
const MAX_EVENTS_PER_WRITE = 50

/** How long one event's JSON may be, per the API's own bound. */
const MAX_EVENT_CONTENT_CHARS = 4096

/**
 * Tool-call kinds the host reports, mapped to the platform's icon vocabulary.
 * A kind with no counterpart falls through to the platform default rather than
 * guessing at a shape the icon set does not carry.
 */
const TOOL_ICONS: Record<string, string> = {
  read: 'read',
  edit: 'write',
  delete: 'write',
  move: 'write',
  search: 'search',
  fetch: 'search',
  execute: 'bash',
}

/** Tool names that spawn or drive subagents; their calls deserve a distinct label. */
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_report', 'subagent_control', 'send_message', 'interrupt_agent', 'list_agents'])

/** Prefix a subagent call's title so the chat reads it as a delegation, not a local tool. */
function subagentTitle(name: string, title: string): string {
  return SUBAGENT_TOOLS.has(name) ? `🧑💻 ${title}` : title
}

/**
 * The last timestamp handed out, so the next one is strictly greater.
 *
 * The client ORDERS events by this value, and a run emits many within one
 * millisecond — a burst of reasoning deltas sharing a timestamp is free to be
 * reordered, which is how one sentence arrives interleaved with the next.
 */
let lastTimestamp = 0

/**
 * Encode one AG-UI event, bounding its payload and stamping it after every
 * event already handed out.
 * @param eventType - the AG-UI event name.
 * @param content - the event's own fields.
 * @returns the event ready to write.
 */
function cotEvent(eventType: string, content: object): CotEvent {
  const encoded = JSON.stringify(content)
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return {
    event_type: eventType,
    content: encoded.length <= MAX_EVENT_CONTENT_CHARS
      ? encoded
      // Dropping the payload would lose the event; a truncation marker keeps
      // its shape valid while saying that something was cut.
      : JSON.stringify({ ...content as Record<string, unknown>, truncated: true, delta: undefined }),
    timestamp: String(lastTimestamp),
  }
}

/**
 * What one tool call's arguments are worth showing.
 *
 * The arguments of a file write are the whole file. Putting them in the
 * chat means the file's contents are copied into a conversation that
 * already has the file on disk, and a chat client renders a megabyte of
 * JSON as a wall. What a reader needs from a tool call is which tool ran
 * and on what — the path, the command, the query — not the payload.
 *
 * So the arguments are summarised: the keys whose values identify the
 * call are kept, and the ones that carry bulk are replaced by their size.
 * The full arguments stay in the session log, where the run can be read
 * later.
 */
const SUMMARY_KEYS = [
  'path', 'file_path', 'filePath', 'command', 'cmd', 'query', 'url', 'pattern',
  'pathPattern', 'glob', 'description', 'name', 'prompt', 'old_str', 'new_str',
  'subagent_type', 'description',
]

/**
 * A parameter this large is described by its size instead of its content: the
 * payload is a whole file or a migrated schema, and neither belongs in a card.
 */
const BULK_VALUE_CHARS = 200

/**
 * Summarise one tool call's arguments for the chat.
 *
 * @param argumentsJson - the arguments as the host delivered them.
 * @param maxValueChars - how much of one kept value to show.
 * @returns a short description of what the call was for.
 */
export function summariseArguments(argumentsJson: string, maxValueChars: number = DEFAULT_LIMITS.toolArgChars): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    // Not JSON: the first line says what it was, which is enough.
    const first = argumentsJson.split('\n')[0]?.trim() ?? ''
    return first.length > maxValueChars ? `${first.slice(0, maxValueChars - 1)}…` : first
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return String(parsed).slice(0, maxValueChars)
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  const kept: string[] = []
  for (const [key, value] of entries) {
    if (!SUMMARY_KEYS.includes(key)) {
      const size = typeof value === 'string' ? value.length : JSON.stringify(value)?.length ?? 0
      if (size > BULK_VALUE_CHARS) kept.push(`${key}: ${size} 字符`)
      continue
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    kept.push(`${key}: ${text.length > maxValueChars ? `${text.slice(0, maxValueChars - 1)}…` : text}`)
  }
  if (kept.length === 0) return `${entries.length} 个参数`
  return kept.join(' · ')
}

/**
 * What one tool result is worth showing.
 *
 * A command's output is output, not prose: the reader wants to know what
 * came back and whether it worked, not to read a thousand lines of it in
 * the chat. The head carries the answer; the rest stays in the session log.
 * The head is a budget, not a rule — a working session wants enough of it to
 * see why a command failed.
 * @param text - the tool's output.
 * @param lines - how many leading lines to show.
 * @param chars - how many characters those lines may take in total.
 * @returns the preview, with a marker when more lines exist.
 */
function summariseResult(
  text: string,
  lines: number = DEFAULT_LIMITS.toolResultLines,
  chars: number = DEFAULT_LIMITS.toolResultChars,
): string {
  const trimmed = text.trim()
  if (trimmed === '') return '（无输出）'
  const head = trimmed.split('\n').slice(0, lines).join('\n')
  const bounded = head.length > chars ? `${head.slice(0, chars - 1)}…` : head
  const total = trimmed.split('\n').length
  if (total > lines) return `${bounded}\n…（共 ${total} 行，完整结果见会话记录）`
  return bounded
}

/**
 * How much of a mid-turn message the process shows before eliding it.
 *
 * A person who pastes a stack trace into a running turn meant it for the
 * model, not for the thinking area — and one event's payload is capped anyway
 * (4096 characters), so the default stays under it. The head is enough to
 * recognise which message turned the run.
 */
/**
 * What one mid-turn message says.
 * @param data - the `user/message` payload.
 * @param maxChars - how much of it the thinking area shows.
 * @returns the message's text, bounded.
 */
function userChatMessageText(
  data: { readonly content: readonly { readonly type: string; readonly text?: string }[] },
  maxChars: number = DEFAULT_LIMITS.userMessageChars,
): string {
  const parts: string[] = []
  for (const block of data.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** Options for {@link createCotRenderer}. */
export interface CotRendererOptions {
  /** Whether the agent's reasoning and tool calls appear at all. */
  readonly showProcess: boolean
  /** Whether the platform hides the process once the run finishes. */
  readonly hidden: boolean
  /** The tool's own label and kind for one call. */
  readonly presentCall: ToolPresentation
  /** Report a handled failure to the operator. */
  readonly onFailure: (error: unknown) => void
  /** Renders the answer itself; the thinking process deliberately carries none. */
  readonly answer: OutboundRenderer
  /** Elision budgets for reasoning, arguments and results; defaults when absent. */
  readonly limits?: Limits
}

/** The thinking process of one turn, and the queue feeding it. */
interface LiveRun {
  readonly turn: number
  readonly opening: Promise<CotHandle | undefined>
  /** Events awaiting a write; drained in arrival order. */
  readonly pending: CotEvent[]
  /** Settles when the queue is idle, so disposal can wait for it. */
  draining: Promise<void>
  /** Whether a reasoning block is open, so its deltas append to one area. */
  reasoningOpen: boolean
  /**
   * The message id of the reasoning block that is open right now.
   *
   * Every block gets its own id, because the protocol hangs a reasoning
   * message off that id: reusing one id for a whole turn makes every later
   * block an edit of the first, and the client shows the whole turn's
   * thinking stacked at the top instead of where each thought happened.
   */
  reasoningId: string
  /** How many reasoning blocks this turn has opened; the id's counter. */
  reasoningBlocks: number
  /** Whether the run was already closed by a terminal event. */
  finished: boolean
  /** When the turn opened, so the closing line can say how long it took. */
  readonly startedAt: number
  /** How many tool calls the turn made, so the closing line can say. */
  toolCalls: number
  /** How many mid-turn messages were shown, so each gets its own area. */
  userMessages: number
  /**
   * When each in-flight tool call started, keyed by its id, so its result can
   * say how long it took.
   *
   * The gap between a call and its result is the one thing a reader watching a
   * run cannot see: the process fills in order, but a step that sat for forty
   * seconds and a step that returned instantly look exactly the same once both
   * have scrolled past. The host's own event carries no elapsed time, so it is
   * measured here, at the two points the renderer already sees.
   */
  readonly callStarted: Map<string, number>
  /** The title of the most recent tool call, for the run's slowest-step line. */
  lastToolTitle: string
  /** The slowest call this run made, so the closing line can name it. */
  slowest: { title: string; ms: number } | undefined
}

/**
 * The closing line, as an event the answer half can send.
 *
 * @param run - the finished run.
 * @param failure - the failure detail, empty when the turn succeeded.
 * @returns the event carrying the line.
 */
function closingEvent(run: LiveRun, failure: string | undefined): HostSessionEvent {
  const text = failure === undefined ? closingLine(run) : `⚠️ 本轮失败 · ${failure}`
  return {
    type: 'assistant/message',
    data: {
      turn: run.turn,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  } as HostSessionEvent
}

/**
 * The line that says the turn is over.
 *
 * A reader watching twenty-six tool calls scroll past has no way to tell
 * that the run ended — the process closes, but nothing says so in words.
 * The count and the elapsed time are the two facts a reader wants at that
 * moment: how much happened, and how long it took.
 */
function closingLine(run: LiveRun): string {
  const calls = run.toolCalls === 0 ? '无工具调用' : `${run.toolCalls} 次工具调用`
  const parts = [`✅ 本轮完成 · ${calls} · 用时 ${duration(Date.now() - run.startedAt)}`]
  // A run's total says how long it took; it does not say where the time went.
  // Naming the slowest step is what turns "四分钟" into something a reader can
  // act on — which command to look at, and whether it should have been a
  // background job.
  if (run.slowest !== undefined && run.toolCalls > 1) {
    parts.push(`最慢 ${run.slowest.title} ${duration(run.slowest.ms)}`)
  }
  return parts.join(' · ')
}

/**
 * Renderer that shows the process as a native CoT message and leaves the answer
 * to `answer`. Falling back is the caller's job: when {@link CotPort.createCot}
 * rejects, this renderer reports it and the turn still answers, because the
 * answer never depended on the thinking process existing.
 * @param port - the CoT operations.
 * @param chatId - the owned chat.
 * @param options - what to show, and where the answer goes.
 * @returns the renderer.
 */
export function createCotRenderer(
  port: CotPort,
  chatId: string,
  options: CotRendererOptions,
): OutboundRenderer {
  const { showProcess, hidden, presentCall, onFailure, answer, limits = DEFAULT_LIMITS } = options
  let live: LiveRun | undefined
  let aimed: ReplyTarget | undefined
  /** A target that arrived mid-run; it owns the NEXT turn, never the live one. */
  let pendingAim: ReplyTarget | undefined
  /**
   * The turn's latest committed text, held because only the LAST one is the
   * answer. An agent narrates between tool calls — "let me look at the packages
   * first" — and every one of those commits would otherwise become its own
   * chat message, which is a wall of replies to a single question. Held at the
   * renderer, not on a run: the answer does not depend on a process existing.
   */
  let held: { turn: number; event: HostSessionEvent } | undefined
  const closing = new Set<Promise<void>>()

  /** Drain one run's queue, respecting the API's per-call event bound. */
  const drain = async (run: LiveRun): Promise<void> => {
    const handle = await run.opening
    if (handle === undefined) {
      run.pending.length = 0
      return
    }
    while (run.pending.length > 0) {
      const batch = run.pending.splice(0, MAX_EVENTS_PER_WRITE)
      await port.writeCotEvents(handle, batch).catch(onFailure)
    }
  }

  const enqueue = (run: LiveRun, ...events: CotEvent[]): void => {
    run.pending.push(...events)
    run.draining = run.draining.then(() => drain(run)).catch(onFailure)
  }

  /**
   * Open a fresh reasoning block for this run and announce it.
   *
   * The id is per block, not per turn: the protocol creates one reasoning
   * message per START carrying that id, so reusing a turn-wide id turns every
   * later thought into an edit of the first one. The reader then sees the whole
   * turn's thinking piled up at the top, far from the tool call it explains.
   * @param run - the run the block belongs to.
   * @returns the id its deltas must carry.
   */
  const openReasoning = (run: LiveRun): string => {
    run.reasoningBlocks += 1
    run.reasoningId = `reasoning-${run.turn}-${run.reasoningBlocks}`
    run.reasoningOpen = true
    enqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId: run.reasoningId, role: 'reasoning' }))
    return run.reasoningId
  }

  /** Close the open reasoning block, if any; a no-op otherwise. */
  const closeReasoning = (run: LiveRun): void => {
    if (!run.reasoningOpen) return
    run.reasoningOpen = false
    enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: run.reasoningId }))
  }

  /** The run for `turn`, opening one when the turn is new. */
  const ensure = (turn: number): LiveRun => {
    if (live !== undefined && live.turn === turn) return live
    if (live !== undefined) closeRun(live)
    if (pendingAim !== undefined) {
      aimed = pendingAim
      pendingAim = undefined
      answer.aim(aimed)
    }
    const opening = port
      .createCot(chatId, { ...aimed === undefined ? {} : { replyTo: aimed.messageId }, hidden })
      .catch((error: unknown) => {
        // The process is presentation; the answer still arrives without it.
        onFailure(error)
        return undefined
      })
    live = {
      turn,
      opening,
      pending: [],
      draining: Promise.resolve(),
      reasoningOpen: false,
      reasoningId: '',
      reasoningBlocks: 0,
      finished: false,
      startedAt: Date.now(),
      toolCalls: 0,
      userMessages: 0,
      callStarted: new Map(),
      lastToolTitle: '',
      slowest: undefined,
    }
    enqueue(live, cotEvent('RUN_STARTED', { threadId: chatId, runId: `turn-${turn}` }))
    return live
  }

  /** Finish one run, closing whatever it left open. */
  const closeRun = (run: LiveRun, failure?: string): void => {
    if (run.finished) return
    run.finished = true
    closeReasoning(run)
    // The line that says the run is over goes to the answer half, NOT into
    // the process: the platform hides the process when the run ends, so a
    // closing line written there would vanish with it. A reader who watched
    // twenty-six calls scroll past needs to be told, in a message that
    // stays, that the run finished.
    answer.handle(closingEvent(run, failure))
    enqueue(run, failure === undefined
      ? cotEvent('RUN_FINISHED', { threadId: chatId, runId: `turn-${run.turn}`, status: 'done' })
      : cotEvent('RUN_ERROR', { message: failure, code: 'TURN_FAILED' }))
    const settled = run.draining
    closing.add(settled)
    void settled.finally(() => closing.delete(settled))
  }

  return {
    aim(target) {
      // Mid-run re-aim deferral (P141): the running turn must keep answering
      // where it was asked — its process is already open under that target and
      // its answer is still owed there. The new target owns the NEXT turn.
      if (live !== undefined && !live.finished) {
        pendingAim = target
        return
      }
      aimed = target
      answer.aim(target)
    },
    handle(event) {
      if (isAssistantMessageEvent(event)) {
        const text = stripToolCallMarkup(assistantText(event.data))
        if (text === '') return
        const superseded = held?.turn === event.data.turn ? held.event : undefined
        held = { turn: event.data.turn, event }
        // The text this one replaces was narration, not an answer: it belongs
        // in the process, where the platform shows it as the agent's own words.
        if (superseded === undefined || !showProcess || !isAssistantMessageEvent(superseded)) return
        const run = ensure(event.data.turn)
        const messageId = `text-${run.turn}-${run.pending.length}`
        enqueue(
          run,
          cotEvent('TEXT_MESSAGE_START', { messageId, role: 'assistant' }),
          cotEvent('TEXT_MESSAGE_CONTENT', {
            messageId,
            delta: stripToolCallMarkup(assistantText(superseded.data)),
          }),
          cotEvent('TEXT_MESSAGE_END', { messageId }),
        )
        return
      }
      // Failures reach the chat through the answer half.
      if (isTurnEndEvent(event)) answer.handle(event)

      if (isUserChatMessageEvent(event)) {
        if (!showProcess) return
        // Only a message that lands MID-turn belongs here. The message that
        // opened the turn has a bubble of its own in the chat, and the process
        // for it opens a step later; showing it again would put the same
        // sentence twice in one screen.
        //
        // A mid-turn message is different: the chat answers it with a receipt
        // line ("已插话…"), never with the words themselves. The reader then
        // watches the agent change direction and has no way to tell what turned
        // it. This is the only place those words can appear, and it appears
        // exactly where the driver admitted them — between two steps of the
        // turn they redirected.
        if (live === undefined || live.finished) return
        const text = userChatMessageText(event.data, limits.userMessageChars)
        if (text === '') return
        const run = live
        // The message ends whatever the agent was thinking; the next reasoning
        // block opens on its own.
        closeReasoning(run)
        run.userMessages += 1
        const messageId = `user-${run.turn}-${run.userMessages}`
        enqueue(
          run,
          cotEvent('TEXT_MESSAGE_START', { messageId, role: 'user' }),
          cotEvent('TEXT_MESSAGE_CONTENT', { messageId, delta: text }),
          cotEvent('TEXT_MESSAGE_END', { messageId }),
        )
        return
      }

      if (isStepStartEvent(event)) {
        // With the process off, nothing here is ever shown — so no process is
        // opened either, and the chat carries answers alone.
        if (!showProcess) return
        // Opening the process here overlaps its round trip with the model's
        // time to first token. No STEP event is written: a step is one
        // iteration of the agent's own loop, and a reader who sees "step 1
        // … step 8" listed above the work learns nothing from the numbering
        // that the reasoning and tool calls do not already say.
        ensure(event.data.turn)
        return
      }
      if (isAssistantChunkEvent(event)) {
        const { chunk } = event.data
        // Only reasoning belongs here: the platform reserves this message for
        // the process, and the answer is sent as its own message.
        if (!showProcess) return
        // Two wire shapes arrive from the host: streaming models emit
        // `reasoning-delta` deltas; non-streaming adapters (pi-ai's deepseek
        // route in particular) emit a whole `block-end` with the reasoning
        // block's complete text and NO deltas in between. Both must render,
        // otherwise the thinking area stays empty for block-delivered runs.
        if (chunk.type === 'reasoning-delta') {
          if (chunk.text === undefined || chunk.text === '') return
          const run = ensure(event.data.turn)
          const messageId = run.reasoningOpen ? run.reasoningId : openReasoning(run)
          enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: chunk.text }))
          return
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning') {
          const text = chunk.block.text ?? ''
          if (text === '') return
          const run = ensure(event.data.turn)
          // A whole block in one event: close whatever was open, then open a
          // block of its own so it lands at this point in the process.
          closeReasoning(run)
          const messageId = openReasoning(run)
          enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: text }))
          closeReasoning(run)
          return
        }
        return
      }
      if (isToolCallEvent(event)) {
        if (!showProcess) return
        const run = ensure(event.data.turn)
        const shown = presentCall(event.data.name, event.data.arguments)
        const toolCallId = event.data.callId
        run.toolCalls += 1
        const startedAt = Date.now()
        run.callStarted.set(toolCallId, startedAt)
        closeReasoning(run)
        const title = subagentTitle(event.data.name, shown.title)
        run.lastToolTitle = title
        // The AG-UI event carries a timestamp, but only as an ordering key the
        // client never shows. A reader who wants to line a step up against the
        // message that asked for it has to read it off the title.
        const shownAt = clockTime(startedAt)
        enqueue(
          run,
          cotEvent('TOOL_CALL_START', {
            toolCallId,
            icon: TOOL_ICONS[shown.kind ?? ''] ?? 'default',
            title: shownAt === undefined ? title : `${title} · ${shownAt}`,
            toolCallName: event.data.name,
          }),
          // The summary, not the arguments: a file write's arguments are
          // the whole file, and the chat already has the file.
          cotEvent('TOOL_CALL_ARGS', { toolCallId, delta: summariseArguments(event.data.arguments, limits.toolArgChars) }),
          cotEvent('TOOL_CALL_END', { toolCallId }),
        )
        return
      }
      if (isToolResultEvent(event)) {
        if (!showProcess) return
        const { callId, text } = toolResultText(event.data)
        if (callId === undefined) return
        const run = ensure(event.data.turn)
        const startedAt = run.callStarted.get(callId)
        run.callStarted.delete(callId)
        const elapsed = startedAt === undefined ? undefined : Date.now() - startedAt
        if (elapsed !== undefined && (run.slowest === undefined || elapsed > run.slowest.ms)) {
          // The title the call itself used, so the closing line names the step
          // exactly as the reader saw it — not a second, differently-worded one.
          run.slowest = { title: run.lastToolTitle, ms: elapsed }
        }
        // How long the call took, on the result line where a reader looks for
        // "did it work, and how long did that take". A failure keeps the same
        // shape, which is what makes two runs comparable.
        const took = elapsed === undefined || elapsed < 1000 ? '' : `⏱ ${duration(elapsed)} · `
        enqueue(run, cotEvent('TOOL_CALL_RESULT', {
          messageId: `result-${callId}`,
          toolCallId: callId,
          role: 'tool',
          // A command's output reads as output, not prose — and not a
          // thousand lines of it either. The head carries the answer; the
          // rest is in the session log.
          content: {
            type: 'code',
            code: `${took}${summariseResult(text, limits.toolResultLines, limits.toolResultChars)}`,
          },
          ...event.data.error === undefined ? {} : { error: event.data.error.code },
        }))
        return
      }
      if (isTurnEndEvent(event)) {
        // One message per turn: the text the turn ended on.
        if (held?.turn === event.data.turn) {
          answer.handle(held.event)
          held = undefined
        }
        // The ended turn's target is spent; a mid-run re-aim now owns the next
        // turn (P141).
        if (pendingAim !== undefined) {
          aimed = pendingAim
          pendingAim = undefined
          answer.aim(aimed)
        }
        if (live === undefined || live.turn !== event.data.turn) return
        const run = live
        live = undefined
        const detail = turnErrorDetail(event.data)
        closeRun(run, detail === '' ? undefined : detail)
      }
    },
    async close() {
      if (held !== undefined) {
        answer.handle(held.event)
        held = undefined
      }
      if (live !== undefined) {
        const run = live
        live = undefined
        closeRun(run)
      }
      await Promise.allSettled([...closing, answer.close()])
    },
  }
}
