/**
 * Peer discovery between bridge instances running in different profile forms
 * (web vs desktop). Each instance heartbeats into a shared peers document in
 * the `~/.dsh` home; entries expire by TTL, so a dead end simply stops
 * appearing. Synchronization actions always target one named peer.
 * @module dsh-lark-bridge/sync/peers
 */
/** How long a peer entry stays visible without a fresh heartbeat. */
export declare const PEER_TTL_MS = 30000;
/** The two runtime forms a bridge instance can run under. */
export type PeerForm = 'web' | 'desktop';
/** Minimal manifest snapshot a peer publishes alongside its heartbeat. */
export interface ProfileManifestLite {
    profile: string;
    dependencies: Record<string, string>;
    bundles: string[];
}
/** One live bridge instance as seen through the shared peers document. */
export interface PeerEntry {
    /** Profile name the instance runs under (`web`, `desktop`, …). */
    profile: string;
    /** Runtime form: dsh web UI or the Desktop 2.0.0 app shell. */
    form: PeerForm;
    /** Port of the instance's control API, when one is listening. */
    port?: number;
    /** Host process id — disambiguates two instances of the same form. */
    pid: number;
    /** Bridge version that published this entry. */
    bridgeVersion: string;
    /**
     * This instance's control-API bearer token, rotating each boot. It travels
     * in the user-owned shared home, so the trust boundary stays "local user".
     */
    token?: string;
    /**
     * Snapshot of this instance's profile manifest, published with every
     * heartbeat. Carrying it in-band makes plugin sync work file-only: the
     * control API stays as the live path when connectivity allows (WSL2 forwards
     * localhost one way only: Windows->WSL, not back).
     */
    manifest?: ProfileManifestLite;
    /** Hostname — distinguishes machines when the home is on a sync drive. */
    host: string;
    /** Epoch ms of the last heartbeat. */
    ts: number;
}
/** This instance's identity, as it should appear to the other end. */
export declare function selfEntry(form: PeerForm, profile: string, bridgeVersion: string, port?: number, token?: string, manifest?: ProfileManifestLite): PeerEntry;
/**
 * Publish this instance's heartbeat and return the other live peers. Both
 * sides of the file go through the directory lock so a heartbeat from the
 * other host cannot erase ours mid-read; expired entries are pruned on every
 * pass.
 */
export declare function heartbeat(mine: PeerEntry, home?: string): Promise<PeerEntry[]>;
/**
 * Read the currently-live peers without heartbeating. Expired entries are
 * pruned as a side effect. Pass the caller's `self` identity (pid + host) to
 * take itself out of the listing.
 */
export declare function listPeers(home?: string, self?: {
    profile: string;
    pid: number;
    host: string;
}): Promise<PeerEntry[]>;
//# sourceMappingURL=peers.d.ts.map