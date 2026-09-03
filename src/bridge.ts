/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-bridge/bridge
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { readDeviceState } from './sync/migrate.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  NormalizedMessage,
  RejectEvent,
  SendResult,
} from '@larksuite/channel'
import type { ResolvedConfig } from './config.ts'
import type {
  HostAgent,
  HostAgentHandle,
  HostAgentOptions,
  HostAgentPresets,
  HostAttachments,
  HostAgentRegistry,
  HostApprovalOutcome,
  HostApprovalRequest,
  HostDefaultModel,
  HostLoader,
  HostSessionEvent,
  HostSessionPersistence,
  HostCommands,
  HostContentBlock,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
  AuditStats,
  ScheduleEntry,
} from './host.ts'
import type { HostJobs, HostLoaderEntry, HostMessageFeedback, HostSessionQuery, HostSkills, HostTokenMeter, SubagentEndData, WorkflowRunInfoData } from './host.ts'
import { isAssistantMessageEvent, isCompactionEndEvent, isCompactionPruneEvent, isCompactionStartEvent, isCompactionSummaryEvent, isGoalChangeEvent, isLlmRetryEvent, isScheduleChangeEvent, isStepStartEvent, isSubagentDescriptorEvent, isTodoWriteEvent, isToolCallEvent, isTurnEndEvent, isWebSearchRequestEvent, isWorkflowAgentEndEvent, isWorkflowAgentStartEvent, isWorkflowRunEndEvent, isWorkflowRunStartEvent } from './host.ts'
import { createCotRenderer } from './cot.ts'
import type { CotPort } from './cot.ts'
import { createMessageRenderer, createStreamRenderer } from './outbound.ts'
import type { OutboundPort, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'
import { refuseApprovalClick, refuseMessage } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import { postChronicle } from './chronicle.ts'
import { briefingPrefix } from './briefing.ts'
import * as subCard from './subagent-card.ts'
import {
  AUDIT_COMMAND,
  CONFIG_COMMAND,
  CONTEXT_COMMAND,
  FEEDBACK_COMMAND,
  HELP_COMMAND,
  isCommandLine,
  JOBS_COMMAND,
  MODEL_COMMAND,
  PLUGINS_COMMAND,
  PRESET_COMMAND,
  RESTART_COMMAND,
  runCommandLine,
  SCHEDULES_COMMAND,
  SESSIONS_COMMAND,
  SKILLS_COMMAND,
  STOP_COMMAND,
  TOOLS_COMMAND,
  WS_COMMAND,
} from './commands.ts'
import { getSyncContext } from './sync/bot-command.ts'
import { collectImages } from './images.ts'
import { saveInboundFiles } from './files.ts'
import type { Locale } from './i18n.ts'
import type { CollectedImages, ImagePort } from './images.ts'
import { syncSlashPanel } from './slash-panel.ts'
import type { SlashPanelPort } from './slash-panel.ts'
import { describeCommand } from './i18n.ts'
import { ConversationSessions } from './session.ts'
import type { SessionLadder } from './session.ts'
import { createReactionTracker } from './reaction.ts'
import type { ReactionTracker } from './reaction.ts'
import { createQuestionProvider } from './questions.ts'
import type { HostUserQuestions } from './questions.ts'
import { createTodoRenderer } from './todo.ts'
import { createGoalRenderer } from './goal.ts'
import { goalActionValue, type GoalActionValue } from './goal.ts'
import {
  agentEndLine,
  agentStartLine,
  phaseLine,
  runEndLine,
  runStartLine,
  workflowLogLine,
} from './workflow.ts'
import {
  compactionPruneLine,
  compactionSummaryLine,
  jobDoneLine,
  retryLine,
  scheduleLine,
  subagentEndLine,
  tokenPressureLine,
  webSearchLine,
} from './notices.ts'
import { onboardingMessage } from './first-contact.ts'
import { createReplayPort } from './replay.ts'
import { createSendFileTool, deliverFile } from './files.ts'

/**
 * The transport surface the bridge drives. `LarkChannel` from
 * `@larksuite/channel` satisfies it structurally; tests substitute a fake.
 */
export interface ChannelPort extends OutboundPort, SlashPanelPort, ImagePort, CotPort {
  /** Open the transport (WebSocket long connection by default). */
  connect(): Promise<void>
  /** Close the transport and release its resources. */
  disconnect(): Promise<void>
  /** Subscribe one normalized inbound event; returns the unsubscriber. */
  on(name: 'message', handler: (msg: NormalizedMessage) => void | Promise<void>): () => void
  on(
    name: 'cardAction',
    handler: (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>,
  ): () => void
  /**
   * A message the transport's own policy layer refused. Subscribing is the only
   * way to tell "the bot ignored me" apart from "the bot is broken": a refusal
   * never reaches the `message` handler and is reported nowhere else.
   */
  on(name: 'reject', handler: (evt: RejectEvent) => void): () => void
  /**
   * A transport failure, including one thrown by an inbound handler: those do
   * NOT reject the awaited dispatch, so an unsubscribed channel loses them.
   */
  on(name: 'error', handler: (err: LarkChannelError) => void): () => void
  /** The long connection dropped; events arriving in the gap are not replayed. */
  on(name: 'reconnecting', handler: () => void): () => void
  /** The long connection is live again. */
  on(name: 'reconnected', handler: () => void): () => void
  /** Replace a sent card's content in place. */
  updateCard(messageId: string, card: object): Promise<void>
  /** Add an emoji reaction to a message; resolves the platform reaction id. */
  addReaction(messageId: string, emojiType: string): Promise<string>
  /** Remove a reaction by the id {@link addReaction} returned. */
  removeReaction(messageId: string, reactionId: string): Promise<void>
}

/** One conversation's chat and its outbound renderer, keyed by session id. */
interface ChatBinding {
  readonly chatId: string
  /** `p2p` or a group kind; approvals in a group are judged as the room. */
  readonly chatType: string
  readonly renderer: OutboundRenderer
  /** The triggering message this session is currently answering, for reaction feedback. */
  currentMessageId: string | undefined
}

/**
 * What one agent creation or resume composes, and the registry view the
 * session's calls are described through. A resumed agent needs the same
 * composition a fresh one gets.
 */
interface AgentComposition {
  /** Recorded on a created session so a later reader knows which preset it joined. */
  readonly presetId?: string
  /** Names what each call of this session's tools does, and its category. */
  readonly presentCall: ToolPresentation
  /** Creation-time composition: the preset join plus this channel's own rows. */
  readonly setup: (agentCtx: Context) => Promise<void>
}

/**
 * The `agents` registry as durable sessions need it. {@link HostAgentRegistry}
 * declares only `create`, so the two further rungs are narrowed here, the way
 * every other host service this bridge consumes is.
 */
interface DurableAgentRegistry extends HostAgentRegistry {
  /**
   * The live agent published on one session id.
   * @param sessionId - the session id to probe.
   * @returns the live agent, or undefined when nothing runs on that id.
   */
  get(sessionId: string): HostAgent | undefined
  /**
   * Load a stored session as a live agent. Takes no `meta`: the stored header
   * already carries the session's cwd and preset.
   * @param options - the session to load, its model route, and its composition.
   * @returns the resumed handle.
   * @throws when no session is stored under the id, or its log cannot be read.
   */
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
}

/** One approval card waiting for a button click. */
interface PendingApproval {
  readonly chatId: string
  readonly chatType: string
  readonly messageId: string
  readonly toolName: string
  /** Cancels the unanswered-card reminder, if one is armed. */
  clearReminder?: () => void
  settle(outcome: HostApprovalOutcome): void
}

/** How much of a pending call's arguments the approval card shows. */
const CARD_ARGUMENTS_MAX_CHARS = 600

/** Marker distinguishing this plugin's approval buttons from other card actions. */
const APPROVAL_ACTION = 'dsh-lark-bridge/approval'

/** Card-button payload carried by an approval decision. */
interface ApprovalActionValue {
  readonly kind: typeof APPROVAL_ACTION
  readonly id: string
  readonly decision: 'allow' | 'reject'
}

/**
 * Narrow an arbitrary card-action value to this plugin's approval payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
function approvalActionValue(value: unknown): ApprovalActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== APPROVAL_ACTION) return undefined
  if (typeof record.id !== 'string') return undefined
  if (record.decision !== 'allow' && record.decision !== 'reject') return undefined
  return { kind: APPROVAL_ACTION, id: record.id, decision: record.decision }
}

/**
 * Build the interactive approval card for one permission question.
 * @param toolName - the tool the question is about.
 * @param reason - the asker's explanation, when it gave one.
 * @param id - correlation id carried by both decision buttons.
 * @returns a Feishu card object for `send({ card })`.
 */
function approvalCard(
  toolName: string,
  reason: string | undefined,
  command: string | undefined,
  id: string,
): object {
  // Only this plugin's own labels use `lark_md`. Every untrusted value — the
  // model's justification and the exact arguments it wants to run — rides a
  // `plain_text` element, which the platform renders literally, so neither can
  // inject card markup or disguise itself as the card's own text.
  const untrusted = (label: string, value: string): object[] => [
    { tag: 'div', text: { tag: 'lark_md', content: `**${label}**` } },
    { tag: 'div', text: { tag: 'plain_text', content: value } },
  ]
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: 'DSH 操作审批' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${toolName}\`` } },
      ...command === undefined ? [] : untrusted('将执行', command),
      ...reason === undefined || reason === '' ? [] : untrusted('模型说明', reason),
      { tag: 'note', elements: [{ tag: 'plain_text', content: '批准前请确认上面的内容确实是你要执行的。' }] },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '允许一次' },
            type: 'primary',
            value: { kind: APPROVAL_ACTION, id, decision: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { kind: APPROVAL_ACTION, id, decision: 'reject' },
          },
        ],
      },
    ],
  }
}

