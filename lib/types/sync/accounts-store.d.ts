/**
 * Named Feishu-account book for the bridge (`/bot account`).
 *
 * Switching accounts means swapping the Feishu自建应用 the bridge connects
 * as — distinct appId/appSecret pairs the operator keeps side by side (a
 * private app, a test app, a second identity). The book stores the pairs
 * under memorable names in the shared sync directory, so every form on the
 * machine sees the same roster and `/bot account use` is one command instead
 * of two error-prone `/bot set` calls with a pasted secret.
 *
 * The file is credentials at rest: same handling as settings.json — atomic
 * tmp+rename writes, posix 600, secrets masked in every reply.
 * @module dsh-lark-bridge/sync/accounts-store
 */
/** One saved Feishu app credential set. */
export interface StoredAccount {
    appId: string;
    appSecret: string;
    domain?: string | undefined;
    savedAt: string;
    note?: string | undefined;
}
/** The whole book: roster plus which name is currently applied. */
export interface AccountBook {
    active?: string | undefined;
    accounts: Record<string, StoredAccount>;
}
/** Absolute path of the shared account book. */
export declare function accountsFile(home?: string): string;
/** Read the book, or an empty one when absent/corrupt. */
export declare function readAccounts(home?: string): Promise<AccountBook>;
/** Atomic write (tmp+rename) of the whole book. */
export declare function writeAccounts(book: AccountBook, home?: string): Promise<void>;
//# sourceMappingURL=accounts-store.d.ts.map