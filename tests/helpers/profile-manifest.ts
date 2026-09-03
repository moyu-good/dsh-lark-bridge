import fs from 'node:fs'
import path from 'node:path'
import type { ProfileManifest } from '../../src/sync/profile-manifest.ts'

/**
 * Materialize a profile manifest in a fake harness home, in the exact shape
 * `readProfileManifest` parses: `dependencies` plus `dsh.profile.bundles`.
 */
export function writeProfileManifest(harnessHome: string, profile: string, manifest: ProfileManifest): void {
  const dir = path.join(harnessHome, 'profiles', profile)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: manifest.dependencies,
    dsh: { profile: { bundles: manifest.bundles } },
  }, null, 2))
}
