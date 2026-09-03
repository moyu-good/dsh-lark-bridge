/**
 * Read a dsh profile's plugin manifest. A profile's manifest is its
 * `package.json`: `dependencies` are the installed plugin packages and
 * `dsh.profile.bundles` the active bundle list — exactly the unit the two
 * profile forms (web vs desktop) drift apart on (upstream dsh-desktop#93).
 * @module dsh-lark-bridge/sync/profile-manifest
 */
/** The plugin manifest of one profile, narrowed to what sync needs. */
export interface ProfileManifest {
    /** Profile directory name (`web`, `desktop`, …). */
    profile: string;
    /** Installed packages: name → version spec (includes non-plugin deps). */
    dependencies: Record<string, string>;
    /** Active bundle list from `dsh.profile.bundles`. */
    bundles: string[];
    /** Epoch ms of the manifest file's last modification. */
    mtimeMs: number;
}
/** Where dsh keeps profiles inside the harness home. */
export declare function profilesDir(harnessHome: string): string;
/**
 * Read one profile's manifest. Missing profile (e.g. desktop not installed on
 * this host) resolves `null` — a legitimate state the sync surface presents
 * as "the other end has no such profile yet", not an error.
 */
export declare function readProfileManifest(harnessHome: string, profile: string): Promise<ProfileManifest | null>;
/** One side of a manifest diff: packages present only on that side. */
export interface ManifestDiff {
    /** Package specs to install here (present there, absent or older here). */
    toInstall: {
        name: string;
        version: string;
    }[];
    /** Active there but not in this profile's bundle list. */
    bundlesToEnable: string[];
}
/**
 * Diff two manifests from the perspective of "here" adopting "there".
 * Bridge-internal packages (cordis runtime, the bridge itself) are excluded:
 * they are per-profile machinery, not community plugins a sync should move.
 */
export declare function diffManifests(here: ProfileManifest, there: ProfileManifest, options?: {
    exclude?: readonly string[];
}): ManifestDiff;
//# sourceMappingURL=profile-manifest.d.ts.map