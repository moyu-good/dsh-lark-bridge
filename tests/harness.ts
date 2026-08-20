import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  MarkdownStreamController,
  NormalizedMessage,
  RejectEvent,
  SendInput,
  SendOptions,
  SendResult,
} from '@larksuite/channel'
import * as plugin from '../src/index.ts'
import { commandName } from '../src/commands.ts'
import { internals } from '../src/runtime.ts'
import type { ChannelConfig } from '../src/runtime.ts'
import type { ChannelPort } from '../src/bridge.ts'
import type {
  HostAgentOptions,
  HostImageLimits,
  HostAttachments,
  HostCommands,
  HostAgentPresets,
  HostApprovalOutcome,
  HostDefaultModel,
  HostSettings,
  HostUserMessage,
} from '../src/host.ts'
import type { RegisterAppPort } from '../src/onboarding.ts'

/**
 * How many inbound subscriptions `installBridge` opens: `message`,
 * `cardAction`, `reject`, `error`, `reconnecting`, `reconnected`. Tests use the
 * count as the "bridge is installed" signal, so it lives here rather than being
 * pinned at each call site.
 */
export const INBOUND_SUBSCRIPTIONS = 6

/** One outbound message captured by the fake port. */
export interface SentMessage {
  to: string
  input: SendInput
  opts?: SendOptions | undefined
}

