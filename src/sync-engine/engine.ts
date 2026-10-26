/**
 * {@link SyncEngine} — the local-first state core of aether-node.
 *
 * A single engine owns one replica of the shared state: LWW-Registers keyed
 * by string plus PN-Counters keyed by string. All mutations are stamped with
 * the node's HLC clock, and {@link SyncEngine.merge} / {@link SyncEngine.importJson}
 * converge replicas using CRDT rules — no coordination server, no conflicts,
 * safe to run fully offline.
 *
 * Merge algebra (for both registers and counters) is guaranteed to be
 * commutative, associative and idempotent, so state converges identically on
 * every node regardless of network topology, partitioning, or duplicate
 * messages.
 */

import { HlcClock, type HlcTimestamp } from './hlc.js';
import {
  emptyCounterState,
  counterValue,
  counterApply,
  mergeCounterStates,
  isPnCounterState,
  type PnCounterState,
} from './counter.js';
import {
  isLwwRegisterState,
  mergeRegisterStates,
  type LwwRegisterState,
} from './lww-register.js';

/** Wire format tag produced by every export. */
export const SYNC_STATE_FORMAT = 'aether-node/v1';

/** The complete CRDT state of one replica, JSON-serializable. */
export interface SyncState {
  format: typeof SYNC_STATE_FORMAT;
  /** Owning replica id of the node that produced this export. */
  node: string;
  /** Monotonic Lamport-style version of the producing node. */
  version: number;
  registers: Record<string, LwwRegisterState>;
  counters: Record<string, PnCounterState>;
}

/** Summary of what a merge actually changed. */
export interface MergeSummary {
  /** Number of register entries whose value visibly changed. */
  registersChanged: number;
  /** Number of counter entries whose value visibly changed. */
  countersChanged: number;
  /** Resulting engine version. */
  version: number;
  /** True when the incoming state carried anything new. */
  applied: boolean;
}

/** Thrown when an imported blob is not a valid aether-node sync state. */
export class SyncImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncImportError';
  }
}

export interface SyncEngineOptions {
  /** Stable replica id. Random when omitted. */
  nodeId?: string;
  /** Inject the wall clock (tests use it to simulate skew/offline edits). */
  now?: () => number;
}

function randomNodeId(): string {
  return (
    'node-' +
    Date.now().toString(36).slice(-4) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  );
}

/**
 * Rebuild a counter state with sorted bucket keys, so exports are
 * byte-identical no matter which merge order populated the buckets.
 */
function canonicalizeCounter(state: PnCounterState): PnCounterState {
  const sortBucket = (bucket: Record<string, number>): Record<string, number> => {
    const sorted: Record<string, number> = {};
    for (const replica of Object.keys(bucket).sort()) {
      sorted[replica] = bucket[replica];
    }
    return sorted;
  };
  return { p: sortBucket(state.p), n: sortBucket(state.n) };
}

/**
 * The local replica. Create one per process (or per "device" in tests), push
 * mutations through it, and exchange {@link SyncEngine.exportJson} blobs with
 * peers whenever connectivity returns.
 */
export class SyncEngine {
  readonly nodeId: string;
  private readonly clock: HlcClock;
  private readonly registers = new Map<string, LwwRegisterState>();
  private readonly counters = new Map<string, PnCounterState>();
  private _version = 0;

  constructor(options: SyncEngineOptions = {}) {
    this.nodeId = options.nodeId ?? randomNodeId();
    this.clock = new HlcClock(this.nodeId, options.now ?? Date.now);
  }

  /** Lamport-style version of this replica: bumps on every op and merge. */
  get version(): number {
    return this._version;
  }

  // ---------------------------------------------------------------------------
  // Registers (LWW)
  // ---------------------------------------------------------------------------

  /** Write a register value, stamped "now" by the local HLC clock. */
  set(key: string, value: unknown): void {
    this.registers.set(key, { value, ts: this.clock.tick() });
    this._version += 1;
  }

  /** Read a register value, or `undefined` when never written. */
  get(key: string): unknown {
    return this.registers.get(key)?.value;
  }

  /** Does the register exist on this replica? */
  has(key: string): boolean {
    return this.registers.has(key);
  }

  /** Timestamp backing the current LWW winner for a register. */
  timestampOf(key: string): HlcTimestamp | undefined {
    return this.registers.get(key)?.ts;
  }

  /** All register keys currently present on this replica. */
  registerKeys(): string[] {
    return [...this.registers.keys()];
  }

  // ---------------------------------------------------------------------------
  // Counters (PN)
  // ---------------------------------------------------------------------------

  /** Increment (or, with a negative delta, decrement) a counter locally. */
  increment(key: string, by = 1): void {
    const next = counterApply(
      this.counters.get(key) ?? emptyCounterState(),
      this.nodeId,
      by,
    );
    this.counters.set(key, next);
    this._version += 1;
  }

  /** Decrement a counter locally. */
  decrement(key: string, by = 1): void {
    this.increment(key, -by);
  }

  /** Observed counter value (`0` when the counter does not exist). */
  counterValue(key: string): number {
    const state = this.counters.get(key);
    return state === undefined ? 0 : counterValue(state);
  }

  /** All counter keys currently present on this replica. */
  counterKeys(): string[] {
    return [...this.counters.keys()];
  }

  // ---------------------------------------------------------------------------
  // CRDT merge
  // ---------------------------------------------------------------------------

  /**
   * Merge another replica's state into this one.
   *
   * Safe to call with partial states, stale states, duplicates, or states from
   * any topological order — the CRDT algebra converges regardless. Returns a
   * summary of what changed locally.
   */
  merge(remote: SyncState): MergeSummary {
    assertSyncState(remote);
    return this.applyMerge(remote);
  }

