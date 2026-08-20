/**
 * dsh-lark-bridge contract tests — 独立契约测试（不依赖 dsh 构建链）。
 *
 * 只测 lib/types 编译产物的纯函数 + 静态读源码检查模块契约。
 * 覆盖：session 键派生 / authorization 权限 / commands 命令解析 /
 * outbound 渲染守卫 / 模块导出契约。
 *
 * 用法: node plugin-contract-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ❌ ${name}: ${error.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed')
}

const session = await import('./lib/types/session.js')
const authorization = await import('./lib/types/authorization.js')
const commands = await import('./lib/types/commands.js')
const outbound = await import('./lib/types/outbound.js')

console.log('== session.ts: conversation key 派生 ==')
const msg = (over = {}) => ({
  messageId: 'om_1',
  chatId: 'oc_123',
  chatType: 'group',
  threadId: undefined,
  senderId: 'ou_456',
  senderName: '张三',
  content: 'hi',
  resources: [],
  ...over,
})
check('chat scope → chatId', () => {
  assert(session.conversationKey('chat', msg()) === 'oc_123')
})
check('chat-thread 无 thread → chatId', () => {
  assert(session.conversationKey('chat-thread', msg()) === 'oc_123')
})
check('chat-thread 有 thread → chatId:threadId', () => {
  assert(session.conversationKey('chat-thread', msg({ threadId: 'om_thread' })) === 'oc_123:om_thread')
})
check('chat-sender → chatId:senderId', () => {
  assert(session.conversationKey('chat-sender', msg()) === 'oc_123:ou_456')
})
check('sessionIdFor 前缀 feishu-', () => {
  assert(session.sessionIdFor('oc_123') === 'feishu-oc_123')
})
check('未知 scope 抛错', () => {
  let threw = false
  try { session.conversationKey('bogus', msg()) } catch { threw = true }
  assert(threw, 'should throw')
})

console.log('== authorization.ts: 权限收窄 ==')
const openAuth = authorization.resolveAuthorization({ senderAllowlist: [], groupAllowlist: [], approvers: [] })
check('空 allowlist 允许 p2p', () => {
  assert(authorization.refuseMessage(openAuth, { senderId: 'ou_x', chatId: 'oc_1', chatType: 'p2p' }) === undefined)
})
check('空 allowlist 允许任意群', () => {
  assert(authorization.refuseMessage(openAuth, { senderId: 'ou_x', chatId: 'oc_1', chatType: 'group' }) === undefined)
})
const narrowAuth = authorization.resolveAuthorization({ senderAllowlist: ['ou_a'], groupAllowlist: ['oc_g'], approvers: [] })
check('senderAllowlist 拦非白名单 p2p', () => {
  assert(authorization.refuseMessage(narrowAuth, { senderId: 'ou_b', chatId: 'oc_1', chatType: 'p2p' }) !== undefined)
})
check('senderAllowlist 放行白名单 p2p', () => {
  assert(authorization.refuseMessage(narrowAuth, { senderId: 'ou_a', chatId: 'oc_1', chatType: 'p2p' }) === undefined)
})
check('groupAllowlist 拦非白名单群', () => {
  assert(authorization.refuseMessage(narrowAuth, { senderId: 'ou_a', chatId: 'oc_other', chatType: 'group' }) !== undefined)
})
check('groupAllowlist 放行白名单群', () => {
  assert(authorization.refuseMessage(narrowAuth, { senderId: 'ou_a', chatId: 'oc_g', chatType: 'group' }) === undefined)
})
check('审批点击: 不同 chat 拒绝', () => {
  assert(authorization.refuseApprovalClick(openAuth, { operatorId: 'ou_a', chatId: 'oc_2' }, { chatId: 'oc_1', chatType: 'p2p' }) !== undefined)
})
check('审批点击: 同 chat 放行', () => {
  assert(authorization.refuseApprovalClick(openAuth, { operatorId: 'ou_a', chatId: 'oc_1' }, { chatId: 'oc_1', chatType: 'p2p' }) === undefined)
})

console.log('== commands.ts: 命令解析 ==')
check('isCommandLine /stop', () => {
  assert(commands.isCommandLine('/stop') === true)
})
check('isCommandLine 普通文本 false', () => {
  assert(commands.isCommandLine('帮我看看代码') === false)
})
check('commandName 解析小写', () => {
  assert(commands.commandName('/Help 列表') === 'help')
})
check('STOP/HELP 常量', () => {
  assert(commands.STOP_COMMAND === 'stop' && commands.HELP_COMMAND === 'help')
})

console.log('== outbound.ts: 工具调用标记清理 ==')
check('stripToolCallMarkup 移除 DSML 块', () => {
  const clean = outbound.stripToolCallMarkup('before <｜｜DSML｜｜tool_calls>{"x":1}</tool_calls> after')
  assert(!clean.includes('tool_calls>'), 'markup should be removed')
  assert(clean.includes('⚠️'), 'notice should be appended')
})
check('stripToolCallMarkup 无标记原样返回', () => {
  assert(outbound.stripToolCallMarkup('plain text') === 'plain text')
})
check('stripToolCallMarkup 未闭合截断', () => {
  const clean = outbound.stripToolCallMarkup('partial <｜｜DSML｜｜tool_calls>{"x"')
  assert(!clean.includes('tool_calls>'), 'unterminated markup removed')
})


console.log('== host.ts: P1 契约对齐 ==')
const host = await import('./lib/types/host.js')
check('agent/status guard', () => {
  assert(host.isAgentStatusEvent({ type: 'agent/status', data: { agentId: 'a', status: 'running' } }) === true)
  assert(host.isAgentStatusEvent({ type: 'turn/end', data: {} }) === false)
})
check('subagent/start guard', () => {
  assert(host.isSubagentStartEvent({ type: 'subagent/start', data: { subagentId: 's', parentId: 'p' } }) === true)
})
check('subagent/end guard', () => {
  assert(host.isSubagentEndEvent({ type: 'subagent/end', data: { subagentId: 's', parentId: 'p', outcome: 'completed' } }) === true)
})
check('skills/change guard', () => {
  assert(host.isSkillsChangeEvent({ type: 'skills/change', data: { skills: [] } }) === true)
})
check('workflow/log guard', () => {
  assert(host.isWorkflowLogEvent({ type: 'workflow/log', data: { runId: 'r', message: 'm' } }) === true)
})
check('workflow/phase guard', () => {
  assert(host.isWorkflowPhaseEvent({ type: 'workflow/phase', data: { runId: 'r', phase: 'p' } }) === true)
})
check('goal/change 兼容 clear 墓碑', () => {
  const ev = host.isGoalChangeEvent({ type: 'goal/change', data: { operation: 'clear', cleared: { id: 'g' }, clearedAt: 1 } })
  assert(ev === true)
})
const hostSrc = readFileSync(join(root, 'src', 'host.ts'), 'utf8')
check('host.ts cancel 签名含 options', () => assert(/cancel\(cause: string, options\?:/.test(hostSrc)))
check('host.ts GoalChange 支持 clear 墓碑', () => assert(/cleared\?:/.test(hostSrc)))

console.log('== 模块契约（静态读源码）==')
const srcFiles = ['index.ts', 'runtime.ts', 'invariant.ts', 'startup.ts']
for (const file of srcFiles) {
  const src = readFileSync(join(root, 'src', file), 'utf8')
  if (file === 'runtime.ts') {
    check('runtime.ts 是核心运行时', () => assert(/export function apply\(ctx: Context, config: Config\)/.test(src)))
  } else if (file === 'startup.ts') {
    check('startup.ts re-export 入口', () => assert(/export \{ name, Config, apply \} from '\.\/index\.ts'/.test(src)))
  } else {
    check(`${file} 导出 name`, () => assert(/export const name/.test(src)))
  }
  if (file === 'index.ts') {
    check('index.ts 导出 Config', () => assert(/export \{ Config \}/.test(src)))
    check('index.ts 导出 apply', () => assert(/export \{ apply \}/.test(src)))
    check('index.ts 声明 inject', () => assert(/export const inject/.test(src)))
  }
  if (file === 'invariant.ts') {
    check('invariant.ts 导出 apply', () => assert(/export const apply/.test(src)))
    check('invariant.ts 声明 inject', () => assert(/export const inject/.test(src)))
  }
}
const runtimeSrc = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8')
check('runtime.ts apply(ctx, config)', () => assert(/export function apply\(ctx: Context, config: Config\)/.test(runtimeSrc)))
check('runtime.ts 使用 createLarkChannel', () => assert(/createLarkChannel/.test(runtimeSrc)))

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
