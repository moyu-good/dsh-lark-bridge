/**
 * Native Feishu capabilities as agent-callable tools.
 *
 * The bridge already renders the agent TO the human; this module lets the
 * agent act on Feishu itself — proactive messages into the current (or any
 * known) chat, and the app's own cloud-drive space as a durable scratchpad.
 * Both ride capabilities the channel already owns: outbound transport for
 * messages, the FeishuCloud client (built for fleet arbitration/migration)
 * for the drive. Tools follow the `send_file` factory pattern: plain
 * definition objects, the outcome in the result, never a throw across the
 * tool boundary.
 * @module dsh-lark-bridge/feishu-tools
 */

import type { OutboundPort } from './outbound.ts'
import { FeishuCloud } from './sync/feishu-cloud.ts'
import type { FeishuCredentials, FetchImpl } from './sync/feishu-cloud.ts'

/** Tool names, exported for tests and deny-list references. */
export const FEISHU_NOTIFY_TOOL = 'feishu_notify'
export const FEISHU_DRIVE_WRITE_TOOL = 'feishu_drive_write'
export const FEISHU_DRIVE_READ_TOOL = 'feishu_drive_read'
export const FEISHU_DRIVE_LIST_TOOL = 'feishu_drive_list'

/** Capabilities the bridge injects at registration time. */
export interface FeishuToolDeps {
  /** Replay-wrapped outbound transport (queued across connection gaps). */
  readonly port: OutboundPort
  /** Session id → chat id, so `feishu_notify` defaults to the current chat. */
  readonly chatOfSession: (sessionId: string) => string | undefined
  /** Credentials for the drive tools; absent → those tools explain why. */
  readonly credentials: FeishuCredentials | undefined
  /** HTTP seam for the drive client; injectable for tests. */
  readonly fetchImpl?: FetchImpl | undefined
}

interface NotifyArgs {
  readonly text?: unknown
  readonly chat_id?: unknown
}

interface NotifyResult {
  readonly ok: boolean
  readonly chat_id?: string
  readonly error?: string
}

interface DriveNameArgs {
  readonly name?: unknown
}

interface DriveWriteArgs {
  readonly name?: unknown
  readonly content?: unknown
}

