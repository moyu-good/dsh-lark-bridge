/**
 * 会话尾部预览：`/resume` 列表里「上次做到哪」那一行。
 *
 * 切回一个历史会话时，飞书聊天窗口看不到那段对话——旧会话的消息从没在这个
 * 群里出现过。只回一句「已切到会话 xxx」等于把人扔进黑盒：他不知道这是哪个
 * 会话、上次停在哪、还有什么事没完。所以预览要给出**最后一句你说的话**和
 * **最后一句我回的话**，这两句比任何摘要都好认。
 *
 * 数据全部来自会话日志本身，不触发模型推理：切会话是低频操作，但让它烧一次
 * token 既慢又会往会话里写一条「总结」，污染真实历史。
 *
 * 日志格式是「一个 zstd 帧压多行 JSONL、帧与帧首尾相接」。要读尾部就得先扫
 * 帧边界（只解析帧头与块头，不解压），再从后往前解压到找齐两条消息为止。
 * 实测 9.5 MB 的会话扫帧 2 ms、提取 1 ms。
 *
 * @module dsh-lark-bridge/session-preview
 */

import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { rotationHome } from './session-rotation.ts'

const decompress = promisify(zstdDecompress)

/** zstd 帧魔数（文件里按小端存放）。 */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * 超过这个大小的会话不预览。
 *
 * 读整个文件是这里最省事的做法，而一个上百 MB 的会话会把「列表」变成一次
 * 磁盘冲击。超限时只是少了预览，时间和目录照常显示。
 */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024

/** 一次会话尾部预览。 */
export interface SessionPreview {
  /** 最后一句真人说的话，已剥掉发送者信封并压平。 */
  readonly lastUser?: string
  /** 最后一句带正文的回复，已压平。 */
  readonly lastAssistant?: string
  /** 最后一个事件的时间（epoch 毫秒）。 */
  readonly lastActivity?: number
  /** 第一个事件的时间（epoch 毫秒），用来算这段对话跨了多久。 */
  readonly startedAt?: number
  /**
   * 真人发了多少次消息。
   *
   * 之所以不直接报 `turn`：turn 的推进不只有人说话，被中断、被压缩、被
   * 目标续跑都会开新的 turn，所以 turn 数会明显多于「你说了几句话」
   * （实测有 54 个 turn 里只有 39 条真人消息的会话）。
   */
  readonly userMessages?: number
  /** 有多少轮 turn——即这段对话进行过多少次来回。 */
  readonly turns?: number
  /** 工具调用次数，代表这轮干了多少活。 */
  readonly toolCalls?: number
  /** 日志占用字节数。 */
  readonly bytes?: number
}

/** {@link readSessionPreview} 的可调项。 */
export interface PreviewOptions {
  /** 最多从尾部往前解压多少帧，默认 400。 */
  readonly maxFrames?: number
  /** 每条预览最多保留多少字符，默认 120。 */
  readonly maxChars?: number
}

/** 一个 zstd 帧在缓冲区里的 `[start, end)` 偏移。 */
interface FrameSpan {
  readonly start: number
  readonly end: number
}

/** 事件里我们会读到的部分；其余字段忽略。 */
interface SessionEvent {
  readonly type?: string
  readonly time?: number
  readonly data?: {
    readonly content?: readonly ContentPart[]
    readonly source?: { readonly kind?: string }
    readonly message?: { readonly content?: readonly ContentPart[] }
    readonly turn?: number
  }
}

/** 消息内容里的一种片段。 */
interface ContentPart {
  readonly type?: string
  readonly text?: string
}

/**
 * 扫出缓冲区里每个 zstd 帧的边界。
 *
 * 只读帧头与块头，跳过块数据，所以几 MB 的文件是毫秒级。首帧从偏移 0 开始
 * 之后帧首尾相接，但压缩数据里可能偶然出现魔数，所以对不上魔数时逐字节
 * 前移重新对齐，而不是直接放弃。
 * @param buffer - 整个会话日志文件。
 * @returns 帧边界，按出现顺序。
 */
