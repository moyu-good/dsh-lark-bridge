/**
 * First-contact guide: when a brand-new chat session is created, send a short
 * guide so a user who has never seen this bot knows what it is, what it can
 * do, and what its permission posture is. Existing sessions (resumed across
 * restarts) never get a second copy — the message fires only on `create`,
 * not on `resume`.
 * @module dsh-lark-bridge/first-contact
 */

/** The sandbox/permission mode the deployment runs under. */
export type PermissionPosture = 'workspace-write' | 'danger-full-access' | 'read-only' | string

/**
 * Derive the permission posture from the same environment knob dsh-base reads
 * (`DSH_PERMISSION_MODE`, default `workspace-write`), so the guide always
 * matches what the session actually enforces.
 * @param env - process environment (injectable for tests).
 * @returns the posture name, defaulting to `workspace-write`.
 */
export function permissionPosture(env: NodeJS.ProcessEnv = process.env): PermissionPosture {
  return env.DSH_PERMISSION_MODE ?? 'workspace-write'
}

/**
 * One sentence describing what the current posture means to the human in the
 * chat.
 */
export function postureLine(posture: PermissionPosture): string {
  switch (posture) {
    case 'danger-full-access':
      return '全自动模式：命令直接执行，不再逐条确认。它和你拥有同等文件权限，请只在你信任的环境使用。'
    case 'read-only':
      return '只读模式：不会修改任何文件，但读取范围仍限工作区。'
    case 'workspace-write':
      return '工作区模式：工作区内可写，工作区外的操作会弹卡片请你确认。'
    default:
      return `当前权限模式：${posture}。`
  }
}

/**
 * Render the first-contact guide for a brand-new session.
 * @param posture - the deployment's permission posture.
 * @returns the markdown message to send into the chat.
 */
export function onboardingText(posture: PermissionPosture): string {
  return [
    '**你好，我是跑在飞书里的编码智能体（DeepSeek Harness）。**',
    '',
    '直接说你要做的事，我会调用工具（终端/文件/搜索等）去完成。',
    '',
    `权限：${postureLine(posture)}`,
    '',
    '常用命令：',
    '- `/help` 查看全部可用命令',
    '- `/stop` 停止当前任务',
    '- `/plan` 先出计划再执行',
    '',
    '开始吧——发一句话试试。',
  ].join('\n')
}

/** The first-contact message, as a plain object for `port.send({ markdown })`. */
export function onboardingMessage(env: NodeJS.ProcessEnv = process.env): { markdown: string } {
  return { markdown: onboardingText(permissionPosture(env)) }
}
