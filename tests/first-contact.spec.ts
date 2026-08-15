import { describe, expect, it } from 'vitest'
import {
  commandGuide,
  onboardingMessage,
  onboardingText,
  permissionPosture,
  postureLine,
} from '../src/first-contact.ts'

describe('first-contact', () => {
  it('defaults the posture to workspace-write without the environment knob', () => {
    expect(permissionPosture({})).toBe('workspace-write')
  })

  it('reads danger-full-access from the environment knob', () => {
    expect(permissionPosture({ DSH_PERMISSION_MODE: 'danger-full-access' })).toBe('danger-full-access')
  })

  it('describes danger-full-access honestly in the guide', () => {
    const line = postureLine('danger-full-access')
    expect(line).toContain('全自动')
    expect(line).toContain('同等文件权限')
  })

  it('describes workspace-write as card-approval mode', () => {
    expect(postureLine('workspace-write')).toContain('弹卡片')
  })

  it('renders a complete guide with commands', () => {
    const text = onboardingText('workspace-write')
    expect(text).toContain('/help')
    expect(text).toContain('/stop')
    expect(text).toContain('/plan')
    expect(text).toContain('权限')
  })

  it('renders the markdown message for a fresh session', () => {
    const msg = onboardingMessage({ DSH_PERMISSION_MODE: 'danger-full-access' })
    expect(msg.markdown).toContain('全自动模式')
  })

  it('tells a first user that /permission without an argument is not a menu', () => {
    const guide = commandGuide('workspace-write')
    expect(guide).toContain('不带参数只显示当前状态')
    expect(guide).toContain('不是选项菜单')
    expect(guide).toContain('/permission danger-full-access')
  })

  it('tells a first user what approval cards are for and to click them', () => {
    const guide = commandGuide('workspace-write')
    expect(guide).toContain('点卡片上的按钮')
    expect(guide).toContain('不点它会一直等')
  })

  it('states the current mode when it is danger-full-access', () => {
    const guide = commandGuide('danger-full-access')
    expect(guide).toContain('已是全自动模式')
  })
})
