import { describe, expect, it, vi } from 'vitest'

/**
 * `scheduleRestart` 的平台分支。
 *
 * 这里测的是真实实现，不是桩：原来的实现把 `/bin/sh` 写死，Windows 上
 * `spawn('/bin/sh', …)` 直接 ENOENT——命令根本没跑起来，`/restart` 在
 * Windows 上永远无效，配什么 `restartCommand` 都没用。这个文件锁住
 * 「Windows 走 PowerShell」这条契约，防止再写回 `/bin/sh`。
 */

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref() {} })),
}))

vi.mock('node:child_process', () => ({ spawn }))

/** 临时把 process.platform 换成给定值，返回还原函数。 */
function withPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => { Object.defineProperty(process, 'platform', original) }
}

describe('scheduleRestart 的平台分支', () => {
  it('POSIX 上用 /bin/sh，延迟交给子进程', async () => {
    const restore = withPlatform('linux')
    try {
      const { scheduleRestart } = await import('../src/commands.ts')
      spawn.mockClear()
      scheduleRestart('systemctl restart my-dsh.service')
      await vi.waitFor(() => { expect(spawn).toHaveBeenCalled() })

      const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
      expect(file).toBe('/bin/sh')
      expect(args.join(' ')).toContain('sleep 2.5')
      expect(args.join(' ')).toContain('systemctl restart my-dsh.service')
      // 必须脱离父进程：父进程马上会被杀掉，延迟得由子进程扛。
      expect(options).toMatchObject({ detached: true })
    } finally {
      restore()
    }
  })

  it('Windows 上用 PowerShell，绝不用 /bin/sh', async () => {
    const restore = withPlatform('win32')
    try {
      const { scheduleRestart } = await import('../src/commands.ts')
      spawn.mockClear()
      scheduleRestart('Restart-DshLark.ps1 -DelaySeconds 0')
      await vi.waitFor(() => { expect(spawn).toHaveBeenCalled() })

      const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
      expect(file).not.toBe('/bin/sh')
      expect(file).toBe('powershell.exe')
      // 延迟仍然要在子进程里等，不能靠父进程的 setTimeout。
      expect(args.join(' ')).toContain('Start-Sleep')
      expect(args.join(' ')).toContain('Restart-DshLark.ps1 -DelaySeconds 0')
      expect(options).toMatchObject({ detached: true })
      // 隐藏控制台窗口：计划任务和托盘里都不该闪一个黑框。
      expect(options).toMatchObject({ windowsHide: true })
    } finally {
      restore()
    }
  })
})
