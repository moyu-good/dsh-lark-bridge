/**
 * Per-session reasoning effort: `/think`.
 *
 * The effort a turn runs at is not something the bridge can set on the agent.
 * The loop resolves it as `options.reasoningEffort ?? persisted header`, and
 * the options come from the deployment's default at creation time — so
 * rewriting that default, which is all `/model` can do, reaches the NEXT
 * session and leaves every running one where it was. A chat needs two things a
 * command can give it: a way to READ what the next request will actually send,
 * and a way to CHANGE it without opening a new session.
 *
 * The change rides the host's own `agent/request` waterfall — the same seam the
 * web UI's model picker uses (`installModelSelection`): the resolved envelope
 * is rewritten on its way to the adapter, so a switch lands on the next step
 * rather than the next session. The choice is recorded as a durable
 * `model/selection` event, the exact event shape that surface writes, so a
 * resumed session and a web-UI client read the same fact instead of two.
 * @module dsh-lark-bridge/think
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandOutcome } from './commands.ts'
import { THINK_COMMAND } from './commands.ts'
import type { HostAgent, HostDefaultModel, HostLlm, HostSession } from './host.ts'

/**
 * Levels offered when no adapter publishes its own.
 *
 * These are the levels the DeepSeek adapters ship (off/low/high/max). The list
 * is a fallback, not the truth: a route that describes itself wins, because
 * offering a level the provider rejects turns a settings command into a failed
 * turn.
 */
export const FALLBACK_EFFORTS: readonly string[] = ['off', 'low', 'high', 'max']

/** One selectable level. */
export interface EffortLevel {
  readonly id: string
  /** Adapter-provided display name, when it has one. */
  readonly name?: string
}

/** The levels one route accepts, and where that list came from. */
export interface EffortCatalog {
  readonly levels: readonly EffortLevel[]
  /** The adapter's own default, materialized when a request omits an effort. */
  readonly defaultEffort?: string
  /** `adapter` when the route described itself, `fallback` otherwise. */
  readonly source: 'adapter' | 'fallback'
}

/** What one `/think` line asked for. */
export type ThinkIntent =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly effort: string }
  | { readonly kind: 'reset' }

/** A recorded model selection, as the session log stores it. */
export interface ModelSelection {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** The parts of one resolved request envelope the override touches. */
export interface RequestEnvelope {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The `agent/request` waterfall payload (subset). */
interface AgentRequestPayload {
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/**
 * Parse one `/think` line.
 * @param line - the trimmed command line, leading slash included.
 * @returns what the line asked for; an empty argument means "show".
 */
export function parseThinkLine(line: string): ThinkIntent {
  // Built per call rather than at module scope on purpose: the command name is
  // imported from `commands.ts`, which imports this module back, and reading it
  // during module evaluation would hit the binding before it initialises.
  const match = new RegExp(`^/${THINK_COMMAND}(?:\\s+(.*))?$`, 'i').exec(line.trim())
  const arg = (match?.[1] ?? '').trim().toLowerCase()
  if (arg === '') return { kind: 'show' }
  // `auto` is what the web picker calls "follow the model"; `default` is the
  // word a reader reaches for. Both mean the same thing here.
  if (arg === 'reset' || arg === 'default' || arg === 'auto') return { kind: 'reset' }
  return { kind: 'set', effort: arg }
}

/**
 * Read the last model selection one session recorded.
 *
 * The scan is a plain array walk — the host serves `eventAt` straight out of
 * the loaded log — so it costs nothing measurable on the path that opens a
 * session, and it keeps the choice in the session instead of in a second store
 * that could drift from it.
 * @param session - the session whose log to scan.
 * @returns the newest recorded selection, or undefined when none exists.
 */
export function lastSelection(session: HostSession): ModelSelection | undefined {
  let found: ModelSelection | undefined
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq) as { readonly type?: string; readonly data?: unknown } | undefined
    if (event?.type !== 'model/selection') continue
    const data = event.data as ModelSelection | undefined
    if (data !== undefined && typeof data === 'object') found = data
  }
  return found
}

/**
 * Resolve the levels one route accepts.
 * @param llm - the llm runtime, when composed.
 * @param provider - the route's provider.
 * @param model - the route's model.
 * @returns the adapter's own list when it has one, the fallback otherwise.
 */
export async function effortCatalog(
  llm: HostLlm | undefined,
  provider: string | undefined,
  model: string | undefined,
): Promise<EffortCatalog> {
  if (llm !== undefined && provider !== undefined && provider !== '' && model !== undefined && model !== '') {
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const reasoning = info.reasoning
      if (reasoning !== undefined && reasoning.efforts.length > 0) {
        return {
          levels: reasoning.efforts.map(effort => ({
            id: effort.id,
            ...effort.name === undefined ? {} : { name: effort.name },
          })),
          ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
          source: 'adapter',
        }
      }
    } catch {
      // A route that cannot describe itself is not a route without levels:
      // falling through to the bridge's list beats claiming "no levels".
    }
  }
  return { levels: FALLBACK_EFFORTS.map(id => ({ id })), source: 'fallback' }
}

