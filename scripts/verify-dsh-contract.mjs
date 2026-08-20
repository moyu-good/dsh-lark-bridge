#!/usr/bin/env node
/**
 * Contract drift gate: verifies that the structural copies in src/host.ts still
 * mirror the live DeepSeek Harness upstream branch. The bridge intentionally does
 * NOT import host source packages, so a host rename/removal would otherwise
 * break at runtime instead of in CI.
 *
 * Usage: node scripts/verify-dsh-contract.mjs
 * Exit 1 on drift or fetch failure.
 */

const RAW = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/'
const FILES = {
  agent: 'packages/core/agent/src/runtime-types.ts',
  goal: 'packages/goal/goal/src/domain.ts',
  subagent: 'packages/subagent/subagent/src/types.ts',
  workflow: 'packages/workflow/workflow/src/index.ts',
  jobs: 'packages/jobs/jobs/src/index.ts',
  feedback: 'packages/feedback/message-feedback/src/types.ts',
}

const checks = [
  {
    name: 'Agent.cancel keeps the options signature',
    file: 'agent',
    pattern: /cancel\(cause: AgentCancelCause, options\?: CancelOptions\): void/,
  },
  {
    name: 'agent/status payload shape',
    file: 'agent',
    pattern: /'agent\/status'\(this: Scoped<Agent>, payload: \{ agent: Agent; status: AgentStatus \}\): void/,
  },
  {
    name: 'Goal clear tombstone survives',
    file: 'goal',
    pattern: /readonly cleared: GoalRef/,
  },
  {
    name: 'Subagent stop reasons stay completed|aborted|error|max-tokens',
    file: 'subagent',
    pattern: /completed: 'completed'[\s\S]*aborted: 'aborted'[\s\S]*error: 'error'[\s\S]*'max-tokens': 'max-tokens'/,
  },
  {
    name: 'workflow/log is a two-argument event',
    file: 'workflow',
    pattern: /'workflow\/log'\(info: WorkflowRunInfo, message: string\): void/,
  },
  {
    name: 'workflow/phase is a two-argument event',
    file: 'workflow',
    pattern: /'workflow\/phase'\(info: WorkflowRunInfo, title: string\): void/,
  },
  {
    name: 'jobs keeps the onJobDone listener contract',
    file: 'jobs',
    pattern: /abstract onJobDone\(listener: JobDoneListener\): \(\) => void/,
  },
  {
    name: 'jobs keeps the list(caller) contract',
    file: 'jobs',
    pattern: /abstract list\(caller\?: Agent\): JobSnapshot\[\]/,
  },
  {
    name: 'message feedback put request keeps its fields',
    file: 'feedback',
    pattern: /readonly sessionId: SessionId[\s\S]*readonly messageId: MessageId[\s\S]*readonly rating: MessageFeedbackRating[\s\S]*readonly ifVersion: MessageFeedbackVersion \| null/,
  },
]

const HOST_PATTERNS = [
  ['HostAgent.cancel mirrors options', /cancel\(cause: string, options\?: \{ readonly keepInbox\?: boolean \}\): void/],
  ['GoalChangeData carries cleared tombstone', /readonly cleared\?: \{ readonly id: string; readonly revision\?: number \}/],
  ['SubagentEndData stopReason union', /readonly stopReason: 'completed' \| 'aborted' \| 'error' \| 'max-tokens'/],
  ['workflow/log declared structurally', /'workflow\/log'\(info: WorkflowRunInfoData, message: string\): void/],
  ['workflow/phase declared structurally', /'workflow\/phase'\(info: WorkflowRunInfoData, title: string\): void/],
  ['AgentStatusData mirrors { agent, status }', /readonly agent: \{ readonly id: string \}/],
  ['HostJobs mirrors onJobDone', /onJobDone\(listener: HostJobDoneListener\): \(\) => void/],
  ['HostJobs mirrors list(caller)', /list\(caller\?: \{ readonly id: string \}\): readonly HostJobSnapshot\[\]/],
  ['HostMessageFeedback mirrors put', /put\(request: \{[\s\S]*readonly sessionId: string[\s\S]*readonly rating: 'positive' \| 'negative'/],
]

async function main() {
  const sources = {}
  for (const [key, path] of Object.entries(FILES)) {
    const res = await fetch(RAW + path)
    if (!res.ok) throw new Error(`fetch ${path} failed: HTTP ${res.status}`)
    sources[key] = await res.text()
  }
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../src/host.ts', import.meta.url), 'utf8')

  let failed = 0
  for (const check of checks) {
    const ok = check.pattern.test(sources[check.file])
    console.log(`${ok ? '  ✅' : '  ❌'} ${check.name}`)
    if (!ok) failed += 1
  }
  for (const [name, pattern] of HOST_PATTERNS) {
    const ok = pattern.test(host)
    console.log(`${ok ? '  ✅' : '  ❌'} host.ts: ${name}`)
    if (!ok) failed += 1
  }
  console.log(failed === 0 ? '\n契约无漂移（dsh 上游 master）' : `\n${failed} 项漂移`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`契约漂移检查失败：${error.message}`)
  process.exit(1)
})
