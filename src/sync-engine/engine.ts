/**
 * aether-node :: sync-engine :: SyncEngine
 *
 * The engine is a replica's entry point into the synchronization world.
 * It owns: a node identity, an HLC clock, a per-node vector clock, and a
 * document assembled from LWW registers.
 *
 * Flow of data:
 *   local change -> applyLocal()  -> Op minted, applied locally, ready to ship
 *   remote ops   -> applyRemote() -> merged idempotently, unknown ops counted
 *   peer catchup -> merge()       -> whole snapshot merged, then only Ops flow
 */

import { hlcToString, HybridLogicalClock } from "./clock.js";
import { LwwRegister } from "./lww-register.js";
import type {
  ApplyResult,
  CrdtKey,
  CrdtSnapshot,
  HlcTimestamp,
  JsonValue,
  LwwEntry,
  NodeId,
  Op,
  SyncEngineOptions,
  VectorClock,
} from "./types.js";

/** Public surface of a change the caller wants to make locally. */
export interface LocalChange {
  readonly key: CrdtKey;
  readonly value?: JsonValue;
}

/** Identity of the local replica. */
export interface NodeIdentity {
  readonly nodeId: NodeId;
  readonly startedAt: number;
}

export class SyncEngine {
  private readonly clock: HybridLogicalClock;
  private readonly startedAt: number;
  private readonly version: Map<NodeId, number> = new Map();
  private readonly doc: Map<CrdtKey, LwwRegister> = new Map();

  constructor(options: SyncEngineOptions = {}) {
    const nodeId = options.nodeId ?? generateNodeId();
    this.clock = new HybridLogicalClock(nodeId);
    this.startedAt = Date.now();
  }

  // --------------------------------------------------------------- identity

  get identity(): NodeIdentity {
    return { nodeId: this.clock.nodeId, startedAt: this.startedAt };
  }

  get nodeId(): NodeId {
    return this.clock.nodeId;
  }

  private versionOf(nodeId: NodeId): number {
    return this.version.get(nodeId) ?? 0;
  }

  private bump(nodeId: NodeId, seq: number): void {
    this.version.set(nodeId, Math.max(this.versionOf(nodeId), seq));
  }

  // ----------------------------------------------------------------- writes

  /**
   * Apply a local mutation. Mints an Op that callers should gossip to peers.
   * The op is already applied to local state when this returns.
   */
  applyLocal(change: LocalChange): Op {
    const hlc = this.clock.tick();
    const op: Op = {
      opId: hlcToString(hlc),
      hlc,
      kind: change.value === undefined ? "del" : "put",
      key: change.key,
      ...(change.value === undefined ? {} : { value: change.value }),
    };
    this.bump(hlc.nodeId, this.versionOf(hlc.nodeId) + 1);
    this.writeKey(change.key, change.value, hlc);
    return op;
  }

  // ----------------------------------------------------------------- reads

  /** Read a key; `undefined` if absent or tombstoned. */
  get(key: CrdtKey): JsonValue | undefined {
    return this.doc.get(key)?.value;
  }

  has(key: CrdtKey): boolean {
    return this.doc.get(key)?.value !== undefined;
  }

  /** Live (non-tombstoned) keys in the document. */
  keys(): CrdtKey[] {
    return [...this.doc.keys()].filter((k) => this.doc.get(k)?.value !== undefined);
  }

  /** Number of live entries. */
  size(): number {
    return this.keys().length;
  }

  // ----------------------------------------------------------------- merge

  /**
   * Merge a batch of remote operations. Safe to call repeatedly with the
   * same data (idempotent) and in any order (commutative/associative).
   */
  applyRemote(ops: Iterable<Op>): ApplyResult {
    let applied = 0;
    let skipped = 0;

    for (const op of ops) {
      // Absorb the peer's clock knowledge so ours never lags causality.
      this.clock.observe(op.hlc);
      // Approximate the sender's sequence with our per-node merge count.
      this.bump(op.hlc.nodeId, this.versionOf(op.hlc.nodeId) + 1);

      const before = this.doc.get(op.key);
      const after = this.writeKey(op.key, op.value, op.hlc);
      // `writeKey` returns a fresh register only when the write wins; an
      // unchanged reference means we already knew this state -> duplicate.
      if (after === before) {
        skipped++;
      } else {
        applied++;
      }
    }

    return { applied, skipped };
  }

  /**
   * Merge an entire snapshot (used when peers first meet, or after long
   * offline periods). Subsequent exchanges should use `applyRemote`.
   */
  merge(snapshot: CrdtSnapshot): ApplyResult {
    let applied = 0;
    let skipped = 0;

    for (const [key, entry] of Object.entries(snapshot.entries)) {
      const incoming = LwwRegister.fromEntry(entry);
      const before = this.doc.get(key);
      const current = before ?? LwwRegister.create(this.nodeId);
      const merged = current.merge(incoming);
      if (merged === current) {
        skipped++;
      } else {
        this.doc.set(key, merged);
        applied++;
      }
    }

    for (const [node, seq] of Object.entries(snapshot.version)) {
      this.bump(node, seq);
    }
    return { applied, skipped };
  }

  /** Export a serializable snapshot for shipping to another peer. */
  snapshot(): CrdtSnapshot {
    const entries: Record<CrdtKey, LwwEntry> = {};
    for (const [key, register] of this.doc) {
      entries[key] = register.toEntry();
    }
    return {
      kind: "aether.crdt.snapshot/v1",
      nodeId: this.nodeId,
      version: this.vectorClock(),
      entries,
    };
  }

  /** Vector clock view (immutable copy). */
  vectorClock(): VectorClock {
    const out: Record<NodeId, number> = {};
    for (const [node, seq] of this.version) out[node] = seq;
    return out;
  }

  // ----------------------------------------------------------------- helper

  private writeKey(
    key: CrdtKey,
    value: JsonValue | undefined,
    hlc: HlcTimestamp,
  ): LwwRegister {
    const current = this.doc.get(key) ?? LwwRegister.create(this.nodeId);
    const next = current.write(value, hlc);
    if (next !== current) this.doc.set(key, next);
    return next;
  }
}

/**
 * Random-ish node id, runtime-agnostic (no Node globals): the sync engine
 * must stay portable to browsers and edge runtimes. Callers with a real
 * identity should always pass `nodeId` explicitly.
 */
function generateNodeId(): NodeId {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x1000000).toString(36).padStart(4, "0");
  return `node-${stamp}-${rand}`;
}
