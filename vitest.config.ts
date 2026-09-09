import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    // CI runners are 2-core: parallel fork workers starve the timing-sensitive
    // channel tests (agent creation, control-API fetches), so CI runs files
    // serially while local machines keep the default parallelism.
    testTimeout: process.env.CI ? 60_000 : 30_000,
    poolOptions: {
      forks: { maxForks: process.env.CI ? 1 : undefined, minForks: 1 },
    },
  },
})
