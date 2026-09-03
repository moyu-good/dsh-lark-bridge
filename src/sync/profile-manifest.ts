/**
 * Read a dsh profile's plugin manifest. A profile's manifest is its
 * `package.json`: `dependencies` are the installed plugin packages and
 * `dsh.profile.bundles` the active bundle list — exactly the unit the two
 * profile forms (web vs desktop) drift apart on (upstream dsh-desktop#93).
 * @module dsh-lark-bridge/sync/profile-manifest
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** The plugin manifest of one profile, narrowed to what sync needs. */
export interface ProfileManifest {
  /** Profile directory name (`web`, `desktop`, …). */
  profile: string
  /** Installed packages: name → version spec (includes non-plugin deps). */
  dependencies: Record<string, string>
  /** Active bundle list from `dsh.profile.bundles`. */
  bundles: string[]
  /** Epoch ms of the manifest file's last modification. */
  mtimeMs: number
}

/** Where dsh keeps profiles inside the harness home. */
export function profilesDir(harnessHome: string): string {
  return path.join(harnessHome, 'profiles')
}

/**
 * Read one profile's manifest. Missing profile (e.g. desktop not installed on
 * this host) resolves `null` — a legitimate state the sync surface presents
 * as "the other end has no such profile yet", not an error.
 */
export async function readProfileManifest(
  harnessHome: string,
  profile: string,
): Promise<ProfileManifest | null> {
  const file = path.join(profilesDir(harnessHome), profile, 'package.json')
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return null
  }
  let parsed: {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const stat = await fsp.stat(file).catch(() => null)
  return {
    profile,
    dependencies: parsed.dependencies ?? {},
    bundles: parsed.dsh?.profile?.bundles ?? [],
    mtimeMs: stat?.mtimeMs ?? 0,
  }
}

/** One side of a manifest diff: packages present only on that side. */
export interface ManifestDiff {
  /** Package specs to install here (present there, absent or older here). */
  toInstall: { name: string; version: string }[]
  /** Active there but not in this profile's bundle list. */
  bundlesToEnable: string[]
}

/**
 * Diff two manifests from the perspective of "here" adopting "there".
 * Bridge-internal packages (cordis runtime, the bridge itself) are excluded:
 * they are per-profile machinery, not community plugins a sync should move.
 */
export function diffManifests(
  here: ProfileManifest,
  there: ProfileManifest,
  options?: { exclude?: readonly string[] },
): ManifestDiff {
  const exclude = new Set(options?.exclude ?? [])
  const toInstall: { name: string; version: string }[] = []
  for (const [name, version] of Object.entries(there.dependencies)) {
    if (exclude.has(name)) continue
    const local = here.dependencies[name]
    if (local === undefined || local !== version) toInstall.push({ name, version })
  }
  const hereBundles = new Set(here.bundles)
  const bundlesToEnable = there.bundles.filter((bundle) => !hereBundles.has(bundle))
  return { toInstall, bundlesToEnable }
}
