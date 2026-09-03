/**
 * Device migration — moving a bridge installation (Feishu credentials, shared
 * settings, per-profile plugin lists) from one machine to another. The
 * export is a constructed JSON document, so the live state that must never
 * travel (peer heartbeats, rotating control tokens, lock files,
 * node_modules) is excluded by construction rather than by filtering. See
 * docs/design/设计卡_设备迁移与多机.md.
 * @module dsh-lark-bridge/sync/migrate
 */
import type { SharedSettings } from './settings-store.ts';
import type { ProfileManifest } from './profile-manifest.ts';
import type { SyncPlan } from './plugin-sync.ts';
/** Identifies a well-formed migration document. */
export declare const MIGRATION_KIND = "dsh-lark-bridge-migration";
/** Bump when the document shape changes; import rejects anything else. */
export declare const MIGRATION_VERSION = 1;
/** Settings keys that are credentials and get masked by default. */
export declare const SECRET_KEYS: readonly ["appSecret"];
/** The migration document itself. */
export interface MigrationFile {
    kind: typeof MIGRATION_KIND;
    version: typeof MIGRATION_VERSION;
    exportedAt: string;
    from: {
        profile: string;
        form: string;
        host: string;
    };
    settings: SharedSettings;
    /** Plugin lists per profile: installed packages + active bundles. */
    profiles: Record<string, {
        dependencies: Record<string, string>;
        bundles: string[];
    }>;
    notes?: Record<string, string>;
}
export interface ExportOptions {
    /** Include credentials verbatim instead of masked (default: masked). */
    includeSecrets?: boolean;
    /** Extra profiles to capture beyond the one this instance runs under. */
    profiles?: readonly string[];
}
/** One profile's plugin list, narrowed for travel. */
export interface TraveledProfile {
    dependencies: Record<string, string>;
    bundles: string[];
}
/** Collect the export document from live local state. */
export declare function buildMigration(home: string | undefined, harnessHome: string, profile: string, form: 'web' | 'desktop', options?: ExportOptions): Promise<MigrationFile>;
/** Absolute path of the default landing file for migrations. */
export declare function migrationFilePath(home?: string): string;
/**
 * Resolve the file to import: no argument means the default landing file;
 * an argument must be a bare file name inside the sync directory — path
 * traversal would turn a chat command into an arbitrary file read.
 */
export declare function resolveMigrationFile(name: string | undefined, home?: string): string;
/** Parse and validate an untrusted document. Throws with a readable reason. */
export declare function validateMigration(parsed: unknown): MigrationFile;
/** Read + validate a migration document from the sync directory. */
export declare function readMigration(name: string | undefined, home?: string): Promise<MigrationFile>;
/**
 * Plan what importing `imported` means for the local `profile`: packages
 * missing locally (or pinned to another version) become `add` steps through
 * the upstream CLI; anything already present stays untouched. Reuses the
 * plugin-sync plan/apply pipeline so semantics never fork.
 */
export declare function buildImportPlan(local: ProfileManifest | null, profile: string, imported: TraveledProfile): SyncPlan;
/**
 * The cross-host reminder text, or null when importing on the same machine.
 * Same-Feishu-app double delivery is the one migration mistake that bites
 * immediately and confusingly, so the import reply always carries it.
 */
export declare function crossHostWarning(file: MigrationFile): string | null;
/** Local device lifecycle state. */
export interface DeviceState {
    retired?: boolean;
    retiredAt?: string;
    activatedAt?: string;
    note?: string;
}
/** Absolute path of this machine's device-state file. */
export declare function deviceStateFile(home?: string): string;
/** Read this machine's device state, or `{}` when absent/corrupt. */
export declare function readDeviceState(home?: string): Promise<DeviceState>;
/** Persist this machine's device state. */
export declare function writeDeviceState(state: DeviceState, home?: string): Promise<void>;
//# sourceMappingURL=migrate.d.ts.map