  /** Merge another engine's export directly (convenience). */
  mergeEngine(other: SyncEngine): MergeSummary {
    return this.merge(other.export());
  }

  private applyMerge(remote: SyncState): MergeSummary {
    let registersChanged = 0;
    let countersChanged = 0;
    // Every remote timestamp we observe pushes the local HLC clock forward so
    // subsequent local writes causally dominate the merged-in state.
    const remoteTss: HlcTimestamp[] = [];
    for (const key in remote.registers) remoteTss.push(remote.registers[key].ts);

    for (const key in remote.registers) {
      const remoteState = remote.registers[key];
      const localState = this.registers.get(key);
      const merged = mergeRegisterStates(localState, remoteState);
      if (merged === undefined) continue;
      if (merged !== localState) {
        if (localState === undefined || merged.value !== localState.value) {
          registersChanged += 1;
        }
        this.registers.set(key, merged);
      }
    }

    for (const key in remote.counters) {
      const remoteState = remote.counters[key];
      const localState = this.counters.get(key);
      const merged = mergeCounterStates(localState, remoteState);
      if (merged === undefined) continue;
      const before = localState === undefined ? 0 : counterValue(localState);
      const after = counterValue(merged);
      if (before !== after) countersChanged += 1;
      // Always store the merged map: per-replica maxima must be carried even
      // when the observed total did not move, or convergence breaks when the
      // peer's state is later relayed through this node.
      this.counters.set(key, merged);
    }

    for (const ts of remoteTss) this.clock.observe(ts);

    // A merge that carries nothing new must not touch the version: imports are
    // routinely replayed (duplicate messages, relays), and re-importing an
    // identical state has to be a no-op.
    const applied = registersChanged > 0 || countersChanged > 0;
    if (applied) {
      this._version = Math.max(this._version, remote.version) + 1;
    }
    return {
      registersChanged,
      countersChanged,
      version: this._version,
      applied,
    };
  }

  // ---------------------------------------------------------------------------
  // Export / import (JSON)
  // ---------------------------------------------------------------------------

  /** Snapshot the full replica state as a plain JSON-serializable object. */
  export(): SyncState {
    const registers: Record<string, LwwRegisterState> = {};
    const counters: Record<string, PnCounterState> = {};
    // Sorted keys make exports byte-comparable in tests and friendly to diffs.
    for (const key of [...this.registers.keys()].sort()) {
      registers[key] = this.registers.get(key) as LwwRegisterState;
    }
    for (const key of [...this.counters.keys()].sort()) {
      counters[key] = canonicalizeCounter(this.counters.get(key) as PnCounterState);
    }
    return {
      format: SYNC_STATE_FORMAT,
      node: this.nodeId,
      version: this._version,
      registers,
      counters,
    };
  }

  /** Snapshot as a JSON string — the wire format peers exchange. */
  exportJson(): string {
    return JSON.stringify(this.export());
  }

  /**
   * Parse and merge an exported state blob (string or already-parsed object).
   * Throws {@link SyncImportError} on malformed input — never silently
   * corrupts local state.
   */
  import(stateOrJson: string | SyncState): MergeSummary {
    let state: SyncState;
    if (typeof stateOrJson === 'string') {
      try {
        state = JSON.parse(stateOrJson) as SyncState;
      } catch (cause) {
        throw new SyncImportError(
          'imported state is not valid JSON: ' +
            (cause instanceof Error ? cause.message : String(cause)),
        );
      }
    } else {
      state = stateOrJson;
    }
    return this.merge(state);
  }

  /** Alias of {@link export} so engines work with JSON.stringify directly. */
  toJSON(): SyncState {
    return this.export();
  }

  /** Build an engine replaying an exported state (read-only view of a peer). */
  static fromJson(stateOrJson: string | SyncState): SyncEngine {
    const parsed =
      typeof stateOrJson === 'string'
        ? (JSON.parse(stateOrJson) as SyncState)
        : stateOrJson;
    assertSyncState(parsed);
    const engine = new SyncEngine({ nodeId: parsed.node });
    engine.applyMerge(parsed);
    engine._version = parsed.version;
    return engine;
  }
}

/** Deep structural validation of an untrusted sync-state blob. */
export function assertSyncState(value: unknown): asserts value is SyncState {
  if (value === null || typeof value !== 'object') {
    throw new SyncImportError('sync state must be a JSON object');
  }
  const v = value as Record<string, unknown>;
  if (v.format !== SYNC_STATE_FORMAT) {
    throw new SyncImportError(
      `unsupported sync state format: expected "${SYNC_STATE_FORMAT}", got ${JSON.stringify(v.format)}`,
    );
  }
  if (typeof v.node !== 'string' || v.node.length === 0) {
    throw new SyncImportError('sync state "node" must be a non-empty string');
  }
  if (typeof v.version !== 'number' || !Number.isFinite(v.version)) {
    throw new SyncImportError('sync state "version" must be a finite number');
  }
  if (v.registers !== undefined) {
    if (v.registers === null || typeof v.registers !== 'object') {
      throw new SyncImportError('sync state "registers" must be an object');
    }
    for (const key in v.registers) {
      if (!isLwwRegisterState((v.registers as Record<string, unknown>)[key])) {
        throw new SyncImportError(`register "${key}" has an invalid shape`);
      }
    }
  }
  if (v.counters !== undefined) {
    if (v.counters === null || typeof v.counters !== 'object') {
      throw new SyncImportError('sync state "counters" must be an object');
    }
    for (const key in v.counters) {
      if (!isPnCounterState((v.counters as Record<string, unknown>)[key])) {
        throw new SyncImportError(`counter "${key}" has an invalid shape`);
      }
    }
  }
}