/** Card headline and color for each settled approval outcome. */
const SETTLED_CARD: Record<HostApprovalOutcome, { template: string; text: string }> = {
  'allowed-once': { template: 'green', text: '✅ 已允许执行一次' },
  'rejected': { template: 'red', text: '⛔ 已拒绝' },
  'cancelled': { template: 'grey', text: '⏹ 请求已撤回' },
  'unavailable': { template: 'grey', text: '⏹ 无法作答' },
}

/**
 * Build the static replacement card shown after an approval settles.
 * @param toolName - the tool the question was about.
 * @param outcome - the closed decision.
 * @returns a Feishu card object for `updateCard`.
 */
function settledCard(toolName: string, outcome: HostApprovalOutcome, decidedBy?: string): object {
  const look = SETTLED_CARD[outcome]
  return {
    config: { wide_screen_mode: true },
    header: { template: look.template, title: { tag: 'plain_text', content: 'DSH 操作审批' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${toolName}\`\n${look.text}` } },
      // Who decided, named rather than restricted: with approvals open to a
      // room, the room should see whose press granted the escalation.
      ...decidedBy === undefined
        ? []
        : [{ tag: 'note', elements: [{ tag: 'plain_text', content: `操作人：${decidedBy}` }] }],
    ],
  }
}

/** How long one tool-activity label may be before it is ellipsized. */
const ACTIVITY_LABEL_MAX_CHARS = 90

/**
 * Reduce one presentation title to a single safe card line: the value is
 * model-influenced (a search pattern, a command) and rides a markdown card, so
 * newlines and code fences — the two things that could restructure the card —
 * come out, and the rest is bounded.
 * @param title - the tool's own label for this call.
 * @returns the label as one bounded line.
 */
