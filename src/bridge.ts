/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-bridge/bridge
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
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
  HostCommands,
  HostContentBlock,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
} from './host.ts'
import { isGoalChangeEvent, isStepStartEvent, isTodoWriteEvent, isToolCallEvent, isTurnEndEvent } from './host.ts'
import { createCotRenderer } from './cot.ts'
import type { CotPort } from './cot.ts'
import { createMessageRenderer, createStreamRenderer } from './outbound.ts'
import type { OutboundPort, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'
import { refuseApprovalClick, refuseMessage } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import { HELP_COMMAND, isCommandLine, runCommandLine, STOP_COMMAND } from './commands.ts'
import { collectImages } from './images.ts'
import type { CollectedImages, ImagePort } from './images.ts'
import { syncSlashPanel } from './slash-panel.ts'
import type { SlashPanelPort } from './slash-panel.ts'
import { ConversationSessions } from './session.ts'
import type { SessionLadder } from './session.ts'
import { createReactionTracker } from './reaction.ts'
import type { ReactionTracker } from './reaction.ts'
import { createQuestionProvider } from './questions.ts'
import type { HostUserQuestions } from './questions.ts'
import { createTodoRenderer } from './todo.ts'
import { createGoalRenderer } from './goal.ts'

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
function composeChatAgent(agentCtx: Context, config: ResolvedConfig): void {
  if (config.denyTools.length > 0) {
    const denied = new Set(config.denyTools)
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
  const bySession = new Map<string, ChatBinding>()
  const pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Arguments of tool calls this turn requested, by call id. An approval names
   * the call it decides but not what that call does, and the human cannot judge
   * an escalation without seeing the command; the log already published these.
   */
  const pendingCallArguments = new Map<string, string>()
  const cwd = resolve(config.cwd ?? process.cwd())

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
  const composeAgent = async (): Promise<AgentComposition> => {
    // Loader siblings mount concurrently; await the complete application so a
    // first message arriving during boot never sees a half-composed agent world.
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    const presets = ctx.get('agentPresets') as HostAgentPresets | undefined
    const presetId = presets === undefined ? undefined : (await presets.resolve(config.preset)).id
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
        composeChatAgent(agentCtx, config)
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
      pending = composeAgent()
      compositions.set(sessionId, pending)
      // A rejected composition is not replayed: the next message may arrive
      // after the roster it named was fixed.
      pending.catch(() => { compositions.delete(sessionId) })
    }
    return pending
  }

  const agents = ctx.agents as DurableAgentRegistry

  const ladder: SessionLadder = {
    lookup: (sessionId) => {
      const agent = agents.get(sessionId)
      // An agent another owner published is theirs to dispose.
      return agent === undefined ? undefined : { agent, dispose: () => Promise.resolve() }
    },
    resume: async (sessionId) => {
      const composition = await compositionFor(sessionId)
      return agents.resume({
        resumeSessionId: sessionId,
        agentOptions: modelSelection(),
        setup: composition.setup,
      })
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

  /** Mark a message as being worked on. Best-effort: the app may lack the scope. */
  let panelPublished = false

  /**
   * Publish what this chat accepts to the bot's `/` panel, once. Fire and
   * forget: discovery is a convenience, and every command works typed by hand.
   */
  const publishSlashPanel = (agent: HostAgent): void => {
    if (!config.syncSlashCommands || panelPublished) return
    panelPublished = true
    const hosted = (ctx.get('commands') as HostCommands | undefined)?.list(agent) ?? []
    const desired = [
      ...hosted.map(descriptor => ({ name: descriptor.name, description: descriptor.description })),
      { name: STOP_COMMAND, description: '停止当前任务' },
      { name: HELP_COMMAND, description: '显示可用命令' },
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
    try {
      const opened = await sessions.acquire(msg)
      const binding = await bindingFor(opened.handle.agent.session.id, msg)
      // The reaction lifecycle follows this session's current trigger.
      binding.currentMessageId = msg.messageId
      // A slash line is a control, not a prompt: the host runs it without a
      // model turn, so it must not be handed to the model as text — and it
      // needs no reply target, since its answer is not an assistant turn.
      if (isCommandLine(msg.content)) {
        const outcome = await runCommandLine(
          msg.content,
          opened.handle.agent,
          ctx.get('commands') as HostCommands | undefined,
          commandSignal(),
        )
        if (outcome.reply !== '') {
          await port.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure)
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
      opened.handle.agent.followup(chatUserMessage(msg, images))
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
      sent = await port.send(binding.chatId, {
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
      pendingApprovals.set(id, {
        chatId: binding.chatId,
        chatType: binding.chatType,
        messageId: sent.messageId,
        toolName: request.toolName,
        settle: resolveOutcome,
      })
      request.signal?.addEventListener(
        'abort',
        () => { settleApproval(id, 'cancelled') },
        { once: true },
      )
    })
  }

  const handleCardAction = (evt: CardActionEvent): CardActionResponse | undefined => {
    const questionResponse = questions.handleCardAction(evt)
    if (questionResponse !== undefined) return questionResponse
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
  ctx.effect(() => port.on('message', (msg) => { void handleMessage(msg) }), 'dsh-lark-bridge:on(message)')
  ctx.effect(() => port.on('cardAction', handleCardAction), 'dsh-lark-bridge:on(cardAction)')

  // Observability. Without these, the failure modes an operator actually hits —
  // "the bot ignored me", "an inbound handler threw", "the connection dropped" —
  // leave no trace at all, because the transport reports each only as an event.
  ctx.effect(() => port.on('reject', (evt: RejectEvent) => {
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

  ctx.effect(() => port.on('error', (error: LarkChannelError) => {
    notify(`dsh-lark-bridge: transport error [${error.code}]: ${error.message}`)
    ctx.logger.warn('transport error [%s]: %s', error.code, error.message)
  }), 'dsh-lark-bridge:on(error)')

  // A gap in the long connection is a gap in delivery: the transport has no
  // replay and no cursor, so events arriving while it is down are simply lost.
  ctx.effect(() => port.on('reconnecting', () => {
    notify('dsh-lark-bridge: connection lost, reconnecting — events arriving now are not replayed')
    ctx.logger.warn('connection lost, reconnecting')
  }), 'dsh-lark-bridge:on(reconnecting)')

  ctx.effect(() => port.on('reconnected', () => {
    notify('dsh-lark-bridge: connection restored')
    ctx.logger.info('connection restored')
  }), 'dsh-lark-bridge:on(reconnected)')

  // Outbound: the owned chat's renderer decides what reaches the chat. The
  // bridge additionally remembers each call's arguments for the approval card,
  // and forgets the turn's calls once it closes.
  ctx.on('session/event', (session, event: HostSessionEvent) => {
    const binding = bySession.get(session.id)
    if (binding === undefined) return
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
    for (const [id, pending] of [...pendingApprovals]) {
      pendingApprovals.delete(id)
      pending.settle('cancelled')
    }
    disposeQuestions?.()
    const bindings = [...bySession.values()]
    bySession.clear()
    compositions.clear()
    pendingCallArguments.clear()
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
    port.connect().catch((error: unknown) => {
      notify(`dsh-lark-bridge: connect failed: ${error instanceof Error ? error.message : String(error)}`)
      ctx.logger.error('dsh-lark-bridge channel connect failed: %s', error)
    })
    return () => port.disconnect().catch(reportSendFailure)
  }, 'dsh-lark-bridge:connect')
}
