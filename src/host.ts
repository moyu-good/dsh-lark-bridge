/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Keeping these structural copies (instead of importing host source
 * packages) lets the package build self-contained; a composed DSH profile
 * supplies the real implementations at runtime. Field shapes mirror
 * `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, and
 * `@deepseek-ai/dsh-user-approval` as of dsh main 2026-08-20 (was 0.0.1-rc.2).
 * P1 alignment: cancel signature, GoalChange clear-tombstone, and Cordis event
 * guards expanded for perfect-plugin roadmap.
 * @module dsh-lark-bridge/host
 */

import type { Context } from '@deepseek-ai/cordis'

/** The live session a host agent drives; only the identity is read here. */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
}

/** Durable metadata for one stored image, from {@link HostAttachments.saveImage}. */
export interface HostImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One model-facing content block this plugin produces. */
export type HostContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: HostImageRef }

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface HostUserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  /** Model-facing content blocks: the chat's text, plus any images it carried. */
  readonly content: readonly HostContentBlock[]
  /** Producer tag: chat input is a direct human prompt. */
  readonly source: { readonly kind: 'user' }
}

/** What one image must satisfy to be stored, from the attachment service. */
export interface HostImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly mediaTypes: readonly string[]
}

/**
 * The `attachments` store (subset of the host `AttachmentStore`). Images reach
 * a model as an opaque reference to bytes this service owns, never as a path
 * or a URL, so a chat image has to be committed here before it can be sent.
 */
export interface HostAttachments {
  readonly imageLimits: HostImageLimits
  /** Validate and durably commit one image; the media type is checked against the bytes. */
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HostImageRef>
}

/** Public live-agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  /** The single identity shared with {@link session}. */
  readonly id: string
  readonly session: HostSession
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: HostUserMessage): void
  /**
   * Clear queued work and abort the active turn. A no-op when nothing is
   * active, so a chat may offer it unconditionally.
   * Signature mirrors Agent.cancel(cause: AgentCancelCause, options?: CancelOptions).
   */
  cancel(cause: string, options?: { readonly keepInbox?: boolean }): void
}

/** An owned agent plus its teardown capability, from `agents.create()`. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** Per-agent provider/model routing accepted by {@link HostAgentRegistry.create}. */
export interface HostAgentOptions {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** One persisted session's header, as this plugin's lookup reads it. */
export interface HostSessionHeader {
  readonly id: string
  /** Unix epoch milliseconds; the newest header for a chat is the one to resume. */
  readonly createdAt: number
}

/**
 * The `sessionPersistence` store (subset of the host provider). Only headers
 * are read: enough to find a chat's previous session without loading any log.
 */
export interface HostSessionPersistence {
  list(signal?: AbortSignal): Promise<readonly HostSessionHeader[]>
}

/** The `agents` registry service (subset of the host `AgentRegistry`). */
export interface HostAgentRegistry {
  /** Reopen a persisted session as a live agent, replaying its history. */
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: HostAgentOptions
    /**
     * Creation-time composition of the agent's scoped world, awaited before
     * the session and agent are published. A rejection rolls the whole
     * creation back, so a broken composition never yields a half-built session.
     */
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
}

/**
 * The `tools` registry, as this plugin's per-agent composition uses it
 * (subset of the host `ToolRegistry`).
 */
export interface HostTools {
  /**
   * Register a monotonic execution guard. Registered through an agent's scoped
   * context it applies to that agent alone; returning a string denies the call
   * with that reason, and no other guard can force-allow what one denied.
   */
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
  /**
   * One visible tool definition in a viewing scope. The scope is an opaque
   * `ScopeKey`; omitted views the global layer, which a deployment with a
   * preset roster leaves empty ({@link HostAgentPresets.standingKeyFor} supplies
   * the roster's).
   */
  get(name: string, scope?: unknown): HostToolDefinition | undefined
}

/** The presentation half of a tool definition (subset of the host `ToolDefinition`). */
export interface HostToolDefinition {
  /**
   * Pure projection of one pending call for a UI. Every view variant carries a
   * `title`: a short, always-visible label describing what THIS call does,
   * which is what a log line or card header shows. Absent on tools that accept
   * the generic fallback (title = tool name).
   */
  presentCall?(args: unknown): { readonly title?: string; readonly kind?: string } | undefined
}

/** One command this deployment offers, from {@link HostCommands.list}. */
export interface HostCommandDescriptor {
  /** Lowercase name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery surfaces. */
  readonly description: string
}

/** One settled command execution (subset of the host `CommandExecution`). */
export interface HostCommandExecution {
  readonly result:
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }
}

/**
 * The `commands` runtime: slash commands dispatched WITHOUT a model turn, which
 * is why a chat must route them here instead of letting the model read a literal
 * `/clear` as prose.
 */
export interface HostCommands {
  /** Commands available to one agent, for discovery. */
  list(agent: HostAgent): readonly HostCommandDescriptor[]
  /**
   * Run one complete slash-command line. Resolves `undefined` when the syntax
   * or the name does not resolve, which is what distinguishes an unknown
   * command from one that ran and failed.
   */
  execute(agent: HostAgent, line: string, signal: AbortSignal): Promise<HostCommandExecution | undefined>
}

/** The `systemPrompt` assembler, as this plugin's per-agent composition uses it. */
export interface HostSystemPrompt {
  /**
   * Register one ordered prompt section in the calling context's scope layer.
   * Tool guidance uses orders 100–199; a duplicate name throws.
   */
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * The `agentPresets` roster (subset of the host `AgentPresets`). A deployment
 * that composes one keeps every model-facing row — tools, prompt sections — on
 * the agent plane, so the tool registry's global layer is EMPTY and an agent
 * that joins no preset reaches the model with no tools at all.
 */
export interface HostAgentPresets {
  /** The preset id mounted when a caller names none. */
  readonly defaultId: string
  /**
   * Resolve a preset id, or the roster default when absent.
   * @throws when the roster supplies no such preset.
   */
  resolve(id?: string): Promise<{ readonly id: string }>
  /**
   * Join one agent's scope to a preset's standing composition. Call from the
   * agent factory's `setup(agentCtx)`.
   */
  mount(agentCtx: Context, id?: string): Promise<unknown>
  /**
   * The standing scope key a reader with no agent resolves this preset's
   * registrations in — the view that holds its tools, since a roster keeps
   * every model-facing row off the global layer.
   */
  standingKeyFor(id?: string): Promise<unknown>
  /** Every preset the configured roots currently supply, broken ones included. */
  list(): Promise<readonly { readonly id: string; readonly trust: 'system' | 'user'; readonly name?: string; readonly description?: string; readonly broken?: string }[]>
  /**
   * The preset one live agent runs on, read from its scope chain.
   * @param agentCtx - the live agent's scoped context.
   * @returns the preset id, or undefined for a rosterless join.
   */
  composedPreset(agentCtx: Context): string | undefined
  /**
   * Re-link one agent to a different preset's standing composition. Valid only
   * while the agent has produced nothing; the caller owns that check.
   * @throws when the id is unknown or the agent already produced.
   */
  recompose(agentCtx: Context, id: string): Promise<unknown>
}

/** One workspace record (subset of the host `Workspace` entity). */
export interface HostWorkspace {
  readonly id: string
  /** The record's canonical (realpath) directory. */
  readonly path: string
  /**
   * Account one session under this workspace. Validates the session header's
   * cwd against {@link path}, so a session created with that exact value
   * attaches and one created with an uncanonicalized variant is rejected.
   */
  attachSession(id: string): Promise<unknown>
}

/**
 * The `workspaceRegistry` service (subset of the host registry). Grouping is
 * accounted, not derived: a session whose cwd merely matches a workspace stays
 * Ungrouped until something attaches it.
 */
export interface HostWorkspaceRegistry {
  /** The record for a canonical path, or undefined when none is registered. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  /** Register a workspace for a directory; at most one record exists per canonical path. */
  create(path: string, title?: string): Promise<HostWorkspace>
}

/** The `agentDefaultModel` service (subset of `AgentDefaultModelConfig`). */
export interface HostDefaultModel {
  /** The deployment's current default provider/model selection. */
  currentSelection(): HostAgentOptions
}

/** The Cordis loader service; awaited so agents never see a half-composed tree. */
export interface HostLoader {
  await(): Promise<unknown>
}

/** One registered namespace's owner scope (subset of the host `SettingsScope`). */
export interface HostSettingsScope {
  /** The resolved value: schema defaults, then composition base, then the user document. */
  get(): unknown
  /** Deep-merge a patch into the user section and persist it through the provider. */
  update(patch: object): Promise<unknown>
}

/** The `settings` user-settings service (subset of `SettingsProvider`). */
export interface HostSettings {
  /**
   * Register a namespace schema; the registration is an effect on the calling
   * fiber. Duplicate namespaces and stored sections the schema rejects fail loud.
   */
  register(ns: string, schema: unknown, options?: { base?: unknown }): HostSettingsScope
}

/** One immutable entry in the host session log; narrowed via the guards below. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The `assistant/message` payload fields this plugin renders. */
export interface AssistantMessageData {
  readonly turn: number
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}

/** The `turn/end` payload fields this plugin reports. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: {
    readonly kind: string
    readonly error?: { readonly code?: string; readonly message?: string }
  }
}

/** The `step/start` payload fields this plugin uses to warm a card up. */
export interface StepStartData {
  readonly turn: number
  readonly step: number
}

/** The `todo/write` payload: the agent's whole current list, replaced per call. */
export interface TodoWriteData {
  readonly todos: readonly { readonly content: string; readonly status: string }[]
}

/** The `goal/change` payload: a whole-value goal snapshot mutation. */
export interface GoalChangeData {
  readonly version?: number
  readonly operation: string
  readonly goal?: {
    readonly objective: string
    readonly phase: string
    readonly blockedReason?: { readonly code?: string; readonly message?: string }
    readonly maxGoalRounds?: number
    readonly id?: string
    readonly revision?: number
  }
  /** Present on clear tombstone (no current goal) */
  readonly cleared?: { readonly id: string; readonly revision?: number }
  readonly clearedAt?: number
  readonly roundsStarted?: number
  readonly createdAt?: number
  readonly updatedAt?: number
}

/** The `tool-workflow/run-start` payload: one top-level workflow run opens. */
export interface WorkflowRunStartData {
  readonly runId: string
  readonly name: string
}

/** The `tool-workflow/agent-start` payload: one workflow member is published. */
export interface WorkflowAgentStartData {
  readonly runId: string
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: string
}

/** The `tool-workflow/agent-end` payload: one workflow member settles. */
export interface WorkflowAgentEndData {
  readonly runId: string
  readonly seq: number
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}

/** The `tool-workflow/run-end` payload: one workflow run closes. */
export interface WorkflowRunEndData {
  readonly runId: string
  readonly stopReason: 'completed' | 'cancelled' | 'error'
}

/** The `compaction/start` payload: a compaction locks the session log. */
export interface CompactionStartData {
  readonly compactionId: string
  readonly turn: number | null
}

/** The `compaction/end` payload: the lock releases (with an error when one occurred). */
export interface CompactionEndData {
  readonly compactionId: string
  readonly turn: number | null
  readonly error?: string
}

/**
 * The `compaction/summary` payload: the summary text that replaced old
 * history, and what it cost. Emitted between `compaction/start` and
 * `compaction/end`; the bridge renders it so the chat sees what a compaction
 * actually produced instead of a silent gap after "正在压缩…".
 */
export interface CompactionSummaryData {
  readonly compactionId: string
  /** The summary's content blocks (text blocks carry the visible summary). */
  readonly summary: readonly unknown[]
  readonly shadowedSeqs: readonly number[]
  /** Heuristic token price of the shadowed history, for the release line. */
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
}

/** The `compaction/prune` payload: a model-free trim of old history. */
export interface CompactionPruneData {
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}

/** The `subagent/descriptor` payload: one session-backed subagent child's durable identity. */
export interface SubagentDescriptorData {
  readonly version: number
  readonly mode: 'one-shot' | 'continuable'
  readonly provider: string
  readonly label?: string
  readonly agentProvider?: string
  readonly agentModel?: string
}

/** The `schedule/change` payload: one durable schedule mutation. */
export interface ScheduleChangeData {
  readonly version: number
  readonly operation: 'create' | 'delete' | 'dispatch'
  readonly schedule?: {
    readonly id: string
    readonly kind: 'after' | 'at' | 'every'
    readonly prompt: string
    readonly everySeconds?: number
  }
  readonly id?: string
}

/** One active schedule as the bridge tracks it from schedule/change events. */
export interface ScheduleEntry {
  readonly id: string
  readonly kind: 'after' | 'at' | 'every'
  readonly prompt: string
  readonly everySeconds?: number
  /** Unix epoch milliseconds when the bridge saw the create. */
  readonly createdAt: number
}

/** Per-session operation counters accumulated for `/audit`. */

/** Cordis `agent/status` payload: lifecycle of one live agent. */
export interface AgentStatusData {
  readonly agent: { readonly id: string }
  readonly status: 'idle' | 'running'
}

/** Cordis `subagent/start|end` payloads (provider-agnostic). */
export interface SubagentStartData {
  readonly runId: string
  readonly provider: string
  readonly id: string
  readonly local: boolean
}
export interface SubagentEndData extends SubagentStartData {
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens'
  readonly lastAssistantMessage?: readonly unknown[]
}

/** Cordis `workflow/*` run identity carried by every live workflow event. */
export interface WorkflowRunInfoData {
  readonly id: string
  readonly meta: unknown
}

