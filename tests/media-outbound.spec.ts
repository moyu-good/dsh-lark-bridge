import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverFile, sendFileKindFor } from '../src/files.ts'
import type { DurationProbe, MeasureDuration } from '../src/files.ts'

/** A fake outbound port recording every send. */
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-media-'))
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

/** A machine whose probe measures every file as the same length. */
const measuring = (ms: number): MeasureDuration => async () => ({ state: 'measured', ms })
/** A machine without `ffprobe`: the transport times the container itself. */
const withoutTool: MeasureDuration = async (): Promise<DurationProbe> => ({ state: 'no-tool' })
/** A probe that ran and could not read the file. */
const unreadable: MeasureDuration = async (): Promise<DurationProbe> => ({ state: 'failed' })

/** The shape one recorded send went out in. */
function shapeOf(input: object): { audio?: { duration?: number }; video?: { duration?: number }; image?: unknown; file?: { fileName?: string } } {
  return input as { audio?: { duration?: number }; video?: { duration?: number }; image?: unknown; file?: { fileName?: string } }
}

/**
 * A recording or a clip plays in place only in a container the transport can
 * carry: it declares every such upload as an `opus` or `mp4` container and times
 * the payload from an Ogg or MP4 stream, refusing the send when it finds
 * neither. Sending an mp3 as a voice note is therefore a send that fails, which
 * is what these tests hold the line on.
 */
describe('media is delivered in a shape the chat can actually carry', () => {
  it('sends an Ogg recording as a voice note, with its duration', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.ogg', 'binary')
    const result = await deliverFile(port, 'oc_1', '/tmp', { path }, measuring(4200))

    expect(sent).toHaveLength(1)
    expect(shapeOf(sent[0]!.input).audio?.duration).toBe(4200)
    expect(shapeOf(sent[0]!.input).file).toBeUndefined()
    expect(result).toEqual({ fileName: 'note.ogg' })
  })

  it('sends an mp4 clip as a video, with its duration', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('clip.mp4', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path }, measuring(1500))

    expect(shapeOf(sent[0]!.input).video?.duration).toBe(1500)
    expect(shapeOf(sent[0]!.input).file).toBeUndefined()
  })

  it('sends an m4v clip as a video too', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('clip.m4v', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path }, measuring(900))

    expect(shapeOf(sent[0]!.input).video).toBeDefined()
  })

  it('leaves the timing to the transport when there is no ffprobe', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.ogg', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path }, withoutTool)

    const audio = shapeOf(sent[0]!.input).audio
    expect(audio).toBeDefined()
    // Nothing measured, so nothing invented: the transport parses the container.
    expect(Object.hasOwn(audio as object, 'duration')).toBe(false)
  })

  it('sends an mp3 as a file, and says why', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.mp3', 'binary')
    const result = await deliverFile(port, 'oc_1', '/tmp', { path }, measuring(4200))

    expect(shapeOf(sent[0]!.input).file?.fileName).toBe('note.mp3')
    expect(shapeOf(sent[0]!.input).audio).toBeUndefined()
    expect(result.note).toContain('语音')
    expect(result.note).toContain('作为文件发送')
  })

  it('never sends a container the chat cannot time', async () => {
    const shaped = ['wav', 'm4a', 'aac', 'flac', 'amr', 'mov', 'mkv', 'webm', 'avi']
    for (const ext of shaped) {
      const { port, sent } = fakePort()
      const path = tempFile(`capture.${ext}`, 'binary')
      await deliverFile(port, 'oc_1', '/tmp', { path }, measuring(1000))

      const input = shapeOf(sent[0]!.input)
      expect(input.file?.fileName, `${ext} must arrive as a file`).toBe(`capture.${ext}`)
      expect(input.audio, `${ext} must not be sent as audio`).toBeUndefined()
      expect(input.video, `${ext} must not be sent as video`).toBeUndefined()
    }
  })

  it('sends an Ogg recording when the machine has no ffprobe at all', async () => {
    const path = tempFile('note.ogg', 'binary')
    const saved = process.env.PATH
    // An empty PATH is a machine without the probe: the transport must still
    // carry the container in kind, timing it itself.
    process.env.PATH = mkdtempSync(join(tmpdir(), 'dsh-bridge-nopath-'))
    try {
      const { port, sent } = fakePort()
      const result = await deliverFile(port, 'oc_1', '/tmp', { path })
      expect(shapeOf(sent[0]!.input).audio).toBeDefined()
      expect(shapeOf(sent[0]!.input).file).toBeUndefined()
      expect(result).toEqual({ fileName: 'note.ogg' })
    } finally {
      if (saved === undefined) delete process.env.PATH
      else process.env.PATH = saved
    }
  })

  it('falls back to a file when the duration cannot be read', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('broken.ogg', 'not really ogg')
    const result = await deliverFile(port, 'oc_1', '/tmp', { path }, unreadable)

    expect(shapeOf(sent[0]!.input).file?.fileName).toBe('broken.ogg')
    expect(shapeOf(sent[0]!.input).audio).toBeUndefined()
    expect(result.note).toContain('时长')
  })

  it('naming a kind cannot turn an untimeable container into a voice note', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('recording.dat', 'binary')
    const result = await deliverFile(port, 'oc_1', '/tmp', { path, kind: 'audio' }, measuring(4200))

    expect(shapeOf(sent[0]!.input).file?.fileName).toBe('recording.dat')
    expect(shapeOf(sent[0]!.input).audio).toBeUndefined()
    expect(result.note).toBeDefined()
  })

  it('lets the caller ask for a file instead of a voice note', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.ogg', 'binary')
    const result = await deliverFile(port, 'oc_1', '/tmp', { path, kind: 'file' }, measuring(4200))

    expect(shapeOf(sent[0]!.input).file?.fileName).toBe('note.ogg')
    expect(result).toEqual({ fileName: 'note.ogg' })
  })

  it('sends an image as an image', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('shot.png', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path })

    expect(shapeOf(sent[0]!.input).image).toBeDefined()
    expect(shapeOf(sent[0]!.input).file).toBeUndefined()
  })

  it('sends anything else as a file, with no note', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('report.html', '<p>hi</p>')
    const result = await deliverFile(port, 'oc_1', '/tmp', { path })

    expect(shapeOf(sent[0]!.input).file?.fileName).toBe('report.html')
    expect(result).toEqual({ fileName: 'report.html' })
  })

  it('keeps the caption as its own message after the media', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.ogg', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path, caption: '今天这段' }, measuring(3000))

    expect(sent).toHaveLength(2)
    expect(shapeOf(sent[0]!.input).audio).toBeDefined()
    expect((sent[1]!.input as { markdown?: string }).markdown).toBe('今天这段')
  })
})

describe('the extension decides, and only two containers count', () => {
  it('reads the deliverable kind off the extension', () => {
    expect(sendFileKindFor('note.ogg')).toBe('audio')
    expect(sendFileKindFor('note.opus')).toBe('audio')
    expect(sendFileKindFor('clip.mp4')).toBe('video')
    expect(sendFileKindFor('clip.m4v')).toBe('video')
    expect(sendFileKindFor('shot.webp')).toBe('image')
    expect(sendFileKindFor('note.mp3')).toBe('file')
    expect(sendFileKindFor('clip.webm')).toBe('file')
    expect(sendFileKindFor('no-extension')).toBe('file')
  })
})