function activityLabel(title: string): string {
  // One pass over both hazards: any run of whitespace (newlines included) or
  // backticks collapses to a single space, so neither a line break nor a code
  // fence in a model-influenced value can restructure the card.
  const line = title.replace(/[\s`]+/g, ' ').trim()
  return line.length <= ACTIVITY_LABEL_MAX_CHARS
    ? line
    : `${line.slice(0, ACTIVITY_LABEL_MAX_CHARS - 1)}…`
}

/**
 * Build the tool-call describer for one agent's view of the registry. Prefers
 * the tool's own `presentCall` title — the label the host's own surfaces show,
 * so a chat line says what a call does rather than repeating its name — then
 * the model's `description` argument, then the bare name.
 * @param tools - the host tool registry, when composed.
 * @param scope - the viewing scope key holding this agent's tools.
 * @returns a describer safe to call on every `tool/call` event.
 */
function createCallPresenter(tools: HostTools | undefined, scope: unknown): ToolPresentation {
  return (name, argumentsJson) => {
    let args: unknown
    try {
      args = JSON.parse(argumentsJson)
    } catch {
      // Raw model output: malformed JSON is the model's mistake, not a reason
      // to lose the activity line.
      return { title: name }
    }
    try {
      const view = tools?.get(name, scope)?.presentCall?.(args)
      const title = view?.title
      if (typeof title === 'string' && title.trim() !== '') {
        return {
          title: activityLabel(title),
          ...typeof view?.kind === 'string' ? { kind: view.kind } : {},
        }
      }
    } catch {
      // presentCall is contracted pure, but it is another package's code and a
      // throw here must not cost the chat its activity line.
    }
    const described = (args as { description?: unknown } | null)?.description
    return typeof described === 'string' && described.trim() !== ''
      ? { title: `${name} · ${activityLabel(described)}` }
      : { title: name }
  }
}

/**
 * Bound one untrusted value to what an approval card may carry.
 * @param text - raw tool arguments as the model produced them.
 * @returns the value, ellipsized when it exceeds the card's budget.
 */
function boundCardText(text: string): string {
  return text.length <= CARD_ARGUMENTS_MAX_CHARS
    ? text
    : `${text.slice(0, CARD_ARGUMENTS_MAX_CHARS - 1)}…`
}

/**
 * Compose the parts of a chat agent's world this channel owns: the tools it
 * must not call, and the prompt sentence that tells the model what to do
 * instead. Both registrations are scoped to this one agent.
 * @param agentCtx - the agent's scope context, inside creation `setup`.
 * @param config - resolved plugin configuration.
 */
/**
 * Compose one chat agent's channel-facing context: tool restrictions, the
 * channel identity prompt, and the channel-owned `send_file` tool when the
 * deployment offers file delivery.
 * @param agentCtx - the agent's scoped Cordis context.
 * @param config - resolved bridge configuration.
 * @param extraTools - channel-owned tools to register on this agent's scope.
 * @param runtimeDenied - the live denied-tool set shared across agents, when
 * the bridge offers runtime `/tools` toggling; falls back to a frozen copy of
 * `config.denyTools` when absent.
 */
function composeChatAgent(
  agentCtx: Context,
  config: ResolvedConfig,
  extraTools: readonly object[] = [],
  runtimeDenied: ReadonlySet<string> | undefined = undefined,
): void {
  // Channel-owned tools (currently `send_file`) register on the agent's own
  // scope, so they exist exactly where the agent looks, and vanish with it.
  const tools = agentCtx.get('tools') as (HostTools & { register(definition: object): () => void }) | undefined
  for (const tool of extraTools) {
    try {
      tools?.register(tool)
    } catch (error) {
      // A duplicate or reserved name must not fail the whole agent creation;
      // the tool simply does not exist for this agent.
      process.stderr.write(`dsh-lark-bridge: channel tool registration skipped (${String(error)})\n`)
    }
  }
  if (config.denyTools.length > 0 || (runtimeDenied !== undefined && runtimeDenied.size > 0)) {
    const denied = runtimeDenied ?? new Set(config.denyTools)
    // A guard rather than `tools.restrict()`: restrict validates its names
    // against the inherited registry and THROWS for one this composition does
    // not have, which would fail every chat agent's creation over a tool the
    // deployment simply never composed.
    ;(agentCtx.get('tools') as HostTools | undefined)?.guard(execution =>
      denied.has(execution.name)
        ? `${execution.name} is unavailable in this chat channel: its answer would surface on a `
          + 'different interface. Ask the user directly in your reply instead, and continue when they answer.'
        : undefined,
    )
  }
  // The channel's identity is a fact the model must know before anything else:
  // the same harness serves Web and CLI surfaces, and without an explicit
  // persona a chat agent answers as "a coding agent" instead of the Feishu bot
  // the human is actually talking to. Kept independent of denyTools so it is
  // always injected, not only when there is a tool restriction to announce.
  const prompt = agentCtx.get('systemPrompt') as HostSystemPrompt | undefined
  prompt?.section({
    name: 'dsh-lark-bridge:identity',
    order: 120,
    text: 'You are 云鹊桥 (dsh-lark-bridge), a coding agent running inside a Feishu/Lark chat '
      + 'via the DeepSeek Harness host. The person you are talking to is the user of this '
      + 'chat, not a machine. Reply in the same language they write in. '
      + 'You have the full coding-agent toolset of the host: you can read and edit files, run '
      + 'commands, and work on projects in the workspace. When you need a decision or want to '
      + 'ask a clarifying question, write it directly in your reply — their next message is the '
      + 'answer, and the chat keeps the conversation going. Do not describe your own '
      + 'architecture or ask what kind of interface you are running on; you are simply the bot '
      + 'in this chat.',
  })
  prompt?.section({
    name: 'dsh-lark-bridge:interaction',
    order: 150,
    text: 'To ask a question or seek approval for a plan, '
      + 'write it in your reply — their next message is the answer. '
      + (config.denyTools.length > 0
        ? `These tools are unavailable here: ${[...new Set(config.denyTools)].join(', ')}.`
        : ''),
  })
}

/**
 * Create an identified user message from one chat input. Group messages carry
 * the sender so the model can tell voices apart; direct messages stay verbatim.
 * @param msg - normalized inbound chat message.
 * @returns a frozen user message for `agent.followup()`.
 */
export function chatUserMessage(msg: NormalizedMessage, images: CollectedImages): HostUserMessage {
  const spoken = msg.chatType === 'group'
    ? `${msg.senderName ?? msg.senderId}: ${msg.content}`
    : msg.content
  // Notes ride the text so a model that cannot be shown an image still knows
  // one was sent, instead of answering as though it had seen it.
  const text = [spoken, ...images.notes].filter(line => line !== '').join('\n')
  const content: HostContentBlock[] = [
    ...text === '' ? [] : [{ type: 'text' as const, text }],
    ...images.blocks,
  ]
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' } as const),
  })
}

/**
 * Install the bridge on a scoped plugin context. Every registration is owned
 * by the context's fiber: disposal disconnects the transport, disposes every
 * agent this channel owns, and settles pending approvals as `'cancelled'`.
 * @param ctx - scoped plugin context carrying the `agents` service.
 * @param config - resolved plugin configuration.
 * @param port - the transport to drive; production passes the real Lark channel.
 */
export function installBridge(
  ctx: Context,
  config: ResolvedConfig,
  port: ChannelPort,
  notify: (line: string) => void,
  authorization: Authorization,
): void {
  // Wrap the transport so a long-connection gap queues outbound calls instead
  // of losing them; `setConnected` toggles the gate from the reconnecting /
  // reconnected subscriptions below.
  const rawPort = port
  const replay = createReplayPort(port, (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    notify(`dsh-lark-bridge: replay flush failed: ${detail}`)
  }, notify)
  // File delivery: `send_file` is the one channel-owned tool, registered per
  // agent below. The session→chat mapping is the bridge's own registry, and
  // the send rides the replay-wrapped transport so a connection gap queues
  // the file like any other outbound message.
  const sendFileTool = createSendFileTool({
    deliverBySession: async (sessionId, args) => {
      const binding = bySession.get(sessionId)
      if (binding === undefined) throw new Error(`会话 ${sessionId} 不在当前聊天`)
      return deliverFile(replay, binding.chatId, cwd, args)
    },
  })
  // The live denied-tool set: seeded from config, then toggled at runtime via
  // /tools. Every chat agent's guard reads this same object, so a switch takes
  // effect on the next tool call without a restart.
  const runtimeDeniedTools = new Set<string>(config.denyTools)
  // Active schedules seen this process, keyed by session id then schedule id.
  // Rebuilt from schedule/change events as they stream in; a restart starts
  // empty (the schedules themselves survive in the session log).
  const scheduleRegistry = new Map<string, Map<string, ScheduleEntry>>()
  // Per-session preset choice made via /preset. Process-local: a restart
  // falls back to the configured default, which the /config command states.
  const sessionPresets = new Map<string, string>()
  const subagentTrackers = new Map<string, subCard.SubagentCardState>()
  // Per-session operation counters for /audit, accumulated from the session
  // event stream. Process-local like the schedule registry.
  const auditStats = new Map<string, AuditStats>()
  const bySession = new Map<string, ChatBinding>()
  const pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Arguments of tool calls this turn requested, by call id. An approval names
   * the call it decides but not what that call does, and the human cannot judge
   * an escalation without seeing the command; the log already published these.
   */
  const pendingCallArguments = new Map<string, string>()
  /** Live workflow run id -> chat id, fed by the durable run-start event. */
  const workflowChats = new Map<string, string>()
  /** Most recent assistant message id per session, for `/feedback`. */
  const lastAssistantIds = new Map<string, string>()
  // Sessions that already received a token-pressure warning since the last
  // drop below threshold. Re-arms when a later poll finds the session back
  // under the threshold, so a fresh climb warns again.
  const pressureWarned = new Set<string>()
  const cwd = resolve(config.cwd ?? process.cwd())

  /**
   * Proactive context-pressure polling. While a live session is bound, the
   * host `tokenMeter` reports how many tokens the session's context costs; a
   * long task that outgrows the advised ceiling degrades quality before any
   * compaction runs. This heads-up posts at most once per crossing.
   */
  const pollTokenPressure = (): void => {
    if (config.tokenPressure.enabled === false) return
    const tokenMeter = ctx.get('tokenMeter') as HostTokenMeter | undefined
    if (tokenMeter === undefined) return
    const { threshold } = config.tokenPressure
    for (const [sessionId, binding] of bySession) {
      let total: number
      let surface: number
      try {
        const measure = tokenMeter.measure({ id: sessionId })
        total = measure.totalTokens
        surface = measure.surfaceTokens
      } catch (error) {
        // A session without a usable meter is not the chat's problem; log and
        // move on so one bad session cannot stall the whole sweep.
        ctx.logger.warn('token pressure measure failed for %s: %s', sessionId, error)
        continue
      }
      if (total >= threshold) {
        if (pressureWarned.has(sessionId)) continue
        pressureWarned.add(sessionId)
        void replay
          .send(binding.chatId, {
            markdown: tokenPressureLine({ total, surface, threshold }),
          })
          .catch(reportSendFailure)
      } else {
        pressureWarned.delete(sessionId)
      }
    }
  }

  const pressureTimer = config.tokenPressure.enabled === false
    ? undefined
    : setInterval(pollTokenPressure, config.tokenPressure.intervalMs)

  /**
   * The workspace chat sessions are accounted under, resolved once. Workspace
   * grouping is an ACCOUNT, not a cwd derivation: a session nobody attaches
   * stays in the GUI's Ungrouped bucket however its cwd reads. Registering the
   * directory when no record exists keeps chat sessions out of that bucket
   * instead of orphaning every one of them.
   */
  let workspacePromise: Promise<HostWorkspace | undefined> | undefined
  const chatWorkspace = (): Promise<HostWorkspace | undefined> => {
    workspacePromise ??= (async () => {
      const registry = ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
      if (registry === undefined) return undefined
      return (await registry.resolveByPath(cwd)) ?? await registry.create(cwd)
    })().catch((error: unknown) => {
      // Grouping is presentation: a chat must still work in a deployment whose
      // registry refuses this directory.
      notify(`dsh-lark-bridge: workspace lookup failed for ${cwd}: ${String(error)}`)
      return undefined
    })
    return workspacePromise
  }

  // Operator-facing, so it goes to the process stream as well as the logger:
  // the shipped profiles compose no logger printer, and a silently swallowed
  // outbound failure is indistinguishable from a hung chat.
  const reportSendFailure = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error)
    notify(`dsh-lark-bridge: outbound send failed: ${detail}`)
    ctx.logger.warn('outbound send failed: %s', detail)
  }

  /** Lifecycle emoji feedback on triggering messages; disabled by configuration. */
  const reactions: ReactionTracker | undefined = config.reactionFeedback
    ? createReactionTracker(port, undefined, reportSendFailure)
    : undefined

  /**
   * Live todo progress cards: `todo_write` snapshots render as one card per
   * session, updated in place. This is the chat equivalent of the Web UI's
   * sidebar todo projection.
   */
  const todos = createTodoRenderer(port, reportSendFailure)

  /** Live goal cards: `goal/change` snapshots render as one card per session. */
  const goals = createGoalRenderer(port, reportSendFailure)

  /**
   * The model-to-human question flow. dsh's `ask_user_question` tool pauses a
   * tool call until a human answers through the single user-questions provider.
   *
   * The seam allows exactly ONE provider. The web profile's api-proxy
   * registers it first (its questions surface in the browser), so a bridge
   * registered on the web profile would fail the plugin's fiber asynchronously
   * and stop the WebSocket from connecting. Deploy the bridge on a profile
   * WITHOUT the web-app bundle (e.g. bundles = [dsh-base, dsh-lark-bridge]):
   * then this bridge owns the slot and the model's question becomes a Feishu
   * card. On the web profile the register is skipped and chat agents ask in
   * prose instead.
   */
  const questions = createQuestionProvider(port, (sessionId) => {
    const binding = bySession.get(sessionId)
    return binding === undefined ? undefined : { chatId: binding.chatId }
  })
  const hostQuestions = ctx.get('userQuestions') as HostUserQuestions | undefined
  let disposeQuestions: (() => void) | undefined
  if (hostQuestions !== undefined) {
    try {
      disposeQuestions = hostQuestions.registerProvider(questions.provider)
    } catch (error) {
      // Synchronous throw (wrong profile composition) or a later async
      // fiber failure both land here only for synchronous throws; an async
      // effect failure would surface as a plugin error instead. The card
      // handler stays installed either way so a slot that opens later can
      // resolve pending questions.
      notify(`dsh-lark-bridge: user-questions provider unavailable (${error instanceof Error ? error.message : String(error)})`)
      ctx.logger.warn('user-questions provider unavailable: %s', error)
    }
  }

  /** Resolve the provider/model for a new chat agent; config overrides the host default. */
  const modelSelection = (): HostAgentOptions => {
    if (config.provider !== undefined || config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }
    const defaults = ctx.get('agentDefaultModel') as HostDefaultModel | undefined
    if (defaults === undefined) {
      throw new Error(
        'dsh-lark-bridge: no model configured — set config.provider/model or compose the agentDefaultModel service',
      )
    }
    return defaults.currentSelection()
  }

  /**
   * Resolve what one agent joins, and the view its calls are described through.
   * A deployment with a preset roster keeps every model-facing row on the agent
   * plane, so an agent that joins nothing reaches the model with NO tools and
   * none of the deployment's prompt sections. The id is resolved up front to
   * record it, and the join happens inside setup so a broken preset rolls the
   * whole creation back instead of publishing a toolless session.
   * @returns the composition every rung of one session's ladder applies.
   * @throws when the roster supplies no such preset.
   */
  const composeAgent = async (sessionId: string): Promise<AgentComposition> => {
    // Loader siblings mount concurrently; await the complete application so a
    // first message arriving during boot never sees a half-composed agent world.
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    const presets = ctx.get('agentPresets') as HostAgentPresets | undefined
    // A /preset switch is remembered per session, so a later resume (the chat
    // speaking again after /stop, or a bridge restart) composes the preset the
    // human chose instead of silently falling back to the configured default.
    const presetId = presets === undefined ? undefined : (await presets.resolve(sessionPresets.get(sessionId) ?? config.preset)).id
    // A roster keeps every tool off the global layer, so its standing key is
    // the view that can describe this agent's calls.
    const toolScope = presets === undefined || presetId === undefined
      ? undefined
      : await presets.standingKeyFor(presetId)
    return {
      ...presetId === undefined ? {} : { presetId },
      presentCall: createCallPresenter(ctx.get('tools') as HostTools | undefined, toolScope),
      setup: async (agentCtx: Context) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        composeChatAgent(agentCtx, config, [sendFileTool], runtimeDeniedTools)
        // Background jobs: a registered under this agent scope sees exactly the
        // jobs its owner starts. Announce terminals so a long-running task's
        // completion is visible in the chat instead of silent until asked.
        // Direct subagent tool calls announce their settlement live. The
        // opening is already covered by the durable subagent/descriptor line,
        // so only the terminal edge is rendered here.
        agentCtx.on('subagent/end', (info: SubagentEndData) => {
          const binding = bySession.get(sessionId)
          if (binding === undefined) return
          void replay.send(binding.chatId, { markdown: subagentEndLine(info) }).catch(reportSendFailure)
        })
        const jobs = agentCtx.get('jobs') as HostJobs | undefined
        jobs?.onJobDone((snapshot) => {
          if (snapshot.status === 'running' || snapshot.status === 'stopping') return
          const binding = bySession.get(sessionId)
          if (binding === undefined) return
          const terminal: {
            readonly id: string
            readonly kind: string
            readonly label: string
            readonly status: 'completed' | 'killed' | 'failed'
            readonly detail?: string
          } = {
            id: snapshot.id,
            kind: snapshot.kind,
            label: snapshot.label,
            status: snapshot.status,
            ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
          }
          void replay.send(binding.chatId, { markdown: jobDoneLine(terminal) }).catch(reportSendFailure)
        })
      },
    }
  }

  /**
   * One composition per session id, shared by the resume attempt, the create
   * that follows it, and the renderer that describes the session's calls.
   * Resolving a preset re-reads the roster, and a first-contact chat walks every
   * rung, so an uncached ladder would read the roster once per rung.
   */
  const compositions = new Map<string, Promise<AgentComposition>>()
  const compositionFor = (sessionId: string): Promise<AgentComposition> => {
    let pending = compositions.get(sessionId)
    if (pending === undefined) {
      pending = composeAgent(sessionId)
      compositions.set(sessionId, pending)
      // A rejected composition is not replayed: the next message may arrive
      // after the roster it named was fixed.
      pending.catch(() => { compositions.delete(sessionId) })
    }
    return pending
  }

  const agents = ctx.agents as DurableAgentRegistry

  /** Session ids created (not resumed) this boot — they get the first-contact guide. */
  const freshlyCreated = new Set<string>()

  const ladder: SessionLadder = {
    lookup: (sessionId) => {
      const agent = agents.get(sessionId)
      // An agent another owner published is theirs to dispose.
      return agent === undefined ? undefined : { agent, dispose: () => Promise.resolve() }
    },
    resume: async (sessionId) => {
      const composition = await compositionFor(sessionId)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: modelSelection(),
        setup: composition.setup,
      })
      // The panel is app-wide and reconcile is idempotent; a resumed session
      // after a restart must refresh it too, or the human's `/` list keeps
      // whatever the previous boot published.
      publishSlashPanel(handle.agent)
      return handle
    },
    create: async (sessionId) => {
      const composition = await compositionFor(sessionId)
      // The workspace's own canonical path, so `attachSession` finds the header
      // cwd it validates against rather than an uncanonicalized variant of it.
      const workspace = await chatWorkspace()
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: workspace?.path ?? cwd,
          ...composition.presetId === undefined ? {} : { agentPreset: composition.presetId },
        },
        agentOptions: modelSelection(),
        setup: composition.setup,
      })
      // Only a true first contact (create, not resume) gets the guide; a
      // resumed session across restarts must not see it a second time.
      freshlyCreated.add(sessionId)
      if (workspace !== undefined) {
        await workspace.attachSession(sessionId).catch((error: unknown) => {
          notify(`dsh-lark-bridge: session ${sessionId} stays ungrouped: ${String(error)}`)
        })
      }
      // The panel is app-wide, and the command list is only knowable from an
      // agent's scope, so the first chat to exist is what can publish it.
      publishSlashPanel(handle.agent)
      return handle
    },
    // A rejected resume is the registry's only existence probe, and an
    // unreadable session log looks exactly like a chat nobody ever messaged, so
    // the ladder's handled failures are reported rather than swallowed.
    report: (line) => { ctx.logger.info(line) },
  }

  const sessions = new ConversationSessions(config.sessionScope, ladder)

  /**
   * The renderer for one session, opened on first use and kept until the fiber
   * unwinds: it holds the turn's streaming card, which outlives any one message.
   * @param sessionId - the session whose events it renders.
   * @param msg - the message that reached this session.
   * @returns the binding, the same object for every later message of the session.
   * @throws when the session's composition cannot be resolved.
   */
  const bindingFor = async (sessionId: string, msg: NormalizedMessage): Promise<ChatBinding> => {
    const existing = bySession.get(sessionId)
    if (existing !== undefined) return existing
    const { presentCall } = await compositionFor(sessionId)
    // The renderer is the composition's last reader; dropping it here leaves the
    // next conversation bound on this id to read the roster fresh.
    compositions.delete(sessionId)
    const binding: ChatBinding = {
      chatId: msg.chatId,
      chatType: msg.chatType,
      renderer: renderFor(msg.chatId, presentCall),
      currentMessageId: undefined,
    }
    bySession.set(sessionId, binding)
    // First contact this boot: send the one-time guide. Best-effort — a send
    // failure must not block the chat that already has the agent working.
    if (config.onboarding && freshlyCreated.delete(sessionId)) {
      void replay.send(binding.chatId, onboardingMessage()).catch(reportSendFailure)
    }
    return binding
  }

  /**
   * The renderer one chat's output goes through.
   *
   * `cot` shows the process as the platform's own agent messages do — reasoning
   * in a thinking area, each tool call with an icon and its result as a code
   * block — and leaves the answer to an ordinary markdown message, which is
   * where the platform says a final answer belongs. `stream` keeps the whole
   * turn in one typewriter card instead, for clients older than that surface.
   * Either way `showProcess` decides whether the process is shown at all.
   * @param chatId - the chat this renderer serves.
   * @param presentCall - the session's tool presenter.
   * @returns the renderer for the configured output.
   */
  const renderFor = (chatId: string, presentCall: ToolPresentation): OutboundRenderer => {
    if (config.output === 'stream') {
      return createStreamRenderer(port, chatId, {
        showProcess: config.showProcess,
        presentCall,
        onFailure: reportSendFailure,
      })
    }
    return createCotRenderer(port, chatId, {
      showProcess: config.showProcess,
      hidden: config.hideProcessWhenDone,
      presentCall,
      onFailure: reportSendFailure,
      answer: createMessageRenderer(port, chatId, reportSendFailure),
    })
  }

  /**
   * Publish what this chat accepts to the bot's `/` panel. Reconcile is
   * idempotent (create missing, remove stale), so it runs on every session
   * acquire — a restart that resumes sessions still refreshes the panel.
   * Fire and forget: discovery is a convenience, and every command works
   * typed by hand.
   */
  /**
   * The Loader tree as of now, flattened for the chat inventory: the bridge's
   * scoped context shares the root loader, so its entries ARE the deployment's
   * plugin tree. Structural group rows (no name) are filtered downstream.
   */
  const loaderEntries = (): HostLoaderEntry[] | undefined => {
    try {
      // The bridge's scoped context delegates `loader` to the root; the cast is
      // safe because every dsh deployment mounts the loader plugin.
      const root = ctx as unknown as { loader?: { entries?: () => Iterable<unknown> } }
      return [...(root.loader?.entries?.() ?? [])] as unknown as HostLoaderEntry[]
    } catch {
      return undefined
    }
  }

  /** The channel-owned commands, independent of any agent's scope — the boot-time panel floor. */
  const channelCommands = (locale: Locale): Array<{ name: string; description: string }> => [
    { name: PRESET_COMMAND, description: describeCommand(PRESET_COMMAND, locale, 'View or switch mode') },
    { name: SESSIONS_COMMAND, description: describeCommand(SESSIONS_COMMAND, locale, 'View session history') },
    { name: TOOLS_COMMAND, description: describeCommand(TOOLS_COMMAND, locale, 'View, deny, or allow tools') },
    { name: SCHEDULES_COMMAND, description: describeCommand(SCHEDULES_COMMAND, locale, 'View scheduled reminders') },
    { name: JOBS_COMMAND, description: describeCommand(JOBS_COMMAND, locale, 'View background jobs') },
    { name: AUDIT_COMMAND, description: describeCommand(AUDIT_COMMAND, locale, 'View operation audit') },
    { name: FEEDBACK_COMMAND, description: describeCommand(FEEDBACK_COMMAND, locale, 'Record feedback about this session') },
    { name: CONTEXT_COMMAND, description: describeCommand(CONTEXT_COMMAND, locale, 'View context pressure') },
    { name: SKILLS_COMMAND, description: describeCommand(SKILLS_COMMAND, locale, 'List / inspect discoverable skills') },
    { name: MODEL_COMMAND, description: describeCommand(MODEL_COMMAND, locale, 'View or switch the default model') },
    { name: WS_COMMAND, description: describeCommand(WS_COMMAND, locale, 'List registered workspaces') },
    { name: PLUGINS_COMMAND, description: describeCommand(PLUGINS_COMMAND, locale, 'List deployed plugins and status') },
    { name: CONFIG_COMMAND, description: describeCommand(CONFIG_COMMAND, locale, 'View current configuration') },
    // /restart only exists when the deployment wired a restart command; an
    // unconfigured restart must not sit on the panel answering with an error.
    ...(config.restartCommand === '' ? [] : [{ name: RESTART_COMMAND, description: describeCommand(RESTART_COMMAND, locale, 'Restart the host process') }]),
    { name: STOP_COMMAND, description: describeCommand(STOP_COMMAND, locale, 'Stop the current task') },
    { name: HELP_COMMAND, description: describeCommand(HELP_COMMAND, locale, 'Show available commands') },
  ]

  const publishSlashPanel = (agent: HostAgent): void => {
    if (!config.syncSlashCommands) return
    const hosted = (ctx.get('commands') as HostCommands | undefined)?.list(agent) ?? []
    // The channel's own commands must appear in the panel too, not only the
    // host's: a command that lives in runCommandLine but never reaches the
    // bot's `/` list is invisible to the human, who reads the panel as the
    // contract of what the bot accepts. Host command descriptions come from
    // dsh in English; the panel follows the bridge's resolved locale, and
    // anything unmapped keeps its own description verbatim.
    const locale = config.locale
    const desired = [
      ...hosted.map(descriptor => ({
        name: descriptor.name,
        description: describeCommand(descriptor.name, locale, descriptor.description),
      })),
      ...channelCommands(locale),
    ]
    void syncSlashPanel(port, desired, notify).then(({ added, removed }) => {
      if (added.length > 0) notify(`dsh-lark-bridge: registered /${added.join(', /')} on the bot's slash panel`)
      if (removed.length > 0) notify(`dsh-lark-bridge: removed /${removed.join(', /')} from the bot's slash panel`)
    })
  }

  /** Aborts in-flight command executions when this bridge unwinds. */
  const commands = new AbortController()
  ctx.effect(() => () => { commands.abort() }, 'dsh-lark-bridge:commands')
  const commandSignal = (): AbortSignal => commands.signal


  const handleMessage = async (msg: NormalizedMessage): Promise<void> => {
    // Authorization before anything else: a message here starts a
    // shell-capable agent. Refusals stay silent in the chat — answering would
    // turn the bot into an oracle for who is authorized — and name the sender
    // on the operator console, which is also how an owner finds their own id.
    const refusal = refuseMessage(authorization, msg)
    if (refusal !== undefined) {
      notify(`dsh-lark-bridge: ignored a message in ${msg.chatId}: ${refusal}`)
      return
    }
    // A bot answering a bot is how mention loops start. `undefined` means the
    // event omitted the sender kind, which is "unknown", not "not a bot" — and
    // refusing every unknown sender would refuse ordinary traffic, so only a
    // positive bot signal is skipped.
    if (msg.senderIsBot === true) return
    // An @-only ping carries no text; starting a turn on an empty prompt spends
    // a turn for nothing. Skipped before the acknowledgement, which would
    // otherwise promise work no turn is doing.
    if (msg.content.trim() === '') return
    // The bot received a real request: acknowledge immediately so the sender
    // sees it landed, before any agent work starts.
    reactions?.ack(msg.messageId)
    // A retired device answers with a one-line notice instead of an agent
    // turn — the successor machine owns the Feishu app's reply path now.
    // `/bot activate` passes through so this end can be re-enabled in chat.
    if (msg.content.trim() !== '/bot activate') {
      const deviceState = await readDeviceState()
      if (deviceState.retired === true) {
        await port.send(msg.chatId, {
          markdown: '↪️ 本端已退位（设备已迁移）。如需在本机重新启用，请发 `/bot activate`。',
        }).catch(reportSendFailure)
        return
      }
    }
    // Full-transcript ingest is fire-and-forget: never awaited, never blocks
    // or fails the turn (contract in src/chronicle.ts).
    postChronicle(config.chronicleEndpoint, { source: config.chronicleSource, text: msg.content, chatId: msg.chatId }, notify)
    try {
      const opened = await sessions.acquire(msg)
      const binding = await bindingFor(opened.handle.agent.session.id, msg)
      // The reaction lifecycle follows this session's current trigger.
      binding.currentMessageId = msg.messageId

      // ── Preemptive commands (owner request 08-25): these bypass the normal
      // pipeline and act IMMEDIATELY on the agent, even mid-turn.
      const preemptive = msg.content.trim()
      if (preemptive === '/stop') {
        opened.handle.agent.cancel('user-requested')
        notify(`dsh-lark-bridge: preemptive /stop for session ${opened.handle.agent.session.id}`)
        await port.send(msg.chatId, { markdown: '⏹ 已停止当前任务' }).catch(reportSendFailure)
        return
      }
      // A slash line is a control, not a prompt: the host runs it without a
      // model turn, so it must not be handed to the model as text — and it
      // needs no reply target, since its answer is not an assistant turn.
      if (isCommandLine(msg.content)) {
        const sessionId = opened.handle.agent.session.id
        const presetBefore = sessionPresets.get(sessionId)
        const outcome = await runCommandLine(
          msg.content,
          opened.handle.agent,
          ctx.get('commands') as HostCommands | undefined,
          commandSignal(),
          ctx.get('agentPresets') as HostAgentPresets | undefined,
          ctx.get('sessionPersistence') as HostSessionPersistence | undefined,
          msg.chatId,
          runtimeDeniedTools,
          scheduleRegistry,
          auditStats,
          config,
          sessionPresets,
          ctx.get('sessionQuery') as HostSessionQuery | undefined,
          ctx.get('jobs') as HostJobs | undefined,
          ctx.get('messageFeedback') as HostMessageFeedback | undefined,
          lastAssistantIds.get(sessionId),
          ctx.get('tokenMeter') as HostTokenMeter | undefined,
          ctx.get('skills') as HostSkills | undefined,
          ctx.get('agentDefaultModel') as HostDefaultModel | undefined,
          {
            ...config.provider === undefined ? {} : { provider: config.provider },
            ...config.model === undefined ? {} : { model: config.model },
          },
          ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined,
          cwd,
          loaderEntries(),
          getSyncContext(),
        )
        // A /preset switch changed this session's composition contract; the
        // cached composition would resume the OLD preset, so drop it and let
        // the next acquire compose from the remembered choice.
        if (sessionPresets.get(sessionId) !== presetBefore) {
          compositions.delete(sessionId)
        }
        if (outcome.reply !== '') {
          await replay.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure)
        }
        return
      }
      // Aimed before the turn starts: the reply belongs to the message that
      // asked for it, and in a topic group an unaimed reply leaves the thread.
      binding.renderer.aim({
        messageId: msg.messageId,
        ...msg.threadId === undefined ? {} : { threadId: msg.threadId },
      } satisfies ReplyTarget)
      const images = await collectImages(
        msg,
        port,
        ctx.get('attachments') as HostAttachments | undefined,
        config.attachImages,
      )
      // Inbound file saving: non-image resources land in the workspace.
      let fileNotes: string[] = []
      if (config.autoSaveFiles && msg.resources?.length) {
        try {
          const saved = await saveInboundFiles(
            msg as never,
            (mid, fk, type) => port.downloadResourceWithMeta(mid, fk, type),
            config.cwd ?? process.cwd(),
          )
          fileNotes = saved.notes
        } catch { /* degrade silently */ }
      }
      // Auto-resume: after a bridge restart an interrupted goal stays durable
      // but its continuation authority resets to disarmed (dsh design). With
      // autoResumeGoals the bridge re-arms an active goal when the chat speaks
      // again, so a deploy no longer silently stops a running task. Best-effort
      // and fire-once per live agent: a later explicit /goal pause still wins.
      if (config.autoResumeGoals) {
        const agent = opened.handle.agent
        try {
          const goalsHost = (ctx as unknown as { goals?: { get(agent: unknown): { readonly goal?: { readonly id: string; readonly revision: number; readonly phase: string }; readonly activation?: string } | undefined } }).goals
          const view = goalsHost?.get(agent)
          if (view !== undefined && view.goal?.phase === 'active' && view.activation === 'disarmed') {
            const ref = { id: view.goal.id, revision: view.goal.revision }
            const goalsRemote = (ctx as unknown as { goals?: { resume(agent: unknown, ref: { id: string; revision: number }): unknown } }).goals
            await goalsRemote?.resume(agent, ref)
            notify(`dsh-lark-bridge: auto-resumed goal "${ref.id}" for session ${agent.session.id}`)
          }
        } catch (error) {
          notify(`dsh-lark-bridge: auto-resume skipped for session ${opened.handle.agent.session.id}: ${String(error)}`)
          ctx.logger.warn('goal auto-resume skipped: %s', error)
        }
      }
      {
      // Ambient situational briefing: once per session, prepended ahead of the
      // user's own text; failures degrade silently to no-briefing.
      const prefix = briefingPrefix(config.briefingFile, opened.handle.agent.session.id, notify)
      // Append file notes to the user's text so the agent knows what arrived.
      const allNotes = [...images.notes, ...fileNotes]
      const spoken = allNotes.length > 0
        ? msg.content + '\n' + allNotes.join('\n')
        : msg.content
      const turn = chatUserMessage({ ...msg, content: spoken }, images)
      let content = prefix === ''
        ? turn.content
        : Object.freeze([
            { type: 'text' as const, text: prefix },
            ...turn.content,
          ])
      opened.handle.agent.followup({ ...turn, content })
    }
    } catch (error) {
      notify(`dsh-lark-bridge: agent creation failed for chat ${msg.chatId}: ${String(error)}`)
      ctx.logger.warn('agent creation failed for chat %s: %s', msg.chatId, error)
      await port
        .send(msg.chatId, { text: `⚠️ 无法启动会话：${error instanceof Error ? error.message : String(error)}` })
        .catch(reportSendFailure)
    }
  }

  const settleApproval = (id: string, outcome: HostApprovalOutcome, decidedBy?: string): boolean => {
    const pending = pendingApprovals.get(id)
    if (pending === undefined) return false
    pendingApprovals.delete(id)
    pending.clearReminder?.()
    pending.settle(outcome)
    void port
      .updateCard(pending.messageId, settledCard(pending.toolName, outcome, decidedBy))
      .catch(reportSendFailure)
    return true
  }

  const askViaCard = async (
    binding: ChatBinding,
    request: HostApprovalRequest,
    next: () => Promise<HostApprovalOutcome>,
  ): Promise<HostApprovalOutcome> => {
    const id = randomUUID()
    let sent: SendResult
    try {
      const command = request.callId === undefined ? undefined : pendingCallArguments.get(request.callId)
      sent = await rawPort.send(binding.chatId, {
        card: approvalCard(
          request.toolName,
          request.reason,
          command === undefined ? undefined : boundCardText(command),
          id,
        ),
      })
    } catch (error) {
      // With no card in front of a human, let the next composed answerer decide.
      reportSendFailure(error)
      return next()
    }
    return new Promise<HostApprovalOutcome>((resolveOutcome) => {
      // Nudge an unanswered card: the agent is parked on it, and a chat with
      // no visual "pending" surface otherwise looks like the bot stopped.
      let reminder: ReturnType<typeof setTimeout> | undefined
      if (config.approvalReminderMs > 0) {
        reminder = setTimeout(() => {
          if (!pendingApprovals.has(id)) return
          void port
            .send(binding.chatId, {
              markdown: `⏳ 有一张审批卡等你处理（\`${request.toolName}\`）——点卡片上的按钮继续，或发 \`/stop\` 取消当前操作。`,
            })
            .catch(reportSendFailure)
        }, config.approvalReminderMs)
      }
      pendingApprovals.set(id, {
        chatId: binding.chatId,
        chatType: binding.chatType,
        messageId: sent.messageId,
        toolName: request.toolName,
        ...reminder === undefined ? {} : { clearReminder: () => clearTimeout(reminder) },
        settle: resolveOutcome,
      })
      request.signal?.addEventListener(
        'abort',
        () => { settleApproval(id, 'cancelled') },
        { once: true },
      )
    })
  }

  /**
   * Drive a goal card's buttons: pause / resume / clear. The buttons carry the
   * session id, so a click from elsewhere is refused before touching the goal.
   */
  const handleGoalCardAction = (evt: CardActionEvent, value: GoalActionValue): CardActionResponse => {
    const binding = bySession.get(value.sessionId)
    if (binding === undefined || binding.chatId !== evt.chatId) {
      return { toast: { type: 'info', content: '该目标卡已失效' } }
    }
    // Same authority as an approval click: whoever may drive this chat may
    // control its goal; anyone else gets a refusal, not a silent no-op.
    const clickRefusal = refuseApprovalClick(
      authorization,
      { operatorId: evt.operator.openId, chatId: evt.chatId },
      { chatId: binding.chatId, chatType: binding.chatType },
    )
    if (clickRefusal !== undefined) {
      notify(`dsh-lark-bridge: rejected a goal click: ${clickRefusal}`)
      return { toast: { type: 'error', content: '你无权操作此目标' } }
    }
    const agent = agents.get(value.sessionId)
    if (agent === undefined) {
      return { toast: { type: 'info', content: '该会话当前不在线' } }
    }
    const goals = (ctx as unknown as { goals?: {
      get(agent: unknown): { readonly goal?: { readonly id: string; readonly revision: number; readonly phase: string } } | undefined
      pause(agent: unknown, ref: { id: string; revision: number }): unknown
      resume(agent: unknown, ref: { id: string; revision: number }): unknown
      clear(agent: unknown, ref: { id: string; revision: number }): unknown
    } }).goals
    if (goals === undefined) {
      return { toast: { type: 'error', content: '目标服务不可用' } }
    }
    const view = goals.get(agent)
    if (view?.goal === undefined) {
      return { toast: { type: 'info', content: '当前没有目标' } }
    }
    const ref = { id: view.goal.id, revision: view.goal.revision }
    try {
      const labels: Record<GoalActionValue['operation'], string> = {
        pause: '已暂停',
        resume: '已继续',
        clear: '已清除',
      }
      if (value.operation === 'pause') goals.pause(agent, ref)
      else if (value.operation === 'resume') goals.resume(agent, ref)
      else goals.clear(agent, ref)
      notify(`dsh-lark-bridge: goal ${value.operation} for session ${value.sessionId}`)
      return { toast: { type: 'success', content: labels[value.operation] } }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      notify(`dsh-lark-bridge: goal ${value.operation} failed for session ${value.sessionId}: ${detail}`)
      return { toast: { type: 'error', content: `操作失败：${detail}` } }
    }
  }

  const handleCardAction = (evt: CardActionEvent): CardActionResponse | undefined => {
    const questionResponse = questions.handleCardAction(evt)
    if (questionResponse !== undefined) return questionResponse
    const goalValue = goalActionValue(evt.action.value)
    if (goalValue !== undefined) {
      return handleGoalCardAction(evt, goalValue)
    }
    const value = approvalActionValue(evt.action.value)
    if (value === undefined) return undefined
    const pending = pendingApprovals.get(value.id)
    if (pending === undefined) return { toast: { type: 'info', content: '该审批已失效' } }
    // Anyone who can see the card can press its button — a group may hold
    // people who are not authorized to run anything here, and one press grants
    // the escalation. The decision counts only from an authorized human, in
    // the chat this card was published to.
    const clickRefusal = refuseApprovalClick(
      authorization,
      { operatorId: evt.operator.openId, chatId: evt.chatId },
      pending,
    )
    if (clickRefusal !== undefined) {
      notify(`dsh-lark-bridge: rejected an approval click: ${clickRefusal}`)
      return { toast: { type: 'error', content: '你无权批准此操作' } }
    }
    const outcome: HostApprovalOutcome = value.decision === 'allow' ? 'allowed-once' : 'rejected'
    const decidedBy = evt.operator.name ?? evt.operator.openId
    if (!settleApproval(value.id, outcome, decidedBy)) {
      return { toast: { type: 'info', content: '该审批已失效' } }
    }
    return {
      toast: {
        type: value.decision === 'allow' ? 'success' : 'info',
        content: value.decision === 'allow' ? '已允许执行一次' : '已拒绝',
      },
    }
  }

  // Inbound events. Registered before connect so no early event is dropped.
  ctx.effect(() => replay.on('message', (msg) => { void handleMessage(msg) }), 'dsh-lark-bridge:on(message)')
  ctx.effect(() => replay.on('cardAction', handleCardAction), 'dsh-lark-bridge:on(cardAction)')

  // Observability. Without these, the failure modes an operator actually hits —
  // "the bot ignored me", "an inbound handler threw", "the connection dropped" —
  // leave no trace at all, because the transport reports each only as an event.
  ctx.effect(() => replay.on('reject', (evt: RejectEvent) => {
    // A missing mention in a group is the configured steady state, not an
    // incident, so it stays off the operator console it would flood.
    if (evt.reason === 'no_mention') {
      ctx.logger.debug('rejected %s in %s: %s', evt.messageId, evt.chatId, evt.reason)
      return
    }
    ctx.logger.info('rejected %s in %s from %s: %s', evt.messageId, evt.chatId, evt.senderId, evt.reason)
    // A tripped loop guard means the bot went quiet on purpose; an operator who
    // does not know that reads it as a hang.
    if (evt.reason === 'bot_loop') {
      notify(`dsh-lark-bridge: bot loop guard tripped in chat ${evt.chatId} — traffic from bots is being refused`)
    }
  }), 'dsh-lark-bridge:on(reject)')

  ctx.effect(() => replay.on('error', (error: LarkChannelError) => {
    notify(`dsh-lark-bridge: transport error [${error.code}]: ${error.message}`)
    ctx.logger.warn('transport error [%s]: %s', error.code, error.message)
  }), 'dsh-lark-bridge:on(error)')

  // A gap in the long connection is a gap in delivery: the transport has no
  // replay and no cursor, so events arriving while it is down are simply lost.
  ctx.effect(() => replay.on('reconnecting', () => {
    replay.setConnected(false)
    notify('dsh-lark-bridge: connection lost, reconnecting — outbound is queued and will replay once restored')
    ctx.logger.warn('connection lost, reconnecting')
  }), 'dsh-lark-bridge:on(reconnecting)')

  ctx.effect(() => replay.on('reconnected', () => {
    replay.setConnected(true)
    notify('dsh-lark-bridge: connection restored')
    ctx.logger.info('connection restored')
  }), 'dsh-lark-bridge:on(reconnected)')

  // Boot-time panel floor: sync the channel-owned commands as soon as the
  // bridge installs, before any chat exists. Without this, a restart that
  // receives no message leaves the panel at the previous boot's list — and an
  // OLD process (one built before new channel commands existed) that does
  // receive a message would reconcile the panel DOWN to its own stale list,
  // deleting commands this channel actually accepts. The agent-scoped full
  // sync (hosted + channel) still runs on every acquire.
  //
  // The transport may not hold credentials yet at install time, so the first
  // attempt can fail before any notify fires; retry on a backoff until the
  // panel answers, then stop — this is a floor, not a poller.
  if (config.syncSlashCommands) {
    const floor = channelCommands(config.locale)
    void (async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const { added } = await syncSlashPanel(port, floor, notify)
          if (added.length > 0) notify(`dsh-lark-bridge: registered /${added.join(', /')} on the bot's slash panel`)
          return
        } catch {
          if (attempt === 3) return
          await new Promise(resolve => setTimeout(resolve, attempt * 15_000))
        }
      }
    })()
  }

  // Outbound: the owned chat's renderer decides what reaches the chat. The
  // bridge additionally remembers each call's arguments for the approval card,
  // and forgets the turn's calls once it closes.
  // Live workflow narration: phase and log events carry only the run identity,
  // so the durable tool-workflow/run-start event supplies the run->chat map.
  // Best-effort: lines arriving before the durable mapping exists are dropped.
  ctx.on('workflow/phase', (info: WorkflowRunInfoData, title: string) => {
    const chatId = workflowChats.get(info.id)
    if (chatId === undefined) return
    void replay.send(chatId, { markdown: phaseLine(title) }).catch(reportSendFailure)
  })
  ctx.on('workflow/log', (info: WorkflowRunInfoData, message: string) => {
    const chatId = workflowChats.get(info.id)
    if (chatId === undefined) return
    void replay.send(chatId, { markdown: workflowLogLine(message) }).catch(reportSendFailure)
  })

  ctx.on('session/event', (session, event: HostSessionEvent) => {
    const binding = bySession.get(session.id)
    if (binding === undefined) return
    // Audit counters: one lightweight pass over the same stream the renderers
    // consume, so /audit needs no file access or extra host seam.
    {
      let stats = auditStats.get(session.id)
      if (stats === undefined) {
        stats = {
          startedAt: Date.now(),
          turns: 0, steps: 0, toolCalls: 0, turnErrors: 0,
          compactions: 0, retries: 0, subagents: 0, workflows: 0, schedules: 0,
        }
        auditStats.set(session.id, stats)
      }
      if (isToolCallEvent(event)) stats.toolCalls += 1
      else if (isTurnEndEvent(event)) {
        stats.turns += 1
        if (event.data.reason.kind === 'error') stats.turnErrors += 1
      } else if (isStepStartEvent(event)) stats.steps += 1
      else if (isCompactionStartEvent(event)) stats.compactions += 1
      else if (isLlmRetryEvent(event)) stats.retries += 1
      else if (isSubagentDescriptorEvent(event)) stats.subagents += 1
      else if (isWorkflowRunStartEvent(event)) stats.workflows += 1
      else if (isScheduleChangeEvent(event)) stats.schedules += 1
    }
    if (isAssistantMessageEvent(event)) {
      lastAssistantIds.set(session.id, event.data.message.id)
    }
    if (isToolCallEvent(event)) {
      pendingCallArguments.set(event.data.callId, event.data.arguments)
    } else if (isTurnEndEvent(event)) {
      pendingCallArguments.clear()
    }
    // Reaction lifecycle: the agent started working once a step opens, and
    // settles when the turn ends. `currentMessageId` is undefined between
    // turns and for slash commands, which drive no agent turn at all.
    if (reactions !== undefined && binding.currentMessageId !== undefined) {
      if (isStepStartEvent(event)) reactions.working(binding.currentMessageId)
      else if (isTurnEndEvent(event)) {
        if (event.data.reason.kind === 'error') reactions.fail(binding.currentMessageId)
        else reactions.done(binding.currentMessageId)
        binding.currentMessageId = undefined
      }
    }
    // Live todo progress: every whole-list snapshot updates the chat card.
    if (isTodoWriteEvent(event)) {
      const items = event.data.todos.filter(
        (item): item is { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' } =>
          item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed',
      )
      void todos.handle(session.id, binding.chatId, items)
    }
    // Live goal state: every snapshot mutation updates the chat card.
    if (isGoalChangeEvent(event)) {
      const goal = event.data.goal
      if (goal !== undefined && (goal.phase === 'active' || goal.phase === 'paused' || goal.phase === 'blocked' || goal.phase === 'complete')) {
        void goals.handle(session.id, binding.chatId, {
          operation: event.data.operation,
          goal: { objective: goal.objective, phase: goal.phase, ...goal.blockedReason !== undefined ? { blockedReason: goal.blockedReason } : {}, ...goal.maxGoalRounds !== undefined ? { maxGoalRounds: goal.maxGoalRounds } : {} },
        })
      }
    }
    // Live workflow fan-out: a text stream per run, so the chat sees the
    // subagent fan-out instead of a silent gap. Best-effort, like todo/goal.
    if (isWorkflowRunStartEvent(event)) {
      workflowChats.set(event.data.runId, binding.chatId)
      void replay.send(binding.chatId, { markdown: runStartLine(event.data) }).catch(reportSendFailure)
    } else if (isWorkflowAgentStartEvent(event)) {
      void replay.send(binding.chatId, { markdown: agentStartLine(event.data) }).catch(reportSendFailure)
    } else if (isWorkflowAgentEndEvent(event)) {
      void replay.send(binding.chatId, { markdown: agentEndLine(event.data) }).catch(reportSendFailure)
    } else if (isWorkflowRunEndEvent(event)) {
      workflowChats.delete(event.data.runId)
      void replay.send(binding.chatId, { markdown: runEndLine(event.data) }).catch(reportSendFailure)
    }
    // Context compaction: tell the chat when history is being summarized, so
    // a later "it forgot" is understood rather than mysterious. The summary
    // and prune events (between start and end) show what the pass produced.
    if (isCompactionStartEvent(event)) {
      void replay.send(binding.chatId, { markdown: '📦 上下文较长，正在压缩（较早内容将被摘要）…' }).catch(reportSendFailure)
    } else if (isCompactionSummaryEvent(event)) {
      void replay.send(binding.chatId, { markdown: compactionSummaryLine(event.data) }).catch(reportSendFailure)
    } else if (isCompactionPruneEvent(event)) {
      void replay.send(binding.chatId, { markdown: compactionPruneLine(event.data) }).catch(reportSendFailure)
    } else if (isCompactionEndEvent(event)) {
      if (event.data.error !== undefined) {
        void replay.send(binding.chatId, { markdown: `⚠️ 上下文压缩失败：${event.data.error}` }).catch(reportSendFailure)
      }
    }
    // One-shot notices for the remaining low-frequency events. `dispatch`
    // stays silent (a schedule firing is noise), retry announces once.
    if (isSubagentDescriptorEvent(event)) {
      // Multi-agent progress card: one updatable card per chat.
      let tracker = subagentTrackers.get(binding.chatId)
      if (tracker === undefined) { tracker = subCard.createTracker(); subagentTrackers.set(binding.chatId, tracker) }
      const childKey = `child-${tracker.entries.size + 1}-${Date.now()}`
      subCard.addEntry(tracker, childKey, event.data)
      const card = subCard.render(tracker)
      void replay.send(binding.chatId, { card }).catch(reportSendFailure)
    }
    if (isScheduleChangeEvent(event)) {
      const line = scheduleLine({
        operation: event.data.operation,
        ...event.data.schedule === undefined ? {} : { kind: event.data.schedule.kind, prompt: event.data.schedule.prompt },
      })
      if (line !== undefined) void replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure)
      // Track active schedules for /schedules. `create` records, `delete`
      // forgets, `dispatch` fires a one-shot (drop it) or ticks a repeating
      // schedule (keep it for the next round).
      const id = event.data.schedule?.id ?? event.data.id
      const sessionId = session.id
      if (id !== undefined) {
        let byId = scheduleRegistry.get(sessionId)
        if (event.data.operation === 'create' && event.data.schedule !== undefined) {
          if (byId === undefined) {
            byId = new Map()
            scheduleRegistry.set(sessionId, byId)
          }
          byId.set(id, {
            id,
            kind: event.data.schedule.kind,
            prompt: event.data.schedule.prompt,
            ...event.data.schedule.everySeconds === undefined ? {} : { everySeconds: event.data.schedule.everySeconds },
            createdAt: Date.now(),
          })
        } else if (byId !== undefined) {
          if (event.data.operation === 'delete') {
            byId.delete(id)
          } else if (event.data.operation === 'dispatch' && event.data.schedule?.kind === 'after') {
            // A one-shot reminder dispatched once is done.
            byId.delete(id)
          }
          if (byId.size === 0) scheduleRegistry.delete(sessionId)
        }
      }
    }
    if (isWebSearchRequestEvent(event)) {
      void replay.send(binding.chatId, { markdown: webSearchLine() }).catch(reportSendFailure)
    }
    if (isLlmRetryEvent(event)) {
      const line = retryLine(event.data)
      if (line !== undefined) void replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure)
    }
    binding.renderer.handle(event)
  })

  // Approval questions for owned agents become cards; everything else delegates.
  //
  // PREPEND is load-bearing. A host answerer may claim every audited request
  // rather than only the sessions its own clients own — the Web app's BFF does
  // exactly that, pushing the question to browser clients and never calling
  // `next()`. Registered in arrival order this plugin would sit behind it (its
  // rows mount during tree load, this bridge installs after the loader
  // settles), so a chat-driven approval would surface in a browser nobody is
  // watching while the chat waits forever. Answering first is correct on the
  // merits too: the human who typed the request is in the chat, and this
  // listener still delegates every session it does not own.
  ctx.on('approval/request', (request, next) => {
    const binding = bySession.get(request.agent.session.id)
    if (binding === undefined) return next()
    return askViaCard(binding, request, next)
  }, { prepend: true })

  // Owned live state unwinds with the fiber: agents down, open questions
  // closed, open streaming cards settled. The session store owns the agents, so
  // it does the disposing — and it leaves an adopted one running for its owner.
  ctx.effect(() => () => {
    if (pressureTimer !== undefined) clearInterval(pressureTimer)
    for (const [id, pending] of [...pendingApprovals]) {
      pendingApprovals.delete(id)
      pending.settle('cancelled')
    }
    disposeQuestions?.()
    const bindings = [...bySession.values()]
    bySession.clear()
    compositions.clear()
    pendingCallArguments.clear()
    lastAssistantIds.clear()
    goals.dispose()
    todos.dispose()
    for (const binding of bindings) {
      if (binding.currentMessageId !== undefined) reactions?.forget(binding.currentMessageId)
    }
    return Promise.allSettled([
      sessions.close(),
      ...bindings.map((binding) => binding.renderer.close()),
    ]).then(() => undefined)
  }, 'dsh-lark-bridge:agents')

  // Registered last so disposal disconnects the transport first.
  ctx.effect(() => {
    replay.connect().catch((error: unknown) => {
      notify(`dsh-lark-bridge: connect failed: ${error instanceof Error ? error.message : String(error)}`)
      ctx.logger.error('dsh-lark-bridge channel connect failed: %s', error)
    })
    return () => replay.disconnect().catch(reportSendFailure)
  }, 'dsh-lark-bridge:connect')
}
