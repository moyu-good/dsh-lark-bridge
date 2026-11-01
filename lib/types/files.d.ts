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
    /**
     * How to deliver the file, when the extension does not say.
     *
     * A recording named `recording.dat` would otherwise arrive as a download
     * link; the transport can carry it as a voice note the human plays in
     * place. Omitted, the kind is read from the extension.
     */
    readonly kind?: SendFileKind;
}
/** The shapes the transport can deliver a file in. */
export type SendFileKind = 'file' | 'image' | 'audio' | 'video';
/**
 * The kind a file is delivered in, read from its extension.
 *
 * Only the containers the transport can actually carry in kind count as audio
 * or video: it declares every such upload as an `opus` or `mp4` container and
 * reads the duration out of an Ogg or MP4 stream, refusing the send when it
 * finds neither. An mp3 named as a voice note therefore fails at upload, while
 * a file attachment always arrives — so everything outside those two containers
 * is a file. The extension is the only signal the model does not have to be
 * taught, and an unknown one reads as a file, the shape that always works.
 * @param fileName - the file's name.
 * @returns the kind to deliver it in.
 */
export declare function sendFileKindFor(fileName: string): SendFileKind;
/** One file's delivery: where it went, and what the caller should know about the shape. */
export interface DeliveredFile {
    readonly fileName: string;
    /**
     * Set when the file could not go out in the shape it was asked for — a media
     * container the chat cannot carry, or a duration that could not be measured.
     * Says why, so a plain attachment is never mistaken for a voice note.
     */
    readonly note?: string;
}
/** The file-delivery capability the tool factory receives from the bridge. */
export interface SendFileCapability {
    /**
     * Deliver one file on behalf of an agent session. Resolves when the platform
     * accepted the upload and the message send settled; rejects with a
     * descriptive error on any failure (unknown session, missing file, too
     * large, transport down).
     */
    deliverBySession(sessionId: string, args: SendFileArgs): Promise<DeliveredFile>;
}
/** Canonical JSON value the tool's `output.schema` declares. */
export interface SendFileResult {
    readonly ok: boolean;
    readonly fileName?: string;
    /** Why the file arrived as a plain attachment, when it could not go out in kind. */
    readonly note?: string;
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
/** What a duration measurement found. */
export type DurationProbe = 
/** A number of milliseconds. */
{
    readonly state: 'measured';
    readonly ms: number;
}
/** No `ffprobe` on this machine: the transport times the containers it knows. */
 | {
    readonly state: 'no-tool';
}
/** `ffprobe` ran and could not measure this file. */
 | {
    readonly state: 'failed';
};
/** Measures one file's duration. Replaceable: measuring shells out to a tool. */
export type MeasureDuration = (path: string) => Promise<DurationProbe>;
/**
 * The line the chat gets when a delivery is refused.
 *
 * The tool result carries the error to the model, and the log carries it to the
 * operator — but the person who asked for the file is looking at the chat, and
 * without this line they see nothing at all. Silence there reads as "the agent
 * forgot", which is the wrong fix to go looking for.
 * @param fileName - the file that did not go out.
 * @param detail - the transport's own message.
 * @returns the notice to send into the chat.
 */
export declare function sendFailureNotice(fileName: string, detail: string): string;
/**
 * Deliver a file to a chat through the outbound transport. Resolves with the
 * delivered file name, or rejects with a message the tool turns into a result.
 *
 * The media goes first and the caption second. The other order was a trap: the
 * caption is a message of its own (a union `SendInput` cannot carry both), so a
 * media send the transport refuses — a path outside `outbound.allowedFileDirs`
 * is the usual one — left the chat holding a friendly line about a file that
 * never arrived. Sending media first means a failure has nothing to contradict
 * it, and the chat gets an explicit notice instead of a dangling caption.
 * @param port - the outbound transport (replay-wrapped by the bridge).
 * @param chatId - the target chat.
 * @param cwd - workspace root, for resolving relative paths.
 * @param args - the parsed tool arguments.
 * @param measure - duration measurement for a voice note or a video; defaults to `ffprobe`.
 */
export declare function deliverFile(port: OutboundPort, chatId: string, cwd: string, args: SendFileArgs, measure?: MeasureDuration): Promise<DeliveredFile>;
export interface SavedFiles {
    readonly notes: string[];
    readonly paths: string[];
}
/**
 * Download and save non-image resources from one chat message into the agent's
 * workspace so the agent can read them with its own tools. Audio, video and
 * stickers ride the same download path (`type: 'file'` — the SDK fetches any
 * non-image resource by key); before this they were dropped silently and the
 * model only ever saw a placeholder tag.
 */
export declare function saveInboundFiles(msg: {
    messageId: string;
    resources: ReadonlyArray<{
        type: string;
        fileKey: string;
        fileName?: string;
    }>;
}, download: (messageId: string, fileKey: string, type: 'image' | 'file') => Promise<{
    buffer: Uint8Array;
}>, workDir: string): Promise<SavedFiles>;
//# sourceMappingURL=files.d.ts.map