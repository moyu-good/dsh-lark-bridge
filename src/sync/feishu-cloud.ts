/**
 * Feishu drive (v1) as the cross-machine carrier: the app's own cloud space
 * is the natural transfer point for migration files and the arbitration
 * record — same credentials the bridge already holds, an isolation boundary
 * the platform enforces, and no manual copying between machines. Token is
 * cached until shortly before expiry; every call goes through the injected
 * fetch so tests run without network.
 * @module dsh-lark-bridge/sync/feishu-cloud
 */

/** Credentials to mint a tenant_access_token (what the bridge already has). */
export interface FeishuCredentials {
  appId: string
  appSecret: string
  /** Open-platform origin, default `https://open.feishu.cn`. */
  domain?: string
}

/** Minimal response surface used here; injectable for tests. */
export type FetchImpl = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
  signal?: AbortSignal
}) => Promise<{ status: number; json: () => Promise<Record<string, unknown>>; text: () => Promise<string> }>

interface CachedToken { value: string; expiresAt: number }

const TOKEN_SAFETY_MS = 60_000

/**
 * Deadline for every drive/auth call made here.
 *
 * This class is read on the inbound message path (the arbitration record is
 * fetched per message, cached for a minute), and `fetch` has no default
 * deadline. A request that stalls without one parks the inbound handler
 * forever: the message is acknowledged with a reaction and then nothing
 * happens — no reply, no error, no log — until the process is restarted.
 * Bounding every call here keeps a stalled carrier from wedging the channel.
 */
const CLOUD_TIMEOUT_MS = 15_000

/**
 * One chat message as the message-history endpoint reports it.
 *
 * Only the fields the gap check needs: who sent it (a user message lost in a
 * connection gap is what the chat must be told to resend) and when.
 */
export interface ChatMessageSummary {
  readonly messageId: string
  /** `user` for a person, `app` for a bot/this app itself, else the platform's value. */
  readonly senderType: string
  /** Server-side creation time in ms. */
  readonly createTimeMs: number
  readonly msgType: string
}

/** Drive-backed JSON storage scoped to the app's own root folder. */
export class FeishuCloud {
  private token?: CachedToken
  private rootToken?: string
  private readonly fetchImpl: FetchImpl