type MessageHandler = (msg: NormalizedMessage) => void | Promise<void>
type CardActionHandler = (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>
type RejectHandler = (evt: RejectEvent) => void
type ErrorHandler = (err: LarkChannelError) => void
type ConnectionStateHandler = () => void
/** Any inbound subscription the fake port accepts, whatever the event name. */
type PortHandler = MessageHandler | CardActionHandler | RejectHandler | ErrorHandler | ConnectionStateHandler

/** One streaming card opened by the renderer, with the content it received. */
export interface StreamedCard {
  to: string
  /** Ordered controller operations: appended chunks and whole-content replacements. */
  ops: ({ append: string } | { set: string })[]
  /** The card's content as the controller applied the operations. */
  content: string
  /** Whether the producer returned, so the stream settled. */
  closed: boolean
}

/** An in-memory {@link ChannelPort} recording traffic and replaying inbound events. */
export function createFakePort() {
  const messageHandlers: MessageHandler[] = []
  const cardHandlers: CardActionHandler[] = []
  /** Every other subscription, by event name, so a test can replay any inbound event. */
  const byName = new Map<string, PortHandler[]>()
  const sent: SentMessage[] = []
  const updated: { messageId: string; card: object }[] = []
  const streams: StreamedCard[] = []
  /** Commands already on the app's panel, and the ones this run registered. */
  const panelCommands: string[] = []
  const panelCreated: string[] = []
  const panelDeleted: string[] = []
  /** Thinking processes opened by the renderer, with the events written to each. */
  const cots: {
    cotId: string
    messageId: string
    chatId: string
    replyTo?: string
    hidden: boolean
    events: { type: string; content: Record<string, unknown> }[]
    /** Stamps exactly as written, so ordering can be asserted. */
    timestamps: string[]
  }[] = []
  /** Downloadable resources, by file key, as the transport would serve them. */
  const resourceBytes = new Map<string, { buffer: Uint8Array; contentType?: string }>()
  const state = {
    connects: 0,
    disconnects: 0,
    subscriptions: 0,
    failNextSend: false,
    /** Reject every `stream()` call, as a deployment without card permissions would. */
    failStreams: false,
    /** Reject panel reads, as an app without the scope would. */
    failPanelList: false,
    /** Reject panel writes, as a duplicate name does. */
    failPanelCreate: false,
    /** Reject panel removals. */
    failPanelDelete: false,
    /** Reject opening a thinking process, as an old deployment would. */
    failCotCreate: false,
    /** Reject writing events to one. */
    failCotWrite: false,
  }
  let counter = 0

  /**
   * The subscription list for one event name. Declared outside the port literal
   * because the port's `on` is an overload set, which a single implementation
   * signature satisfies only through an assertion.
   */
  const listFor = (name: string): PortHandler[] => {
    if (name === 'message') return messageHandlers as PortHandler[]
    if (name === 'cardAction') return cardHandlers as PortHandler[]
    const existing = byName.get(name)
    if (existing !== undefined) return existing
    const fresh: PortHandler[] = []
    byName.set(name, fresh)
    return fresh
  }

  const subscribe = (name: string, handler: PortHandler): (() => void) => {
    const list = listFor(name)
    list.push(handler)
    state.subscriptions += 1
    return () => {
      const index = list.indexOf(handler)
      if (index >= 0) {
        list.splice(index, 1)
        state.subscriptions -= 1
      }
    }
  }

  const port: ChannelPort = {
    async connect() { state.connects += 1 },
    async disconnect() { state.disconnects += 1 },
    on: subscribe as ChannelPort['on'],
    async send(to, input, opts): Promise<SendResult> {
      if (state.failNextSend) {
        state.failNextSend = false
        throw new Error('send failed (fake)')
      }
      sent.push({ to, input, opts })
      counter += 1
      return { messageId: `om_sent_${counter}` }
    },
    async updateCard(messageId, card) {
      updated.push({ messageId, card })
    },
    async createCot(chatId, options) {
      if (state.failCotCreate) throw new Error('cot unavailable (fake)')
      counter += 1
      const handle = { cotId: `cot_${counter}`, messageId: `om_cot_${counter}` }
      cots.push({
        ...handle,
        chatId,
        ...options.replyTo === undefined ? {} : { replyTo: options.replyTo },
        hidden: options.hidden,
        events: [],
        timestamps: [],
      })
      return handle
    },
    async writeCotEvents(handle, events) {
      if (state.failCotWrite) throw new Error('cot write rejected (fake)')
      const cot = cots.find((c) => c.cotId === handle.cotId)
      if (cot === undefined) throw new Error(`no such cot ${handle.cotId} (fake)`)
      // The API bounds one write; a fake that ignored it would hide a real limit.
      if (events.length > 50) throw new Error('too many events in one write (fake)')
      cot.events.push(...events.map((e) => ({
        type: e.event_type,
        content: JSON.parse(e.content) as Record<string, unknown>,
      })))
      cot.timestamps.push(...events.map((e) => e.timestamp))
    },
    async downloadResourceWithMeta(messageId, fileKey, _type) {
      const stored = resourceBytes.get(fileKey)
      if (stored === undefined) throw new Error(`no such resource ${fileKey} on ${messageId} (fake)`)
      return stored
    },
    async listSlashCommands() {
      if (state.failPanelList) throw new Error('no permission to list commands (fake)')
      return panelCommands.map((c, index) => ({ command: c, commandId: `cmd_${index}` }))
    },
    async deleteSlashCommand(commandId) {
      if (state.failPanelDelete) throw new Error('cannot remove command (fake)')
      const index = panelCommands.findIndex((_, i) => `cmd_${i}` === commandId)
      if (index >= 0) panelDeleted.push(panelCommands[index]!)
    },
    async createSlashCommand(command) {
      if (state.failPanelCreate) throw new Error('command already exists (fake)')
      panelCommands.push(command)
      panelCreated.push(command)
    },
    async stream(to, input): Promise<SendResult> {
      if (state.failStreams) throw new Error('stream rejected (fake)')
      counter += 1
      const card: StreamedCard = { to, ops: [], content: '', closed: false }
      streams.push(card)
      const controller: MarkdownStreamController = {
        messageId: `om_stream_${counter}`,
        async append(chunk: string) {
          card.ops.push({ append: chunk })
          card.content += chunk
        },
        async setContent(full: string) {
          card.ops.push({ set: full })
          card.content = full
        },
      }
      // The real SDK drives the producer to completion before resolving.
      await input.markdown(controller)
      card.closed = true
      return { messageId: controller.messageId }
    },
  }

  return {
    port,
    sent,
    updated,
    streams,
    panelCommands,
    panelCreated,
    panelDeleted,
    resourceBytes,
    cots,
    state,
    /** Deliver one inbound chat message to every subscribed handler. */
    async emitMessage(msg: NormalizedMessage): Promise<void> {
      for (const handler of [...messageHandlers]) await handler(msg)
    },
    /** Deliver one policy rejection to every subscribed handler. */
    emitReject(evt: RejectEvent): void {
      for (const handler of [...(byName.get('reject') ?? [])]) (handler as RejectHandler)(evt)
    },
    /** Deliver one transport failure to every subscribed handler. */
    emitError(err: LarkChannelError): void {
      for (const handler of [...(byName.get('error') ?? [])]) (handler as ErrorHandler)(err)
    },
    /** Deliver one connection-state change to every subscribed handler. */
    emitConnectionState(name: 'reconnecting' | 'reconnected'): void {
      for (const handler of [...(byName.get(name) ?? [])]) (handler as ConnectionStateHandler)()
    },
    /** Deliver one card action; returns the last handler's response. */
    async emitCardAction(evt: CardActionEvent): Promise<CardActionResponse | undefined> {
      let response: CardActionResponse | undefined
      for (const handler of [...cardHandlers]) {
        const result = await handler(evt)
        if (result !== undefined) response = result
      }
      return response
    },
  }
}

/** The sender `fakeMessage()` speaks as, and the default clicker in tests. */
export const SENDER_ID = 'ou_sender_1'

/** A complete inbound message with overridable fields. */
export function fakeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_in_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    senderId: 'ou_sender_1',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
    ...overrides,
  }
}

