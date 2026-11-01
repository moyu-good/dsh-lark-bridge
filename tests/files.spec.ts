import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSendFileTool, deliverFile, renderSendFileResult, saveInboundFiles, SEND_FILE_TOOL_NAME } from '../src/files.ts'
import type { SendFileArgs, SendFileResult } from '../src/files.ts'

/** A fake outbound port recording file sends. */
function fakePort() {
  const sent: { to: string; input: object }[] = []
  const port = {
    sent,
    async send(to: string, input: object) {
      sent.push({ to, input })
      return { messageId: `om_${sent.length}` }
    },
    async stream() { return { messageId: 'om_s' } },
  } as never
  return { port, sent }
}

/** A real temp file for delivery tests. */
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-files-'))
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('send_file tool definition', () => {
  it('declares the channel tool name and schema', () => {
    const tool = createSendFileTool({
      deliverBySession: async () => { throw new Error('unused') },
    }) as {
      name: string
      parameters: { type: string; properties: { path: { type?: string }; caption?: { type?: string } }; required: string[] }
      output: { schema: object }
    }
    expect(tool.name).toBe(SEND_FILE_TOOL_NAME)
    // dsh projects `parameters` (a JSON Schema object) onto the model.
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.properties.path.type).toBe('string')
    expect(tool.parameters.required).toContain('path')
  })

  it('delivers through the capability and reports the file name', async () => {
    const delivered: { sessionId: string; args: SendFileArgs }[] = []
    const tool = createSendFileTool({
      deliverBySession: async (sessionId, args) => {
        delivered.push({ sessionId, args })
        return { fileName: 'report.html' }
      },
    }) as { execute(args: unknown, exec: unknown): Promise<SendFileResult> }
    const result = await tool.execute(
      { path: '/tmp/report.html' },
      { agent: { session: { id: 'ses_1' } } },
    )
    expect(result).toEqual({ ok: true, fileName: 'report.html' })
    expect(delivered[0]).toEqual({ sessionId: 'ses_1', args: { path: '/tmp/report.html' } })
  })

  it('turns a delivery failure into an error result', async () => {
    const tool = createSendFileTool({
      deliverBySession: async () => { throw new Error('文件不存在') },
    }) as { execute(args: unknown, exec: unknown): Promise<SendFileResult> }
    const result = await tool.execute(
      { path: '/tmp/nope.html' },
      { agent: { session: { id: 'ses_1' } } },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('文件不存在')
  })

  it('renders a success result for the model', () => {
    // dsh calls render(args, value); the canonical value is the second arg.
    expect(renderSendFileResult({ path: 'x' }, { ok: true, fileName: 'a.html' })[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('a.html'),
    })
  })

  it('carries a downgrade note through to the model', async () => {
    const note = '语音仅支持 ogg/opus 容器，该文件已作为文件发送。'
    const tool = createSendFileTool({
      deliverBySession: async () => ({ fileName: 'note.mp3', note }),
    }) as { execute(args: unknown, exec: unknown): Promise<SendFileResult> }

    const result = await tool.execute({ path: '/tmp/note.mp3' }, { agent: { session: { id: 'ses_1' } } })

    // A send that arrived as a plain attachment must not read as a voice note.
    expect(result).toEqual({ ok: true, fileName: 'note.mp3', note })
    expect(renderSendFileResult({ path: '/tmp/note.mp3' }, result)[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(note),
    })
  })
})

