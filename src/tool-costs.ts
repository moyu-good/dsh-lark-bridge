/**
 * 把「工具说明」那一大块 token 拆到每个工具上。
 *
 * `contextBreakdown.toolsTokens` 是宿主按
 * `ceil(JSON.stringify(header.tools).length / 4) + 4` 算出的整块数字，接口里
 * 没有逐工具明细。但算它的原料——最近一条 `request/header` 事件里的
 * `header.tools`——就躺在会话日志里，桥按同一公式拆一遍，各工具之和便与那块
 * 总数对得上（差一个固定的 JSON 框架开销）。
 *
 * 这件事 `/context` 需要：只知道「工具说明 55,000」没法决定关哪个 MCP，
 * 知道「其中 chrome 那个 12,000」才有可操作性。
 */

import type { HostSession, HostSessionEvent } from './host.ts'
import type { ToolCost } from './notices.ts'

/** 宿主估算文本密度的固定启发式：4 字符 1 token（`dsh-token-meter`）。 */
const CHARS_PER_TOKEN = 4

/** `request/header` 事件里我们关心的那一小块。 */
interface HeaderEventData {
  readonly header?: {
    readonly tools?: readonly unknown[]
  }
}

function nameOf(tool: unknown): string {
  const name = (tool as { name?: unknown } | null)?.name
  return typeof name === 'string' && name !== '' ? name : '(未命名工具)'
}

/**
 * 读最近一条请求头里的工具定义，按占用降序返回。
 *
 * 从日志尾部往前找：请求头只在变化时落盘，所以最近一条就是当前生效的那份；
 * 工具一直没变时它会离尾部很远，因此不设扫描上限——一次纯内存遍历，
 * 比"扫到一半放弃、报个偏小的数"诚实。
 * @param session - 要回放的会话。
 * @returns 逐工具占用；会话还没有任何请求头时 `undefined`（不是空数组：
 *   「没跑过」和「一个工具都没挂」是两件事）。
 */
export function readToolCosts(session: HostSession): ToolCost[] | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq) as HostSessionEvent | undefined
    if (event?.type !== 'request/header') continue
    const tools = (event.data as HeaderEventData | undefined)?.header?.tools
    if (!Array.isArray(tools) || tools.length === 0) return []
    return tools
      .map(tool => ({
        name: nameOf(tool),
        tokens: Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN),
      }))
      .sort((a, b) => b.tokens - a.tokens)
  }
  return undefined
}