/** One agent creation recorded by the fake registry. */
export interface CreatedAgent {
  sessionId: string
  meta: { cwd?: string; agentPreset?: string } | undefined
  agentOptions: HostAgentOptions | undefined
  /** Whether creation ran a composition `setup` callback, and with a scoped context. */
  setupRan: boolean
  /** Deny reason this agent's composed guards give one tool name, if any. */
  denyReason: (name: string) => string | undefined
  /** Prompt sections setup registered on this agent's scope. */
  promptSections: { name: string; order: number; text: string }[]
  agent: {
    id: string
    session: { id: string }
    followup: ReturnType<typeof vi.fn<(m: HostUserMessage) => void>>
    cancel: ReturnType<typeof vi.fn<(cause: string) => void>>
  }
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

/** An in-memory `agents` registry capturing every agent it produced. */
export function createFakeAgents(extraServices: { jobs?: object } = {}) {
  const created: CreatedAgent[] = []
  /** Session ids a test declared stored, so `resume` loads them instead of rejecting. */
  const resumable = new Set<string>()
  /** Agents a test declared already live under another owner, so `get` adopts one. */
  const live = new Map<string, CreatedAgent['agent']>()
  const resumed: string[] = []
  const looked: string[] = []

  const makeAgent = (sessionId: string): CreatedAgent['agent'] => ({
    id: sessionId,
    session: { id: sessionId },
    followup: vi.fn<(m: HostUserMessage) => void>(),
    cancel: vi.fn<(cause: string) => void>(),
  })

  /**
   * Run one composition the way the real factory does: on a scoped context
   * carrying the per-agent tools and prompt services, awaited BEFORE the agent
   * is published, so a rejection surfaces to the caller and yields no agent.
   */
  const compose = async (setup?: (agentCtx: Context) => Promise<void>) => {
    const guards: ((execution: { name: string }) => string | undefined)[] = []
    const sections: { name: string; order: number; text: string }[] = []
    if (setup !== undefined) {
      const agentCtx = new Context()
      if (extraServices.jobs !== undefined) agentCtx.provide('jobs', extraServices.jobs)
      agentCtx.provide('tools', { guard: (g: (e: { name: string }) => string | undefined) => {
        guards.push(g)
        return () => { guards.splice(guards.indexOf(g), 1) }
      } })
      agentCtx.provide('systemPrompt', { section: (s: { name: string; order: number; text: string }) => {
        sections.push(s)
        return () => undefined
      } })
      await setup(agentCtx)
    }
    return {
      setupRan: setup !== undefined,
      /** Deny reason the composed guards give a tool, or undefined when allowed. */
      denyReason: (name: string) => guards.map(g => g({ name })).find(r => r !== undefined),
      promptSections: sections,
    }
  }

  const service = {
    /** The live agent already published on this id, as the real registry reports it. */
    get(sessionId: string) {
      looked.push(sessionId)
      return live.get(sessionId)
    },
    /**
     * The real registry rejects when nothing is stored under the id — that
     * rejection is this channel's only existence probe. A resumed agent carries
     * no `meta`: the stored session header already holds its cwd and preset.
     */
    async resume(options: {
      readonly resumeSessionId: string
      readonly agentOptions?: HostAgentOptions
      readonly setup?: (agentCtx: Context) => Promise<void>
    }) {
      resumed.push(options.resumeSessionId)
      if (!resumable.has(options.resumeSessionId)) {
        throw new Error(`no stored session for ${options.resumeSessionId} (fake)`)
      }
      const agent = makeAgent(options.resumeSessionId)
      live.set(options.resumeSessionId, agent)
      const record: CreatedAgent = {
        sessionId: options.resumeSessionId,
        meta: undefined,
        agentOptions: options.agentOptions,
        ...await compose(options.setup),
        agent,
        dispose: vi.fn<() => Promise<void>>(async () => {}),
      }
      created.push(record)
      return { agent, dispose: record.dispose }
    },
    async create(options: {
      readonly sessionId: string
      readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
      readonly agentOptions?: HostAgentOptions
      readonly setup?: (agentCtx: Context) => Promise<void>
    }) {
      const agent = makeAgent(options.sessionId)
      live.set(options.sessionId, agent)
      const record: CreatedAgent = {
        sessionId: options.sessionId,
        meta: options.meta === undefined ? undefined : { ...options.meta },
        agentOptions: options.agentOptions,
        ...await compose(options.setup),
        agent,
        dispose: vi.fn<() => Promise<void>>(async () => {}),
      }
      created.push(record)
      return { agent, dispose: record.dispose }
    },
  }
  return {
    created,
    service,
    /** Ids `resume` loads, and agents `get` adopts. */
    resumable,
    live,
    /** Ids handed to `resume` and to `get`, in call order. */
    resumed,
    looked,
    /** Declare one id already live under another owner. */
    declareLive(sessionId: string): CreatedAgent['agent'] {
      const agent = makeAgent(sessionId)
      live.set(sessionId, agent)
      return agent
    },
  }
}

/** One line the plugin logged, at the level it chose. */
export interface LoggedLine {
  type: 'error' | 'info' | 'warn' | 'debug'
  /** The format string and its parameters, joined; assert with `toContain`. */
  text: string
}

/** Plugin config overrides; an explicit `undefined` removes a harness default. */
type ConfigOverrides = { [K in keyof plugin.Config]?: plugin.Config[K] | undefined }

/** Mount the production plugin over the fake port and fake `agents` registry. */
export async function mountChannel(
  config: ConfigOverrides = {},
  services: {
    defaultModel?: HostDefaultModel
    settings?: HostSettings
    registerApp?: RegisterAppPort
    presets?: HostAgentPresets
    /**
     * An answerer registered BEFORE the plugin, as a host row that mounts
     * during tree load is (the Web app's BFF claims every audited approval and
     * never delegates). Records whether it was ever consulted.
     */
    competingAnswerer?: { claims: { toolName: string }[] }
    /** The `tools` registry the bridge describes calls through. */
    tools?: object
    /** The `workspaceRegistry` chat sessions are accounted under. */
    workspaces?: object
    /** The `commands` runtime slash lines dispatch through. */
    commands?: object
    /** The `attachments` store chat images are committed to. */
    attachments?: object
    /** The `jobs` registry background tasks register with. */
    jobs?: object
    /**
     * The `goals` service stub (the bridge injects it). Defaults to an empty
     * view so autoResume reads no goal; tests with a goal pass a stub whose
     * `get`/`resume` record what the bridge does.
     */
    goals?: object
  } = {},
) {
  const ctx = new Context()
  const logs: LoggedLine[] = []
  // Cordis buffers log messages and prints nothing without an exporter, and its
  // default exporter level drops `debug`; this one keeps every level so a test
  // can tell an operator-console line from one deliberately kept off it.
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      logs.push({ type: message.type, text: (message.args as unknown[]).map(part => String(part)).join(' ') })
    },
  })
  const agents = createFakeAgents({ jobs: services.jobs })
  const competing = services.competingAnswerer
  if (competing !== undefined) {
    ctx.on('approval/request', (request) => {
      competing.claims.push({ toolName: request.toolName })
      // Claims the question without delegating, exactly like the BFF.
      return new Promise<HostApprovalOutcome>(() => {})
    })
  }
  ctx.provide('agents', agents.service)
  // The bridge injects `goals` (the dsh GoalService); the harness stubs it so
  // tree load passes the inject check and autoResume reads the test's view.
  ctx.provide('goals', services.goals ?? { get: () => undefined, resume: async () => {} })
  if (services.defaultModel !== undefined) ctx.provide('agentDefaultModel', services.defaultModel)
  if (services.settings !== undefined) ctx.provide('settings', services.settings)
  if (services.presets !== undefined) ctx.provide('agentPresets', services.presets)
  if (services.tools !== undefined) ctx.provide('tools', services.tools)
  if (services.workspaces !== undefined) ctx.provide('workspaceRegistry', services.workspaces)
  if (services.commands !== undefined) ctx.provide('commands', services.commands)
  if (services.attachments !== undefined) ctx.provide('attachments', services.attachments)
  if (services.jobs !== undefined) ctx.provide('jobs', services.jobs)
  const fake = createFakePort()
  const portConfigs: ChannelConfig[] = []
  const notices: string[] = []
  const originalCreatePort = internals.createPort
  const originalRegisterApp = internals.registerApp
  const originalNotify = internals.notify
  const portAuthorizations: {
    directSenders: string[]
    groups: string[]
    approvers: string[]
  }[] = []
  internals.createPort = (portConfig, authorization) => {
    portConfigs.push(portConfig)
    portAuthorizations.push({
      directSenders: [...authorization.directSenders],
      groups: [...authorization.groups],
      approvers: [...authorization.approvers],
    })
    return fake.port
  }
  internals.registerApp = services.registerApp
    ?? (() => Promise.reject(new Error('registerApp not faked for this test')))
  internals.notify = (line) => { notices.push(line) }
  // A re-issued QR code waits out the production floor, which a test must not.
  internals.reissueFloorMs = 0
  const merged = {
    appId: 'cli_test',
    appSecret: 'test-secret',
    provider: 'test-provider',
    model: 'test-model',
    // The first-contact guide is covered by its own spec; message-count
    // assertions elsewhere stay stable with it off.
    onboarding: false,
    ...config,
  } as plugin.Config
  const fiber = await ctx.plugin(plugin, merged)
  // Activation bootstraps asynchronously; hold until the bridge subscribed when
  // the mount alone is expected to reach a connected channel.
  if (merged.appId !== undefined && merged.appSecret !== undefined && services.settings === undefined) {
    await vi.waitFor(() => {
      if (fake.state.subscriptions !== INBOUND_SUBSCRIPTIONS) throw new Error('bridge not subscribed yet')
    })
  }
  return {
    ctx,
    fiber,
    fake,
    agents,
    portConfigs,
    portAuthorizations,
    notices,
    logs,
    async dispose(): Promise<void> {
      try {
        await fiber.dispose()
      } finally {
        internals.createPort = originalCreatePort
        internals.registerApp = originalRegisterApp
        internals.notify = originalNotify
        delete internals.reissueFloorMs
      }
    },
  }
}

