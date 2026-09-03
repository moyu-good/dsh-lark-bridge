/**
 * Read a dsh profile's plugin manifest. A profile's manifest is its
 * `package.json`: `dependencies` are the installed plugin packages and
 * `dsh.profile.bundles` the active bundle list — exactly the unit the two
 * profile forms (web vs desktop) drift apart on (upstream dsh-desktop#93).
 * @module dsh-lark-bridge/sync/profile-manifest
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
/** Where dsh keeps profiles inside the harness home. */
export function profilesDir(harnessHome) {
    return path.join(harnessHome, 'profiles');
}
/**
 * Read one profile's manifest. Missing profile (e.g. desktop not installed on
 * this host) resolves `null` — a legitimate state the sync surface presents
 * as "the other end has no such profile yet", not an error.
 */
export async function readProfileManifest(harnessHome, profile) {
    const file = path.join(profilesDir(harnessHome), profile, 'package.json');
    let raw;
    try {
        raw = await fsp.readFile(file, 'utf8');
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const stat = await fsp.stat(file).catch(() => null);
    return {
        profile,
        dependencies: parsed.dependencies ?? {},
        bundles: parsed.dsh?.profile?.bundles ?? [],
        mtimeMs: stat?.mtimeMs ?? 0,
    };
}
/**
 * Diff two manifests from the perspective of "here" adopting "there".
 * Bridge-internal packages (cordis runtime, the bridge itself) are excluded:
 * they are per-profile machinery, not community plugins a sync should move.
 */
export function diffManifests(here, there, options) {
    const exclude = new Set(options?.exclude ?? []);
    const toInstall = [];
    for (const [name, version] of Object.entries(there.dependencies)) {
        if (exclude.has(name))
            continue;
        const local = here.dependencies[name];
        if (local === undefined || local !== version)
            toInstall.push({ name, version });
    }
    const hereBundles = new Set(here.bundles);
    const bundlesToEnable = there.bundles.filter((bundle) => !hereBundles.has(bundle));
    return { toInstall, bundlesToEnable };
}
//# sourceMappingURL=profile-manifest.js.map