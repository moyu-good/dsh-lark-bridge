/**
 * Localhost-only control API for cross-instance sync. Each bridge instance
 * serves its health, its profile manifest, and a manifest diff to the peer
 * instance; every request must carry the instance's boot token as a bearer.
 * The token rotates each boot and travels through the shared peers document
 * (`peers.json`), which lives in the user-owned `~/.dsh` home — so the trust
 * boundary is "local user", matching the threat model of a developer machine
 * and the one-time-token pattern upstream introduced for the web UI in 0.1.2.
 * @module dsh-lark-bridge/sync/control-api
 */
import http from 'node:http';
const MAX_BODY = 1 << 20; // 1 MiB — the API serves manifests and small commands
/**
 * Start the control API bound to 127.0.0.1. Rejects requests lacking the
 * exact bearer token; everything it serves is read-only in this iteration.
 */
export function startControlApi(state, token, requestedPort) {
    const server = http.createServer((req, res) => {
        void handle(req, res, state, token).catch(() => {
            res.statusCode = 500;
            res.end('{"error":"internal"}');
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort ?? 0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                port: address.port,
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}
async function handle(req, res, state, token) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end('{"error":"unauthorized"}');
        return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/control/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            profile: state.profile,
            form: state.form,
            bridgeVersion: state.bridgeVersion,
            pid: process.pid,
        }));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/control/manifest') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(await state.manifest()));
        return;
    }
    res.statusCode = 404;
    res.end('{"error":"not_found"}');
}
/** Fetch a peer's manifest over its control API. */
export async function fetchPeerManifest(port, token, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/control/manifest`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Ask a peer for its health snapshot. */
export async function fetchPeerHealth(port, token, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/control/health`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Body reader with the shared size cap; rejects oversized payloads. */
export async function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
//# sourceMappingURL=control-api.js.map