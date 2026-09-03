/**
 * Cross-profile settings single source for the bridge.
 *
 * DSH Desktop 2.0.0 keeps a separate `desktop` profile from the `web` profile
 * (upstream dsh-desktop#93): sessions and themes already live in the shared
 * `~/.dsh` home, but per-profile configuration does not. This store puts the
 * bridge's own bot settings into that shared home so both forms read one
 * truth, while the host-injected profile configuration stays the boot-time
 * base that the shared file overlays.
 *
 * Two hosts must never corrupt each other (upstream deepseek-harness#1485
 * showed concurrent writers destroying shared state), so every write is:
 * backup → atomic tmp+rename, and cross-process contention goes through an
 * O_EXCL lockfile with stale-lock takeover.
 * @module dsh-lark-bridge/sync/settings-store
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
/** Fields the shared store is allowed to carry. Keep in step with `Config`. */
export const SHARED_KEYS = [
    'appId', 'appSecret', 'domain', 'locale', 'cwd', 'provider', 'model',
];
const DIR_NAME = 'dsh-lark-bridge';
const FILE_NAME = 'settings.json';
const LOCK_NAME = 'settings.lock';
const LOCK_STALE_MS = 10_000;
/** Absolute path of the shared sync directory (`$DSH_HOME/dsh-lark-bridge`). */
export function syncDir(home) {
    // DSH_SYNC_HOME exists because the two forms rarely share one harness home:
    // the web form runs in WSL (/root/.dsh) while the Desktop app uses the
    // Windows home. Pointing both at the same directory (e.g. the Windows home
    // through the /mnt/c mount) restores the single source the sync relies on.
    const base = process.env.DSH_SYNC_HOME
        ?? home
        ?? process.env.DSH_HOME
        ?? path.join(os.homedir(), '.dsh');
    return path.join(base, DIR_NAME);
}
/** Absolute path of the shared settings file. */
export function settingsFile(home) {
    return path.join(syncDir(home), FILE_NAME);
}
/**
 * Read the shared settings document, or `{}` when absent/corrupt. A corrupt
 * file is quarantined (renamed `.corrupt-<ts>`) rather than trusted or
 * silently discarded — the operator can diff it after the fact.
 */
export async function readSettings(home) {
    const file = settingsFile(home);
    let raw;
    try {
        raw = await fsp.readFile(file, 'utf8');
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error();
        return parsed;
    }
    catch {
        await fsp.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => { });
        return {};
    }
}
/**
 * Atomically replace the shared document. Writes go tmp+rename so a reader on
 * the other host never sees a torn file; the previous document is kept as a
 * timestamped backup for last-writer-wins archaeology.
 */
export async function writeSettings(settings, home) {
    const dir = syncDir(home);
    await fsp.mkdir(dir, { recursive: true });
    const file = settingsFile(home);
    const clean = {};
    for (const key of SHARED_KEYS) {
        const value = settings[key];
        if (typeof value === 'string' && value !== '')
            clean[key] = value;
    }
    const payload = `${JSON.stringify(clean, null, 2)}\n`;
    await fsp.copyFile(file, `${file}.bak-${Date.now()}`).catch(() => { });
    const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
    await fsp.writeFile(tmp, payload, { mode: 0o600 });
    await fsp.rename(tmp, file);
}
/**
 * Merge the shared document over a host-injected overlay: the shared file is
 * what the operator last touched from either end, so it wins per key.
 */
export function mergeSettings(base, shared) {
    return { ...base, ...shared };
}
/**
 * Acquire the directory lock, run `body`, release. Cross-process contention
 * resolves by stale takeover: a lock older than {@link LOCK_STALE_MS} belongs
 * to a dead writer and is taken over. Same-process re-entry rejects — callers
 * serialize their own workflows.
 */
export async function withLock(home, body) {
    const dir = syncDir(home);
    await fsp.mkdir(dir, { recursive: true });
    const lock = path.join(dir, LOCK_NAME);
    for (;;) {
        try {
            const fd = fs.openSync(lock, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
            fs.closeSync(fd);
            break;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            const stat = await fsp.stat(lock).catch(() => null);
            if (stat === null)
                continue;
            if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                await fsp.unlink(lock).catch(() => { });
                continue;
            }
            await sleep(50);
        }
    }
    try {
        return await body();
    }
    finally {
        await fsp.unlink(lock).catch(() => { });
    }
}
/**
 * Read-modify-write the shared document under the lock. The mutator receives
 * the current document and returns the replacement; `undefined` means "leave
 * the file alone".
 */
export async function updateSettings(home, mutate) {
    return withLock(home, async () => {
        const current = await readSettings(home);
        const next = mutate(current);
        if (next !== undefined)
            await writeSettings(next, home);
        return next === undefined ? current : next;
    });
}
/**
 * Mask a credential for any UI or log surface: keep the last four characters,
 * never the secret itself. Short values collapse entirely.
 */
export function maskSecret(value) {
    if (value === undefined || value === '')
        return '';
    if (value.length <= 4)
        return '****';
    return `****${value.slice(-4)}`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=settings-store.js.map