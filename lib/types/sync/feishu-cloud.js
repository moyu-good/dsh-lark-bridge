/**
 * Feishu drive (v1) as the cross-machine carrier: the app's own cloud space
 * is the natural transfer point for migration files and the arbitration
 * record — same credentials the bridge already holds, an isolation boundary
 * the platform enforces, and no manual copying between machines. Token is
 * cached until shortly before expiry; every call goes through the injected
 * fetch so tests run without network.
 * @module dsh-lark-bridge/sync/feishu-cloud
 */
const TOKEN_SAFETY_MS = 60_000;
/**
 * Deadline for every drive/auth call made here.
 *
 * This class is read on the inbound message path (the arbitration record is
 * fetched per message, cached for a minute), and `fetch` has no default
 * deadline. A request that stalls without one parks the inbound handler
 * forever: the message is acknowledged with a reaction and then nothing
 * happens — no reply, no error, no log — until the process is restarted.
 * Bounding every call here keeps a stalled carrier from wedging the channel.
 */
const CLOUD_TIMEOUT_MS = 15_000;
/** Drive-backed JSON storage scoped to the app's own root folder. */
export class FeishuCloud {
    creds;
    token;
    rootToken;
    fetchImpl;
    constructor(creds, fetchImpl = fetch) {
        this.creds = creds;
        // Bound every call at the seam rather than at each call site.
        this.fetchImpl = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
    }
    origin() {
        return (this.creds.domain ?? 'https://open.feishu.cn').replace(/\/$/, '');
    }
    /** Mint (or reuse) a tenant_access_token. */
    async getToken() {
        if (this.token && Date.now() < this.token.expiresAt)
            return this.token.value;
        const res = await this.fetchImpl(`${this.origin()}/open-apis/auth/v3/tenant_access_token/internal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: this.creds.appId, app_secret: this.creds.appSecret }),
        });
        const data = (await res.json());
        if (data.code !== 0 || !data.tenant_access_token) {
            throw new Error(`飞书 token 获取失败(${data.code}): ${data.msg ?? 'unknown'}`);
        }
        this.token = { value: data.tenant_access_token, expiresAt: Date.now() + (data.expire ?? 7200) * 1000 - TOKEN_SAFETY_MS };
        return this.token.value;
    }
    /**
     * The app's own bot profile — the display name a human sees in the Feishu
     * chat header. Fleet UX depends on it: several endpoints (and even several
     * deployments) share or echo app names, so the model's self-description and
     * the first-contact guide quote this name instead of guessing.
     */
    async botInfo() {
        const token = await this.getToken();
        const res = await this.fetchImpl(`${this.origin()}/open-apis/bot/v3/info`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json());
        if (data.code !== 0 || data.bot?.app_name === undefined) {
            throw new Error(`飞书 bot 信息获取失败(${data.code}): ${data.msg ?? 'unknown'}`);
        }
        return { name: data.bot.app_name, active: data.bot.activate_status === 2 };
    }
    /** The app's own drive root folder — files land here unless told otherwise. */
    async rootFolder() {
        if (this.rootToken)
            return this.rootToken;
        const token = await this.getToken();
        const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/explorer/v2/root_folder/meta`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json());
        const folder = data.data?.token;
        if (data.code !== 0 || !folder)
            throw new Error(`飞书根目录获取失败(${data.code}): ${data.msg ?? 'unknown'}`);
        this.rootToken = folder;
        return folder;
    }
    /** Upload one text file. Returns its drive file token. */
    async upload(fileName, content, folderToken) {
        const token = await this.getToken();
        const folder = folderToken ?? await this.rootFolder();
        const bytes = Buffer.from(content, 'utf8');
        const form = new FormData();
        form.append('file_name', fileName);
        form.append('parent_type', 'explorer');
        form.append('parent_node', folder);
        form.append('size', String(bytes.length));
        form.append('file', new Blob([bytes]), fileName);
        const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/upload_all`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
        });
        const data = (await res.json());
        const fileToken = data.data?.file_token;
        if (data.code !== 0 || !fileToken)
            throw new Error(`飞书上传失败(${data.code}): ${data.msg ?? 'unknown'}`);
        return fileToken;
    }
    /** List the app's root folder: name → token + modified time (ms). */
    async list() {
        const token = await this.getToken();
        const folder = await this.rootFolder();
        const out = [];
        let pageToken;
        for (;;) {
            const url = new URL(`${this.origin()}/open-apis/drive/v1/files`);
            url.searchParams.set('folder_token', folder);
            url.searchParams.set('page_size', '200');
            if (pageToken !== undefined)
                url.searchParams.set('page_token', pageToken);
            const res = await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
            const data = (await res.json());
            if (data.code !== 0)
                throw new Error(`飞书列目录失败(${data.code}): ${data.msg ?? 'unknown'}`);
            for (const file of data.data?.files ?? []) {
                if (file.token !== undefined) {
                    out.push({
                        name: file.name ?? '',
                        token: file.token,
                        // Feishu returns ms as a string.
                        modifiedMs: Number(file.modified_time ?? 0),
                    });
                }
            }
            pageToken = data.data?.next_page_token;
            if (pageToken === undefined || pageToken === '')
                break;
        }
        return out;
    }
    /** Download one file's text by token. */
    async download(fileToken) {
        const token = await this.getToken();
        const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/${fileToken}/download`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status !== 200)
            throw new Error(`飞书下载失败: HTTP ${res.status}`);
        return res.text();
    }
    /** Delete one file by token (best effort by caller). */
    async remove(fileToken) {
        const token = await this.getToken();
        const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/${fileToken}?type=file`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json());
        if (data.code !== 0)
            throw new Error(`飞书删除失败(${data.code}): ${data.msg ?? 'unknown'}`);
    }
    /** Upsert-by-name: upload fresh, then retire the old version of that name. */
    async putJson(name, content) {
        const previous = (await this.list()).filter((file) => file.name === name);
        const fresh = await this.upload(name, content);
        for (const old of previous) {
            await this.remove(old.token).catch(() => { });
        }
        void fresh;
    }
    /** Fetch the newest file with this name, or null when absent. */
    async getJson(name) {
        const matches = (await this.list())
            .filter((file) => file.name === name)
            .sort((a, b) => b.modifiedMs - a.modifiedMs);
        if (matches.length === 0)
            return null;
        return this.download(matches[0].token);
    }
    /** Remove every file with this name (used before a clean re-put). */
    async removeByName(name) {
        for (const file of await this.list()) {
            if (file.name === name)
                await this.remove(file.token).catch(() => { });
        }
    }
}
//# sourceMappingURL=feishu-cloud.js.map