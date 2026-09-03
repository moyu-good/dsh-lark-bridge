/**
 * Device migration — moving a bridge installation (Feishu credentials, shared
 * settings, per-profile plugin lists) from one machine to another. The
 * export is a constructed JSON document, so the live state that must never
 * travel (peer heartbeats, rotating control tokens, lock files,
 * node_modules) is excluded by construction rather than by filtering. See
 * docs/design/设计卡_设备迁移与多机.md.
 * @module dsh-lark-bridge/sync/migrate
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { maskSecret, readSettings, syncDir } from "./settings-store.js";
import { readProfileManifest } from "./profile-manifest.js";
/** Identifies a well-formed migration document. */
export const MIGRATION_KIND = 'dsh-lark-bridge-migration';
/** Bump when the document shape changes; import rejects anything else. */
export const MIGRATION_VERSION = 1;
/** Settings keys that are credentials and get masked by default. */
export const SECRET_KEYS = ['appSecret'];
/** Collect the export document from live local state. */
export async function buildMigration(home, harnessHome, profile, form, options) {
    const settings = await readSettings(home);
    const traveled = {};
    for (const [key, value] of Object.entries(settings)) {
        const isSecret = SECRET_KEYS.includes(key);
        traveled[key] =
            isSecret && !options?.includeSecrets ? maskSecret(value) : value;
    }
    const wanted = [profile, ...(options?.profiles ?? []).filter((p) => p !== profile)];
    const profiles = {};
    for (const name of wanted) {
        const manifest = await readProfileManifest(harnessHome, name);
        profiles[name] = manifest === null
            ? { dependencies: {}, bundles: [] }
            : { dependencies: manifest.dependencies, bundles: manifest.bundles };
    }
    return {
        kind: MIGRATION_KIND,
        version: MIGRATION_VERSION,
        exportedAt: new Date().toISOString(),
        from: { profile, form, host: os.hostname() },
        settings: traveled,
        profiles,
        notes: {
            hint: 'sessions live under ~/.dsh (upstream-owned); copy that directory to carry them — this file intentionally excludes live state (peers, tokens, node_modules)',
        },
    };
}
/** Absolute path of the default landing file for migrations. */
export function migrationFilePath(home) {
    return path.join(syncDir(home), 'migrate.json');
}
/**
 * Resolve the file to import: no argument means the default landing file;
 * an argument must be a bare file name inside the sync directory — path
 * traversal would turn a chat command into an arbitrary file read.
 */
export function resolveMigrationFile(name, home) {
    const dir = syncDir(home);
    if (name === undefined || name === '')
        return path.join(dir, 'migrate.json');
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || path.basename(name) !== name) {
        throw new Error(`非法文件名 \`${name}\`——只允许 sync 目录内的裸文件名`);
    }
    return path.join(dir, name);
}
/** Parse and validate an untrusted document. Throws with a readable reason. */
export function validateMigration(parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('迁移文件不是 JSON 对象');
    }
    const doc = parsed;
    if (doc.kind !== MIGRATION_KIND)
        throw new Error(`kind 不是 \`${MIGRATION_KIND}\`——这不是桥的迁移文件`);
    if (doc.version !== MIGRATION_VERSION)
        throw new Error(`版本 ${String(doc.version)} 不受支持（当前 ${MIGRATION_VERSION}）`);
    const from = doc.from;
    if (from === undefined || typeof from.host !== 'string')
        throw new Error('缺 from.host');
    if (typeof doc.exportedAt !== 'string')
        throw new Error('缺 exportedAt');
    if (doc.settings === null || typeof doc.settings !== 'object' || Array.isArray(doc.settings)) {
        throw new Error('settings 段缺失或形状不对');
    }
    if (doc.profiles === null || typeof doc.profiles !== 'object' || Array.isArray(doc.profiles)) {
        throw new Error('profiles 段缺失或形状不对');
    }
    return doc;
}
/** Read + validate a migration document from the sync directory. */
export async function readMigration(name, home) {
    const file = resolveMigrationFile(name, home);
    let raw;
    try {
        raw = await fsp.readFile(file, 'utf8');
    }
    catch {
        throw new Error(`读不到迁移文件 \`${file}\`——先把旧机 /bot export 的产物放进来`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('迁移文件不是合法 JSON');
    }
    return validateMigration(parsed);
}
/**
 * Plan what importing `imported` means for the local `profile`: packages
 * missing locally (or pinned to another version) become `add` steps through
 * the upstream CLI; anything already present stays untouched. Reuses the
 * plugin-sync plan/apply pipeline so semantics never fork.
 */
export function buildImportPlan(local, profile, imported) {
    const steps = [];
    for (const [name, spec] of Object.entries(imported.dependencies)) {
        if (local?.dependencies[name] === spec)
            continue;
        const pinned = spec.includes('@', 1) ? spec : `${name}@${spec}`;
        steps.push({
            kind: 'add',
            profile,
            spec: pinned,
            command: `dsh plugin --profile ${profile} add ${pinned}`,
        });
    }
    return { steps, inSync: Object.keys(local?.dependencies ?? {})
            .filter((name) => imported.dependencies[name] !== undefined
            && !steps.some((step) => step.spec.startsWith(`${name}@`))) };
}
/**
 * The cross-host reminder text, or null when importing on the same machine.
 * Same-Feishu-app double delivery is the one migration mistake that bites
 * immediately and confusingly, so the import reply always carries it.
 */
export function crossHostWarning(file) {
    if (file.from.host === os.hostname())
        return null;
    return `⚠️ 此文件来自 **${file.from.host}**。若旧机的桥仍在运行，请先停掉它——同一个飞书 appId 两台机器同时连接会导致消息双投递、双回复。`;
}
//# sourceMappingURL=migrate.js.map