  constructor(
    private readonly creds: FeishuCredentials,
    fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  ) {
    // Bound every call at the seam rather than at each call site.
    this.fetchImpl = (url, init = {}) =>
      fetchImpl(url, { ...init, signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) })
  }

  private origin(): string {
    return (this.creds.domain ?? 'https://open.feishu.cn').replace(/\/$/, '')
  }

  /** Mint (or reuse) a tenant_access_token. */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value
    const res = await this.fetchImpl(`${this.origin()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.creds.appId, app_secret: this.creds.appSecret }),
    })
    const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`飞书 token 获取失败(${data.code}): ${data.msg ?? 'unknown'}`)
    }
    this.token = { value: data.tenant_access_token, expiresAt: Date.now() + (data.expire ?? 7200) * 1000 - TOKEN_SAFETY_MS }
    return this.token.value
  }

  /**
   * The app's own bot profile — the display name a human sees in the Feishu
   * chat header. Fleet UX depends on it: several endpoints (and even several
   * deployments) share or echo app names, so the model's self-description and
   * the first-contact guide quote this name instead of guessing.
   */
  async botInfo(): Promise<{ name: string; active: boolean }> {
    const token = await this.getToken()
    const res = await this.fetchImpl(`${this.origin()}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as { code?: number; msg?: string; bot?: { app_name?: string; activate_status?: number } }
    if (data.code !== 0 || data.bot?.app_name === undefined) {
      throw new Error(`飞书 bot 信息获取失败(${data.code}): ${data.msg ?? 'unknown'}`)
    }
    return { name: data.bot.app_name, active: data.bot.activate_status === 2 }
  }

  /** The app's own drive root folder — files land here unless told otherwise. */
  async rootFolder(): Promise<string> {    if (this.rootToken) return this.rootToken
    const token = await this.getToken()
    const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/explorer/v2/root_folder/meta`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as { code?: number; msg?: string; data?: { token?: string } }
    const folder = data.data?.token
    if (data.code !== 0 || !folder) throw new Error(`飞书根目录获取失败(${data.code}): ${data.msg ?? 'unknown'}`)
    this.rootToken = folder
    return folder
  }

  /** Upload one text file. Returns its drive file token. */
  async upload(fileName: string, content: string, folderToken?: string): Promise<string> {
    const token = await this.getToken()
    const folder = folderToken ?? await this.rootFolder()
    const bytes = Buffer.from(content, 'utf8')
    const form = new FormData()
    form.append('file_name', fileName)
    form.append('parent_type', 'explorer')
    form.append('parent_node', folder)
    form.append('size', String(bytes.length))
    form.append('file', new Blob([bytes]), fileName)
    const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/upload_all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const data = (await res.json()) as { code?: number; msg?: string; data?: { file_token?: string } }
    const fileToken = data.data?.file_token
    if (data.code !== 0 || !fileToken) throw new Error(`飞书上传失败(${data.code}): ${data.msg ?? 'unknown'}`)
    return fileToken
  }

  /** List the app's root folder: name → token + modified time (ms). */
  async list(): Promise<{ name: string; token: string; modifiedMs: number }[]> {
    const token = await this.getToken()
    const folder = await this.rootFolder()
    const out: { name: string; token: string; modifiedMs: number }[] = []
    let pageToken: string | undefined
    for (;;) {
      const url = new URL(`${this.origin()}/open-apis/drive/v1/files`)
      url.searchParams.set('folder_token', folder)
      url.searchParams.set('page_size', '200')
      if (pageToken !== undefined) url.searchParams.set('page_token', pageToken)
      const res = await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      const data = (await res.json()) as {
        code?: number
        msg?: string
        data?: { files?: { name?: string; token?: string; modified_time?: string }[]; next_page_token?: string }
      }
      if (data.code !== 0) throw new Error(`飞书列目录失败(${data.code}): ${data.msg ?? 'unknown'}`)
      for (const file of data.data?.files ?? []) {
        if (file.token !== undefined) {
          out.push({
            name: file.name ?? '',
            token: file.token,
            // Feishu returns ms as a string.
            modifiedMs: Number(file.modified_time ?? 0),
          })
        }
      }
      pageToken = data.data?.next_page_token
      if (pageToken === undefined || pageToken === '') break
    }
    return out
  }

  /**
   * Chat messages created inside `[startMs, endMs]`, oldest first.
   *
   * The long connection has no cursor, so a message sent while it is down
   * never reaches the bridge — but it does exist on the server. Reading it
   * back is what turns "a gap happened, maybe something was lost" into "N user
   * messages were lost". Bounded to `maxPages` (50 per page) so a very long
   * outage cannot hold the reconnect path in a paging loop; the caller only
   * needs to know whether anything was lost, not the exact transcript.
   * @param chatId - chat to read.
   * @param startMs - window start, inclusive, in ms.
   * @param endMs - window end, inclusive, in ms.
   * @param maxPages - page cap (50 messages per page).
   * @returns the messages in the window, in send order.
   */
  async listMessages(
    chatId: string,
    startMs: number,
    endMs: number,
    maxPages = 5,
  ): Promise<ChatMessageSummary[]> {
    const token = await this.getToken()
    const out: ChatMessageSummary[] = []
    let pageToken: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`${this.origin()}/open-apis/im/v1/messages`)
      url.searchParams.set('container_id_type', 'chat')
      url.searchParams.set('container_id', chatId)
      // The endpoint takes seconds, while the bridge tracks ms.
      url.searchParams.set('start_time', String(Math.floor(startMs / 1000)))
      url.searchParams.set('end_time', String(Math.ceil(endMs / 1000)))
      url.searchParams.set('sort_type', 'ByCreateTimeAsc')
      url.searchParams.set('page_size', '50')
      if (pageToken !== undefined) url.searchParams.set('page_token', pageToken)
      const res = await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      const data = (await res.json()) as {
        code?: number
        msg?: string
        data?: {
          has_more?: boolean
          page_token?: string
          items?: {
            message_id?: string
            msg_type?: string
            create_time?: string | number
            sender?: { sender_type?: string }
          }[]
        }
      }
      if (data.code !== 0) throw new Error(`飞书消息历史读取失败(${data.code}): ${data.msg ?? 'unknown'}`)
      for (const item of data.data?.items ?? []) {
        if (item.message_id === undefined) continue
        out.push({
          messageId: item.message_id,
          senderType: item.sender?.sender_type ?? '',
          createTimeMs: Number(item.create_time ?? 0),
          msgType: item.msg_type ?? '',
        })
      }
      pageToken = data.data?.page_token
      if (data.data?.has_more !== true || pageToken === undefined || pageToken === '') break
    }
    return out
  }

  /** Download one file's text by token. */
  async download(fileToken: string): Promise<string> {
    const token = await this.getToken()
    const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/${fileToken}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status !== 200) throw new Error(`飞书下载失败: HTTP ${res.status}`)
    return res.text()
  }

  /** Delete one file by token (best effort by caller). */
  async remove(fileToken: string): Promise<void> {
    const token = await this.getToken()
    const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/${fileToken}?type=file`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as { code?: number; msg?: string }
    if (data.code !== 0) throw new Error(`飞书删除失败(${data.code}): ${data.msg ?? 'unknown'}`)
  }

  /** Upsert-by-name: upload fresh, then retire the old version of that name. */
  async putJson(name: string, content: string): Promise<void> {
    const previous = (await this.list()).filter((file) => file.name === name)
    const fresh = await this.upload(name, content)
    for (const old of previous) {
      await this.remove(old.token).catch(() => {})
    }
    void fresh
  }

  /** Fetch the newest file with this name, or null when absent. */
  async getJson(name: string): Promise<string | null> {
    const matches = (await this.list())
      .filter((file) => file.name === name)
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
    if (matches.length === 0) return null
    return this.download(matches[0]!.token)
  }

  /** Remove every file with this name (used before a clean re-put). */
  async removeByName(name: string): Promise<void> {
    for (const file of await this.list()) {
      if (file.name === name) await this.remove(file.token).catch(() => {})
    }
  }
}