export interface AuditStats {
  /** Unix epoch milliseconds when the bridge first saw this session. */
  readonly startedAt: number
  turns: number
  steps: number
  toolCalls: number
  /** Turns that closed with an error reason. */
  turnErrors: number
  compactions: number
  retries: number
  subagents: number
  workflows: number
  schedules: number
}

/** The `web/deepseek-search-llm-request` payload: one DeepSeek search request was made. */
export interface WebSearchRequestData {
  readonly request?: unknown
}

/** The `llm/retry` payload: one retry of a failed model call is scheduled. */
export interface LlmRetryData {
  readonly retryId: string
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs?: number
  readonly failure?: { readonly name?: string; readonly message?: string }
}

/** The `assistant/chunk` payload fields this plugin streams. */
export interface AssistantChunkData {
  readonly turn: number
  /**
   * One raw stream chunk. `text-delta` / `reasoning-delta` stream token-wise;
   * `block-end` carries a complete block (a text or reasoning paragraph) when
   * the adapter delivers whole blocks instead of deltas — pi-ai's deepseek
   * route emits `block-end` with `block: { type: 'reasoning', text }` and no
   * reasoning-delta events in between.
   */
  readonly chunk: {
    readonly type: string
    readonly text?: string
    readonly block?: {
      readonly type: string
      readonly text?: string
    }
  }
}

