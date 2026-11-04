import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  condense,
  describeScale,
  describeSpan,
  findSessionFile,
  formatBytes,
  readSessionPreview,
  readPreviews,
  scanFrames,
  sessionDirName,
  stripEnvelope,
} from '../src/session-preview.ts'

/** 一条真人用户消息事件。 */
function userEvent(text: string, kind = 'user'): string {
  return JSON.stringify({
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
  })
}

/** 一条助手消息事件；`parts` 允许造出只有思考、没有正文的回复。 */
function assistantEvent(parts: { type: string; text?: string }[]): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq: 2,
    time: 2000,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: parts } },
  })
}

/** 任意其它事件，用来把两条目标消息隔开。 */
function fillerEvent(seq: number): string {
  return JSON.stringify({ type: 'step/start', seq, time: 3000, data: { turn: 1, step: seq } })
}

/** 一条 turn/start 事件，轮次的唯一来源。 */
function turnEvent(turn: number): string {
  return JSON.stringify({ type: 'turn/start', seq: 100 + turn, time: 4000, data: { turn } })
}

/** 一条工具调用事件。 */
function toolEvent(seq: number): string {
  return JSON.stringify({ type: 'tool/call', seq, time: 4500, data: { name: 'pwsh' } })
}

/**
 * 按真实格式写一个会话日志：每个数组元素是一帧，帧里是多行 JSONL。
 * @returns 日志文件的绝对路径。
 */
function writeSession(sessionId: string, frames: string[][], home = mkdtempSync(join(tmpdir(), 'dsh-prev-'))): string {
  const dir = join(home, 'sessions', '--D-Work--', sessionDirName(sessionId))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(frames.map(lines => zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')))))
  return file
}

describe('会话预览', () => {
  it('扫出一帧压多行的日志里每一帧的边界', () => {
    const file = writeSession('feishu-oc_s1', [
      [fillerEvent(1), fillerEvent(2)],
      [fillerEvent(3)],
      [fillerEvent(4), fillerEvent(5), fillerEvent(6)],
    ])
    const buffer = readFileSync(file)
    expect(scanFrames(buffer)).toHaveLength(3)
  })

  it('取最后一句用户消息和最后一句带正文的回复', async () => {
    const file = writeSession('feishu-oc_s2', [
      [userEvent('第一句'), assistantEvent([{ type: 'text', text: '第一次回复' }])],
      [userEvent('第二句'), assistantEvent([{ type: 'reasoning', text: '想了想' }, { type: 'text', text: '第二次回复' }])],
    ])
    const preview = await readSessionPreview(file)
    expect(preview?.lastUser).toBe('第二句')
    expect(preview?.lastAssistant).toBe('第二次回复')
    expect(preview?.lastActivity).toBe(2000)
  })

  it('跳过只有思考没有正文的回复，往前找真正的答复', async () => {
    const file = writeSession('feishu-oc_s3', [
      [userEvent('问题'), assistantEvent([{ type: 'text', text: '有正文的答复' }])],
      [assistantEvent([{ type: 'reasoning', text: '只有思考' }])],
    ])
    const preview = await readSessionPreview(file)
    expect(preview?.lastAssistant).toBe('有正文的答复')
  })

  it('不把非真人来源的 user 消息当成「你说的话」', async () => {
    const file = writeSession('feishu-oc_s4', [
      [userEvent('真人说的')],
      [userEvent('系统注入的', 'goal'), assistantEvent([{ type: 'text', text: '好的' }])],
    ])
    const preview = await readSessionPreview(file)
    expect(preview?.lastUser).toBe('真人说的')
  })

  it('读不到文件时安静地返回 undefined', async () => {
    await expect(readSessionPreview(join(tmpdir(), 'dsh-prev-missing', 'nope.zstd'))).resolves.toBeUndefined()
  })

  it('空文件返回 undefined 而不是抛错', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-prev-'))
    const dir = join(home, 'sessions', '--D-Work--', 'feishu-oc_s5')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.alloc(0))
    await expect(readSessionPreview(file)).resolves.toBeUndefined()
  })

  it('按 id 找到日志文件', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-prev-'))
    const file = writeSession('feishu-oc_s6:r1', [[fillerEvent(1)]], home)
    await expect(findSessionFile('feishu-oc_s6:r1', home)).resolves.toBe(file)
    await expect(findSessionFile('feishu-oc_s6:r404', home)).resolves.toBeUndefined()
  })

  it('批量读预览时读不到的占位为 undefined', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-prev-'))
    writeSession('feishu-oc_s7:r1', [[userEvent('在的')]], home)
    const previews = await readPreviews(['feishu-oc_s7:r1', 'feishu-oc_s7:missing'], { home })
    expect(previews[0]?.lastUser).toBe('在的')
    expect(previews[1]).toBeUndefined()
  })

  it('数出轮次、真人消息数和工具调用次数', async () => {
    const file = writeSession('feishu-oc_s8', [
      [turnEvent(1), userEvent('第一句'), toolEvent(1), toolEvent(2)],
      [turnEvent(2), userEvent('第二句'), toolEvent(3)],
      [turnEvent(3), userEvent('第三句')],
    ])
    const preview = await readSessionPreview(file)
    expect(preview?.turns).toBe(3)
    expect(preview?.userMessages).toBe(3)
    expect(preview?.toolCalls).toBe(3)
    expect(preview?.bytes).toBeGreaterThan(0)
  })

  it('轮次按 turn 号去重，重复写下的同一轮只算一次', async () => {
    const file = writeSession('feishu-oc_s9', [
      [turnEvent(1), userEvent('先说')],
      // 重放会再写一遍同一轮的 turn/start，直接数事件数会多算。
      [turnEvent(1), turnEvent(2), userEvent('再说')],
    ])
    const preview = await readSessionPreview(file)
    expect(preview?.turns).toBe(2)
    expect(preview?.userMessages).toBe(2)
  })

  it('计数纵览全量，不受尾部帧数上限影响', async () => {
    // 只有 1 帧可读、但那一帧之外的事件不该被忽略。
    const frames = [[turnEvent(1), userEvent('开头')]]
    for (let n = 2; n <= 20; n += 1) frames.push([turnEvent(n), userEvent(`第 ${n} 句`)])
    const file = writeSession('feishu-oc_s10', frames)
    const preview = await readSessionPreview(file, { maxFrames: 1 })
    expect(preview?.turns).toBe(20)
    expect(preview?.userMessages).toBe(20)
    // 尾部预览仍只取了最后那一段。
    expect(preview?.lastUser).toBe('第 20 句')
  })
})

