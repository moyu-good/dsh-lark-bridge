/**
 * Peer discovery between bridge instances running in different profile forms
 * (web vs desktop). Each instance heartbeats into a shared peers document in
 * the `~/.dsh` home; entries expire by TTL, so a dead end simply stops
 * appearing. Synchronization actions always target one named peer.
 * @module dsh-lark-bridge/sync/peers
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncDir, withLock } from "./settings-store.js";
/** How long a peer entry stays visible without a fresh heartbeat. */
export const PEER_TTL_MS = 30_000;
const FILE_NAME = 'peers.json';
function peersFile(home) {
    return path.join(syncDir(home), FILE_NAME);
}
/** This instance's identity, as it should appear to the other end. */
export function selfEntry(form, profile, bridgeVersion, port, token, manifest) {
    return {
        profile,
        form,
        ...(port === undefined ? {} : { port }),
        pid: process.pid,
        bridgeVersion,
        ...(token === undefined ? {} : { token }),
        ...(manifest === undefined ? {} : { manifest }),
        host: os.hostname(),
        ts: Date.now(),
    };
}
async function readDocument(home) {
    try {
        const parsed = JSON.parse(await fsp.readFile(peersFile(home), 'utf8'));
        if (!Array.isArray(parsed.peers))
            return { peers: [] };
        return parsed;
    }
    catch {
        return { peers: [] };
    }
}
async function writeDocument(home, doc) {
    const dir = syncDir(home);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
    await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, peersFile(home));
}
/**
 * Publish this instance's heartbeat and return the other live peers. Both
 * sides of the file go through the directory lock so a heartbeat from the
 * other host cannot erase ours mid-read; expired entries are pruned on every
 * pass.
 */
export async function heartbeat(mine, home) {
    return withLock(home, async () => {
        const doc = await readDocument(home);
        const now = Date.now();
        const isSelf = (peer) => peer.profile === mine.profile && peer.pid === mine.pid && peer.host === mine.host;
        const others = doc.peers
            .filter((peer) => !isSelf(peer))
            .filter((peer) => now - peer.ts <= PEER_TTL_MS);
        await writeDocument(home, { peers: [...others, { ...mine, ts: now }] });
        return others;
    });
}
/**
 * Read the currently-live peers without heartbeating. Expired entries are
 * pruned as a side effect. Pass the caller's `self` identity (pid + host) to
 * take itself out of the listing.
 */
export async function listPeers(home, self) {
    return withLock(home, async () => {
        const doc = await readDocument(home);
        const now = Date.now();
        const isSelf = (peer) => self !== undefined && peer.profile === self.profile
            && peer.pid === self.pid && peer.host === self.host;
        const alive = doc.peers
            .filter((peer) => now - peer.ts <= PEER_TTL_MS)
            .filter((peer) => !isSelf(peer));
        if (alive.length !== doc.peers.length) {
            await writeDocument(home, { peers: alive });
        }
        return alive;
    });
}
//# sourceMappingURL=peers.js.map