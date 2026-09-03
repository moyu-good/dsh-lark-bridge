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
}) => Promise<{
    status: number;
    json: () => Promise<Record<string, unknown>>;
    text: () => Promise<string>;
}>;
/** Drive-backed JSON storage scoped to the app's own root folder. */
export declare class FeishuCloud {
    private readonly creds;
    private readonly fetchImpl;
    private token?;
    private rootToken?;
    constructor(creds: FeishuCredentials, fetchImpl?: FetchImpl);
    private origin;
    /** Mint (or reuse) a tenant_access_token. */
    getToken(): Promise<string>;
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