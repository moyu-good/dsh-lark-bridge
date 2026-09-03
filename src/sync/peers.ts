/**
 * Peer discovery between bridge instances running in different profile forms
 * (web vs desktop). Each instance heartbeats into a shared peers document in
 * the `~/.dsh` home; entries expire by TTL, so a dead end simply stops
 * appearing. Synchronization actions always target one named peer.
 * @module dsh-lark-bridge/sync/peers
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncDir, withLock } from './settings-store.ts'

/** How long a peer entry stays visible without a fresh heartbeat. */
export const PEER_TTL_MS = 30_000

/** The two runtime forms a bridge instance can run under. */
export type PeerForm = 'web' | 'desktop'

/** Minimal manifest snapshot a peer publishes alongside its heartbeat. */
export interface ProfileManifestLite {
  profile: string
  dependencies: Record<string, string>
  bundles: string[]
}

/** One live bridge instance as seen through the shared peers document. */
export interface PeerEntry {
  /** Profile name the instance runs under (`web`, `desktop`, …). */
  profile: string
  /** Runtime form: dsh web UI or the Desktop 2.0.0 app shell. */
  form: PeerForm
  /** Port of the instance's control API, when one is listening. */
  port?: number
  /** Host process id — disambiguates two instances of the same form. */
  pid: number
  /** Bridge version that published this entry. */
  bridgeVersion: string
  /**
   * This instance's control-API bearer token, rotating each boot. It travels
   * in the user-owned shared home, so the trust boundary stays "local user".
   */
  token?: string
  /**
   * Snapshot of this instance's profile manifest, published with every
   * heartbeat. Carrying it in-band makes plugin sync work file-only: the
   * control API stays as the live path when connectivity allows (WSL2 forwards
   * localhost one way only: Windows->WSL, not back).
   */
  manifest?: ProfileManifestLite
  /** Hostname — distinguishes machines when the home is on a sync drive. */
  host: string
  /** Epoch ms of the last heartbeat. */
  ts: number
}

interface PeersDocument {
  peers: PeerEntry[]
}

const FILE_NAME = 'peers.json'

function peersFile(home?: string): string {
  return path.join(syncDir(home), FILE_NAME)
}

/** This instance's identity, as it should appear to the other end. */
export function selfEntry(
  form: PeerForm,
  profile: string,
  bridgeVersion: string,
  port?: number,
  token?: string,
  manifest?: ProfileManifestLite,
): PeerEntry {
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
  }
}

async function readDocument(home?: string): Promise<PeersDocument> {
  try {
    const parsed = JSON.parse(await fsp.readFile(peersFile(home), 'utf8')) as PeersDocument
    if (!Array.isArray(parsed.peers)) return { peers: [] }
    return parsed
  } catch {
    return { peers: [] }
  }
}

async function writeDocument(home: string | undefined, doc: PeersDocument): Promise<void> {
  const dir = syncDir(home)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`)
  await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  await fsp.rename(tmp, peersFile(home))
}

/**
 * Publish this instance's heartbeat and return the other live peers. Both
 * sides of the file go through the directory lock so a heartbeat from the
 * other host cannot erase ours mid-read; expired entries are pruned on every
 * pass.
 */
export async function heartbeat(
  mine: PeerEntry,
  home?: string,
): Promise<PeerEntry[]> {
  return withLock(home, async () => {
    const doc = await readDocument(home)
    const now = Date.now()
    const isSelf = (peer: PeerEntry): boolean =>
      peer.profile === mine.profile && peer.pid === mine.pid && peer.host === mine.host
    const others = doc.peers
      .filter((peer) => !isSelf(peer))
      .filter((peer) => now - peer.ts <= PEER_TTL_MS)
    await writeDocument(home, { peers: [...others, { ...mine, ts: now }] })
    return others
  })
}

/**
 * Read the currently-live peers without heartbeating. Expired entries are
 * pruned as a side effect. Pass the caller's `self` identity (pid + host) to
 * take itself out of the listing.
 */
export async function listPeers(
  home?: string,
  self?: { profile: string; pid: number; host: string },
): Promise<PeerEntry[]> {
  return withLock(home, async () => {
    const doc = await readDocument(home)
    const now = Date.now()
    const isSelf = (peer: PeerEntry): boolean =>
      self !== undefined && peer.profile === self.profile
        && peer.pid === self.pid && peer.host === self.host
    const alive = doc.peers
      .filter((peer) => now - peer.ts <= PEER_TTL_MS)
      .filter((peer) => !isSelf(peer))
    if (alive.length !== doc.peers.length) {
      await writeDocument(home, { peers: alive })
    }
    return alive
  })
}