export function scanFrames(buffer: Buffer): FrameSpan[] {
  const frames: FrameSpan[] = []
  let i = 0
  while (i + 4 <= buffer.length) {
    if (buffer.readUInt32LE(i) !== ZSTD_MAGIC) {
      i += 1
      continue
    }
    const start = i
    i += 4
    if (i >= buffer.length) break
    const descriptor = buffer[i]!
    i += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (singleSegment === 0) i += 1 // Window_Descriptor
    i += [0, 1, 2, 4][dictFlag] ?? 0
    i += fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : ([0, 2, 4, 8][fcsFlag] ?? 0)
    let last = false
    while (!last && i + 3 <= buffer.length) {
      const header = buffer[i]! | (buffer[i + 1]! << 8) | (buffer[i + 2]! << 16)
      i += 3
      last = (header & 1) === 1
      const blockType = (header >> 1) & 3
      const blockSize = header >>> 3
      // RLE 块的数据只有 1 字节，其余块按声明长度跳过。
      i += blockType === 1 ? 1 : blockSize
    }
    if (checksum === 1) i += 4
    if (i > buffer.length) break
    frames.push({ start, end: i })
  }
  return frames
}

/**
 * 会话 id 在磁盘上的目录名：冒号被写成 `~003A`。
 *
 * 目录名是文件系统事实，不跟着界面上的脱敏走；用 id 直接推导比读目录内容快，
 * 也不会因为某个会话的 header 读不出来就找不到文件。
 * @param sessionId - 会话 id。
 * @returns 目录名。
 */
export function sessionDirName(sessionId: string): string {
  return sessionId.replace(/:/g, '~003A')
}

/**
 * 找到某个会话的日志文件。
 *
 * 会话按「工作目录编码 / 会话 id 编码」两层存放，工作目录那一层无法从 id
 * 推导（同一个 id 可能出现在换过目录的对话里），所以逐层探一遍。目录数在
 * 百级，每次 stat 一次，几毫秒。
 * @param sessionId - 会话 id。
 * @param home - harness home 覆盖，测试用。
 * @returns 日志文件的绝对路径，找不到时为 undefined。
 */
export async function findSessionFile(sessionId: string, home?: string): Promise<string | undefined> {
  const root = path.join(rotationHome(home), 'sessions')
  const name = sessionDirName(sessionId)
  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(root)
  } catch {
    return undefined
  }
  for (const cwdDir of cwdDirs) {
    const file = path.join(root, cwdDir, name, 'session.v4.jsonl.zstd')
    try {
      const info = await stat(file)
      if (info.isFile()) return file
    } catch {
      // 这个工作目录下没有它，继续找下一个。
    }
  }
  return undefined
}

/**
 * 剥掉消息开头的发送者信封。
 *
 * 桥写进会话的用户消息带前缀，两种形状：`发送者: [时间 · …]` 独占第一行，
 * 正文从第二行开始；或者 `发送者: 正文` 挤在一行。两种都要剥，否则预览
 * 显示的是 `{{PERSON_…}}: [2026-11-04 15:07:36 …]` 这种没人想看的东西。
 * 正文自己以「注意: …」开头的不能被误剥，所以冒号前含中文就不动。
 * @param text - 原始消息文本。
 * @returns 正文。
 */
export function stripEnvelope(text: string): string {
  const firstBreak = text.indexOf('\n')
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak)
  // `发送者: [时间 · 距上一轮 N 分钟前]` 整行都是信封。
  if (firstBreak !== -1 && /^\S.{0,80}:\s*\[[^\]]*\]\s*$/.test(firstLine)) {
    return text.slice(firstBreak + 1).trim()
  }
  const inline = /^(\S{1,80}):\s+(.+)$/s.exec(text)
  if (inline !== null && !/[\u4e00-\u9fff]/.test(inline[1]!)) return inline[2]!.trim()
  return text.trim()
}

