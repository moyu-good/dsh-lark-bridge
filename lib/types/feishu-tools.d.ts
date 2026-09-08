/**
 * Native Feishu capabilities as agent-callable tools.
 *
 * The bridge already renders the agent TO the human; this module lets the
 * agent act on Feishu itself — proactive messages into the current (or any
 * known) chat, and the app's own cloud-drive space as a durable scratchpad.
 * Both ride capabilities the channel already owns: outbound transport for
 * messages, the FeishuCloud client (built for fleet arbitration/migration)
 * for the drive. Tools follow the `send_file` factory pattern: plain
 * definition objects, the outcome in the result, never a throw across the
 * tool boundary.
 * @module dsh-lark-bridge/feishu-tools
 */
import type { OutboundPort } from './outbound.ts';
import type { FeishuCredentials, FetchImpl } from './sync/feishu-cloud.ts';
/** Tool names, exported for tests and deny-list references. */
export declare const FEISHU_NOTIFY_TOOL = "feishu_notify";
export declare const FEISHU_DRIVE_WRITE_TOOL = "feishu_drive_write";
export declare const FEISHU_DRIVE_READ_TOOL = "feishu_drive_read";
export declare const FEISHU_DRIVE_LIST_TOOL = "feishu_drive_list";
/** Capabilities the bridge injects at registration time. */
export interface FeishuToolDeps {
    /** Replay-wrapped outbound transport (queued across connection gaps). */
    readonly port: OutboundPort;
    /** Session id → chat id, so `feishu_notify` defaults to the current chat. */
    readonly chatOfSession: (sessionId: string) => string | undefined;
    /** Credentials for the drive tools; absent → those tools explain why. */
    readonly credentials: FeishuCredentials | undefined;
    /** HTTP seam for the drive client; injectable for tests. */
    readonly fetchImpl?: FetchImpl | undefined;
}
/**
 * The four definitions. `exec.agent.session.id` names the chat for
 * `feishu_notify` the same way `send_file` resolves its delivery target.
 */
export declare function createFeishuTools(deps: FeishuToolDeps): object[];
/** The prompt section text for the tools above (composeChatAgent registers it). */
export declare function feishuToolsPromptSection(): string;
//# sourceMappingURL=feishu-tools.d.ts.map