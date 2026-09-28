#!/usr/bin/env node
/**
 * 系统性契约排查：把 src/host.ts 镜像的上游契约逐项与本地 0.1.7 实际源码比对。
 *
 * 与 verify-dsh-contract.mjs 的区别：
 *   - 那个查"上游有没有某个签名"（按已知清单，漏项就抓不到）
 *   - 这个查"桥接镜像的每一项，在 0.1.7 里还在不在、签名变没变"
 *
 * 用法: node scripts/audit-host-contract.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

// 用环境变量定位 dsh 安装，不硬编码机器相关路径（仓库 hygiene 规则禁止 WSL 挂载路径）。
const DSH_ROOT = process.env.DSH_HOME
  ?? resolvePath(process.env.HOME ?? '/root', '..', '..', 'PROJECT', 'deepseek-harness-0.1.7-rc.2')
const DSH = join(DSH_ROOT, 'node_modules', '@deepseek-ai')
const HOST = readFileSync(new URL('../src/host.ts', import.meta.url), 'utf8')

/** host.ts 里镜像的服务名 → 0.1.7 里对应的包 */
const SERVICES = {
  HostJobs: 'dsh-jobs',
  HostAgentPresets: 'dsh-agent-preset-registry',
  HostCommands: 'dsh-commands',
  HostSessionPersistence: 'dsh-session-persistence',
  HostWorkspaceRegistry: 'dsh-workspace',
  HostSkills: 'dsh-skill',
  HostAttachments: 'dsh-attachment',
  HostSettings: 'dsh-settings',
  HostTools: 'dsh-tools',
}

/** 从 host.ts 抽一个 interface 的方法签名 */
function methodNames(iface) {
  const m = HOST.match(new RegExp(`export interface ${iface}\\b[\\s\\S]*?\\n}`))
  if (!m) return []
  return [...m[0].matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*[?:]?\s*\(/gm)]
    .map(x => x[1])
}

function findPackageSource(pkg) {
  const root = join(DSH, pkg, 'lib', 'types')
  if (!existsSync(root)) return null
  // 优先 index.d.ts，否则合并 types 目录下全部 d.ts
  const idx = join(root, 'index.d.ts')
  if (existsSync(idx)) return readFileSync(idx, 'utf8')
  const parts = []
  for (const f of readdirSync(root)) {
    if (f.endsWith('.d.ts')) parts.push(readFileSync(join(root, f), 'utf8'))
  }
  return parts.length > 0 ? parts.join('\n') : null
}

console.log('='.repeat(76))
console.log('host.ts 契约系统性排查（对照本地 dsh 0.1.7-rc.2）')
console.log('='.repeat(76))

let missing = 0
let checked = 0

for (const [iface, pkg] of Object.entries(SERVICES)) {
  const methods = methodNames(iface)
  if (methods.length === 0) {
    console.log(`\n⚠ ${iface}: host.ts 里没抽到方法（可能不是方法式接口）`)
    continue
  }
  const src = findPackageSource(pkg)
  if (src === null) {
    console.log(`\n? ${iface} → ${pkg}: 包未找到，跳过`)
    continue
  }
  console.log(`\n【${iface}】→ ${pkg}`)
  for (const fn of methods) {
    checked += 1
    const re = new RegExp(`\\b${fn}\\s*[(:<]`)
    const ok = re.test(src)
    if (!ok) missing += 1
    console.log(`   ${ok ? '✅' : '❌'} ${fn}`)
  }
}

console.log('\n' + '='.repeat(76))
console.log(`检查 ${checked} 个方法，${missing} 个在 0.1.7 中找不到`)
console.log('='.repeat(76))