/**
 * 把一次预览的规模压成一行，放在会话标题下面。
 *
 * 只报轮次是不够的：一个 54 轮的会话可能因为跑了三千多次工具调用而变成
 * 几 MB（实测如此），也可能只是几 KB 的闲聊。反过来，几 MB 的会话也可能
 * 只有 1 轮。所以三样都得给——说了几轮、你说了几句、干了多少活——再加一个
 * 「💬/📄」标记，让人一眼分出「那个很长的会话」。
 * @param preview - 一次会话预览。
 * @returns 形如「54 轮 · 你说了 39 句 · 3889 次工具调用 · 7.9 MB」。
 */
export function describeScale(preview: SessionPreview): string {
  const parts: string[] = []
  if (preview.turns !== undefined && preview.turns > 0) parts.push(`${preview.turns} 轮`)
  if (preview.userMessages !== undefined && preview.userMessages > 0) parts.push(`你说了 ${preview.userMessages} 句`)
  if (preview.toolCalls !== undefined && preview.toolCalls > 0) parts.push(`${preview.toolCalls} 次工具调用`)
  if (preview.bytes !== undefined && preview.bytes > 0) parts.push(formatBytes(preview.bytes))
  return parts.join(' · ')
}

/**
 * 把字节数写成习惯的单位。
 * @param bytes - 字节数。
 * @returns 形如 `7.9 MB`；不足 1 KB 用字节。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 一段对话持续了多久，写成「3 天」「5 小时」这种。
 *
 * 跨度和规模是两回事：一个连聊三天的会话可能只有 20 轮，但它显然比
 * 一个两小时里说了 60 句的会话更「长」。两者一起看才判断得准。
 * @param preview - 一次会话预览。
 * @returns 形如 `3.9 天`；拿不到起止时间时为空串。
 */
export function describeSpan(preview: SessionPreview): string {
  if (preview.startedAt === undefined || preview.lastActivity === undefined) return ''
  const ms = preview.lastActivity - preview.startedAt
  if (!(ms > 0)) return ''
  const hours = ms / 3_600_000
  if (hours < 1) return '不到 1 小时'
  if (hours < 24) return `${Math.round(hours)} 小时`
  return `${(hours / 24).toFixed(1)} 天`
}

/**
 * 把一段消息压成一行预览。
 * @param text - 原始文本。
 * @param maxChars - 最多保留多少字符。
 * @returns 压平并截断后的文本。
 */
