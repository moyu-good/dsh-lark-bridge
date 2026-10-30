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
/** Absolute path of the per-chat binding file (`$DSH_HOME/dsh-lark-bridge/…`). */
export declare function chatWorkspaceFile(home?: string): string;
/**
 * Read every binding, or `{}` when the file is absent or unreadable.
 *
 * A corrupt file reads as empty rather than throwing: a broken convenience map
 * must not stop the bridge from serving chats, and the next write replaces it.
 *
 * @param home - harness home override, for tests.
 * @returns chat id → absolute directory.
 */
export declare function readChatWorkspaces(home?: string): Promise<Record<string, string>>;
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
export declare function writeChatWorkspace(chatId: string, dir: string | null, home?: string): Promise<void>;
//# sourceMappingURL=chat-workspace.d.ts.map