interface DriveResult {
  readonly ok: boolean
  readonly name?: string
  readonly content?: string | null
  readonly files?: readonly { name: string; modifiedMs: number }[]
  readonly error?: string
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The four definitions. `exec.agent.session.id` names the chat for
 * `feishu_notify` the same way `send_file` resolves its delivery target.
 */
export function createFeishuTools(deps: FeishuToolDeps): object[] {
  const resolveChat = (exec: unknown, explicit: unknown): string | undefined => {
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
    const sessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
    return sessionId === undefined ? undefined : deps.chatOfSession(sessionId)
  }

  const cloud = (): FeishuCloud | undefined => {
    if (deps.credentials === undefined) return undefined
    return new FeishuCloud(deps.credentials, deps.fetchImpl)
  }

  return [
    {
      name: FEISHU_NOTIFY_TOOL,
      description:
        'Send a message to a Feishu chat through the bridge transport — including a chat '
        + 'DIFFERENT from the one this turn runs in. Use it for proactive pings the human '
        + 'should see now: a long task hit a milestone, a scheduled job finished, a '
        + 'background subagent needs attention. Without chat_id it posts into the CURRENT '
        + 'chat; the text is Feishu markdown.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message body, Feishu markdown (post text)' },
          chat_id: { type: 'string', description: 'Target chat id; omit to send into the current chat' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            chat_id: { type: 'string' },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: NotifyResult): object[] => [
          { type: 'text', text: value.ok ? `已发送到聊天 \`${value.chat_id ?? '?'}\`。` : `发送失败：${value.error ?? '未知错误'}` },
        ],
      },
      async execute(args: unknown, exec: unknown): Promise<NotifyResult> {
        const parsed = args as NotifyArgs
        const text = asText(parsed.text)
        if (text.trim() === '') return { ok: false, error: 'text 不能为空' }
        const chatId = resolveChat(exec, parsed.chat_id)
        if (chatId === undefined) return { ok: false, error: '无法确定目标聊天：当前会话未绑定聊天，且未传 chat_id' }
        try {
          await deps.port.send(chatId, { markdown: text })
          return { ok: true, chat_id: chatId }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    {
      name: FEISHU_DRIVE_WRITE_TOOL,
      description:
        'Write (or overwrite) a text file in the Feishu app\'s own cloud-drive space — a '
        + 'durable spot reachable from any device with this Feishu app, independent of the '
        + 'workspace filesystem. Use it for handoff notes, fleet state, or artifacts the '
        + 'human wants to open inside Feishu.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name in the app drive space (e.g. notes.md)' },
          content: { type: 'string', description: 'Full text content to store' },
        },
        required: ['name', 'content'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            name: { type: 'string' },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: DriveResult): object[] => [
          { type: 'text', text: value.ok ? `已写入飞书云空间：\`${value.name ?? '?'}\`。` : `写入失败：${value.error ?? '未知错误'}` },
        ],
      },
      async execute(args: unknown): Promise<DriveResult> {
        const parsed = args as DriveWriteArgs
        const name = asText(parsed.name)
        const content = typeof parsed.content === 'string' ? parsed.content : ''
        if (name.trim() === '') return { ok: false, error: 'name 不能为空' }
        const client = cloud()
        if (client === undefined) return { ok: false, error: '本端未配置飞书凭证，云空间不可用' }
        try {
          await client.putJson(name, content)
          return { ok: true, name }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    {
      name: FEISHU_DRIVE_READ_TOOL,
      description:
        'Read one text file back from the Feishu app\'s cloud-drive space (the files '
        + '`feishu_drive_write` stores). Returns null content when the name is unknown.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name in the app drive space' },
        },
        required: ['name'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            name: { type: 'string' },
            content: { type: ['string', 'null'] },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: DriveResult): object[] => [
          { type: 'text', text: value.ok ? `已读取 \`${value.name ?? '?'}\`（${value.content === null || value.content === undefined ? 0 : value.content.length} 字符）。` : `读取失败：${value.error ?? '未知错误'}` },
        ],
      },
      async execute(args: unknown): Promise<DriveResult> {
        const parsed = args as DriveNameArgs
        const name = asText(parsed.name)
        if (name.trim() === '') return { ok: false, error: 'name 不能为空' }
        const client = cloud()
        if (client === undefined) return { ok: false, error: '本端未配置飞书凭证，云空间不可用' }
        try {
          const content = await client.getJson(name)
          return { ok: true, name, content }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    {
      name: FEISHU_DRIVE_LIST_TOOL,
      description:
        'List the files currently stored in the Feishu app\'s cloud-drive space.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, modifiedMs: { type: 'number' } } } },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: DriveResult): object[] => [
          { type: 'text', text: value.ok ? `云空间共 ${value.files?.length ?? 0} 个文件。` : `列出失败：${value.error ?? '未知错误'}` },
        ],
      },
      async execute(): Promise<DriveResult> {
        const client = cloud()
        if (client === undefined) return { ok: false, error: '本端未配置飞书凭证，云空间不可用' }
        try {
          const files = await client.list()
          return { ok: true, files: files.map((file) => ({ name: file.name, modifiedMs: file.modifiedMs })) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
  ]
}

/** The prompt section text for the tools above (composeChatAgent registers it). */
export function feishuToolsPromptSection(): string {
  return 'Channel-native Feishu tools are registered for you: `feishu_notify` posts a message '
    + 'into this chat (or any chat_id you pass) outside your normal reply flow — use it for '
    + 'proactive pings from long or scheduled work, not as a substitute for your reply. '
    + '`feishu_drive_write` / `feishu_drive_read` / `feishu_drive_list` store and fetch text '
    + 'files in the Feishu app\'s own cloud space, which survives across devices and '
    + 'machines — use them for handoff notes and state that must outlive this workspace.'
}