/** The `tool/result` payload fields a thinking process reports. */
export interface ToolResultData {
  readonly turn: number
  readonly message: {
    /** The producing call, so a result pairs with the call that asked. */
    readonly source?: { readonly callId?: string }
    readonly content: readonly {
      readonly type: string
      readonly toolCallId?: string
      /** Nested model-facing blocks; a tool's text output lives here. */
      readonly content?: readonly { readonly type: string; readonly text?: string }[]
    }[]
  }
  readonly error?: { readonly name: string; readonly code: string }
}

/** The `tool/call` payload fields this plugin surfaces as activity. */
export interface ToolCallData {
  readonly turn: number
  /** Pairs the call with the approval question that decides it. */
  readonly callId: string
  readonly name: string
  /** Raw arguments JSON exactly as the model produced it (unparsed, untrusted). */
  readonly arguments: string
}

/**
 * Narrow a session event to the assembled assistant message for one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantMessageData}.
 */
export function isAssistantMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantMessageData } {
  return event.type === 'assistant/message'
}

/**
 * Narrow a session event to a closed turn boundary.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TurnEndData}.
 */
export function isTurnEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnEndData } {
  return event.type === 'turn/end'
}

/**
 * Narrow a session event to the opening of one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link StepStartData}.
 */
export function isStepStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: StepStartData } {
  return event.type === 'step/start'
}

