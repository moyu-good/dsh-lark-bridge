import { describe, expect, it } from 'vitest'
import {
  createFeishuTools,
  FEISHU_DRIVE_LIST_TOOL,
  FEISHU_DRIVE_READ_TOOL,
  FEISHU_DRIVE_WRITE_TOOL,
  FEISHU_NOTIFY_TOOL,
} from '../src/feishu-tools.ts'
import type { OutboundPort } from '../src/outbound.ts'
import type { FetchImpl } from '../src/sync/feishu-cloud.ts'

interface Recorded { chatId: string; markdown: string }

function fakePort(): { port: OutboundPort; sent: Recorded[] } {
  const sent: Recorded[] = []
  const port = {
    send: async (chatId: string, payload: { markdown?: string }) => {
      sent.push({ chatId, markdown: payload.markdown ?? '' })
      return { messageId: 'm1' }
    },
  } as unknown as OutboundPort
  return { port, sent }
}

const execFor = (sessionId: string): unknown => ({ agent: { session: { id: sessionId } } })

function tools(overrides: {
  sent?: Recorded[]
  credentials?: { appId: string; appSecret: string } | undefined
  fetchImpl?: FetchImpl
} = {}) {
  const sent = overrides.sent ?? []
  const port = {
    send: async (chatId: string, payload: { markdown?: string }) => {
      sent.push({ chatId, markdown: payload.markdown ?? '' })
      return { messageId: 'm1' }
    },
  } as unknown as OutboundPort
  const set = createFeishuTools({
    port,
    chatOfSession: (sessionId) => (sessionId === 's-chat' ? 'oc_current' : undefined),
    credentials: 'credentials' in overrides ? overrides.credentials : { appId: 'cli_x', appSecret: 's' },
    fetchImpl: overrides.fetchImpl,
  })
  const byName = new Map(set.map((tool) => [(tool as { name: string }).name, tool]))
  return { byName, sent }
}

describe('feishu_notify', () => {
  it('delivers to the current chat when no chat_id is given', async () => {
    const { byName, sent } = tools()
    const notify = byName.get(FEISHU_NOTIFY_TOOL) as { execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; chat_id?: string }> }
    const result = await notify.execute({ text: 'stage 1 done' }, execFor('s-chat'))
    expect(result.ok).toBe(true)
    expect(result.chat_id).toBe('oc_current')
    expect(sent).toEqual([{ chatId: 'oc_current', markdown: 'stage 1 done' }])
  })

  it('an explicit chat_id overrides the current chat', async () => {
    const { byName, sent } = tools()
    const notify = byName.get(FEISHU_NOTIFY_TOOL) as { execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; chat_id?: string }> }
    const result = await notify.execute({ text: 'hi', chat_id: 'oc_other' }, execFor('s-chat'))
    expect(result.ok).toBe(true)
    expect(sent[0]!.chatId).toBe('oc_other')
  })

  it('an unbound session without chat_id is a clean refusal', async () => {
    const { byName } = tools()
    const notify = byName.get(FEISHU_NOTIFY_TOOL) as { execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; error?: string }> }
    const result = await notify.execute({ text: 'hi' }, execFor('s-nowhere'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('chat_id')
  })

  it('empty text is refused', async () => {
    const { byName } = tools()
    const notify = byName.get(FEISHU_NOTIFY_TOOL) as { execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; error?: string }> }
    expect((await notify.execute({ text: '  ' }, execFor('s-chat'))).ok).toBe(false)
  })
})

describe('drive tools', () => {
  it('without credentials they refuse cleanly instead of throwing', async () => {
    const { byName } = tools({ credentials: undefined })
    const write = byName.get(FEISHU_DRIVE_WRITE_TOOL) as { execute: (args: unknown) => Promise<{ ok: boolean; error?: string }> }
    const read = byName.get(FEISHU_DRIVE_READ_TOOL) as { execute: (args: unknown) => Promise<{ ok: boolean; error?: string }> }
    const list = byName.get(FEISHU_DRIVE_LIST_TOOL) as { execute: () => Promise<{ ok: boolean; error?: string }> }
    expect((await write.execute({ name: 'a.md', content: 'x' })).error).toContain('凭证')
    expect((await read.execute({ name: 'a.md' })).error).toContain('凭证')
    expect((await list.execute()).error).toContain('凭证')
  })

  it('write then read round-trips through the fake Feishu API', async () => {
    // name → (token, content), shaped exactly like the drive surface
    // feishu-cloud.ts speaks: token mint, root folder meta, upload_all,
    // folder listing, download-by-token, delete.
    const store = new Map<string, { token: string; content: string; modified: number }>()
    let seq = 0
    const json = (body: unknown, status = 200): Response => ({
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response)
    const fetchImpl: FetchImpl = async (url, init) => {
      const href = String(url)
      if (href.includes('/tenant_access_token/')) {
        return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
      }
      if (href.includes('/drive/explorer/v2/root_folder/meta')) {
        return json({ code: 0, data: { token: 'fld-root' } })
      }
      if (href.includes('/drive/v1/files/upload_all')) {
        const form = init?.body as FormData
        const name = String(form.get('file_name'))
        // feishu-cloud passes the text through a Blob in the form's `file`.
        const blob = form.get('file') as Blob
        const content = await blob.text()
        const token = `tok-${++seq}`
        store.set(name, { token, content, modified: seq })
        return json({ code: 0, data: { file_token: token } })
      }
      if (href.includes('/drive/v1/files/') && href.includes('/download')) {
        const token = href.split('/drive/v1/files/')[1]!.split('/')[0]!
        const entry = [...store.values()].find((file) => file.token === token)
        // The real download endpoint streams the RAW bytes; feishu-cloud
        // reads them with res.text(), not res.json().
        return { status: 200, json: async () => entry?.content ?? null, text: async () => entry?.content ?? '' } as unknown as Response
      }
      if (href.includes('/drive/v1/files?') || href.includes('/drive/v1/files&')) {
        return json({
          code: 0,
          data: { files: [...store.entries()].map(([name, file]) => ({ name, token: file.token, modified_time: String(file.modified) })) },
        })
      }
      if (href.includes('/drive/v1/files/') && init?.method === 'DELETE') {
        const token = href.split('/drive/v1/files/')[1]!.split('?')[0]!
        for (const [name, file] of store) if (file.token === token) store.delete(name)
        return json({ code: 0 })
      }
      return json({ code: -1, msg: `unexpected ${href}` }, 500)
    }
    const { byName } = tools({ fetchImpl })
    const write = byName.get(FEISHU_DRIVE_WRITE_TOOL) as { execute: (args: unknown) => Promise<{ ok: boolean; error?: string }> }
    const read = byName.get(FEISHU_DRIVE_READ_TOOL) as { execute: (args: unknown) => Promise<{ ok: boolean; content?: string | null }> }
    const list = byName.get(FEISHU_DRIVE_LIST_TOOL) as { execute: () => Promise<{ ok: boolean; files?: { name: string }[] }> }

    const written = await write.execute({ name: 'handoff.md', content: 'meeting at 3' })
    expect(written.ok).toBe(true)
    const listed = await list.execute()
    expect(listed.ok).toBe(true)
    expect(listed.files?.map((file) => file.name)).toContain('handoff.md')
    const readBack = await read.execute({ name: 'handoff.md' })
    expect(readBack.ok).toBe(true)
    expect(readBack.content).toBe('meeting at 3')
  })
})