/** An in-memory `agentPresets` roster recording every resolve and mount. */
export function createFakePresets(ids: string[] = ['default'], defaultId = ids[0]!) {
  const mounted: { id: string | undefined; scoped: boolean }[] = []
  const resolved: (string | undefined)[] = []
  const presets: HostAgentPresets = {
    async resolve(id) {
      resolved.push(id)
      const wanted = id ?? defaultId
      if (!ids.includes(wanted)) throw new Error(`agent-presets: unknown preset "${wanted}"`)
      return { id: wanted }
    },
    async mount(agentCtx, id) {
      mounted.push({ id, scoped: agentCtx !== undefined })
      return undefined
    },
    async standingKeyFor(id) {
      return `standing:${id ?? defaultId}`
    },
  }
  return { presets, mounted, resolved }
}

/** An in-memory `workspaceRegistry` recording lookups, creations, and attachments. */
export function createFakeWorkspaces(registered: Record<string, string> = {}) {
  const created: string[] = []
  const attached: { workspaceId: string; sessionId: string }[] = []
  const state = { failAttach: false }
  const entity = (path: string, id: string) => ({
    id,
    path,
    async attachSession(sessionId: string) {
      if (state.failAttach) throw new Error('cwd does not match the workspace path (fake)')
      attached.push({ workspaceId: id, sessionId })
    },
  })
  const service = {
    async resolveByPath(path: string) {
      const id = registered[path]
      return id === undefined ? undefined : entity(path, id)
    },
    async create(path: string) {
      created.push(path)
      const id = `ws_created_${created.length}`
      registered[path] = id
      return entity(path, id)
    },
  }
  return { service, created, attached, state }
}

