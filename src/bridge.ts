/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-bridge/bridge
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { readDeviceState, ensureDeviceId } from './sync/migrate.ts'
import { arbitrationForInbound, claimIfActiveStale, isActiveEndpoint, accountUseByName, accountForgetByName } from './sync/bot-command.ts'
import { accountCardValue } from './account-card.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  NormalizedMessage,
  RejectEvent,
  SendResult,
} from '@larksuite/channel'
import { DEFAULT_LIMITS } from './config.ts'
import type { BusyPolicy, ResolvedConfig } from './config.ts'
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
import type { HostJobs, HostJobSnapshot, HostLoaderEntry, HostMessageFeedback, HostSession, HostSessionQuery, HostSkills, HostTokenMeter, ScheduleChangeData, SubagentEndData, WorkflowRunInfoData } from './host.ts'
import { isAssistantMessageEvent, isTeamRelayMessageEvent, isCompactionEndEvent, isPresentedEvent, isCompactionPruneEvent, isCompactionStartEvent, isCompactionSummaryEvent, isGoalChangeEvent, isLlmRetryEvent, isScheduleChangeEvent, isStepStartEvent, isSubagentCatalogEvent, isSubagentDescriptorEvent, isTodoWriteEvent, isToolCallEvent, isTurnEndEvent, isWebSearchRequestEvent, isWorkflowAgentEndEvent, isWorkflowAgentStartEvent, isWorkflowRunEndEvent, isWorkflowRunStartEvent ,
  isTeamMemberEvent,
  isTeamTaskEvent,
  isTeamMessageEvent,
  isTeamMessageDeliveredEvent} from './host.ts'
import { createCotRenderer } from './cot.ts'
import type { CotPort } from './cot.ts'
import { readChatWorkspaces, writeChatWorkspace } from './chat-workspace.ts'
import { createMessageRenderer, createStreamRenderer } from './outbound.ts'
import type { OutboundPort, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'
import { refuseApprovalClick, refuseMessage } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import { postChronicle } from './chronicle.ts'
import { briefingPrefix } from './briefing.ts'
import * as subCard from './subagent-card.ts'
import * as teamCard from './team-card.ts'
import {
  AUDIT_COMMAND,
  BALANCE_COMMAND,
  BOT_COMMAND,
  commandName,
  CONFIG_COMMAND,
  CONTEXT_COMMAND,
  FEEDBACK_COMMAND,
  HELP_COMMAND,
  isCommandLine,
  JOBS_COMMAND,
  MANUAL_COMMAND,
  MODEL_COMMAND,
  NEW_COMMAND,
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
import { ConversationSessions, conversationKey, sessionIdFor } from './session.ts'
import type { SessionLadder } from './session.ts'
import { baseSessionIdOf, createRotationStore } from './session-rotation.ts'
import { createReactionTracker } from './reaction.ts'
import type { ReactionTracker } from './reaction.ts'
import { createQuestionProvider } from './questions.ts'
import type { HostUserQuestionRequest, HostQuestionAnswer } from './questions.ts'
import { createTodoRenderer } from './todo.ts'

/**
 * Host contract mirror: the 0.1.5 `user-questions/request` waterfall.
 *
 * Declared here so the bridge's composition-time listener is type-checked
 * against the same shape the host dispatches. Scope-filtered: an agent-scoped
 * listener only receives that agent's requests.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(
      request: HostUserQuestionRequest,
      next: () => Promise<HostQuestionAnswer>,
    ): Promise<HostQuestionAnswer>
    /**
     * Live assistant streaming, published by the driving Agent (0.1.5).
     *
     * Frames arrive as `start` (carrying turn and step), a run of `chunk`
     * frames, then `end`. The chunk payload is the same `StreamChunk` the
     * retired `assistant/chunk` session event carried.
     */
    'agent/assistant-stream'(
      payload: {
        agent: { readonly session: { readonly id: string } }
        frame:
          | { readonly type: 'start'; readonly attemptId: string; readonly turn: number; readonly step: number }
          | { readonly type: 'chunk'; readonly attemptId: string; readonly chunk: StreamChunkLike }
          | { readonly type: 'end'; readonly attemptId: string }
      },
    ): void
  }
}

