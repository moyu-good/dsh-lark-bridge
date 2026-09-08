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
import fsp from 'node:fs/promises';
import { syncDir } from "./settings-store.js";
const FILE_NAME = 'accounts.json';
/** Absolute path of the shared account book. */
export function accountsFile(home) {
    return syncDir(home) + '/' + FILE_NAME;
}
/** Read the book, or an empty one when absent/corrupt. */
export async function readAccounts(home) {
    try {
        const raw = await fsp.readFile(accountsFile(home), 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.accounts !== 'object' || parsed.accounts === null) {
            return { accounts: {} };
        }
        return { active: parsed.active, accounts: parsed.accounts };
    }
    catch {
        return { accounts: {} };
    }
}
/** Atomic write (tmp+rename) of the whole book. */
export async function writeAccounts(book, home) {
    const file = accountsFile(home);
    await fsp.mkdir(syncDir(home), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(book, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(tmp, file);
}
//# sourceMappingURL=accounts-store.js.map