/**
 * Narrow a session event to one todo-list replacement.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TodoWriteData}.
 */
export function isTodoWriteEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TodoWriteData } {
  return event.type === 'todo/write'
}

/**
 * Narrow a session event to one goal snapshot mutation.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link GoalChangeData}.
 */
export function isGoalChangeEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: GoalChangeData } {
  return event.type === 'goal/change'
}

/** Narrow a session event to one workflow run opening. */
export function isWorkflowRunStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: WorkflowRunStartData } {
  return event.type === 'tool-workflow/run-start'
}

/** Narrow a session event to one workflow member publication. */
export function isWorkflowAgentStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: WorkflowAgentStartData } {
  return event.type === 'tool-workflow/agent-start'
}

/** Narrow a session event to one workflow member settlement. */
export function isWorkflowAgentEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: WorkflowAgentEndData } {
  return event.type === 'tool-workflow/agent-end'
}

/** Narrow a session event to one workflow run closing. */
export function isWorkflowRunEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: WorkflowRunEndData } {
  return event.type === 'tool-workflow/run-end'
}

/** Narrow a session event to a compaction lock opening. */
export function isCompactionStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionStartData } {
  return event.type === 'compaction/start'
}

/** Narrow a session event to a compaction lock releasing. */
export function isCompactionEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionEndData } {
  return event.type === 'compaction/end'
}

/** Narrow a session event to a compaction summary (what replaced old history). */
export function isCompactionSummaryEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionSummaryData } {
  return event.type === 'compaction/summary'
}

/** Narrow a session event to a model-free prune of old history. */
export function isCompactionPruneEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: CompactionPruneData } {
  return event.type === 'compaction/prune'
}

/** Narrow a session event to one subagent descriptor. */
export function isSubagentDescriptorEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: SubagentDescriptorData } {
  return event.type === 'subagent/descriptor'
}

