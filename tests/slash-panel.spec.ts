import { describe, expect, it } from 'vitest'
import { syncSlashPanel } from '../src/slash-panel.ts'
import type { PanelCommand, SlashPanelPort } from '../src/slash-panel.ts'

/** A fake panel port recording every mutation. */
function fakePort(existing: PanelCommand[]) {
  const state = [...existing]
  const created: { name: string; description: string }[] = []
  const deleted: string[] = []
  const port: SlashPanelPort = {
    async listSlashCommands() {
      return [...state]
    },
    async createSlashCommand(name: string, description: string) {
      created.push({ name, description })
      state.push({ command: name, commandId: `id-${state.length + 1}`, description })
    },
    async deleteSlashCommand(commandId: string) {
      deleted.push(commandId)
      const index = state.findIndex(entry => entry.commandId === commandId)
      if (index >= 0) state.splice(index, 1)
    },
  }
  return { port, created, deleted, state }
}

const notify = (): void => {}

describe('syncSlashPanel', () => {
  it('creates missing commands and removes stale ones', async () => {
    const { port, created, deleted } = fakePort([
      { command: 'old', commandId: 'id-old' },
    ])
    const result = await syncSlashPanel(port, [
      { name: 'goal', description: '查看/设置目标' },
      { name: 'stop', description: '停止当前任务' },
    ], notify)
    expect(result.added).toEqual(['goal', 'stop'])
    expect(result.removed).toEqual(['old'])
    expect(deleted).toEqual(['id-old'])
  })

  it('leaves a matching command untouched', async () => {
    const { port, created, deleted } = fakePort([
      { command: 'goal', commandId: 'id-goal', description: '查看/设置目标' },
    ])
    const result = await syncSlashPanel(port, [
      { name: 'goal', description: '查看/设置目标' },
    ], notify)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(created).toEqual([])
    expect(deleted).toEqual([])
  })

  it('refreshes a command whose description drifted (locale switch, old boot)', async () => {
    const { port, created, deleted } = fakePort([
      { command: 'goal', commandId: 'id-goal', description: 'set or view the goal for a long-running task' },
    ])
    const result = await syncSlashPanel(port, [
      { name: 'goal', description: '查看/设置目标' },
    ], notify)
    // The platform has no update verb: drift is one delete + one create.
    expect(result.added).toEqual(['goal'])
    expect(result.removed).toEqual([])
    expect(deleted).toEqual(['id-goal'])
    expect(created).toEqual([{ name: 'goal', description: '查看/设置目标' }])
  })

  it('tolerates a listing that omits descriptions', async () => {
    const { port, created, deleted } = fakePort([
      { command: 'goal', commandId: 'id-goal' },
    ])
    const result = await syncSlashPanel(port, [
      { name: 'goal', description: '查看/设置目标' },
    ], notify)
    // Unknown previous description is not treated as a drift.
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(created).toEqual([])
    expect(deleted).toEqual([])
  })
})