/** The subset of the host's `StreamChunk` the renderer reads. */
interface StreamChunkLike {
  readonly type: string
  readonly text?: string
  readonly index?: number
  readonly block?: { readonly type?: string; readonly text?: string }
}
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
import { createFeishuTools, feishuToolsPromptSection, FEISHU_NOTIFY_TOOL } from './feishu-tools.ts'
import { FeishuCloud } from './sync/feishu-cloud.ts'
import { pricingPromptLine } from './pricing.ts'

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
  /**
   * Read one message back as a normalized message.
   *
   * Optional on purpose: the transport is the only thing that can fetch one,
   * and a test double that does not model the API must still satisfy the port.
   * When absent, a reply-quoted message simply reaches the model without its
   * quote — degraded, not broken.
   */
  fetchMessage?(messageId: string): Promise<NormalizedMessage | undefined>
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
  /**
   * The host's live session object.
   *
   * The token meter prices a context by replaying the session's own event
   * log, so it needs the session itself — its `seq` and `eventAt()` — not
   * just the id. Handing it the id makes the replay read nothing and the
   * meter report zero tokens forever, so the context-pressure warning
   * would never fire.
   */
  readonly session: HostSession
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
  /**
   * The viewing scope this session's tools live in.
   *
   * A roster keeps every model-facing row off the global layer, so the
   * scope is what a reader needs to see the tools this session actually
   * has. It is the same opaque key the host's own tool view takes.
   */
  readonly toolScope?: unknown
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
function boundCardText(text: string, maxChars: number = DEFAULT_LIMITS.approvalArgChars): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars - 1)}…`
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
  identityClause?: () => string | undefined,
): void {
  // Channel-owned tools (currently `send_file`) register on the agent's own
  // scope, so they exist exactly where the agent looks, and vanish with it.
  // The service is read through the Context merge first (`agent.ctx.tools`):
  // that is where the host puts it, and the accessor reaches the same
  // instance. `ctx.get('tools')` is the fallback for harnesses that only
  // register the service under its name.
  //
  // The comment this replaced said `get` no longer handed back the service.
  // That was true of one 0.1.5-era shape; the current host registers the
  // runtime as `super(ctx, 'tools')`, so `get` resolves it again — the
  // upstream's own plugins read it that way.
  const tools = ((agentCtx as unknown as { tools?: unknown }).tools
    ?? agentCtx.get('tools')) as (HostTools & { register(definition: object): () => void }) | undefined
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
  // the human is actually talking to. The bot's Feishu app name (when the
  // lookup settled) leads the section — asked "who are you", the model quotes
  // the name the human already sees in the chat header, plus which fleet
  // endpoint is answering. Kept independent of denyTools so it is always
  // injected, not only when there is a tool restriction to announce.
  const prompt = agentCtx.get('systemPrompt') as HostSystemPrompt | undefined
  const clause = identityClause?.()
  prompt?.section({
    name: 'dsh-lark-bridge:identity',
    order: 120,
    text: (clause === undefined ? '' : `你是飞书上的${clause}。`)
      + 'You are a coding agent running inside a Feishu/Lark chat '
      + 'via the DeepSeek Harness host. The person you are talking to is the user of this '
      + 'chat, not a machine. Reply in the same language they write in. '
      + 'You have the full coding-agent toolset of the host: you can read and edit files, run '
      + 'commands, and work on projects in the workspace. When you need a decision or want to '
      + 'ask a clarifying question, write it directly in your reply — their next message is the '
      + 'answer, and the chat keeps the conversation going. Do not describe your own '
      + 'architecture or ask what kind of interface you are running on; you are simply the bot '
      + 'in this chat. When the user asks who you are, answer with the Chinese name above '
      + '(if present) — never invent a different name.',
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
  if (extraTools.some((tool) => (tool as { name?: string }).name === FEISHU_NOTIFY_TOOL)) {
    prompt?.section({ name: 'dsh-lark-bridge:feishu-tools', order: 121, text: feishuToolsPromptSection() })
  }
  prompt?.section({ name: 'dsh-lark-bridge:pricing', order: 122, text: pricingPromptLine() })
  prompt?.section({
    name: 'dsh-lark-bridge:background-tasks',
    order: 130,
    text: 'Long-running commands (builds, installs, setup scripts, anything that may take '
      + 'minutes): ALWAYS pass run_in_background=true to the shell/exec tool. '
      + 'The host JobRegistry tracks the job and the bridge automatically sends a '
      + 'completion notice with the output tail into this chat when it settles — '
      + 'you do NOT need to poll. '
      + 'NEVER wrap a command in `while pgrep ...; do sleep N; done; tail ...` or '
      + 'similar polling loops: the wrapper itself becomes the process that gets '
      + 'killed by the turn timeout, and the tail/echo after the loop never runs. '
      + 'If you need to check on a background job later, use `/jobs` or read the '
      + 'log file the command was told to write to — do not block a turn waiting.',
  })
}

/**
 * Whether a standby endpoint answers this line in the chat.
 *
 * The fleet is single-writer: only the arbitration-active endpoint replies,
 * and a standby stays silent on ordinary traffic so a phone client never
 * talks over the machine that is actually answering. Silence is wrong for the
 * two READ-ONLY lines the user guide sends a puzzled operator to (`/help` and
 * `/bot devices`) — their entire job is to say where the fleet is, so
 * swallowing them turns a healthy standby into "the bot is dead". Everything
 * with an effect (and all prose) still gets nothing, so answering can never
 * make a standby a second executor of the same command.
 * @param text - the inbound message text exactly as received.
 * @returns whether this line deserves a standby notice.
 */
function standbyAnswers(text: string): boolean {
  const line = text.trim()
  const name = commandName(line)
  if (name === HELP_COMMAND) return true
  if (name !== BOT_COMMAND) return false
  // Mirrors `runBotCommand`'s own split, so the line answered here is the line
  // that would have run `/bot devices` on the active end.
  const sub = line.slice(1 + BOT_COMMAND.length).trim().split(/\s+/)[0] ?? ''
  return sub === 'devices'
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
 * How much of a quoted message the model is shown.
 *
 * A quote can be an entire bot answer. Repeating it verbatim buys nothing the
 * session history does not already hold, and a long one would push the actual
 * question out of the model's attention — so the head, and a marker.
 */


/**
 * Render the message a chat message quotes back, as a block to prepend.
 *
 * 飞书的「引用」不是正文的一部分：入站事件只带 `parent_id`，被引用的那条要
 * 另外调 `im.v1.message.get` 才能读到。不取它，模型看到的就是一句「这个你再
 * 改改」加一片空白——它只能猜「这个」是什么，而人会以为它当然看得见。
 *
 * @param quoted - the referenced message, already fetched.
 * @returns the block and its trailing newline, or '' when there is nothing to show.
 */
export function quotedPrefix(quoted: NormalizedMessage | undefined, maxChars: number = DEFAULT_LIMITS.quoteChars): string {
  if (quoted === undefined) return ''
  const body = quoted.content.trim()
  const who = quoted.senderName ?? quoted.senderId
  // A quote with no text is usually an image or a file: say so, rather than
  // presenting an empty quote that reads as a bug.
  const text = body !== ''
    ? body.length > maxChars
      ? `${body.slice(0, maxChars)}…（引用内容过长，已截断）`
      : body
    : quoted.resources.length > 0
      ? '（这是一条图片/文件消息，没有文字内容）'
      : '（这条被引用的消息没有文字内容）'
  return `[引用 · ${who}]\n${text}\n[/引用]\n`
}

/** What one chat message becomes, and what the chat is told about it. */
export interface BusyDelivery {
  /** The inbox boundary the message actually takes. */
  readonly policy: BusyPolicy
  /** One line telling the chat where the message went; '' when it needs none. */
  readonly receipt: string
}

/**
 * Choose the inbox boundary for one chat message (issue #5).
 *
 * A message that lands while a turn is running used to be queued
 * unconditionally: the chat read the wait as a hang, and the only way to change
 * direction was `/stop`, which throws the running turn's work away. `steer`
 * lands the message at the running driver's next step boundary, so a
 * correction takes effect inside the turn it corrects.
 *
 * An idle agent keeps the original semantics — an ordinary follow-up turn that
 * opens one — whatever the policy says, because there is nothing to steer.
 *
 * A policy the host cannot honour (an agent double with no `steer`, a host old
 * enough to predate it) degrades to `queue` and says so: the message must still
 * arrive, one turn later.
 *
 * @param busy - whether a turn is running (`agent.status === 'running'`).
 * @param policy - the deployment's `busyPolicy`.
 * @param agent - the live agent, inspected for the boundary it accepts.
 * @returns the policy to apply and the receipt line for it.
 */
export function busyDelivery(
  busy: boolean,
  policy: BusyPolicy,
  agent: Pick<HostAgent, 'steer' | 'inject'>,
): BusyDelivery {
  if (!busy) return { policy: 'queue', receipt: '' }
  if (policy === 'steer') {
    return typeof agent.steer === 'function'
      ? { policy: 'steer', receipt: '🎯 已插话：下一个 step 边界生效，当前进度保留；要立即中止请发 /stop。' }
      : { policy: 'queue', receipt: '⚠️ 本宿主不支持中途插话（steer），已退回排队：当前任务完成后处理这条。' }
  }
  if (policy === 'inject') {
    return typeof agent.inject === 'function'
      ? { policy: 'inject', receipt: '📎 已作为上下文注入：模型下一步会读到，不打断当前任务。' }
      : { policy: 'queue', receipt: '⚠️ 本宿主不支持上下文注入（inject），已退回排队：当前任务完成后处理这条。' }
  }
  return { policy: 'queue', receipt: '⏳ 已排队：当前任务完成后自动处理这条。' }
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
  // Declared deliverables reach the chat through the same path. The model
  // ends a turn by naming files it produced; without this they stay on the
  // host's disk, and the person who asked for them is looking at the chat.
  const deliverDeclaredFile = async (sessionId: string, path: string, caption: string | undefined) => {
    const binding = bySession.get(sessionId)
    if (binding === undefined) throw new Error(`会话 ${sessionId} 不在当前聊天`)
    return deliverFile(replay, binding.chatId, cwd, {
      path,
      ...caption === undefined || caption === '' ? {} : { caption },
    })
  }
  /**
   * Deliver a file a child session declared into the chat that owns it.
   *
   * A child runs in its own session, so the session is not the one bound to
   * the chat; the chat is found through the child mapping instead. A file
   * nobody can place is reported rather than dropped without a word.
   */
  const deliverChildDeclaredFile = async (
    chatId: string,
    path: string,
    caption: string | undefined,
  ): Promise<void> => {
    await deliverFile(replay, chatId, cwd, {
      path,
      ...caption === undefined || caption === '' ? {} : { caption },
    })
  }
  // Native Feishu tools (2026-09-09): the agent can act on Feishu itself —
  // proactive messages through the same replay-wrapped transport, and the
  // app's cloud-drive space as a durable cross-device scratchpad. Registered
  // per chat agent next to `send_file`; a failure here must not touch the
  // channel, matching every other composition step.
  const feishuTools = createFeishuTools({
    port: replay,
    chatOfSession: (sessionId) => bySession.get(sessionId)?.chatId,
    // Lazy arrows, not direct references: this factory runs before the binding
    // helpers below are initialised, and the tools only call them at use time.
    bindChatCwd: (chatId, dir) => bindChatCwd(chatId, dir),
    chatCwd: (chatId) => chatCwd(chatId),
    credentials: config.appId !== undefined && config.appSecret !== undefined
      ? { appId: config.appId, appSecret: config.appSecret, ...(config.domain !== undefined ? { domain: config.domain } : {}) }
      : undefined,
  })
  /**
   * Who the human is talking to, as Feishu itself names the app — quoted by
   * the model's self-description and the first-contact guide so the identity
   * question is answered before it is asked (fleet UX: endpoints and even
   * separate deployments echo similar names; the form/profile suffix tells
   * same-app ends apart). Best-effort: a failed lookup only hides the name.
   */
  let botName: string | undefined
  if (config.appId !== undefined && config.appSecret !== undefined) {
    void new FeishuCloud({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.domain !== undefined ? { domain: config.domain } : {}),
    }).botInfo().then((info) => { botName = info.name }).catch(() => {})
  }
  /** One clause naming this bot and which endpoint is answering. */
  const identityClause = (): string | undefined => {
    const syncCtx = getSyncContext()
    const where = syncCtx === undefined ? '' : `（本端：${syncCtx.form} · ${syncCtx.profile}）`
    return botName === undefined ? undefined : `「${botName}」${where}`
  }
  // The live denied-tool set: seeded from config, then toggled at runtime via
  // /tools. Every chat agent's guard reads this same object, so a switch takes
  // effect on the next tool call without a restart.
  const runtimeDeniedTools = new Set<string>(config.denyTools)
  // Active schedules seen for this process, keyed by session id then schedule
  // id. Fed by schedule/change events as they stream in, and rebuilt from the
  // schedule plugin itself the first time a session is asked about (see
  // seedScheduleRegistry) — a restart otherwise starts empty, and a reminder
  // created by an earlier process would never be reported again.
  const scheduleRegistry = new Map<string, Map<string, ScheduleEntry>>()
  /** One schedule record as the plugin's own `list` reports it. */
  interface ScheduleRecordLike {
    readonly id: string
    readonly kind: 'after' | 'at' | 'every'
    readonly prompt: string
    readonly everySeconds?: number
  }
  /** Sessions whose registry was already rebuilt from their own log. */
  const seededSchedules = new Set<string>()
  /**
   * Apply one `schedule/change` payload to a session's registry.
   *
   * `create` records, `delete` forgets, `dispatch` fires a one-shot (drop it)
   * or ticks a repeating schedule (keep it for the next round). Split out of
   * the event handler so the log replay below applies exactly the same rules —
   * two implementations of "what is still scheduled" is how the two drift.
   *
   * @param byId - the session's registry.
   * @param data - the event payload.
   */
  const applyScheduleChange = (byId: Map<string, ScheduleEntry>, data: ScheduleChangeData): void => {
    const id = data.schedule?.id ?? data.id
    if (id === undefined) return
    if (data.operation === 'create' && data.schedule !== undefined) {
      byId.set(id, {
        id,
        kind: data.schedule.kind,
        prompt: data.schedule.prompt,
        ...data.schedule.everySeconds === undefined ? {} : { everySeconds: data.schedule.everySeconds },
        createdAt: Date.now(),
      })
      return
    }
    if (data.operation === 'delete') byId.delete(id)
    // A one-shot reminder dispatched once is done.
    else if (data.operation === 'dispatch' && data.schedule?.kind === 'after') byId.delete(id)
  }
  /**
   * Rebuild one session's schedule registry from its own log, once.
   *
   * The registry is fed by live `schedule/change` events, so a restart starts
   * empty — and a reminder created before this process booted never announces
   * itself again. That is not a corner case: a long-running deployment creates
   * reminders in one process and answers `/schedules` in the next, and the
   * command then reports "none" for reminders that are still firing.
   *
   * The schedule plugin owns the truth: its `list` is what actually fires, and
   * it survives restarts. The session log is only a fallback — it carries the
   * change events that happened to be appended, and a reminder created before
   * this process booted has none, which is exactly the case that broke.
   *
   * Either way the replay is silent on purpose: someone asking what is
   * scheduled must not be told again about every reminder ever created.
   *
   * @param session - the session to restore.
   */
  const seedScheduleRegistry = async (session: HostSession): Promise<void> => {
    if (seededSchedules.has(session.id)) return
    seededSchedules.add(session.id)
    const byId = scheduleRegistry.get(session.id) ?? new Map<string, ScheduleEntry>()
    // Authoritative first. `list` is the query the scheduler itself answers
    // with, so whatever it returns IS what will fire.
    const store = ctx.get('schedule') as
      | { list?: (query: { sessionId: string }) => Promise<readonly ScheduleRecordLike[]> }
      | undefined
    if (store?.list !== undefined) {
      try {
        const records = await store.list({ sessionId: session.id })
        for (const record of records) {
          byId.set(record.id, {
            id: record.id,
            kind: record.kind,
            prompt: record.prompt,
            ...record.everySeconds === undefined ? {} : { everySeconds: record.everySeconds },
            createdAt: Date.now(),
          })
        }
        if (byId.size > 0) scheduleRegistry.set(session.id, byId)
        return
      } catch {
        // A deployment without the schedule service (or a version whose
        // `list` moved) still deserves the log fallback below.
      }
    }
    for (let seq = 0; seq < session.seq; seq++) {
      const event = session.eventAt(seq) as HostSessionEvent | undefined
      if (event === undefined || !isScheduleChangeEvent(event)) continue
      applyScheduleChange(byId, event.data)
    }
    if (byId.size > 0) scheduleRegistry.set(session.id, byId)
  }
  /**
   * Call ids whose declared files were already delivered, per session.
   *
   * A turn can end with more than one declaration, and a host may replay
   * the event or nest calls, so the call id is what makes the delivery
   * exactly-once. The set is bounded by the number of declarations one
   * session makes, which is small.
   */
  const presentedCalls = new Map<string, Set<string>>()
  // Per-session preset choice made via /preset. Process-local: a restart
  // falls back to the configured default, which the /config command states.
  const sessionPresets = new Map<string, string>()
  const subagentTrackers = new Map<string, subCard.SubagentCardState>()
  /** One team card per chat, with the message id it updates in place. */
  const teamTrackers = new Map<string, { state: teamCard.TeamCardState; messageId?: string; updatedAt?: number; sending?: boolean; pending?: boolean }>()
  /** 外勤会话镜像 (P141)：未绑定且非子会话的独立会话，按会话节流推一行进度。 */
  const externalMirrorAt = new Map<string, number>()
  /**
   * When each child's last progress line reached the chat, per chat+child.
   *
   * A child's work is worth saying out loud, but every one of its tool
   * calls is not: a child that reads twenty files would otherwise put
   * twenty lines into the chat between the question and the answer. One
   * line per child per window is what a reader can actually use.
   */
  const childProgressAt = new Map<string, number>()
  /** How often one child's progress reaches the chat, in milliseconds. */
  const CHILD_PROGRESS_WINDOW_MS = 30_000
  /** childId → chatId. 0.1.5 runs every child in its OWN session — the id
   * `subagent/catalog` reports as `childId` IS that session id (verified against
   * this install: each of the 20 catalog ids had a matching session directory),
   * so a child's events arrive under a session that has no chat binding. This map
   * is how they find their panel row without touching the parent's display. */
  const childChat = new Map<string, string>()
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
  /** The last token total seen for a session, so the poll log only speaks when it changed. */
  const lastMeasured = new Map<string, number>()
  const cwd = resolve(config.cwd ?? process.cwd())
  /**
   * Per-chat cwd overrides, loaded once and kept in step with writes.
   *
   * A chat that ran `/ws use <dir>` keeps that directory across restarts and
   * across `/new`: the binding is the chat's, not the session's, because the
   * whole point is that the next conversation starts in the same project.
   */
  let chatBindingsPromise: Promise<Record<string, string>> | undefined
  const chatBindings = (): Promise<Record<string, string>> => {
    chatBindingsPromise ??= readChatWorkspaces()
    return chatBindingsPromise
  }
  /**
   * The directory a chat's next session should start in.
   *
   * Bound chats win; everything else falls back to the deployment `cwd`. The
   * result is canonicalised because the workspace registry validates a session
   * header against a realpath, and an uncanonicalized variant is rejected.
   *
   * @param chatId - the chat asking.
   * @returns the absolute directory for its next session.
   */
  const chatCwd = async (chatId: string): Promise<string> => {
    const bindings = await chatBindings()
    const bound = bindings[chatId]
    return bound === undefined ? cwd : resolve(bound)
  }
  /**
   * Bind one chat to a directory (or clear it with `null`) and drop the cached
   * workspace promise, so the next session resolves the new directory.
   *
   * @param chatId - the chat being rebound.
   * @param dir - absolute directory, or `null` to fall back to the deployment cwd.
   */
  const bindChatCwd = async (chatId: string, dir: string | null): Promise<void> => {
    await writeChatWorkspace(chatId, dir)
    const bindings = await chatBindings()
    if (dir === null) delete bindings[chatId]
    else bindings[chatId] = dir
  }
  /**
   * The directory each session id must start in, seeded before the ladder runs.
   *
   * `SessionLadder.create` receives only the session id — the chat it came from
   * is not part of the contract — so the bound directory is handed over here,
   * keyed by the id the acquire path is about to ask for.
   */
  const pendingSessionCwd = new Map<string, string>()

  /**
   * Multi-agent panel plumbing — ONE updatable card per chat, keyed by the
   * child's own session id.
   *
   * Why `subagent/catalog` and not `subagent/descriptor`: 0.1.5 appends the
   * descriptor inside the CHILD's session (subagent-in-process-driver
   * `attachDescriptorAppend`), so a subscriber on the parent chat session never
   * receives it. The durable parent-side record is `subagent/catalog`
   * (`establishCatalogChild` → `parent.append`), and it carries
   * `childId / childCreatedAt / mode / label`. Wiring the panel to the
   * descriptor is why「多代理执行面板」never appeared while every gate stayed
   * green (2026-09-15).
   */
  const CARD_UPDATE_MIN_MS = 4000
  const streamDebug = process.env.DSH_BRIDGE_STREAM_DEBUG === '1'

  const trackerFor = (chatId: string): subCard.SubagentCardState => {
    let tracker = subagentTrackers.get(chatId)
    if (tracker === undefined) {
      tracker = subCard.createTracker()
      subagentTrackers.set(chatId, tracker)
    }
    return tracker
  }

  /** Send the panel the first time, then keep it updated in place. */
  const flushSubagentCard = async (
    chatId: string,
    tracker: subCard.SubagentCardState,
    force: boolean,
  ): Promise<void> => {
    const now = Date.now()
    if (!force && tracker.updatedAt !== undefined && now - tracker.updatedAt < CARD_UPDATE_MIN_MS) return
    tracker.updatedAt = now
    const card = subCard.render(tracker, now)
    if (tracker.messageId === undefined) {
      const sent = await replay.send(chatId, { card })
      tracker.messageId = sent.messageId
      return
    }
    await port.updateCard(tracker.messageId, card)
  }

  /**
   * Send or refresh the team card for one chat.
   *
   * The card is sent once and updated in place afterwards, so a reader
   * watches one panel instead of scrolling a stream of team notices. The
   * throttle keeps a burst of team events from turning into a burst of card
   * updates.
   * @param chatId - the chat that leads the team.
   * @param force - update even inside the throttle window.
   */
  const flushTeamCard = async (chatId: string, force: boolean): Promise<void> => {
    const tracker = teamTrackers.get(chatId)
    if (tracker === undefined) return
    const now = Date.now()
    if (!force && tracker.updatedAt !== undefined && now - tracker.updatedAt < CARD_UPDATE_MIN_MS) return
    tracker.updatedAt = now
    const card = teamCard.renderTeamCard(tracker.state)
    if (tracker.messageId === undefined) {
      // The first send waits on a round trip, and a second event can land
      // inside that window. Without this latch both see no message id and
      // each send a card of its own, so a chat ends up with two panels.
      //
      // The event that arrives meanwhile is not dropped: it is remembered,
      // and the card is sent again once the first send settled, so the
      // panel shows the newest state rather than the state at first send.
      if (tracker.sending === true) {
        tracker.pending = true
        return
      }
      tracker.sending = true
      try {
        const sent = await replay.send(chatId, { card })
        tracker.messageId = sent.messageId
      } finally {
        tracker.sending = false
      }
      if (tracker.pending === true) {
        tracker.pending = false
        await flushTeamCard(chatId, true)
      }
      return
    }
    await port.updateCard(tracker.messageId, card)
  }

  /**
   * Fold a message one teammate relayed into another into the team card.
   *
   * The team package steers a member's message into the recipient's inbox
   * rather than recording a mailbox event, so the card's message list is
   * built from these relayed messages. A chat that has not seen a roster
   * event yet has no card to update, and the message is dropped with a note
   * rather than inventing a team the chat never led.
   */
  const noteTeamRelayMessage = (chatId: string, event: HostSessionEvent): void => {
    if (!isTeamRelayMessageEvent(event)) return
    const tracker = teamTrackers.get(chatId)
    if (tracker === undefined) return
    teamCard.addTeamRelayMessage(tracker.state, event.data.message, event.data.message.source.senderSessionId)
    void flushTeamCard(chatId, true).catch(reportSendFailure)
  }

  const upsertSubagent = (
    chatId: string,
    id: string,
    descriptor: { mode?: string; label?: string },
    force = false,
  ): void => {
    const tracker = trackerFor(chatId)
    subCard.addEntry(tracker, id, descriptor)
    void flushSubagentCard(chatId, tracker, force).catch(reportSendFailure)
  }

  /** The panel's「最近在做的事」line: the tool's name plus its most telling string
   * argument (path / command / query). markActivity clips it to one card line. */
  const toolActivityLine = (name: string, args: unknown): string => {
    const first = Object.values((args ?? {}) as Record<string, unknown>)
      .find(v => typeof v === 'string' && v.trim() !== '')
    return first === undefined ? name : `${name} ${String(first)}`
  }

  /**
   * Fold one activity sample into a child's row.
   *
   * Attribution here is EXACT rather than guessed: the child works in its own
   * session and callers pass that session id, which is the same id
   * `subagent/catalog` keyed the row with — so concurrent children can never
   * show one child's work under another child's name.
   */
  const noteChildActivity = (chatId: string, childId: string, line: string): void => {
    const tracker = subagentTrackers.get(chatId)
    if (tracker === undefined || line.trim() === '') return
    const entry = subCard.markActivity(tracker, childId, line)
    if (entry === undefined) return
    if (streamDebug) notify(`dsh-lark-bridge: child ${childId}: ${line.slice(0, 60)}`)
    // The first thing a child does is worth an immediate redraw — otherwise the
    // row sits at「进行中」with no detail until the throttle window passes.
    void flushSubagentCard(chatId, tracker, entry.chunks <= 1).catch(reportSendFailure)
    // And one line of it reaches the chat, on a window: the delegation was
    // announced there, so the progress belongs there too. Without it the
    // chat says a child was sent and then goes quiet until the answer.
    if (config.announceSubagents === false) return
    const key = `${chatId}|${childId}`
    const now = Date.now()
    const last = childProgressAt.get(key)
    if (last !== undefined && now - last < CHILD_PROGRESS_WINDOW_MS) return
    childProgressAt.set(key, now)
    const label = entry.label.trim() === '' ? '子代理' : entry.label
    void replay.send(chatId, {
      markdown: `🔀 ${label} · ${line.trim()}`,
    }).catch(reportSendFailure)
  }

  /**
   * A child's own session events are what the panel narrates.
   *
   * This routing is the whole point of the panel. Without it the card was
   * rendered once when `subagent/catalog` arrived and then froze at
   * 「进行中 · 0秒」for the child's entire run — the row existed, but the reader
   * still could not see what the child was doing.
   */
  const noteChildSessionEvent = (chatId: string, childId: string, event: HostSessionEvent): void => {
    // A message one teammate relayed to another lands in the recipient's own
    // session, so a chat that leads the team sees it through the child
    // mapping rather than through its own session.
    if (isTeamRelayMessageEvent(event)) {
      noteTeamRelayMessage(chatId, event)
      return
    }
    // A child can declare a deliverable too. The declaration lands in the
    // child's own session, so the branch that serves the chat's own session
    // never sees it — and a file that cannot be placed used to vanish
    // without a word. The chat that owns the child gets it, or a notice.
    if (isPresentedEvent(event) && config.presentBridge !== false) {
      const callId = event.data.callId
      let seen = presentedCalls.get(childId)
      if (seen === undefined) { seen = new Set<string>(); presentedCalls.set(childId, seen) }
      if (!seen.has(callId)) {
        seen.add(callId)
        void (async () => {
          for (const file of event.data.files) {
            const caption = file.description === undefined || file.description === ''
              ? `交付文件 · turn ${event.data.turn}`
              : file.description
            try {
              await deliverChildDeclaredFile(chatId, file.path, caption)
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              void replay.send(chatId, {
                markdown: `⚠️ 交付文件 \`${file.path}\` 未能送达：${detail}`,
              }).catch(reportSendFailure)
            }
          }
        })()
      }
      return
    }
    if (isToolCallEvent(event)) {
      noteChildActivity(chatId, childId, toolActivityLine(event.data.name, event.data.arguments))
      return
    }
    if (isAssistantMessageEvent(event)) {
      const text = event.data.message.content
        .filter(block => block.type === 'text' && block.text)
        .map(block => block.text).join('')
      noteChildActivity(chatId, childId, text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '')
    }
  }

  /**
   * Keep「已跑时长」honest while a child is quiet: a running row is re-rendered
   * on a slow tick even when no activity arrives, so the panel never looks
   * frozen. Idle chats cost nothing — the tick skips them.
   */
  const PANEL_TICK_MS = 15_000
  const panelTicker = setInterval(() => {
    const now = Date.now()
    for (const [chatId, tracker] of subagentTrackers) {
      if (subCard.runningEntries(tracker).length === 0) continue
      if (tracker.updatedAt !== undefined && now - tracker.updatedAt < PANEL_TICK_MS - 1_000) continue
      void flushSubagentCard(chatId, tracker, true).catch(reportSendFailure)
    }
  }, PANEL_TICK_MS)
  panelTicker.unref?.()

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
        // The meter replays the session's own event log, so it gets the
        // session object. Passing the id alone makes the replay read
        // nothing and the meter report zero tokens for every session —
        // silently, with no error to catch — and the context-pressure
        // warning below would then never fire.
        const measure = tokenMeter.measure(binding.session)
        total = measure.totalTokens
        surface = measure.surfaceTokens
      } catch (error) {
        // A session without a usable meter is not the chat's problem; log and
        // move on so one bad session cannot stall the whole sweep.
        ctx.logger.warn('token pressure measure failed for %s: %s', sessionId, error)
        continue
      }
      // The sweep says nothing when it succeeds, so there is no way to
      // tell from outside that it ran at all — and "the meter was handed
      // the wrong thing" looks exactly like "no session is under
      // pressure". A line with the number the meter returned makes the
      // difference visible: a non-zero total proves the meter read the
      // session.
      //
      // The line is written only when the number moved, or the first
      // time it is seen. A poll every ten minutes for every session
      // would put a line per session per poll into the log, and a log
      // that repeats itself is a log nobody reads.
      const previous = lastMeasured.get(sessionId)
      if (previous === undefined || previous !== total) {
        lastMeasured.set(sessionId, total)
        notify(
          `dsh-lark-bridge: token pressure poll session=${sessionId} total=${total} surface=${surface} threshold=${threshold}`,
        )
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
  /**
   * Resolve (or register) the workspace record for one directory.
   *
   * Cached by DIRECTORY, not by chat: two chats in the same project share one
   * lookup, and a chat rebound to another project simply asks under a new key —
   * so a rebind can never be served by a stale promise.
   *
   * @param dir - the canonical directory a session starts in.
   * @returns the workspace record, or undefined when no registry is composed.
   */
  const workspacePromises = new Map<string, Promise<HostWorkspace | undefined>>()
  const chatWorkspace = (dir: string): Promise<HostWorkspace | undefined> => {
    const existing = workspacePromises.get(dir)
    if (existing !== undefined) return existing
    const pending = (async () => {
      const registry = ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
      if (registry === undefined) return undefined
      return (await registry.resolveByPath(dir)) ?? await registry.create(dir)
    })().catch((error: unknown) => {
      // Grouping is presentation: a chat must still work in a deployment whose
      // registry refuses this directory.
      notify(`dsh-lark-bridge: workspace lookup failed for ${dir}: ${String(error)}`)
      return undefined
    })
    workspacePromises.set(dir, pending)
    return pending
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
  let disposeQuestions: (() => void) | undefined
  try {
    // 0.1.5 moved this seam from a provider registry on `ctx.userQuestions`
    // (`registerProvider`) to the `user-questions/request` waterfall: a
    // listener claims the request by RETURNING an answer and delegates by
    // calling `next()`. The request shape is unchanged (questions/agent/
    // signal), so the provider plugs in directly. A throw fails the question
    // closed rather than leaving the model hanging.
    const onQuestion = async (
      request: HostUserQuestionRequest,
      next: () => Promise<HostQuestionAnswer>,
    ): Promise<HostQuestionAnswer> => {
      try {
        return await questions.provider.ask(request)
      } catch (error) {
        ctx.logger.warn('user-questions answerer failed, delegating: %s', error)
        return await next()
      }
    }
    disposeQuestions = ctx.on('user-questions/request', onQuestion)
  } catch (error) {
    // A synchronous throw here means the seam is absent from this profile
    // composition. The card handler stays installed either way so a slot
    // that opens later can still resolve a pending question.
    notify(`dsh-lark-bridge: user-questions provider unavailable (${error instanceof Error ? error.message : String(error)})`)
    ctx.logger.warn('user-questions provider unavailable: %s', error)
  }

  /**
   * Resolve the provider/model for a new chat agent.
   *
   * The host's own selection comes first: it carries the choice `/model`
   * saved, and the config values are the deployment's initial defaults
   * rather than a lock. Reading the config first would make `/model` report
   * a switch that never reaches a new agent.
   */
  const modelSelection = (): HostAgentOptions => {
    const defaults = ctx.get('agentDefaultModel') as HostDefaultModel | undefined
    if (defaults !== undefined) {
      return defaults.currentSelection()
    }
    if (config.provider !== undefined || config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }
    throw new Error(
      'dsh-lark-bridge: no model configured — set config.provider/model or compose the agentDefaultModel service',
    )
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
    // 0.1.7: `standingKeyFor` was replaced by `acquireScope`, which returns a
    // disposable lease `{ key: ScopeKey } & AsyncDisposable` instead of a bare
    // key. Sources: dsh-api-session-controller/lib/index.js:2324 (hands the
    // lease to its caller) and dsh-webhook/lib/index.js:158 (holds it for the
    // life of the using-scope). This scope lives as long as the session does,
    // so the lease is kept and released with the session, never eagerly.
    const toolScopeLease = presets === undefined || presetId === undefined
      ? undefined
      : await presets.acquireScope(presetId)
    const toolScope = toolScopeLease?.key
    return {
      ...presetId === undefined ? {} : { presetId },
      ...toolScope === undefined ? {} : { toolScope },
      presentCall: createCallPresenter(ctx.get('tools') as HostTools | undefined, toolScope),
      setup: async (agentCtx: Context) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        composeChatAgent(agentCtx, config, [sendFileTool, ...feishuTools], runtimeDeniedTools, identityClause)
        // Background jobs: a registered under this agent scope sees exactly the
        // jobs its owner starts. Announce terminals so a long-running task's
        // completion is visible in the chat instead of silent until asked.
        // Direct subagent tool calls announce their settlement live. The
        // opening is already covered by the durable subagent/descriptor line,
        // so only the terminal edge is rendered here.
        agentCtx.on('subagent/end', (info: SubagentEndData) => {
          const binding = bySession.get(sessionId)
          if (binding === undefined) return
          // Settle the panel row this child owns. `info.id` is the child's
          // session id, which is exactly the key the catalog row used.
          const tracker = subagentTrackers.get(binding.chatId)
          // The child is done: stop resolving its session to this chat.
          childChat.delete(info.id)
          const settled = tracker?.entries.get(info.id)
          if (tracker !== undefined && subCard.settleEntry(tracker, info.id, info.stopReason) !== undefined) {
            void flushSubagentCard(binding.chatId, tracker, true).catch(reportSendFailure)
          }
          // Prefer the delivery block (label + duration + what it produced) over
          // the bare「子任务结束 [id]」line, which told the reader nothing.
          const delivery = settled === undefined ? undefined : subCard.deliveryText(settled)
          void replay.send(binding.chatId, {
            markdown: delivery ?? subagentEndLine(info),
          }).catch(reportSendFailure)
        })
        const jobs = agentCtx.get('jobs') as HostJobs | undefined
        /**
         * The retained output of a settled job, for its completion notice.
         *
         * `readAt` is the non-consuming read: it leaves the cursor the agent
         * pulls from exactly where it is, so announcing a completion never
         * steals output the model still expects to see (a `read()` here would).
         * A notice without its tail still beats no notice, so any failure
         * degrades to "no tail" instead of throwing into the event stream.
         */
        const jobOutput = (job: HostJobSnapshot): string => {
          const coords = job.output
          if (jobs === undefined || coords === undefined || coords.total <= coords.earliest) return ''
          try {
            // The engine's owner check takes a bare session-id string; the old
            // object form failed it and the catch below ate the throw — the
            // notice's tail was silently empty ever since the feature landed.
            return jobs.readAt(job.id, coords.earliest, sessionId)
              .chunks.map((chunk) => chunk.text).join('')
          } catch (error) {
            // Degrading to "no tail" is right — a notice without its tail
            // still beats no notice. But it used to degrade silently, and
            // that is how the wrong caller shape stayed invisible: the
            // failure left nothing behind to point at. It leaves a trace
            // now, and still does not throw into the event stream.
            console.warn(
              `[dsh-lark-bridge] 读取子任务 ${job.id} 的输出失败：`
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            return ''
          }
        }
        // dsh 0.1.7 removed `JobRegistry.onJobDone`; completions now arrive on
        // the registry's event stream as a `settled` event carrying the job's
        // projection. `awaited` marks settlements a live `wait()` already
        // delivered, so only the unawaited ones are announced here — reporting
        // the awaited ones too would duplicate what the caller already got.
        jobs?.events?.subscribe({ owners: 'scope' }, (event) => {
          if (event.type !== 'settled') return
          if (event.awaited) return
          const snapshot = event.job
          if (snapshot.status === 'running' || snapshot.status === 'stopping') return
          const binding = bySession.get(sessionId)
          if (binding === undefined) return
          const output = jobOutput(snapshot)
          // The projection carries only `startedAt`; the notice wants the
          // elapsed time, so measure it here, at settlement.
          const durationMs = Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0 ? Math.max(0, Date.now() - snapshot.startedAt) : undefined
          const terminal: {
            readonly id: string
            readonly kind: string
            readonly label: string
            readonly status: 'completed' | 'killed' | 'failed'
            readonly detail?: string
            readonly durationMs?: number
            readonly output?: string
          } = {
            id: snapshot.id,
            kind: snapshot.kind,
            label: snapshot.label,
            status: snapshot.status,
            ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
            ...durationMs === undefined ? {} : { durationMs },
            ...output === '' ? {} : { output },
          }
          void replay.send(binding.chatId, { markdown: jobDoneLine(terminal, config.limits.jobTailChars) }).catch(reportSendFailure)
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
      maybeSyncPendingPanel(handle.agent)
      return handle
    },
    create: async (sessionId) => {
      const composition = await compositionFor(sessionId)
      // The directory this session starts in: the chat's binding when it has
      // one, else the deployment cwd. The workspace's own canonical path is
      // used so `attachSession` finds the header cwd it validates against
      // rather than an uncanonicalized variant of it.
      //
      // `/new` reaches this rung with the ROTATED id (`<base>:r<stamp><tail>`),
      // while the binding was seeded under the conversation's BASE id — the
      // acquire that triggered the rotation only knew that one. Without the
      // base lookup a rotation silently started in the deployment cwd and
      // `/ws use` looked like it had done nothing.
      const baseSessionId = baseSessionIdOf(sessionId)
      const dir = pendingSessionCwd.get(sessionId) ?? pendingSessionCwd.get(baseSessionId) ?? cwd
      pendingSessionCwd.delete(sessionId)
      pendingSessionCwd.delete(baseSessionId)
      const workspace = await chatWorkspace(dir)
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: workspace?.path ?? dir,
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
      maybeSyncPendingPanel(handle.agent)
      return handle
    },
    // A rejected resume is the registry's only existence probe, and an
    // unreadable session log looks exactly like a chat nobody ever messaged, so
    // the ladder's handled failures are reported rather than swallowed.
    report: (line) => { ctx.logger.info(line) },
  }

  const sessions = new ConversationSessions(config.sessionScope, ladder, createRotationStore())

  /**
   * The renderer for one session, opened on first use and kept until the fiber
   * unwinds: it holds the turn's streaming card, which outlives any one message.
   * @param sessionId - the session whose events it renders.
   * @param msg - the message that reached this session.
   * @returns the binding, the same object for every later message of the session.
   * @throws when the session's composition cannot be resolved.
   */
  const bindingFor = async (sessionId: string, msg: NormalizedMessage, session: HostSession): Promise<ChatBinding> => {
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
      session,
    }
    bySession.set(sessionId, binding)
    // First contact this boot: send the one-time guide. Best-effort — a send
    // failure must not block the chat that already has the agent working.
    if (config.onboarding && freshlyCreated.delete(sessionId)) {
      void replay.send(binding.chatId, onboardingMessage(process.env, identityClause())).catch(reportSendFailure)
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
      limits: config.limits,
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
      // The same lookup the rest of the bridge uses for host services. The
      // earlier property access on the scoped context was not the same
      // seam, so a host that moved the loader left the inventory silently
      // empty.
      const loader = ctx.get('loader') as HostLoader | undefined
      const entries = loader?.entries
      // A missing seam is not an empty deployment. Returning [] here would
      // tell the reader "no plugins are installed" when the truth is that
      // the bridge cannot see them, which is the difference between
      // "nothing to install" and "the inventory is broken".
      if (entries === undefined) return undefined
      return [...entries.call(loader)] as unknown as HostLoaderEntry[]
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
    { name: BALANCE_COMMAND, description: describeCommand(BALANCE_COMMAND, locale, 'DeepSeek API balance') },
    { name: MANUAL_COMMAND, description: describeCommand(MANUAL_COMMAND, locale, 'The full user guide') },
    // Only when the deployment composed the feedback service: a panel entry
    // that always answers with "not available" is worse than no entry.
    ...(ctx.get('messageFeedback') === undefined ? [] : [{ name: FEEDBACK_COMMAND, description: describeCommand(FEEDBACK_COMMAND, locale, 'Record feedback about this session') }]),
    { name: CONTEXT_COMMAND, description: describeCommand(CONTEXT_COMMAND, locale, 'View context pressure') },
    { name: SKILLS_COMMAND, description: describeCommand(SKILLS_COMMAND, locale, 'List / inspect discoverable skills') },
    { name: MODEL_COMMAND, description: describeCommand(MODEL_COMMAND, locale, 'View or switch the default model') },
    { name: WS_COMMAND, description: describeCommand(WS_COMMAND, locale, 'List registered workspaces') },
    { name: PLUGINS_COMMAND, description: describeCommand(PLUGINS_COMMAND, locale, 'List deployed plugins and status') },
    { name: CONFIG_COMMAND, description: describeCommand(CONFIG_COMMAND, locale, 'View current configuration') },
    // /bot is listed even when the sync layer is not up: it answers with the
    // reason rather than failing, and a deployment that enables sync later
    // must not need a panel re-registration to reach it. The sync context is
    // published asynchronously, so testing for it here would be a race.
    { name: BOT_COMMAND, description: describeCommand(BOT_COMMAND, locale, 'Bridge dual-end status, settings, plugin sync') },
    // /restart only exists when the deployment wired a restart command; an
    // unconfigured restart must not sit on the panel answering with an error.
    ...(config.restartCommand === '' ? [] : [{ name: RESTART_COMMAND, description: describeCommand(RESTART_COMMAND, locale, 'Restart the host process') }]),
    { name: STOP_COMMAND, description: describeCommand(STOP_COMMAND, locale, 'Stop the current task') },
    { name: NEW_COMMAND, description: describeCommand(NEW_COMMAND, locale, 'Start a new session') },
    { name: HELP_COMMAND, description: describeCommand(HELP_COMMAND, locale, 'Show available commands') },
  ]

  /**
   * The panel belongs to the Feishu APP, and a fleet shares one app: when web
   * and desktop both boot, two differently composed host command sets would
   * rewrite the panel out from under each other, and the menu stops matching
   * whichever endpoint actually answers the commands. The arbitration's
   * active endpoint is therefore the single panel writer — standbys keep
   * their list to themselves and re-sync the moment they are promoted
   * (election, `/bot activate`), which the inbound path drives through
   * `maybeSyncPendingPanel`.
   */
  let panelSyncPending = false
  const ownPanel = async (): Promise<boolean> => {
    const arbitration = await arbitrationForInbound()
    if (arbitration === null) return true
    const syncCtx = getSyncContext()
    const identity = await ensureDeviceId()
    return isActiveEndpoint(arbitration, identity.deviceId, syncCtx?.form ?? 'web', syncCtx?.profile ?? 'web')
  }
  const publishSlashPanel = (agent: HostAgent): void => {
    if (!config.syncSlashCommands) return
    void (async () => {
      if (!(await ownPanel())) {
        panelSyncPending = true
        notify('dsh-lark-bridge: standby endpoint skipped slash-panel sync (the active endpoint owns the panel)')
        return
      }
      panelSyncPending = false
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
      ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      void syncSlashPanel(port, desired, notify).then(({ added, removed }) => {
        if (added.length > 0) notify(`dsh-lark-bridge: registered /${added.join(', /')} on the bot's slash panel`)
        if (removed.length > 0) notify(`dsh-lark-bridge: removed /${removed.join(', /')} from the bot's slash panel`)
      })
    })()
  }
  /** A promoted standby re-syncs the panel once, on the next inbound message. */
  const maybeSyncPendingPanel = (agent: HostAgent): void => {
    if (!panelSyncPending || !config.syncSlashCommands) return
    void ownPanel().then((mine) => {
      if (!mine) return
      panelSyncPending = false
      publishSlashPanel(agent)
    })
  }

  /** Aborts in-flight command executions when this bridge unwinds. */
  const commands = new AbortController()
  const lastSearchNoticeAt = new Map<string, number>()
  ctx.effect(() => () => { commands.abort() }, 'dsh-lark-bridge:commands')
  const commandSignal = (): AbortSignal => commands.signal

  /**
   * Report a stage that overruns, naming it.
   *
   * The inbound handler awaits several things with no deadline (device state,
   * the cloud arbitration record, session acquisition). When one never
   * settles the handler parks for good: the message is acknowledged with a
   * reaction and then nothing happens — no reply, no error, no log — and only
   * a restart clears it. Naming the stage that overran turns that from
   * guesswork into a one-line diagnosis.
   */
  const SLOW_STAGE_MS = 10_000
  const stage = async <T>(messageId: string, name: string, run: () => Promise<T>): Promise<T> => {
    const timer = setInterval(
      () => notify(`dsh-lark-bridge: inbound ${messageId} still in stage=${name} after ${SLOW_STAGE_MS / 1000}s`),
      SLOW_STAGE_MS,
    )
    timer.unref?.()
    try {
      return await run()
    } finally {
      clearInterval(timer)
    }
  }

  const handleMessage = async (msg: NormalizedMessage): Promise<void> => {
    // One line per inbound message: without it, "no reply and no log" cannot be
    // told apart from "the handler never ran at all" — and that distinction
    // decides whether to look inside the bridge or outside it.
    notify(`dsh-lark-bridge: inbound ${msg.messageId} in ${msg.chatId}`)
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
      const deviceState = await stage(msg.messageId, 'device-state', () => readDeviceState())
      if (deviceState.retired === true) {
        await port.send(msg.chatId, {
          markdown: '↪️ 本端已退位（设备已迁移）。如需在本机重新启用，请发 `/bot activate`。',
        }).catch(reportSendFailure)
        return
      }
      // Cloud arbitration (when present): only the active ENDPOINT replies —
      // device + form + profile, since one machine running web and desktop
      // holds two Feishu connections and a machine-only check would let both
      // answer every message twice. Absence of arbitration — no credentials,
      // carrier down, never written — keeps every end replying as before.
      // When the active endpoint has gone silent, election lets the smallest
      // fresh endpoint key take over.
      const arbitration = await stage(msg.messageId, 'arbitration', () => arbitrationForInbound())
      if (arbitration !== null) {
        const syncCtx = getSyncContext()
        const myIdentity = await stage(msg.messageId, 'device-identity', () => ensureDeviceId())
        const myForm = syncCtx?.form ?? 'web'
        const myProfile = syncCtx?.profile ?? 'web'
        if (!isActiveEndpoint(arbitration, myIdentity.deviceId, myForm, myProfile)) {
          const claimed = syncCtx !== undefined && await claimIfActiveStale(syncCtx, arbitration)
          if (!claimed) {
            // Standby backs off so the active endpoint is the only writer: a
            // per-message chat notice would read as the bot talking to itself
            // from a phone client (2026-09-10 operator report). The exception
            // is the read-only troubleshooting pair — silence there is what
            // makes a healthy standby look like a dead bot, since `/bot
            // devices` is the very first thing the guide tells a puzzled
            // operator to send. Everything else still gets no chat line.
            const where = arbitration.form === undefined ? '' : `（${arbitration.form}${arbitration.profile === undefined ? '' : `/${arbitration.profile}`}）`
            notify(`dsh-lark-bridge: standby backed off a message in ${msg.chatId} (active: ${arbitration.activeName}${where})`)
            if (standbyAnswers(msg.content)) {
              await port.send(msg.chatId, {
                markdown: `🛰️ 本端是待命端，活跃端是 **${arbitration.activeName}**${where}——命令由活跃端执行。`
                  + '这条只读命令请到活跃端发；想让本端接管，发 `/bot activate`。',
              }).catch(reportSendFailure)
            }
            return
          }
          notify(`dsh-lark-bridge: elected active endpoint ${myIdentity.deviceId} (${myForm}/${myProfile}; previous went silent)`)
        }
      }
    }
    // Full-transcript ingest is fire-and-forget: never awaited, never blocks
    // or fails the turn (contract in src/chronicle.ts).
    postChronicle(config.chronicleEndpoint, { source: config.chronicleSource, text: msg.content, chatId: msg.chatId }, notify)
    try {
      // The ladder only sees the session id — the chat it came from is not part
      // of its contract — so the directory this session must start in is handed
      // over here, before the acquire that may create it.
      pendingSessionCwd.set(
        sessionIdFor(conversationKey(config.sessionScope ?? 'chat', msg)),
        await chatCwd(msg.chatId),
      )
      const opened = await stage(msg.messageId, 'session-acquire', () => sessions.acquire(msg))
      const binding = await stage(msg.messageId, 'session-bind', () => bindingFor(opened.handle.agent.session.id, msg, opened.handle.agent.session))
      // The reaction lifecycle follows this session's current trigger.
      binding.currentMessageId = msg.messageId

      // ── Preemptive commands (owner request 08-25): these bypass the normal
      // pipeline and act IMMEDIATELY on the agent, even mid-turn.
      const preemptive = msg.content.trim().toLowerCase()
      if (preemptive === '/stop') {
        opened.handle.agent.cancel('user-requested')
        notify(`dsh-lark-bridge: preemptive /stop for session ${opened.handle.agent.session.id}`)
        await port.send(msg.chatId, { markdown: '⏹ 已停止当前任务' }).catch(reportSendFailure)
        return
      }
      // `/ws use <dir>` binds THIS chat to a project directory, durably.
      //
      // The binding is the chat's, not the session's, because `/new` in this
      // chat must land in the same project again — that is the whole point. A
      // project's memory lives in its AGENTS.md, and that file only loads when
      // the session's cwd is inside that directory. Switching therefore takes
      // effect on the NEXT session; the running one keeps the directory it was
      // created in, because moving files under a working agent is worse than
      // asking for a `/new`.
      const wsUse = /^\/ws\s+use(?:\s+(.+))?$/i.exec(msg.content.trim())
      if (wsUse !== null) {
        const asked = (wsUse[1] ?? '').trim().replace(/^["']|["']$/g, '')
        if (asked === '') {
          const current = await chatCwd(msg.chatId)
          await port.send(msg.chatId, {
            markdown: `📁 本会话绑定：\`${current}\`\n\n\`/ws use <目录>\` 切换 · \`/ws use default\` 解除绑定 · 切换后发 \`/new\` 开新对话生效`,
          }).catch(reportSendFailure)
          return
        }
        if (asked.toLowerCase() === 'default') {
          await bindChatCwd(msg.chatId, null)
          await port.send(msg.chatId, {
            markdown: `📁 已解除绑定，本会话回到部署目录 \`${cwd}\`。发 \`/new\` 生效。`,
          }).catch(reportSendFailure)
          return
        }
        const target = resolve(asked)
        let isDirectory = false
        try { isDirectory = statSync(target).isDirectory() } catch { /* missing or denied */ }
        if (!isDirectory) {
          await port.send(msg.chatId, {
            markdown: `⚠️ 目录不存在或不是目录：\`${target}\`\n\n绑定未改动。`,
          }).catch(reportSendFailure)
          return
        }
        await bindChatCwd(msg.chatId, target)
        await port.send(msg.chatId, {
          markdown: `📁 本会话已绑定到 \`${target}\`。\n\n发 \`/new\` 开新对话，之后就在这个项目里工作——该目录的 \`AGENTS.md\` 会被加载。`,
        }).catch(reportSendFailure)
        return
      }
      // `/new` (and its alias `/clear`) rotates the conversation onto a fresh
      // session, leaving the old one stored for history (`/sessions`). Refused
      // mid-turn: disposing the old agent would kill work the chat never asked
      // to abandon.
      if (preemptive === '/new' || preemptive === '/clear') {
        if (opened.handle.agent.status === 'running') {
          await port.send(msg.chatId, { markdown: '⏳ 当前任务还在跑：先 /stop 或等它结束，再 /new 开新会话。' }).catch(reportSendFailure)
          return
        }
        try {
          const rotated = await sessions.rotate(msg)
          notify(`dsh-lark-bridge: /new rotated ${msg.chatId} to session ${rotated.handle.agent.session.id}`)
          const warn = rotated.persisted ? '' : '\n⚠️ 但轮换记忆写入失败：重启后这条对话会退回旧历史，重要话题先别开。'
          await port.send(msg.chatId, { markdown: '🆕 已开新会话。下一条消息起就是新话题；旧会话保留在历史里（`/sessions` 可查）。' + warn }).catch(reportSendFailure)
        } catch (error) {
          await port.send(msg.chatId, { markdown: `⚠️ 开新会话失败：${error instanceof Error ? error.message : String(error)}` }).catch(reportSendFailure)
        }
        return
      }
      // A slash line is a control, not a prompt: the host runs it without a
      // model turn, so it must not be handed to the model as text — and it
      // needs no reply target, since its answer is not an assistant turn.
      if (isCommandLine(msg.content)) {
        const sessionId = opened.handle.agent.session.id
        const presetBefore = sessionPresets.get(sessionId)
        // A slash command runs on the host, not on the model. When it
        // throws, the outer catch would report "cannot start session" —
        // which is not what happened and sent issue #2's reporter looking
        // for a session problem instead of a command-argument problem.
        // The command path therefore owns its own error surface.
        let outcome: Awaited<ReturnType<typeof runCommandLine>>
        try {
          // A slash command may ask what is scheduled. Rebuild the registry
          // first: a reminder created by an earlier process never announced
          // itself to this one, and /schedules would report "none" for
          // something that is still firing.
          await seedScheduleRegistry(opened.handle.agent.session)
          outcome = await runCommandLine(
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
            // The chat's effective directory, not the deployment default: a
            // `/ws use` binding outranks `config.cwd` for the next session, so
            // `/ws` must report the same directory `/new` will land in.
            await chatCwd(msg.chatId),
            loaderEntries(),
            getSyncContext(),
            ctx.get('tools') as HostTools | undefined,
            (await compositionFor(sessionId)).toolScope,
            // `cwdBound` trails the whole signature, so it is last here even
            // though it describes the cwd two arguments up.
            (await chatBindings())[msg.chatId] !== undefined,
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          notify(`dsh-lark-bridge: command execution failed for chat ${msg.chatId}: ${detail}`)
          ctx.logger.warn('command execution failed for chat %s: %s', msg.chatId, error)
          try {
            const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
            appendFileSync('/tmp/dsh-session-crash.log', `[${new Date().toISOString()}] chat=${msg.chatId} command=${msg.content}\n${stack}\n\n`)
          } catch { /* diagnostics must never mask the original failure */ }
          await port
            .send(msg.chatId, { text: `⚠️ 命令执行失败：${detail}` })
            .catch(reportSendFailure)
          return
        }
        // A /preset switch changed this session's composition contract; the
        // cached composition would resume the OLD preset, so drop it and let
        // the next acquire compose from the remembered choice.
        if (sessionPresets.get(sessionId) !== presetBefore) {
          compositions.delete(sessionId)
        }
        if (outcome.reply !== '') {
          await replay.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure)
        }
        // An interactive outcome (the account switcher) rides a card; the
        // empty reply says the card IS the whole answer.
        if (outcome.card !== undefined) {
          await replay.send(binding.chatId, { card: outcome.card }).catch(reportSendFailure)
        }
        return
      }
      // Busy-input routing (issue #5, `busyPolicy`) and its visibility
      // (2026-09-12 operator report, P140: a message sent mid-turn used to be
      // silent, and the chat read the wait as a hang). One short line names the
      // boundary the message actually took.
      const busyPlan = busyDelivery(
        opened.handle.agent.status === 'running',
        config.busyPolicy,
        opened.handle.agent,
      )
      if (busyPlan.receipt !== '') {
        void replay.send(binding.chatId, { markdown: busyPlan.receipt }).catch(reportSendFailure)
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
        // user's own text; failures degrade silently to no-briefing. The read is
        // sync and the file may live on a bridged filesystem, so wrap it: a
        // stall then names its stage instead of freezing the loop silently.
        const prefix = await stage(msg.messageId, 'briefing', async () => briefingPrefix(config.briefingFile, opened.handle.agent.session.id, notify))
      // 引用回复（消息 → 回复）：飞书只把 `parent_id` 放进事件，被引用那条的
      // 正文要另外读一次。不读，用户发的是「这个再改改」，模型看到的就只剩
      // 这五个字——它只能猜「这个」指什么。
      //
      // 话题群是例外：那里 `parent_id` 指的是话题根，不是用户主动引用的一条，
      // 拿它当引用会让每条消息都背上一段历史，把真正的提问挤出注意力。
      const quoted = await stage(msg.messageId, 'quote', async () => {
        const parentId = msg.replyToMessageId
        if (parentId === undefined || parentId === '' || parentId === msg.messageId) return ''
        if (msg.threadId !== undefined && parentId === msg.threadId) return ''
        const fetchOne = port.fetchMessage
        if (typeof fetchOne !== 'function') return ''
        try {
          return quotedPrefix(await fetchOne.call(port, parentId), config.limits.quoteChars)
        } catch (error) {
          // A quote the app cannot read must not cost the whole message: the
          // user's own words still reach the model, minus the quote.
          notify(`dsh-lark-bridge: quoted message ${parentId} unreadable: ${error instanceof Error ? error.message : String(error)}`)
          return ''
        }
      })
      // Append file notes to the user's text so the agent knows what arrived.
      // (`chatUserMessage` folds `images.notes` into the text itself — adding
      // them here as well made every image note reach the model twice.)
      const allNotes = [...fileNotes]
      const spoken = [quoted, msg.content, ...allNotes].filter(part => part !== '').join('\n')
      const turn = chatUserMessage({ ...msg, content: spoken }, images)
      let content = prefix === ''
        ? turn.content
        : Object.freeze([
            { type: 'text' as const, text: prefix },
            ...turn.content,
          ])
      // `inject` only attaches to a live driver: a turn that closed while the
      // images or the briefing were being read would leave the note parked in
      // the inbox with nothing to wake it, so a message that is no longer
      // mid-turn becomes the ordinary follow-up it has now become. Steering
      // needs no such check — an idle driver starts a turn for it.
      const parkedInject = busyPlan.policy === 'inject' && opened.handle.agent.status !== 'running'
      if (parkedInject) {
        notify(`dsh-lark-bridge: inject downgraded to followup for session ${opened.handle.agent.session.id} (turn closed before delivery)`)
      }
      const delivery: BusyPolicy = parkedInject ? 'queue' : busyPlan.policy
      const message = { ...turn, content }
      if (delivery === 'steer') opened.handle.agent.steer?.(message)
      else if (delivery === 'inject') opened.handle.agent.inject?.(message)
      else opened.handle.agent.followup(message)
    }
    } catch (error) {
      notify(`dsh-lark-bridge: agent creation failed for chat ${msg.chatId}: ${String(error)}`)
      ctx.logger.warn('agent creation failed for chat %s: %s', msg.chatId, error)
      // The chat only shows the message; the operator needs the stack. journald
      // carries no trace for this process, so persist it where it survives.
      const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
      try {
        appendFileSync('/tmp/dsh-session-crash.log', `[${new Date().toISOString()}] chat=${msg.chatId}\n${stack}\n\n`)
      } catch { /* diagnostics must never mask the original failure */ }
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
          command === undefined ? undefined : boundCardText(command, config.limits.approvalArgChars),
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

  /**
   * The account-switcher card's buttons: fleet-single-writer (both ends
   * receive every click; only the arbitration-active endpoint acts), then
   * operator authorization, then the same switch/forget the text command
   * runs. The result lands as a toast plus a chat line — the stale card
   * stays behind, the line is the truth.
   */
  const handleAccountCardAction = async (
    evt: CardActionEvent,
    acct: { act: 'use' | 'forget'; name: string },
  ): Promise<CardActionResponse> => {
    const syncCtx = getSyncContext()
    if (syncCtx === undefined) return { toast: { type: 'error', content: '同步层未就绪，稍后再试' } }
    const arbitration = await arbitrationForInbound()
    if (arbitration !== null) {
      const identity = await ensureDeviceId()
      if (!isActiveEndpoint(arbitration, identity.deviceId, syncCtx.form, syncCtx.profile)) {
        return { toast: { type: 'info', content: '本端为待命端，已忽略（活跃端处理中）' } }
      }
    }
    const refusal = refuseMessage(authorization, {
      senderId: evt.operator.openId,
      chatId: evt.chatId,
      chatType: 'p2p',
    })
    if (refusal !== undefined) {
      notify(`dsh-lark-bridge: rejected an account-card click: ${refusal}`)
      return { toast: { type: 'error', content: '你无权切换账号' } }
    }
    const outcome = acct.act === 'use'
      ? await accountUseByName(syncCtx, acct.name)
      : await accountForgetByName(syncCtx, acct.name)
    void replay.send(evt.chatId, { markdown: outcome.text }).catch(reportSendFailure)
    return {
      toast: {
        type: outcome.ok ? 'success' : 'error',
        content: outcome.ok
          ? (acct.act === 'use' ? `已切换到 ${acct.name}，重启后生效` : `已删除 ${acct.name}`)
          : '没有这个账号，见聊天里的提示',
      },
    }
  }

  const handleCardAction = (evt: CardActionEvent): CardActionResponse | undefined => {
    const questionResponse = questions.handleCardAction(evt)
    if (questionResponse !== undefined) return questionResponse
    const acct = accountCardValue(evt.action.value)
    if (acct !== undefined) {
      void handleAccountCardAction(evt, acct)
      return { toast: { type: 'info', content: '正在处理…' } }
    }
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
  // A rejected handler must not vanish: the message is acknowledged with a
  // reaction before any of the work starts, so an unobserved rejection (or a
  // handler parked on a call with no deadline) reads to the human as "the bot
  // saw me, then did nothing" and leaves no trace to diagnose. Report it and
  // settle the reaction as a failure so the ack is not the last thing it shows.
  ctx.effect(() => replay.on('message', (msg: NormalizedMessage) => {
    void handleMessage(msg).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      notify(`dsh-lark-bridge: inbound handler failed for ${msg.messageId}: ${detail}`)
      ctx.logger.warn('inbound handler failed for %s: %s', msg.messageId, error)
      void reactions?.fail(msg.messageId)
    })
  }), 'dsh-lark-bridge:on(message)')
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
  let disconnectedAt: number | undefined
  ctx.effect(() => replay.on('reconnecting', () => {
    replay.setConnected(false)
    disconnectedAt ??= Date.now()
    notify('dsh-lark-bridge: connection lost, reconnecting — outbound is queued and will replay once restored')
    ctx.logger.warn('connection lost, reconnecting')
  }), 'dsh-lark-bridge:on(reconnecting)')

  ctx.effect(() => replay.on('reconnected', () => {
    replay.setConnected(true)
    notify('dsh-lark-bridge: connection restored')
    ctx.logger.info('connection restored')
    // Inbound events are not replayed across a gap (the transport has no
    // cursor), so a long one silently ate every message the chat sent. Tell
    // the bound chats instead of leaving them reading the silence as a hang
    // (2026-09-12 operator report; P140).
    const gapStart = disconnectedAt
    disconnectedAt = undefined
    if (gapStart === undefined) return
    const gapMs = Date.now() - gapStart
    if (gapMs < 30_000) return
    const gapLabel = gapMs < 120_000
      ? `${Math.round(gapMs / 1000)} 秒`
      : `${Math.round(gapMs / 60_000)} 分钟`
    const notice = `⚠️ 连接中断了约 ${gapLabel}——期间发来的消息飞书不会补送，重要指令请重发。`
    for (const chatId of new Set([...bySession.values()].map(binding => binding.chatId))) {
      void replay.send(chatId, { markdown: notice }).catch(reportSendFailure)
    }
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

  /**
  * Host contract mirror: 0.1.5 delivers live assistant streaming through the
  * Agent-scoped `agent/assistant-stream` event. Older harnesses appended an
  * `assistant/chunk` session event instead, and 0.1.5 dropped that producer —
  * the type survives only in the session-format migrations, so a renderer
  * that waits for it renders no reasoning at all while the run looks healthy.
  *
  * The frame union carries `turn`/`step` on `start` and only the `chunk` on
  * each `chunk` frame, so the pair is tracked per attempt and folded back in
  * before handing the renderer the event shape it already consumes.
  */
  const attemptSteps = new Map<string, { turn: number; step: number }>()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent.session.id
    const binding = bySession.get(sessionId)
    if (binding === undefined) return
    // Children publish their own attempts on the session they share with the
    // agent that spawned them, and their turn/step counters restart at 1. Left
    // unfiltered they render into the same chat as the parent's, so the reader
    // sees the reasoning of every subagent interleaved with the parent's and
    // the same step numbers over and over. Only the session's own agent owns
    // the chat's process display.
    const owner = agents.get(sessionId)
    if (owner !== undefined && owner !== agent) {
      // Child agent. Two rules, both learned the hard way:
      //   1. never render it into the parent's process display — unfiltered,
      //      every subagent's reasoning interleaved with the parent's and its
      //      turn/step counters restarted at 1, so the reader saw the same
      //      step numbers over and over (fix 80b6019);
      //   2. do not drop it either — route it to the multi-agent panel, keyed
      //      by the child's own session id, so the run stays visible without
      //      polluting the parent's answer.
      // (A child streams in its own session, so it never reaches this branch —
      // its content is narrated by `noteChildSessionEvent`.)
      return
    }
  if (frame.type === 'end') {
    attemptSteps.delete(frame.attemptId)
    return
  }
  if (frame.type === 'start') {
    attemptSteps.set(frame.attemptId, { turn: frame.turn, step: frame.step })
    return
  }
  const at = attemptSteps.get(frame.attemptId) ?? { turn: 0, step: 0 }
  binding.renderer.handle({
    type: 'assistant/chunk',
    data: { turn: at.turn, step: at.step, chunk: frame.chunk },
  } as HostSessionEvent)
  })

  ctx.on('session/event', (session, event: HostSessionEvent) => {
    const binding = bySession.get(session.id)
    if (binding === undefined) {
      // A child runs in its own session (see `childChat`), so its events never
      // match a bound session — narrate them into its panel row instead of
      // dropping them. This is what makes the panel live.
      const childOf = childChat.get(session.id)
      if (childOf !== undefined) {
        noteChildSessionEvent(childOf, session.id, event)
        return
      }
      // 外勤会话镜像 (P141, 09-15 令：实时多agent实况)：既未绑定、也非
      // 子会话的独立会话（并行开发线/CLI 运行）→ 按会话节流（60s）推一行进度/
      // 完结到绑定聊天。聊天自身会话走下方渲染管线，互不重复。
      // A session that is neither this chat's nor a known child's still
      // declares deliverables. It belongs to no chat, so the files cannot be
      // placed — but the person who asked for them is looking at a chat, and
      // silence reads as "it worked". The files are announced to the chats
      // this bridge serves, so the reader can go and get them.
      if (isPresentedEvent(event) && config.presentBridge !== false) {
        const callId = event.data.callId
        let seen = presentedCalls.get(session.id)
        if (seen === undefined) { seen = new Set<string>(); presentedCalls.set(session.id, seen) }
        if (!seen.has(callId)) {
          seen.add(callId)
          for (const file of event.data.files) {
            const caption = file.description === undefined || file.description === ''
              ? `交付文件 · turn ${event.data.turn}`
              : file.description
            const seenChats = new Set<string>()
            for (const b2 of bySession.values()) {
              if (seenChats.has(b2.chatId)) continue
              seenChats.add(b2.chatId)
              void replay.send(b2.chatId, {
                markdown: `📎 另一会话声明了交付文件：\`${file.path}\`${caption === '' ? '' : ` · ${caption}`}\n（该会话不属于当前聊天，文件未能送达本聊天）`,
              }).catch(() => {})
            }
          }
        }
        return
      }
      const notable = isStepStartEvent(event) || isTurnEndEvent(event)
      const nowMs = Date.now()
      const last = externalMirrorAt.get(session.id)
      if (notable && (last === undefined || nowMs - last >= 60_000)) {
        externalMirrorAt.set(session.id, nowMs)
        const turn = (event.data as { turn?: number }).turn
        const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
        const label = isTurnEndEvent(event)
          ? `✅ T${turn ?? '?'} 完成（${reason ?? '?'}）`
          : `T${turn ?? '?'} 进行中`
        const seenChats = new Set<string>()
        for (const b of bySession.values()) {
          if (seenChats.has(b.chatId)) continue
          seenChats.add(b.chatId)
          void replay.send(b.chatId, { markdown: `⚙️ [会话 ${session.id.slice(0, 8)}] ${label}` }).catch(() => {})
        }
      }
      return
    }
    // One answer, one bubble — no cross-surface relay here.
    //
    // A `🌐【web】` mirror used to re-post turns the bridge did not drive, on the
    // premise that they "never passed the Feishu pipeline". They already do: the
    // renderer below handles EVERY event of a bound session, whoever drove the
    // turn, so each external turn went out twice — the answer, and the same text
    // ~0.1s later behind that prefix (7 such pairs in one 150-message window of
    // production traffic). The mirror also carried a dead guard: it deleted the
    // driving flag at `turn/end` before reading it, so that check never failed.
    // Contract: tests/cross-surface-delivery.spec.ts.
    if (isTurnEndEvent(event)) {
      // Close out one-shot children spawned by this turn, so the panel does not
      // leave stale「进行中」rows behind. `continuable` children outlive the
      // turn by design and keep their own status.
      const panel = subagentTrackers.get(binding.chatId)
      if (panel !== undefined && subCard.settleRunningOneShots(panel) > 0) {
        void flushSubagentCard(binding.chatId, panel, true).catch(reportSendFailure)
      }
    }
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
    if (isSubagentCatalogEvent(event)) {
      // Durable child record on the PARENT session — the reachable event in
      // 0.1.5 (see the panel plumbing note above). Keyed by the child's own
      // session id, so its activity can be attributed later.
      // Register the child so its OWN session events can find this chat.
      childChat.set(event.data.childId, binding.chatId)
      // Say the delegation out loud. A child that is announced only in the
      // panel is invisible to a reader who is looking at the chat: the panel
      // is a card that must be found, and the chat is where the question was
      // asked. The label is the child's own description of its work, so the
      // line says what is being done rather than that something is.
      if (config.announceSubagents !== false) {
        const label = event.data.label === undefined || event.data.label.trim() === ''
          ? '未命名任务'
          : event.data.label.trim()
        void replay.send(binding.chatId, {
          markdown: `🔀 派出子代理 · ${label}\n（进展会实时更新，完成后一并汇报）`,
        }).catch(reportSendFailure)
      }
      upsertSubagent(binding.chatId, event.data.childId, {
        mode: event.data.mode,
        ...event.data.label === undefined ? {} : { label: event.data.label },
      }, true)
    }
    // Team events (W-10a): the host records the members and the shared tasks
    // in the session that leads the team. One card per chat shows all of it,
    // updated in place. The two mailbox events are historical records the
    // host reads but never writes — live traffic arrives as relayed
    // messages, handled above.
    // A message a teammate relayed into this session. The team package does
    // not record a mailbox event for it: it steers the message into the
    // recipient's inbox, and it arrives as a `user/message` whose source
    // names the sender.
    if (isTeamRelayMessageEvent(event)) {
      noteTeamRelayMessage(binding.chatId, event)
    }
    if (isTeamMemberEvent(event) || isTeamTaskEvent(event) || isTeamMessageEvent(event) || isTeamMessageDeliveredEvent(event)) {
      const teamId = event.data.teamId
      let tracker = teamTrackers.get(binding.chatId)
      if (tracker === undefined || tracker.state.teamId !== teamId) {
        tracker = { state: teamCard.createTeamState(teamId) }
        teamTrackers.set(binding.chatId, tracker)
      }
      if (isTeamMemberEvent(event)) teamCard.addTeamMember(tracker.state, event.data.member)
      else if (isTeamTaskEvent(event)) teamCard.addTeamTask(tracker.state, event.data.task)
      else if (isTeamMessageEvent(event)) teamCard.addTeamMessage(tracker.state, event.data.message)
      else teamCard.markTeamMessageDelivered(tracker.state, event.data.messageId)
      void flushTeamCard(binding.chatId, true).catch(reportSendFailure)
    }
    if (isPresentedEvent(event)) {
      // The model declared files at the end of its turn. Deliver them to the
      // chat, once per declaration.
      //
      // The event fires once per declaration, but a host may replay it or
      // nest calls, so the call id is what makes the delivery exactly-once.
      // A session that already delivered this call is skipped.
      if (config.presentBridge !== false) {
        const callId = event.data.callId
        let seen = presentedCalls.get(session.id)
        if (seen === undefined) { seen = new Set<string>(); presentedCalls.set(session.id, seen) }
        if (!seen.has(callId)) {
          seen.add(callId)
          // Deliveries are sequential: the chat reads them in the order the
          // model declared them, and a second file waits for the first to
          // settle rather than racing it.
          void (async () => {
            for (const file of event.data.files) {
              const caption = file.description === undefined || file.description === ''
                ? `交付文件 · turn ${event.data.turn}`
                : file.description
              try {
                await deliverDeclaredFile(session.id, file.path, caption)
              } catch (error) {
                // A file that cannot be delivered is reported once, in the
                // chat, and not retried: the retry belongs to the model,
                // which can call the send tool again with a different path.
                const detail = error instanceof Error ? error.message : String(error)
                void replay.send(binding.chatId, {
                  markdown: `⚠️ 交付文件 \`${file.path}\` 未能送达：${detail}`,
                }).catch(reportSendFailure)
              }
            }
          })()
        }
      }
    }
    if (isScheduleChangeEvent(event)) {
      const line = scheduleLine({
        operation: event.data.operation,
        ...event.data.schedule === undefined ? {} : { kind: event.data.schedule.kind, prompt: event.data.schedule.prompt },
      })
      if (line !== undefined) void replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure)
      // Keep /schedules in step with the live stream. A session whose log was
      // already replayed (seedScheduleRegistry) starts from that state; one
      // that was not yet starts from what this event says, and the replay
      // later re-applies it — applyScheduleChange is idempotent by design.
      const sessionId = session.id
      const byId = scheduleRegistry.get(sessionId) ?? new Map<string, ScheduleEntry>()
      applyScheduleChange(byId, event.data)
      if (byId.size === 0) scheduleRegistry.delete(sessionId)
      else scheduleRegistry.set(sessionId, byId)
    }
    if (isWebSearchRequestEvent(event)) {
      const nowMs = Date.now()
      const last = lastSearchNoticeAt.get(binding.chatId)
      if (last === undefined || nowMs - last >= 90_000) {
        lastSearchNoticeAt.set(binding.chatId, nowMs)
        void replay.send(binding.chatId, { markdown: webSearchLine() }).catch(reportSendFailure)
      }
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