describe('deliverFile', () => {
  it('uploads a real file with its base name', async () => {
    const file = tempFile('报告.html', '<h1>你好</h1>')
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', '/workspace', { path: file })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('oc_1')
    expect((sent[0]!.input as { file: { fileName: string } }).file.fileName).toBe('报告.html')
  })

  it('resolves a relative path against the workspace root', async () => {
    const file = tempFile('report.md', '# 报告')
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', dirname(file), { path: 'report.md' })
    expect(sent).toHaveLength(1)
  })

  it('rejects a missing file', async () => {
    const { port } = fakePort()
    await expect(deliverFile(port, 'oc_1', '/workspace', { path: '/no/such/file.pdf' }))
      .rejects.toThrow(/不存在/)
  })

  it('sends the file first, then the caption as its own message', async () => {
    const file = tempFile('r.csv', 'a,b')
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', '/workspace', { path: file, caption: '这是结果' })
    expect(sent).toHaveLength(2)
    // SendInput is a union: file and markdown never share one message, or the
    // transport's markdown-first dispatch drops the file silently.
    expect((sent[0]!.input as { file: { fileName: string } }).file.fileName).toBe('r.csv')
    expect('markdown' in sent[0]!.input).toBe(false)
    // The caption follows the file: a refused media send must not leave the
    // chat holding a caption for a file that never arrived.
    expect('file' in sent[1]!.input).toBe(false)
    expect((sent[1]!.input as { markdown?: string }).markdown).toBe('这是结果')
  })

  it('tells the chat when the transport refuses the media, and still rejects', async () => {
    const file = tempFile('chart.png', 'binary')
    const sent: { to: string; input: object }[] = []
    const port = {
      async send(to: string, input: object) {
        // The exact refusal a deployment without outbound.allowedFileDirs gives.
        if ('image' in input) throw new Error('local file source requires `outbound.allowedFileDirs` to be configured')
        sent.push({ to, input })
        return { messageId: `om_${sent.length}` }
      },
      async stream() { return { messageId: 'om_s' } },
    } as never

    await expect(deliverFile(port, 'oc_1', '/workspace', { path: file, caption: '看这张图' }))
      .rejects.toThrow(/发送失败/)
    // The failure notice — not the caption — is what the chat must see.
    expect(sent).toHaveLength(1)
    const notice = (sent[0]!.input as { markdown?: string }).markdown ?? ''
    expect(notice).toContain('没有发出去')
    expect(notice).toContain('chart.png')
    expect(notice).toContain('allowedFileDirs')
    expect(notice).not.toContain('看这张图')
  })

  it('omits the caption message when absent', async () => {
    const file = tempFile('r.csv', 'a,b')
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', '/workspace', { path: file })
    expect(sent).toHaveLength(1)
    expect('markdown' in sent[0]!.input).toBe(false)
    expect((sent[0]!.input as { file: { fileName: string } }).file.fileName).toBe('r.csv')
  })
})

describe('saveInboundFiles', () => {
  const fakeDownload = vi.fn(async () => ({ buffer: new Uint8Array([1, 2, 3]) }))

  it('saves documents, audio and video, and notes each kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-'))
    const saved = await saveInboundFiles(
      {
        messageId: 'om_1',
        resources: [
          { type: 'file', fileKey: 'fk1', fileName: '报告.pdf' },
          { type: 'audio', fileKey: 'fk2', fileName: 'voice.opus' },
          { type: 'video', fileKey: 'fk3' },
        ],
      },
      fakeDownload as never,
      dir,
    )
    expect(saved.paths).toHaveLength(3)
    expect(saved.notes[0]).toContain('📎 用户发送了文件「报告.pdf」')
    expect(saved.notes[1]).toContain('🎤 用户发送了语音「voice.opus」')
    expect(saved.notes[2]).toContain('🎬 用户发送了视频「video_fk3」')
    expect(fakeDownload).toHaveBeenCalledWith('om_1', 'fk2', 'file')
  })

  it('notes a failed download instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-'))
    const saved = await saveInboundFiles(
      { messageId: 'om_2', resources: [{ type: 'audio', fileKey: 'fk9', fileName: 'v.opus' }] },
      (async () => { throw new Error('boom') }) as never,
      dir,
    )
    expect(saved.notes[0]).toContain('保存失败')
    expect(saved.paths).toHaveLength(0)
  })

  it('ignores image resources (handled by the image path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-'))
    const saved = await saveInboundFiles(
      { messageId: 'om_3', resources: [{ type: 'image', fileKey: 'fk0' }] },
      fakeDownload as never,
      dir,
    )
    expect(saved.notes).toHaveLength(0)
    expect(saved.paths).toHaveLength(0)
  })

  it('saves a sticker instead of dropping it silently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-'))
    const saved = await saveInboundFiles(
      { messageId: 'om_4', resources: [{ type: 'sticker', fileKey: 'fk5' }] },
      fakeDownload as never,
      dir,
    )
    expect(saved.notes[0]).toContain('用户发送了贴纸')
    expect(saved.paths).toHaveLength(1)
  })

  it('never overwrites an earlier arrival with the same name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-'))
    const msg = { messageId: 'om_5', resources: [{ type: 'file', fileKey: 'fk6', fileName: 'report.pdf' }] }
    const first = await saveInboundFiles(msg, fakeDownload as never, dir)
    const second = await saveInboundFiles(msg, fakeDownload as never, dir)
    expect(first.paths[0]).not.toBe(second.paths[0])
    expect(second.paths[0]).toContain('report-2.pdf')
  })

  it('strips control characters from a file name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-'))
    const saved = await saveInboundFiles(
      { messageId: 'om_6', resources: [{ type: 'file', fileKey: 'fk7', fileName: 'a\nb.txt' }] },
      fakeDownload as never,
      dir,
    )
    expect(saved.notes[0]).not.toContain('a\nb')
    expect(saved.notes[0]).toContain('a_b.txt')
  })
})
