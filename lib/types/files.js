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
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
/** The `send_file` tool the bridge registers on chat agents. */
export const SEND_FILE_TOOL_NAME = 'send_file';
/** Model-facing content renderer for the tool's canonical result. */
export function renderSendFileResult(args, value) {
    void args;
    if (value.ok && value.fileName !== undefined) {
        return [{ type: 'text', text: `已发送文件 \`${value.fileName}\` 到当前聊天。` }];
    }
    return [{ type: 'text', text: `文件发送失败：${value.error ?? '未知错误'}` }];
}
/** Presentation title for one pending call, for the call log/card header. */
export function presentSendFileCall(args) {
    const path = args.path;
    return { title: `发送文件 ${typeof path === 'string' ? path : ''}`.trimEnd() };
}
/**
 * The tool definition to register on one chat agent's scope. The factory
 * captures the bridge's delivery capability so the tool can reach the chat
 * the agent belongs to.
 * @param capability - the bridge's file delivery hook.
 * @returns a dsh `ToolDefinition`-shaped registration.
 */
export function createSendFileTool(capability) {
    return {
        name: SEND_FILE_TOOL_NAME,
        description: 'Send one file from the workspace as an attachment in the current chat. '
            + 'Use it to deliver finished artifacts to the human: HTML reports, PDFs, '
            + 'spreadsheets, images, logs. The human can open or download the file '
            + 'directly from the chat. Pass an absolute path, or a path relative to '
            + 'the workspace root.',
        // `parameters` (not `schema`) is the ToolSchema field dsh projects onto
        // the model. A JSON Schema object, so snapshotJsonValue keeps it lossless.
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or workspace-relative path of the file to send' },
                caption: { type: 'string', description: 'Optional short caption delivered with the file' },
            },
            required: ['path'],
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    fileName: { type: 'string' },
                    error: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: renderSendFileResult,
            presentationMeta: presentSendFileCall,
        },
        async execute(args, exec) {
            const parsed = args;
            const sessionId = exec.agent?.session?.id;
            if (sessionId === undefined) {
                return { ok: false, error: '无法确定所属会话' };
            }
            try {
                const { fileName } = await capability.deliverBySession(sessionId, parsed);
                return { ok: true, fileName };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
/**
 * Deliver a file to a chat through the outbound transport. Resolves with the
 * delivered file name, or rejects with a message the tool turns into a result.
 * @param port - the outbound transport (replay-wrapped by the bridge).
 * @param chatId - the target chat.
 * @param cwd - workspace root, for resolving relative paths.
 * @param args - the parsed tool arguments.
 */
export async function deliverFile(port, chatId, cwd, args) {
    const absolute = resolve(cwd, args.path);
    const stat = await fs.stat(absolute).catch((error) => {
        throw new Error(`文件不存在或不可读：${args.path}（${error instanceof Error ? error.message : String(error)}）`);
    });
    if (!stat.isFile())
        throw new Error(`不是文件：${args.path}`);
    const fileName = absolute.split(/[\\/]/).pop() ?? 'file';
    // SendInput is a UNION: `file` and `markdown` are mutually exclusive
    // members, and the transport dispatches on `"markdown" in input` FIRST — a
    // mixed `{ file, markdown }` shape silently sends only the caption and
    // drops the file. A caption must be its own message, before the file.
    const caption = args.caption;
    if (caption !== undefined && caption !== '') {
        await port.send(chatId, { markdown: caption });
    }
    await port.send(chatId, { file: { source: absolute, fileName } });
    return { fileName };
}
//# sourceMappingURL=files.js.map