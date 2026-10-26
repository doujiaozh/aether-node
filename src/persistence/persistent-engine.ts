/**
 * {@link PersistentSyncEngine} — a {@link SyncEngine} that survives restarts.
 *
 * The engine keeps its full CRDT state (registers + counters) in a local
 * SQLite file and, after every mutation (`set`, `increment`, `merge`,
 * `import`), asynchronously writes the state back to disk. Flushes are
 * coalesced and serialized, so bursts of mutations produce an ordered
 * sequence of complete snapshots instead of racing writes. A mutation never
 * blocks on disk I/O, and a flush failure is reported through
 * `onFlushError` rather than rejected back into the caller.
 *
 * Restoring is a CRDT merge of the persisted snapshot into a fresh engine:
 * identical semantics to syncing with a peer, which also pushes the local
 * HLC clock past every observed timestamp so post-restore writes causally
 * dominate the recovered state. When the store carries a node id and none is
 * configured, the persisted id is adopted so restarts reuse the same
 * replica instead of minting fresh counter buckets.
 */

import {
  SyncEngine,
  type MergeSummary,
  type SyncEngineOptions,
  type SyncState,
} from '../sync-engine/index.js';
import { SqliteStateStore, type StateStore } from './sqlite-store.js';

/** Database path used when `open()` is called without one. */
export const DEFAULT_DB_PATH = 'aether.db';

export interface PersistentSyncEngineOptions extends SyncEngineOptions {
  /** Path of the SQLite database file. Defaults to {@link DEFAULT_DB_PATH}. */
  path?: string;
  /**
   * An already-open store. When omitted, a {@link SqliteStateStore} is
   * opened at `path`; injection keeps tests hermetic.
   */
  store?: StateStore;
  /** Observer for asynchronous flush failures (mutations never throw on disk errors). */
  onFlushError?: (error: unknown) => void;
}

export class PersistentSyncEngine extends SyncEngine {
  private readonly store: StateStore;
  private readonly handleFlushError?: (error: unknown) => void;
  private flushChain: Promise<void> = Promise.resolve();
  private flushQueued = false;

  /**
   * Attach persistence to an open store. Prefer {@link PersistentSyncEngine.open},
   * which also restores the saved state; this constructor exists for
   * injected stores and internal reuse.
   */
  constructor(
    store: StateStore,
    options: SyncEngineOptions & PersistentSyncEngineOptions = {},
  ) {
    super(options);
    this.store = store;
    this.handleFlushError = options.onFlushError;
  }

  /**
   * Open the database at `options.path` (or a store given via
   * `options.store`), restore the persisted state if any, and return a
   * persistent engine.
   */
  static async open(
    options: PersistentSyncEngineOptions = {},
  ): Promise<PersistentSyncEngine> {
    const { path, store: givenStore, onFlushError, ...engineOptions } = options;
    const store = givenStore ?? (await SqliteStateStore.open(path ?? DEFAULT_DB_PATH));
    const persisted = store.loadState();
    const engine = new PersistentSyncEngine(store, {
      ...engineOptions,
      nodeId: engineOptions.nodeId ?? persisted?.node,
    });
    engine.adoptPersisted(persisted);
    return engine;
  }

  /** The store backing this engine (exposed for servers that manage its lifecycle). */
  get backingStore(): StateStore {
    return this.store;
  }

  override set(key: string, value: unknown): void {
    super.set(key, value);
    this.scheduleFlush();
  }

  override increment(key: string, by = 1): void {
    super.increment(key, by);
    this.scheduleFlush();
  }

  override merge(remote: SyncState): MergeSummary {
    const summary = super.merge(remote);
    this.scheduleFlush();
    return summary;
  }

  override import(stateOrJson: string | SyncState): MergeSummary {
    const summary = super.import(stateOrJson);
    this.scheduleFlush();
    return summary;
  }

  /** Wait until every flush scheduled so far has completed (or failed). */
  async flush(): Promise<void> {
    await this.flushChain;
  }

  /** Flush pending writes and close the underlying store. */
  async close(): Promise<void> {
    await this.flush();
    this.store.close();
  }

  /**
   * Coalescing flush: at most one write is in flight, and one more may be
   * queued behind it; whatever arrives later is always picked up by the
   * queued write. The chain never rejects, so `flush()` and the mutation
   * fast-path stay free of unhandled rejections.
   */
  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.flushChain = this.flushChain.then(async () => {
      this.flushQueued = false;
      try {
        await this.store.saveState(this.export());
      } catch (error) {
        this.handleFlushError?.(error);
      }
    });
  }

  private adoptPersisted(state: SyncState | undefined): void {
    if (state === undefined) return;
    super.merge(state);
  }
}
