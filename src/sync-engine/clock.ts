/**
 * aether-node :: sync-engine :: Hybrid Logical Clock
 *
 * A minimal, correct HLC implementation.
 *
 * Rules (Lamport-style, hybridized with wall time):
 *   - tick(): the counter resets whenever physical time moves past the
 *     last observed wall time, otherwise it increments. The clock never
 *     goes backwards even if `Date.now()` jumps.
 *   - observe(): merges knowledge of a remote timestamp, so the local
 *     clock stays ahead of anything we have ever seen.
 *   - compare(): total order on (wallTimeMs, counter, nodeId).
 */

import type { HlcTimestamp, NodeId } from "./types.js";

/** Minimum legal `nodeId` so comparisons always have a deterministic winner. */
const MIN_NODE_ID = "";

/** Pure, total ordering of two HLC timestamps. */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a.wallTimeMs !== b.wallTimeMs) return a.wallTimeMs < b.wallTimeMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  const n = a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  return n;
}

/** Stringify an HLC for use as an operation id or in logs. */
export function hlcToString(t: HlcTimestamp): string {
  return `${t.nodeId}:${t.wallTimeMs.toString(36)}:${t.counter.toString(36)}`;
}

/** Parse a string produced by `hlcToString`. */
export function parseHlc(s: string): HlcTimestamp {
  const [nodeId, w, c] = s.split(":");
  if (nodeId === undefined || w === undefined || c === undefined) {
    throw new Error(`malformed HLC string: ${s}`);
  }
  return { nodeId, wallTimeMs: Number.parseInt(w, 36), counter: Number.parseInt(c, 36) };
}

/** Mutable HLC state belonging to one replica. */
export class HybridLogicalClock {
  private wallTimeMs = 0;
  private counter = 0;
  private readonly _nodeId: NodeId;

  constructor(nodeId: NodeId, init?: Partial<HlcTimestamp>) {
    this._nodeId = nodeId;
    this.wallTimeMs = init?.wallTimeMs ?? 0;
    this.counter = init?.counter ?? 0;
  }

  get nodeId(): NodeId {
    return this._nodeId;
  }

  /** Mint a fresh timestamp for a local event. */
  tick(): HlcTimestamp {
    const now = Date.now();
    if (now > this.wallTimeMs) {
      this.wallTimeMs = now;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return { wallTimeMs: this.wallTimeMs, counter: this.counter, nodeId: this._nodeId };
  }

  /** Absorb knowledge of a remote timestamp. */
  observe(remote: HlcTimestamp): void {
    const now = Date.now();
    if (now > this.wallTimeMs && now > remote.wallTimeMs) {
      this.wallTimeMs = now;
      this.counter = 0;
    } else if (remote.wallTimeMs > this.wallTimeMs) {
      this.wallTimeMs = remote.wallTimeMs;
      this.counter = remote.counter + 1;
    } else if (this.wallTimeMs > remote.wallTimeMs) {
      this.counter += 1;
    } else {
      // Same wall time: max of the counters.
      this.counter = Math.max(this.counter, remote.counter) + 1;
    }
  }

  /** Snapshot-free peek at current state (useful for debugging). */
  state(): HlcTimestamp {
    return { wallTimeMs: this.wallTimeMs, counter: this.counter, nodeId: this._nodeId };
  }
}

/** Sentinel lower-bound timestamp, usable as a "never written" initial value. */
export function minHlc(nodeId: NodeId = MIN_NODE_ID): HlcTimestamp {
  return { wallTimeMs: 0, counter: 0, nodeId };
}