describe('会话规模描述', () => {
  it('把规模写成一行', () => {
    const line = describeScale({ turns: 54, userMessages: 39, toolCalls: 3889, bytes: 8_290_000 })
    // 去掉兆字节的尾数，避免不同平台格式化差异影响断言。
    expect(line.startsWith('54 轮 · 你说了 39 句 · 3889 次工具调用 · ')).toBe(true)
  })

  it('没有的项不占位', () => {
    expect(describeScale({ turns: 3 })).toBe('3 轮')
    expect(describeScale({})).toBe('')
  })

  it('轮次为 0 的会话不写「0 轮」', () => {
    expect(describeScale({ turns: 0, userMessages: 0, bytes: 1024 })).toBe('1.0 KB')
  })

  it('字节数按习惯单位写', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(8_290_000)).toBe('7.9 MB')
  })

  it('历时按小时或天写', () => {
    const hour = 3_600_000
    expect(describeSpan({ startedAt: 0, lastActivity: hour * 5 })).toBe('5 小时')
    expect(describeSpan({ startedAt: 0, lastActivity: hour * 24 * 3 })).toBe('3.0 天')
    expect(describeSpan({ startedAt: 0, lastActivity: 1000 })).toBe('不到 1 小时')
    expect(describeSpan({ startedAt: 0 })).toBe('')
  })
})

describe('预览文本整理', () => {
  it('剥掉独占一行的发送者信封', () => {
    expect(stripEnvelope('陈佳免: [2026-11-04 15:07:36 (+08:00) · 距上一轮 2 分钟前]\n按对长期最有利的方式做'))
      .toBe('按对长期最有利的方式做')
  })

  it('剥掉挤在一行的发送者前缀', () => {
    expect(stripEnvelope('ou_e8d54820c8aa2d69e042bc5ac1f3d33f: 打开这个目录')).toBe('打开这个目录')
  })

  it('正文自己带中文冒号时不动它', () => {
    expect(stripEnvelope('注意: 这里有坑')).toBe('注意: 这里有坑')
  })

  it('压平换行并截断', () => {
    expect(condense('第一行\n第二行\n\n第三行', 100)).toBe('第一行 第二行 第三行')
    expect(condense('一二三四五六七八九十', 5)).toBe('一二三四五…')
  })

  it('会话目录名把冒号编码成 ~003A', () => {
    expect(sessionDirName('feishu-oc_abc:r123')).toBe('feishu-oc_abc~003Ar123')
    expect(sessionDirName('feishu-oc_abc')).toBe('feishu-oc_abc')
  })
})
