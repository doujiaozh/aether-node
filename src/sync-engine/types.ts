/**
 * aether-node :: sync-engine :: core CRDT data structures
 *
 * This file defines the *lingua franca* of the synchronization layer. The
 * types here are intentionally wire-format friendly (plain JSON) so that
 * operations and snapshots can be shipped verbatim over any transport:
 * WebSocket, WebRTC data channel, Bluetooth, a QR code, or a USB stick.
 *
 * The concrete CRDT algorithms (OR-Set, RGA text, counters ...) will be
 * layered on top of this foundation; for now we define the envelope plus
 * a Last-Write-Wins register as the reference semantics.
 */

/**
 * Identifier of a replica / peer in the mesh. Opaque to the engine itself:
 * any stable, comparable string works (UUID, DID, hostname, ...).
 */
export type NodeId = string;

/** Keys address entries inside a CRDT document. */
export type CrdtKey = string;

/**
 * JSON-compatible value. Everything the sync layer stores must round-trip
 * through `JSON.stringify`, because that is the lowest common denominator
 * across every language and transport aether-node speaks to.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Hybrid Logical Clock (HLC) timestamp.
 *
 * Combines physical time (so humans see sensible ordering) with a logical
 * counter (so the clock never goes backwards, even on a drifted machine)
 * and the node identity (so every timestamp is globally unique and ties
 * can always be broken deterministically).
 */
export interface HlcTimestamp {
  /** Wall-clock time in milliseconds since the Unix epoch. */
  readonly wallTimeMs: number;
  /** Logical counter; disambiguates events minted within the same millisecond. */
  readonly counter: number;
  /** Node that minted this timestamp. Breaks all remaining ties lexicographically. */
  readonly nodeId: NodeId;
}

/**
 * Vector clock: per-node monotonically increasing counters.
 *
 * The classic question of CRDT operation exchange — "have I already seen
 * this?" — is answered by comparing the operation's causal history with
 * the local vector: an op from node N at sequence S is already known iff
 * `local[N] >= S`.
 */
export type VectorClock = Readonly<Record<NodeId, number>>;

/**
 * A single immutable mutation. Operations (not whole documents) are the
 * unit of synchronization: they keep the wire payload proportional to
 * *change*, not to *state*.
 */
export interface Op {
  /** Globally unique operation id (conventionally `${hlc}`). */
  readonly opId: string;
  /** HLC timestamp minted by the origin node. */
  readonly hlc: HlcTimestamp;
  /** Discriminator for future op families (put / delete / append / ...). */
  readonly kind: OpKind;
  /** Document entry the operation targets. */
  readonly key: CrdtKey;
  /** Payload of the operation; absent for tombstoning kinds. */
  readonly value?: JsonValue;
}

/** Operation families. The engine currently understands `put` and `del`. */
export type OpKind = "put" | "del";

/** An entry as stored inside an LWW (last-write-wins) document. */
export interface LwwEntry {
  /** Last-writing HLC timestamp — the authority for ordering. */
  readonly hlc: HlcTimestamp;
  /** Payload; `undefined` means the entry is tombstoned. */
  readonly value?: JsonValue;
}

/**
 * Serializable view of a CRDT document. Snapshots are how a fresh or
 * long-offline peer catches up in one shot; afterwards, only `Op`s flow.
 */
export interface CrdtSnapshot {
  readonly kind: "aether.crdt.snapshot/v1";
  readonly nodeId: NodeId;
  /** Vector clock as of the snapshot — describes how far the peer has seen. */
  readonly version: VectorClock;
  /** Key -> LWW entry map (including tombstones). */
  readonly entries: Readonly<Record<CrdtKey, LwwEntry>>;
}

/**
 * The universal contract every CRDT in aether-node must satisfy.
 *
 * A correct CRDT merge is:
 *  - **commutative**: `a.merge(b) === b.merge(a)`
 *  - **associative**: `(a.merge(b)).merge(c) === a.merge(b.merge(c))`
 *  - **idempotent**: `a.merge(a) === a`
 * Together these properties make convergence automatic: peers can merge
 * in any order, any number of times, and still end up identical.
 */
export interface Mergeable<T> {
  merge(other: T): T;
}

/** Result of applying remote data locally. */
export interface ApplyResult {
  /** Number of ops/entries that actually changed local state. */
  readonly applied: number;
  /** Number of duplicates the peer already knew about. */
  readonly skipped: number;
}

/** Options accepted by the sync engine. */
export interface SyncEngineOptions {
  /** Stable identity for this replica. Generated when omitted. */
  readonly nodeId?: NodeId;
}
