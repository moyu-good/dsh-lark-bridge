/**
 * Feishu drive (v1) as the cross-machine carrier: the app's own cloud space
 * is the natural transfer point for migration files and the arbitration
 * record — same credentials the bridge already holds, an isolation boundary
 * the platform enforces, and no manual copying between machines. Token is
 * cached until shortly before expiry; every call goes through the injected
 * fetch so tests run without network.
 * @module dsh-lark-bridge/sync/feishu-cloud
 */
/** Credentials to mint a tenant_access_token (what the bridge already has). */
export interface FeishuCredentials {
    appId: string;
    appSecret: string;
    /** Open-platform origin, default `https://open.feishu.cn`. */
    domain?: string;
}
/** Minimal response surface used here; injectable for tests. */
export type FetchImpl = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    signal?: AbortSignal;
}) => Promise<{
    status: number;
    json: () => Promise<Record<string, unknown>>;
    text: () => Promise<string>;
}>;
/**
 * One chat message as the message-history endpoint reports it.
 *
 * Only the fields the gap check needs: who sent it (a user message lost in a
 * connection gap is what the chat must be told to resend) and when.
 */
export interface ChatMessageSummary {
    readonly messageId: string;
    /** `user` for a person, `app` for a bot/this app itself, else the platform's value. */
    readonly senderType: string;
    /** Server-side creation time in ms. */
    readonly createTimeMs: number;
    readonly msgType: string;
}
/** Drive-backed JSON storage scoped to the app's own root folder. */
export declare class FeishuCloud {
    private readonly creds;
    private token?;
    private rootToken?;
    private readonly fetchImpl;
    constructor(creds: FeishuCredentials, fetchImpl?: FetchImpl);
    private origin;
    /** Mint (or reuse) a tenant_access_token. */
    getToken(): Promise<string>;
    /**
     * The app's own bot profile — the display name a human sees in the Feishu
     * chat header. Fleet UX depends on it: several endpoints (and even several
     * deployments) share or echo app names, so the model's self-description and
     * the first-contact guide quote this name instead of guessing.
     */
    botInfo(): Promise<{
        name: string;
        active: boolean;
    }>;
    /** The app's own drive root folder — files land here unless told otherwise. */
    rootFolder(): Promise<string>;
    /** Upload one text file. Returns its drive file token. */
    upload(fileName: string, content: string, folderToken?: string): Promise<string>;
    /** List the app's root folder: name → token + modified time (ms). */
    list(): Promise<{
        name: string;
        token: string;
        modifiedMs: number;
    }[]>;
    /**
     * Chat messages created inside `[startMs, endMs]`, oldest first.
     *
     * The long connection has no cursor, so a message sent while it is down
     * never reaches the bridge — but it does exist on the server. Reading it
     * back is what turns "a gap happened, maybe something was lost" into "N user
     * messages were lost". Bounded to `maxPages` (50 per page) so a very long
     * outage cannot hold the reconnect path in a paging loop; the caller only
     * needs to know whether anything was lost, not the exact transcript.
     * @param chatId - chat to read.
     * @param startMs - window start, inclusive, in ms.
     * @param endMs - window end, inclusive, in ms.
     * @param maxPages - page cap (50 messages per page).
     * @returns the messages in the window, in send order.
     */
    listMessages(chatId: string, startMs: number, endMs: number, maxPages?: number): Promise<ChatMessageSummary[]>;
    /** Download one file's text by token. */
    download(fileToken: string): Promise<string>;
    /** Delete one file by token (best effort by caller). */
    remove(fileToken: string): Promise<void>;
    /** Upsert-by-name: upload fresh, then retire the old version of that name. */
    putJson(name: string, content: string): Promise<void>;
    /** Fetch the newest file with this name, or null when absent. */
    getJson(name: string): Promise<string | null>;
    /** Remove every file with this name (used before a clean re-put). */
    removeByName(name: string): Promise<void>;
}
//# sourceMappingURL=feishu-cloud.d.ts.map