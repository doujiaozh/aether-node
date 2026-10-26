/**
 * Hybrid Logical Clock (HLC) timestamp.
 *
 * The causal-ordering primitive shared by every CRDT in aether-node. Combining
 * physical wall-clock time with a logical counter gives timestamps that are:
 *  - monotonic per node (the counter increments when the wall clock stalls),
 *  - pairwise comparable across nodes (skew-tolerant),
 *  - totally ordered when combined with a deterministic node-id tiebreaker.
 */

/** An HLC timestamp. Serialized as-is inside exported sync state. */
export interface HlcTimestamp {
  /** Wall-clock epoch milliseconds (Date.now()). */
  wall: number;
  /** Logical counter, bumped when the wall clock does not advance. */
  logical: number;
  /** Owning replica id — deterministic tiebreaker for total order. */
  node: string;
}

/**
 * A single-node HLC. Not thread-safe; one clock per engine is the intended
 * usage since all local mutations funnel through {@link SyncEngine}.
 */
export class HlcClock {
  private lastWall = 0;
  private lastLogical = 0;

  constructor(
    public readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Advance the clock and return a fresh local timestamp. */
  tick(): HlcTimestamp {
    const wall = this.now();
    if (wall > this.lastWall) {
      this.lastWall = wall;
      this.lastLogical = 0;
    } else {
      this.lastLogical += 1;
    }
    return { wall: this.lastWall, logical: this.lastLogical, node: this.nodeId };
  }

  /**
   * Observe a (possibly remote) timestamp and push the local clock past it.
   * Guarantees that any timestamp issued afterwards happens-after `remote`
   * and after anything the local node already issued.
   */
  observe(remote: HlcTimestamp): HlcTimestamp {
    const wall = this.now();
    if (wall > this.lastWall && wall > remote.wall) {
      this.lastWall = wall;
      this.lastLogical = 0;
    } else if (remote.wall > this.lastWall) {
      this.lastWall = remote.wall;
      this.lastLogical = remote.logical + 1;
    } else if (remote.wall === this.lastWall) {
      this.lastLogical = Math.max(this.lastLogical, remote.logical) + 1;
    } else {
      this.lastLogical += 1;
    }
    return { wall: this.lastWall, logical: this.lastLogical, node: this.nodeId };
  }
}

/**
 * Total order on HLC timestamps: (wall, logical, node) lexicographic.
 * Returns negative if `a` happened-before `b`, 0 if identical, positive
 * if `a` happened-after `b`.
 */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

/** The minimal HLC timestamp; orders before every real timestamp. */
export function zeroHlc(node = ''): HlcTimestamp {
  return { wall: 0, logical: 0, node };
}

/** Structural check for values deserialized from untrusted JSON. */
export function isHlcTimestamp(value: unknown): value is HlcTimestamp {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.wall === 'number' &&
    Number.isFinite(v.wall) &&
    typeof v.logical === 'number' &&
    Number.isFinite(v.logical) &&
    typeof v.node === 'string'
  );
}
