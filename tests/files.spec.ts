import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSendFileTool, deliverFile, renderSendFileResult, SEND_FILE_TOOL_NAME } from '../src/files.ts'
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
      schema: Record<string, { type?: string; required?: true }>
      output: { schema: object }
    }
    expect(tool.name).toBe(SEND_FILE_TOOL_NAME)
    expect(tool.schema.path.type).toBe('string')
    expect(tool.schema.path.required).toBe(true)
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
    expect(renderSendFileResult({ ok: true, fileName: 'a.html' })[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('a.html'),
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
    await deliverFile(port, 'oc_1', file.slice(0, file.lastIndexOf('/')), { path: 'report.md' })
    expect(sent).toHaveLength(1)
  })

  it('rejects a missing file', async () => {
    const { port } = fakePort()
    await expect(deliverFile(port, 'oc_1', '/workspace', { path: '/no/such/file.pdf' }))
      .rejects.toThrow(/不存在/)
  })

  it('sends the caption alongside the file', async () => {
    const file = tempFile('r.csv', 'a,b')
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', '/workspace', { path: file, caption: '这是结果' })
    expect((sent[0]!.input as { markdown?: string }).markdown).toBe('这是结果')
  })

  it('omits the caption field when absent', async () => {
    const file = tempFile('r.csv', 'a,b')
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', '/workspace', { path: file })
    expect('markdown' in sent[0]!.input).toBe(false)
  })
})
