#!/usr/bin/env node
/**
 * Clean the build output before a full rebuild.
 *
 * tsdown runs with `clean: false` (its entry points live INSIDE outDir —
 * the tsc-emitted `lib/types/*.js` — so tsdown's own clean would delete its
 * inputs), which leaves stale hashed chunks from earlier builds behind. This
 * script removes the whole output directory first so every build is fresh.
 */
import { rmSync } from 'node:fs'

rmSync('lib', { recursive: true, force: true })