/**
 * The live per-session effort choices, and the request hook that applies them.
 *
 * One instance serves the whole bridge: every agent's `setup` installs a hook
 * that reads this table by session id, so a choice made in a chat applies to
 * that chat's agent and to no other.
 */
export class EffortOverrides {
  private readonly bySession = new Map<string, string>()

  /** Advertised levels per route, so the capability lookup runs once per model. */
  private readonly accepted = new Map<string, ReadonlySet<string>>()

  private readonly ctx: Context

  /**
   * @param ctx - the bridge's context, used to reach the llm runtime lazily —
   *   a profile that mounts the llm row later still gets a correct answer.
   */
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * The override in force for one session.
   * @param sessionId - the session to look up.
   * @returns the chosen effort, or undefined when the session follows the default.
   */
  get(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)
  }

  /**
   * Re-read one session's choice from its own log.
   *
   * Called when an agent is composed: a resumed session must come back at the
   * effort its human chose, not at the deployment default.
   * @param session - the session being opened.
   */
  restore(session: HostSession): void {
    const recorded = lastSelection(session)
    if (recorded === undefined) return
    if (recorded.reasoningEffort === undefined) this.bySession.delete(session.id)
    else this.bySession.set(session.id, recorded.reasoningEffort)
  }

  /**
   * Record one session's choice, durably when the host can append.
   * @param session - the session the choice belongs to.
   * @param selection - the provider/model it applies to, plus the effort
   *   (`undefined` clears the override and returns the session to the default).
   */
  set(session: HostSession, selection: ModelSelection): void {
    if (selection.reasoningEffort === undefined) this.bySession.delete(session.id)
    else this.bySession.set(session.id, selection.reasoningEffort)
    // Best effort by design: a host without `append` still honours the choice
    // for this process, and the reply says which of the two happened.
    session.append?.('model/selection', selection)
  }

  /**
   * Install the request-side override on one agent's scope.
   * @param agentCtx - the agent's scoped context.
   * @param sessionId - the session this agent drives.
   */
  install(agentCtx: Context, sessionId: string): void {
    const override = async (
      _payload: AgentRequestPayload,
      next: () => Promise<RequestEnvelope>,
    ): Promise<RequestEnvelope> => {
      const resolved = await next()
      const wanted = this.bySession.get(sessionId)
      if (wanted === undefined) return resolved
      // A stale choice must not break every turn: after `/model` moves the
      // session to a route that does not offer it, the request goes out as the
      // route's own default instead of failing validation.
      if (!(await this.accepts(resolved.provider, resolved.model, wanted))) return resolved
      return { ...resolved, reasoningEffort: wanted }
    }
    // `agent/request` is a host event whose declaration this package does not
    // import — the bridge keeps its host contract as structural copies so the
    // package builds self-contained — so the context's event table cannot name
    // it. The payload and resolver shapes are mirrored above from the loop's
    // own dispatch; the cast is that mirror, not a guess about behaviour.
    const scope = agentCtx as unknown as {
      on(
        name: string,
        listener: (payload: AgentRequestPayload, next: () => Promise<RequestEnvelope>) => Promise<RequestEnvelope>,
      ): () => void
    }
    scope.on('agent/request', override)
  }

  /**
   * Whether one route advertises an effort.
   *
   * Unknown routes pass: a provider that publishes no reasoning metadata may
   * still accept the field, and refusing on silence would make the command
   * useless on exactly the deployments that need it.
   */
  private async accepts(provider: string, model: string, effort: string): Promise<boolean> {
    const key = `${provider}/${model}`
    const cached = this.accepted.get(key)
    if (cached !== undefined) return cached.has(effort)
    const llm = this.ctx.get('llm') as HostLlm | undefined
    if (llm === undefined) return true
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info.reasoning?.efforts
      if (efforts === undefined || efforts.length === 0) return true
      const ids = new Set(efforts.map(level => level.id))
      this.accepted.set(key, ids)
      return ids.has(effort)
    } catch {
      return true
    }
  }
}

