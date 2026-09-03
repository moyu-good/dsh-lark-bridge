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
/** Fields the shared store is allowed to carry. Keep in step with `Config`. */
export declare const SHARED_KEYS: readonly ["appId", "appSecret", "domain", "locale", "cwd", "provider", "model"];
/** One stored settings document: exactly the shared keys that were set. */
export type SharedSettings = Partial<Record<(typeof SHARED_KEYS)[number], string>>;
/** The per-host overlay merged under the shared document. */
export type ConfigOverlay = Partial<Record<(typeof SHARED_KEYS)[number], string>>;
/** Absolute path of the shared sync directory (`$DSH_HOME/dsh-lark-bridge`). */
export declare function syncDir(home?: string): string;
/** Absolute path of the shared settings file. */
export declare function settingsFile(home?: string): string;
/**
 * Read the shared settings document, or `{}` when absent/corrupt. A corrupt
 * file is quarantined (renamed `.corrupt-<ts>`) rather than trusted or
 * silently discarded — the operator can diff it after the fact.
 */
export declare function readSettings(home?: string): Promise<SharedSettings>;
/**
 * Atomically replace the shared document. Writes go tmp+rename so a reader on
 * the other host never sees a torn file; the previous document is kept as a
 * timestamped backup for last-writer-wins archaeology.
 */
export declare function writeSettings(settings: SharedSettings, home?: string): Promise<void>;
/**
 * Merge the shared document over a host-injected overlay: the shared file is
 * what the operator last touched from either end, so it wins per key.
 */
export declare function mergeSettings(base: ConfigOverlay, shared: SharedSettings): ConfigOverlay;
/**
 * Acquire the directory lock, run `body`, release. Cross-process contention
 * resolves by stale takeover: a lock older than {@link LOCK_STALE_MS} belongs
 * to a dead writer and is taken over. Same-process re-entry rejects — callers
 * serialize their own workflows.
 */
export declare function withLock<T>(home: string | undefined, body: () => Promise<T>): Promise<T>;
/**
 * Read-modify-write the shared document under the lock. The mutator receives
 * the current document and returns the replacement; `undefined` means "leave
 * the file alone".
 */
export declare function updateSettings(home: string | undefined, mutate: (current: SharedSettings) => SharedSettings | undefined): Promise<SharedSettings>;
/**
 * Mask a credential for any UI or log surface: keep the last four characters,
 * never the secret itself. Short values collapse entirely.
 */
export declare function maskSecret(value: string | undefined): string;
//# sourceMappingURL=settings-store.d.ts.map