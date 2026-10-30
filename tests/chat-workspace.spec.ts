import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatWorkspaceFile, readChatWorkspaces, writeChatWorkspace } from '../src/chat-workspace.ts'

/**
 * 每个会话的工作区绑定必须活过重启——这是它存在的全部理由。
 * 用真实文件而不是 mock：tmp+rename 的原子性就是被测对象的一部分。
 */
describe('per-chat 工作区绑定', () => {
  /** 一个独立的 harness home。 */
  const home = () => mkdtempSync(join(tmpdir(), 'chat-ws-'))

  it('写入后能读回来', async () => {
    const dir = home()
    await writeChatWorkspace('oc_a', 'D:\\proj', dir)
    expect(await readChatWorkspaces(dir)).toEqual({ oc_a: 'D:\\proj' })
  })

  it('两个会话各绑各的，互不覆盖', async () => {
    const dir = home()
    await writeChatWorkspace('oc_a', 'D:\\a', dir)
    await writeChatWorkspace('oc_b', 'D:\\b', dir)
    expect(await readChatWorkspaces(dir)).toEqual({ oc_a: 'D:\\a', oc_b: 'D:\\b' })
  })

  it('传 null 解除绑定', async () => {
    const dir = home()
    await writeChatWorkspace('oc_a', 'D:\\a', dir)
    await writeChatWorkspace('oc_a', null, dir)
    expect(await readChatWorkspaces(dir)).toEqual({})
  })

  it('文件损坏时读成空表，而不是让桥起不来', async () => {
    const dir = home()
    const file = chatWorkspaceFile(dir)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'not json at all', 'utf8')
    expect(await readChatWorkspaces(dir)).toEqual({})
  })

  it('文件不存在时读成空表', async () => {
    expect(await readChatWorkspaces(home())).toEqual({})
  })
})
