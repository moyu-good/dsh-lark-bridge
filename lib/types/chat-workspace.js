/**
 * Per-chat working-directory bindings.
 *
 * A session's cwd is fixed when the session is created, so "switch project"
 * means "switch where the NEXT session starts" — the current conversation
 * keeps working where it was. That is the only honest semantic here: moving a
 * live session would move files under an agent mid-turn.
 *
 * The binding therefore has to outlive a restart. An operator who points a
 * chat at a project once should not have to redo it every time the host comes
 * back, and `/new` in that chat must land in the same project again.
 *
 * Storage is a plain JSON map beside the shared settings, written tmp+rename so
 * a reader never sees a torn file.
 * @module dsh-lark-bridge/chat-workspace
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { syncDir } from "./sync/settings-store.js";
const FILE_NAME = 'chat-workspaces.json';
/** Absolute path of the per-chat binding file (`$DSH_HOME/dsh-lark-bridge/…`). */
export function chatWorkspaceFile(home) {
    return path.join(syncDir(home), FILE_NAME);
}
/**
 * Read every binding, or `{}` when the file is absent or unreadable.
 *
 * A corrupt file reads as empty rather than throwing: a broken convenience map
 * must not stop the bridge from serving chats, and the next write replaces it.
 *
 * @param home - harness home override, for tests.
 * @returns chat id → absolute directory.
 */
export async function readChatWorkspaces(home) {
    let raw;
    try {
        raw = await fsp.readFile(chatWorkspaceFile(home), 'utf8');
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [chatId, dir] of Object.entries(parsed)) {
            if (typeof dir === 'string' && dir !== '')
                out[chatId] = dir;
        }
        return out;
    }
    catch {
        return {};
    }
}
/**
 * Bind one chat to a directory, or clear its binding with `null`.
 *
 * Read-modify-write: two chats binding at once must not drop each other, and
 * the file is small enough that holding the whole map is free.
 *
 * @param chatId - the chat whose binding changes.
 * @param dir - absolute directory, or `null` to fall back to the deployment cwd.
 * @param home - harness home override, for tests.
 */
export async function writeChatWorkspace(chatId, dir, home) {
    const current = await readChatWorkspaces(home);
    if (dir === null)
        delete current[chatId];
    else
        current[chatId] = dir;
    const file = chatWorkspaceFile(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, file);
}
//# sourceMappingURL=chat-workspace.js.map