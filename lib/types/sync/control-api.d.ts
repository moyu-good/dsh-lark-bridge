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
import type { ProfileManifest } from './profile-manifest.ts';
/** The surface other instances may call. */
export interface ControlState {
    profile: string;
    form: 'web' | 'desktop';
    bridgeVersion: string;
    manifest: () => Promise<ProfileManifest | null>;
}
/** A running control API server. */
export interface ControlServer {
    /** Actual bound port (the requested port or an ephemeral fallback). */
    port: number;
    close(): Promise<void>;
}
/**
 * Start the control API bound to 127.0.0.1. Rejects requests lacking the
 * exact bearer token; everything it serves is read-only in this iteration.
 */
export declare function startControlApi(state: ControlState, token: string, requestedPort?: number): Promise<ControlServer>;
/** Fetch a peer's manifest over its control API. */
export declare function fetchPeerManifest(port: number, token: string, timeoutMs?: number): Promise<ProfileManifest | null>;
/** Ask a peer for its health snapshot. */
export declare function fetchPeerHealth(port: number, token: string, timeoutMs?: number): Promise<{
    profile: string;
    form: string;
    bridgeVersion: string;
    pid: number;
} | null>;
/** Body reader with the shared size cap; rejects oversized payloads. */
export declare function readBody(req: http.IncomingMessage): Promise<string>;
//# sourceMappingURL=control-api.d.ts.map