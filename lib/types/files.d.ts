/**
 * File delivery: the `send_file` tool the bridge registers on every chat
 * agent, and the delivery helper it calls.
 *
 * The host session event stream carries no file payloads — a tool result is
 * text, a path is not an artifact the channel knows about. So the channel
 * exposes its own tool: an agent that produced a report, spreadsheet, or
 * image calls `send_file(path)` and the bridge uploads that file to the
 * Feishu chat as a real attachment. The agent learns the outcome in its
 * result, and the human gets a clickable file in the chat it is already
 * watching.
 * @module dsh-lark-bridge/files
 */
import type { OutboundPort } from './outbound.ts';
/** The `send_file` tool the bridge registers on chat agents. */
export declare const SEND_FILE_TOOL_NAME = "send_file";
/** Parsed `send_file` arguments, validated by the tool schema. */
export interface SendFileArgs {
    /** Absolute or workspace-relative path of the file to deliver. */
    readonly path: string;
    /** Optional caption text delivered with the attachment. */
    readonly caption?: string;
}
/** The file-delivery capability the tool factory receives from the bridge. */
export interface SendFileCapability {
    /**
     * Deliver one file on behalf of an agent session. Resolves when the platform
     * accepted the upload and the message send settled; rejects with a
     * descriptive error on any failure (unknown session, missing file, too
     * large, transport down).
     */
    deliverBySession(sessionId: string, args: SendFileArgs): Promise<{
        readonly fileName: string;
    }>;
}
/** Canonical JSON value the tool's `output.schema` declares. */
export interface SendFileResult {
    readonly ok: boolean;
    readonly fileName?: string;
    readonly error?: string;
}
/** Model-facing content renderer for the tool's canonical result. */
export declare function renderSendFileResult(args: unknown, value: SendFileResult): object[];
/** Presentation title for one pending call, for the call log/card header. */
export declare function presentSendFileCall(args: unknown): {
    readonly title?: string;
    readonly kind?: string;
};
/**
 * The tool definition to register on one chat agent's scope. The factory
 * captures the bridge's delivery capability so the tool can reach the chat
 * the agent belongs to.
 * @param capability - the bridge's file delivery hook.
 * @returns a dsh `ToolDefinition`-shaped registration.
 */
export declare function createSendFileTool(capability: SendFileCapability): object;
/**
 * Deliver a file to a chat through the outbound transport. Resolves with the
 * delivered file name, or rejects with a message the tool turns into a result.
 * @param port - the outbound transport (replay-wrapped by the bridge).
 * @param chatId - the target chat.
 * @param cwd - workspace root, for resolving relative paths.
 * @param args - the parsed tool arguments.
 */
export declare function deliverFile(port: OutboundPort, chatId: string, cwd: string, args: SendFileArgs): Promise<{
    readonly fileName: string;
}>;
//# sourceMappingURL=files.d.ts.map