/** Render the levels one catalog offers, in the order the adapter gave them. */
function levelList(catalog: EffortCatalog): string {
  return catalog.levels.map(level => `\`${level.id}\``).join(' · ')
}

/**
 * Handle `/think [level|reset]`: show or change this session's reasoning effort.
 * @param line - the trimmed command line.
 * @param agent - the chat's agent (owns the session being changed).
 * @param overrides - the live override table, when the bridge wired one.
 * @param llm - the llm runtime, when composed (for the route's own levels).
 * @param defaultModel - the deployment default, for the "follow the default" line.
 * @returns the reply for the chat.
 */
export async function runThinkCommand(
  line: string,
  agent: HostAgent,
  overrides: EffortOverrides | undefined,
  llm: HostLlm | undefined,
  defaultModel: HostDefaultModel | undefined,
): Promise<CommandOutcome> {
  if (overrides === undefined) {
    return { reply: '⚠️ 本部署没有启用思考强度控制，`/think` 不可用。', resolved: false }
  }
  const session = agent.session
  const intent = parseThinkLine(line)
  const header = session.requestHeader?.()?.config
  const configured = defaultModel?.currentSelection()
  const provider = header?.provider ?? configured?.provider
  const model = header?.model ?? configured?.model
  const catalog = await effortCatalog(llm, provider, model)
  const current = overrides.get(session.id)

  if (intent.kind === 'show') {
    // Two facts, kept apart on purpose: what the next request will send, and
    // what the deployment would send if this session had no choice of its own.
    const effective = current ?? header?.reasoningEffort
    const origin = current !== undefined
      ? '本会话设置'
      : header?.reasoningEffort === undefined
        ? '未显式设置，由模型决定'
        : '上一次请求实际使用'
    const fallback = configured?.reasoningEffort
    const lines = [
      '**思考强度**（本会话）',
      `当前：${effective === undefined ? '未设置' : `\`${effective}\``}（${origin}）`,
      `可选：${levelList(catalog)}${catalog.source === 'fallback' ? '（模型未声明，按 DeepSeek 通用档位）' : ''}`,
      `部署默认：${fallback === undefined ? '未设置' : `\`${fallback}\``}`,
      '',
      `切换：\`/${THINK_COMMAND} <档位>\` · 回到默认：\`/${THINK_COMMAND} reset\``,
      '改动对下一步请求即生效，不用 `/new`。',
    ]
    return { reply: lines.join('\n'), resolved: true }
  }

  const route = { provider, model }
  if (route.provider === undefined || route.provider === '' || route.model === undefined || route.model === '') {
    return { reply: '⚠️ 还不知道本会话用哪个模型，等这轮请求跑完再试 `/think`。', resolved: false }
  }

  if (intent.kind === 'reset') {
    overrides.set(session, { provider: route.provider, model: route.model })
    const back = configured?.reasoningEffort
    return {
      reply: `✅ 已回到部署默认${back === undefined ? '（未设置，由模型决定）' : `（\`${back}\`）`}，下一步请求生效。`,
      resolved: true,
    }
  }

  const known = catalog.levels.some(level => level.id === intent.effort)
  if (!known) {
    return {
      reply: `⚠️ 没有 \`${intent.effort}\` 这一档。\n可选：${levelList(catalog)}`,
      resolved: false,
    }
  }
  overrides.set(session, { provider: route.provider, model: route.model, reasoningEffort: intent.effort })
  return {
    reply: `✅ 思考强度已设为 \`${intent.effort}\`，下一步请求即生效（不用 \`/new\`）。回到默认：\`/${THINK_COMMAND} reset\`。`,
    resolved: true,
  }
}