/** Narrow a session event to one schedule mutation. */
export function isScheduleChangeEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ScheduleChangeData } {
  return event.type === 'schedule/change'
}

/** Narrow a session event to one DeepSeek search request. */
export function isWebSearchRequestEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: WebSearchRequestData } {
  return event.type === 'web/deepseek-search-llm-request'
}

/** Narrow a session event to one scheduled model-call retry. */
export function isLlmRetryEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: LlmRetryData } {
  return event.type === 'llm/retry'
}

/**
 * Narrow a session event to one raw assistant stream chunk.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantChunkData}.
 */

/**
 * Narrow a Cordis event to agent lifecycle status.
 */
export function isAssistantChunkEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantChunkData } {
  return event.type === 'assistant/chunk'
}

/**
 * Narrow a session event to one completed tool call's result.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolResultData}.
 */
export function isToolResultEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolResultData } {
  return event.type === 'tool/result'
}

/**
 * The call one result answers, and the text it produced.
 * @param data - the completed result payload.
 * @returns the call id and its joined text output.
 */
export function toolResultText(data: ToolResultData): { callId: string | undefined; text: string } {
  const block = data.message.content[0]
  const text = (block?.content ?? [])
    .filter(inner => inner.type === 'text' && inner.text !== undefined)
    .map(inner => inner.text)
    .join('')
  return { callId: block?.toolCallId ?? data.message.source?.callId, text }
}

/**
 * Narrow a session event to one model-requested tool invocation.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolCallData}.
 */
export function isToolCallEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolCallData } {
  return event.type === 'tool/call'
}

/**
 * Join the text blocks of a committed assistant message.
 * @param data - the committed message payload.
 * @returns the concatenated text, empty when the step produced none.
 */
export function assistantText(data: AssistantMessageData): string {
  return data.message.content
    .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text)
    .join('')
}

/**
 * Render a failed turn's reason as one operator-readable line.
 * @param data - the closed turn payload.
 * @returns the error detail, empty when the turn did not fail.
 */
export function turnErrorDetail(data: TurnEndData): string {
  if (data.reason.kind !== 'error') return ''
  const error = data.reason.error
  return error === undefined ? '' : `${error.code ?? 'error'}: ${error.message ?? ''}`.trimEnd()
}

/** Closed outcome of a host approval question; `'allowed-once'` is the only grant. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Readonly same-process permission question (subset of `ApprovalRequest`). */
export interface HostApprovalRequest {
  /** The agent on whose behalf the question is asked; routes the question. */
  readonly agent: HostAgent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /** Aborting withdraws the question; a late answer is discarded. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via `inject`. */
    agents: HostAgentRegistry
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
    /** Waterfall permission question; answer only for owned agents, else delegate via `next()`. */
    'approval/request'(
      request: HostApprovalRequest,
      next: () => Promise<HostApprovalOutcome>,
    ): Promise<HostApprovalOutcome>
    /** Live subagent settlement, scoped to the delegating agent. */
    'subagent/end'(info: SubagentEndData): void
    /** Live workflow run narration (two-argument Cordis events). */
    'workflow/log'(info: WorkflowRunInfoData, message: string): void
    'workflow/phase'(info: WorkflowRunInfoData, title: string): void
  }
}

/** One cross-session search hit (subset of the host `SessionSearchHit`). */
export interface HostSessionQueryHit {
  readonly session: { readonly id: string; readonly createdAt?: number }
  readonly bestMatch: { readonly snippet: string }
}

/**
 * The `sessionQuery` service (subset of the host `SessionQuery`), consumed by
 * `/sessions <keyword>` when the deployment composes a search backend.
 */
export interface HostSessionQuery {
  searchSessions(request: {
    readonly query: string
    readonly limit?: number
    readonly signal?: AbortSignal
  }): Promise<{ readonly items: readonly HostSessionQueryHit[] }>
}

/** A read-only job projection (subset of the host `JobSnapshot`). */
export interface HostJobSnapshot {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly startedAt: number
}

/** Completion listener shape of `JobRegistry.onJobDone`. */
export type HostJobDoneListener = (
  snapshot: HostJobSnapshot,
  owner: { readonly id: string } | undefined,
) => void | PromiseLike<void>

/** The `jobs` registry (subset of the host `JobRegistry`), per-agent scoped. */
export interface HostJobs {
  onJobDone(listener: HostJobDoneListener): () => void
  /** List caller-owned and unowned jobs in registration order. */
  list(caller?: { readonly id: string }): readonly HostJobSnapshot[]
}
