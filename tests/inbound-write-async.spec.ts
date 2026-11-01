import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveInboundFiles } from '../src/files.ts'

/**
 * The inbound save path runs for every chat message, so the write must not hold
 * the event loop: a blocking write of one inbound file stalls every other chat
 * while the workspace answers. These tests pin the behaviour the async write has
 * to keep — bytes, destination, numbering, error handling — plus the property
 * that makes it safe on a bridged workspace: the bytes go through the
 * asynchronous write, and the file is complete by the time the save resolves.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const MSG = Object.freeze({
  messageId: 'om_inbound_1',
  resources: [{ type: 'file', fileKey: 'fk_inbound_1', fileName: '报告.pdf' }],
})

/** One workspace directory per test, so numbering tests start from empty. */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-bridge-inbound-async-'))
}

describe('saveInboundFiles writes asynchronously', () => {
  it('has the bytes on disk by the time the save resolves', async () => {
    const dir = workspace()
    const saved = await saveInboundFiles(MSG, async () => ({ buffer: PDF }), dir)

    expect(saved.paths).toEqual([join(dir, '报告.pdf')])
    expect(readFileSync(saved.paths[0]!)).toEqual(Buffer.from(PDF))
    expect(saved.notes[0]).toContain('📎 用户发送了文件「报告.pdf」，已保存到工作区')
  })

  it('hands the bytes to the asynchronous write, not a blocking one', async () => {
    const dir = workspace()
    // The download is held open until the test releases it, so everything left
    // after the release is the write and the promise hops around it — no timing
    // and no I/O in between.
    let atDownload!: () => void
    const parked = new Promise<void>((resolve) => { atDownload = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const download = async () => {
      atDownload()
      await gate
      return { buffer: PDF }
    }

    const pending = saveInboundFiles(MSG, download, dir)
    await parked
    let settled = false
    pending.then(() => { settled = true }, () => { settled = true })

    release()
    // The judge is WHICH API the save used, not how long it took. A
    // synchronous write is a different call: it blocks the event loop for
    // the length of the disk I/O, which on a bridged workspace is a round
    // trip to the host and freezes every other chat for that long. The
    // asynchronous write is the one that hands the bytes to the filesystem
    // and returns to the event loop.
    //
    // Timing is not a judge here: "the file is not on disk yet after N
    // microtasks" is a clock dressed as a fact, and on a fast machine the
    // write has already landed, so the assertion fails for a reason that has
    // nothing to do with the code under test.
    const written = vi.spyOn(fs, 'writeFile')
    const saved = await pending
    expect(written).toHaveBeenCalled()
    written.mockRestore()
    expect(existsSync(saved.paths[0]!)).toBe(true)
    expect(readFileSync(saved.paths[0]!)).toEqual(Buffer.from(PDF))
  })

  it('writes only the bytes of the view it was handed', async () => {
    const dir = workspace()
    // A view into a larger buffer must not spill its neighbours to disk — the
    // synchronous write read the view, and the async one has to as well.
    const backing = new Uint8Array([0x00, 0x00, ...PDF, 0x00])
    const view = backing.subarray(2, 2 + PDF.length)

    const saved = await saveInboundFiles(
      MSG,
      async () => ({ buffer: view }),
      dir,
    )

    expect(readFileSync(saved.paths[0]!)).toEqual(Buffer.from(PDF))
  })

  it('reports a failed write as a note instead of rejecting', async () => {
    // A file where the workspace should be: the destination cannot exist under
    // it, so the write fails the way it fails in production (no such directory)
    // and the loop has to absorb it, as it did for a synchronous write.
    const blocker = join(workspace(), 'not-a-directory')
    writeFileSync(blocker, 'x')

    const saved = await saveInboundFiles(MSG, async () => ({ buffer: PDF }), blocker)

    expect(saved.paths).toEqual([])
    expect(saved.notes).toHaveLength(1)
    expect(saved.notes[0]).toContain('📎 文件 报告.pdf 保存失败')
    // ENOTDIR is the POSIX code; Windows reports ENOENT for the same shape (a
    // file stands where the directory should be). What this locks is that the
    // failure is named in the note rather than swallowed — the exact code is
    // the platform's business, and pinning one made the suite red on Windows.
    expect(saved.notes[0]).toMatch(/ENOTDIR|ENOENT/)
  })

  it('still numbers a later arrival of the same name instead of overwriting it', async () => {
    const dir = workspace()
    const first = await saveInboundFiles(MSG, async () => ({ buffer: PDF }), dir)
    const second = await saveInboundFiles(
      MSG,
      async () => ({ buffer: new Uint8Array([0x41]) }),
      dir,
    )

    expect(first.paths[0]).toBe(join(dir, '报告.pdf'))
    expect(second.paths[0]).toBe(join(dir, '报告-2.pdf'))
    expect(readFileSync(first.paths[0]!)).toEqual(Buffer.from(PDF))
    expect(readFileSync(second.paths[0]!)).toEqual(Buffer.from([0x41]))
  })
})


/**
 * Two messages carrying the same file name arrive at the same time.
 *
 * The write is asynchronous on purpose, so the event loop runs other work
 * between the check that a name is free and the write that takes it. Two
 * arrivals that both see the name as free write to the same path, and the
 * second one overwrites the first — a file the user was told was saved
 * simply is not there any more.
 */
describe('two arrivals with the same name do not overwrite each other', () => {
  it('gives each of them its own file', async () => {
    const dir = workspace()
    const first = { ...MSG, messageId: 'om_inbound_a' }
    const second = { ...MSG, messageId: 'om_inbound_b' }
    // Both downloads wait for the same gate, so both saves are in flight
    // when the bytes land.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const download = async () => {
      await gate
      return { buffer: PDF }
    }

    const one = saveInboundFiles(first, download, dir)
    const two = saveInboundFiles(second, download, dir)
    release()
    const [savedOne, savedTwo] = await Promise.all([one, two])

    expect(savedOne.paths[0]).not.toBe(savedTwo.paths[0])
    expect(existsSync(savedOne.paths[0]!)).toBe(true)
    expect(existsSync(savedTwo.paths[0]!)).toBe(true)
    expect(readFileSync(savedOne.paths[0]!)).toEqual(Buffer.from(PDF))
    expect(readFileSync(savedTwo.paths[0]!)).toEqual(Buffer.from(PDF))
  })
})
