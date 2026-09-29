import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    // The channel tests are timing-sensitive: agent creation and control-API
    // fetches run against a clock, and parallel fork workers starve them. On a
    // loaded machine that surfaces as `vi.waitFor` timing out — an agent that
    // was never created — so the same revision passes or fails depending on
    // what else the box is doing. That costs more than the parallelism saves:
    // a red suite you cannot trust is worse than a slow green one.
    //
    // One fork, always. The whole suite is ~25s serial.
    testTimeout: 60_000,
    // Vitest 4 lifted these out of `poolOptions`; leaving them nested is
    // silently ignored, which puts the suite straight back on parallel
    // workers and brings the starvation flakes back with it.
    maxWorkers: 1,
    minWorkers: 1,
  },
})
