import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  condense,
  findSessionFile,
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