export function condense(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars)}…`
}

/**
 * 从一条消息的 content 里拼出正文。
 * @param parts - 消息内容片段。
 * @returns 文本片段拼起来的结果；没有文本片段时为空串。
 */
function textOf(parts: readonly ContentPart[] | undefined): string {
  if (parts === undefined) return ''
  return parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text!)
    .join('\n')
    .trim()
}

/**
 * 读一个会话的尾部预览。
 *
 * 从最后一帧往前解压，直到拿齐「最后一句你说的话」和「最后一句我回的话」。
 * 读不到（文件不在、超限、损坏、格式不认识）都返回 undefined —— 预览是
 * 锦上添花，不能让它把 `/resume` 弄挂。
 * @param file - 会话日志文件路径。
 * @param options - 帧数与字符数上限。
 * @returns 预览，或 undefined。
 */
export async function readSessionPreview(file: string, options: PreviewOptions = {}): Promise<SessionPreview | undefined> {
  const maxFrames = options.maxFrames ?? 400
  const maxChars = options.maxChars ?? 120
  let buffer: Buffer
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) return undefined
    const handle = await open(file, 'r')
    try {
      buffer = Buffer.alloc(info.size)
      await handle.read(buffer, 0, info.size, 0)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }

  const frames = scanFrames(buffer)
  if (frames.length === 0) return undefined

  let lastUser: string | undefined
  let lastAssistant: string | undefined
  let lastActivity: number | undefined
  let startedAt: number | undefined
  let userMessages = 0
  let toolCalls = 0
  // turn 号来自 `turn/start` 的 data.turn，用集合是因为同一号不该重复计数；
  // 直接数事件数会被「重放/续跑」写下的重复 turn 骗到。
  const turnNumbers = new Set<number>()

  // 计数必须纵览全量：轮次和工具调用次数散落在整个文件里，只读尾部会少算。
  // 这一步顺带把每条事件都解一遍，比再读第二遍便宜。
  for (const span of frames) {
    let raw: string
    try {
      raw = (await decompress(buffer.subarray(span.start, span.end))).toString('utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue
      let event: SessionEvent
      try {
        event = JSON.parse(line) as SessionEvent
      } catch {
        continue
      }
      if (startedAt === undefined && typeof event.time === 'number') startedAt = event.time
      if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turnNumbers.add(event.data.turn)
      else if (event.type === 'user/message' && event.data?.source?.kind === 'user') userMessages += 1
      else if (event.type === 'tool/call') toolCalls += 1
    }
  }

  // 再从尾部往前找最后两句话；只扫最近若干帧，长会话不必为预览解到底。
  for (let index = frames.length - 1; index >= 0 && frames.length - index <= maxFrames; index -= 1) {
    const span = frames[index]!
    let raw: string
    try {
      raw = (await decompress(buffer.subarray(span.start, span.end))).toString('utf8')
    } catch {
      // 单帧坏了不该让整次预览失败：跳过它继续往前。
      continue
    }
    const lines = raw.split('\n')
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const line = lines[lineIndex]!
      if (line === '') continue
      let event: SessionEvent
      try {
        event = JSON.parse(line) as SessionEvent
      } catch {
        continue
      }
      if (lastActivity === undefined && typeof event.time === 'number') lastActivity = event.time
      if (lastAssistant === undefined && event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text !== '') lastAssistant = condense(text, maxChars)
      }
      if (lastUser === undefined && event.type === 'user/message' && event.data?.source?.kind === 'user') {
        const text = textOf(event.data?.content)
        if (text !== '') lastUser = condense(stripEnvelope(text), maxChars)
      }
      if (lastUser !== undefined && lastAssistant !== undefined) break
    }
    if (lastUser !== undefined && lastAssistant !== undefined) break
  }

  if (lastUser === undefined && lastAssistant === undefined && lastActivity === undefined) return undefined
  // `exactOptionalPropertyTypes` 下不能把 undefined 显式塞进可选字段，
  // 所以只把拿到了的那些摊进来。
  return {
    ...(lastUser === undefined ? {} : { lastUser }),
    ...(lastAssistant === undefined ? {} : { lastAssistant }),
    ...(lastActivity === undefined ? {} : { lastActivity }),
    ...(startedAt === undefined ? {} : { startedAt }),
    userMessages,
    turns: turnNumbers.size,
    toolCalls,
    bytes: buffer.length,
  }
}

/**
 * 一次性拿多个会话的预览，逐个读、按顺序返回。
 *
 * 不并发读是为了让内存峰值等于「最大单个会话」而不是「所有会话之和」——
 * 列表最多也就十来个，串行的几十毫秒换一个不会爆的内存曲线是划算的。
 * @param sessionIds - 会话 id 列表。
 * @param options - 透传给 {@link readSessionPreview}。
 * @returns 与入参等长的数组，读不到的为 undefined。
 */
export async function readPreviews(
  sessionIds: readonly string[],
  options: PreviewOptions & { readonly home?: string } = {},
): Promise<readonly (SessionPreview | undefined)[]> {
  const out: (SessionPreview | undefined)[] = []
  for (const sessionId of sessionIds) {
    const file = await findSessionFile(sessionId, options.home)
    out.push(file === undefined ? undefined : await readSessionPreview(file, options))
  }
  return out
}

/**
 * 默认的 harness home，与 `rotationHome` 同源但独立导出，方便调用方只依赖本模块。
 * @returns 目录路径。
 */
export function previewHome(): string {
  return process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh')
}