/** An in-memory `attachments` store recording every committed image. */
export function createFakeAttachments(limits: Partial<HostImageLimits> = {}) {
  const saved: { mediaType: string; bytes: number; name?: string }[] = []
  const state = { failSave: false }
  const service: HostAttachments = {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 3,
      maxMessageImageBytes: 2_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...limits,
    },
    async saveImage(input) {
      if (state.failSave) throw new Error('store rejected the image (fake)')
      saved.push({
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        ...input.name === undefined ? {} : { name: input.name },
      })
      return {
        attachmentId: `att_${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 100,
        height: 50,
        ...input.name === undefined ? {} : { name: input.name },
      }
    },
  }
  return { service, saved, state }
}

/** An in-memory `commands` runtime recording every dispatched line. */
export function createFakeCommands(
  available: { name: string; description: string }[] = [{ name: 'clear', description: '开始新的对话' }],
  outcomes: Record<string, { kind: 'success'; text?: string } | { kind: 'error'; text: string }> = {},
) {
  const executed: string[] = []
  const service: HostCommands = {
    list: () => available,
    async execute(_agent, line, _signal) {
      executed.push(line)
      const name = commandName(line) ?? ''
      if (!available.some(c => c.name === name)) return undefined
      return { result: outcomes[name] ?? { kind: 'success', text: `ran ${name}` } }
    },
  }
  return { service, executed }
}

/** An in-memory `tools` registry that can describe calls and record guards. */
export function createFakeTools(
  presenters: Record<string, (args: unknown) => { title?: string } | undefined> = {},
) {
  const views: { name: string; scope: unknown }[] = []
  const service = {
    guard: () => () => undefined,
    get(name: string, scope?: unknown) {
      views.push({ name, scope })
      const presentCall = presenters[name]
      return presentCall === undefined ? undefined : { presentCall }
    },
  }
  return { service, views }
}

/** An in-memory `settings` service: one namespace layering base under `stored`. */
export function createFakeSettings(stored: Record<string, unknown> = {}) {
  const updates: object[] = []
  const registered: { ns: string; base: unknown }[] = []
  const settings: HostSettings = {
    register(ns, _schema, options) {
      registered.push({ ns, base: options?.base })
      return {
        get: () => ({ ...(options?.base as Record<string, unknown>), ...stored }),
        update: async (patch) => {
          updates.push(patch)
          Object.assign(stored, patch)
        },
      }
    },
  }
  return { settings, updates, registered }
}

/** Extract the approval correlation payload from a sent card's buttons. */
export function approvalValueFromCard(card: object): { kind: string; id: string; decision: string }[] {
  const elements = (card as { elements: { tag: string; actions?: { value: { kind: string; id: string; decision: string } }[] }[] }).elements
  const action = elements.find((element) => element.tag === 'action')
  return (action?.actions ?? []).map((button) => button.value)
}
