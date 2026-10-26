import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PersistentSyncEngine,
  SqliteStateStore,
  PersistenceError,
  PERSIST_FORMAT,
  type StateStore,
  type PersistentSyncEngineOptions,
} from '../src/persistence/index.js';
import {
  SyncEngine,
  SYNC_STATE_FORMAT,
  compareHlc,
} from '../src/sync-engine/index.js';

/** Fresh, unique database path for one test case. */
async function newDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aether-persist-'));
  return join(dir, 'aether.db');
}

/** Poll until `condition` holds; fails the test instead of hanging forever. */
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition never met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Read whatever is currently persisted at `path`, or return undefined. */
async function probeState(path: string) {
  const probe = await SqliteStateStore.open(path);
  const state = probe.loadState();
  probe.close();
  return state;
}

const openedEngines: PersistentSyncEngine[] = [];

async function openEngine(options: Partial<PersistentSyncEngineOptions> = {}): Promise<PersistentSyncEngine> {
  const engine = await PersistentSyncEngine.open(options);
  openedEngines.push(engine);
  return engine;
}

afterEach(async () => {
  while (openedEngines.length > 0) {
    const engine = openedEngines.pop();
    if (engine) await engine.close();
  }
});

describe('SqliteStateStore', () => {
  it('exposes a fresh empty store as having no state', async () => {
    const path = await newDbPath();
    const store = await SqliteStateStore.open(path);
    expect(store.loadState()).toBeUndefined();
    store.close();
  });

  it('round-trips a serialized SyncState byte for value', async () => {
    const path = await newDbPath();
    const engine = new SyncEngine({ nodeId: 'rt-1' });
    engine.set('name', 'aether');
    engine.set('nested', { deep: { array: [1, 2, 3] }, ok: true });
    engine.increment('hits', 7);
    engine.decrement('misses', 2);

    const store = await SqliteStateStore.open(path);
    await store.saveState(engine.export());
    const loaded = store.loadState();
    expect(loaded).toEqual(engine.export());
    store.close();
  });

  it('writes the persistence format marker into the database', async () => {
    const path = await newDbPath();
    const engine = new SyncEngine({ nodeId: 'fmt-1' });
    engine.set('k', 'v');

    const store = await SqliteStateStore.open(path);
    await store.saveState(engine.export());
    const raw = (await readFile(path)).toString('latin1');
    expect(raw).toContain(PERSIST_FORMAT);
    store.close();
  });
});

describe('PersistentSyncEngine restore', () => {
  it('recovers registers and counters across a reopen', async () => {
    const path = await newDbPath();
    const first = await openEngine({ path, nodeId: 'restore-1' });
    first.set('answer', 42);
    first.set('payload', { hello: 'world', n: [1, 2, 3] });
    first.increment('requests', 5);
    first.decrement('errors', 2);
    await first.flush();
    await first.close();
    openedEngines.pop();

    const second = await openEngine({ path });
    expect(second.nodeId).toBe('restore-1');
    expect(second.get('answer')).toBe(42);
    expect(second.get('payload')).toEqual({ hello: 'world', n: [1, 2, 3] });
    expect(second.counterValue('requests')).toBe(5);
    expect(second.counterValue('errors')).toBe(-2);
    expect(second.export().node).toBe('restore-1');
  });

  it('adopts the persisted node id when none is configured', async () => {
    const path = await newDbPath();
    const first = await openEngine({ path, nodeId: 'auto-id' });
    first.set('k', 'v');
    await first.close();
    openedEngines.pop();

    const second = await openEngine({ path });
    expect(second.nodeId).toBe('auto-id');
  });

  it('honors an explicitly configured node id over the persisted one', async () => {
    const path = await newDbPath();
    const first = await openEngine({ path, nodeId: 'old' });
    first.set('k', 'v');
    await first.close();
    openedEngines.pop();

    const second = await openEngine({ path, nodeId: 'new' });
    expect(second.nodeId).toBe('new');
  });

  it('restores counter buckets under the persisted replica id', async () => {
    const path = await newDbPath();
    const first = await openEngine({ path, nodeId: 'bucket-1' });
    first.increment('shared', 3);
    await first.close();
    openedEngines.pop();

    const second = await openEngine({ path, nodeId: 'bucket-2' });
    second.increment('shared', 4);
    await second.close();
    openedEngines.pop();

    const third = await openEngine({ path });
    expect(third.counterValue('shared')).toBe(7);
    expect(Object.keys(third.export().counters.shared.p).sort()).toEqual([
      'bucket-1',
      'bucket-2',
    ]);
  });

  it('keeps recovered writes causally dominant after restart', async () => {
    const fixedNow = () => 5_000_000;
    const path = await newDbPath();
    const first = await openEngine({ path, nodeId: 'hlc-1', now: fixedNow });
    first.set('k', 'first');
    await first.close();
    openedEngines.pop();

    const second = await openEngine({ path, nodeId: 'hlc-1', now: fixedNow });
    second.set('k', 'second');
    const state = second.export();
    expect(compareHlc(state.registers.k.ts, { wall: 5_000_000, logical: 0, node: 'hlc-1' })).toBe(1);
    expect(second.get('k')).toBe('second');
  });

  it('starts empty when the database file does not exist', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'fresh' });
    expect(engine.registerKeys()).toEqual([]);
    expect(engine.counterKeys()).toEqual([]);
  });

  it('starts empty when the database file is empty', async () => {
    const path = await newDbPath();
    await writeFile(path, Buffer.alloc(0));
    const engine = await openEngine({ path, nodeId: 'fresh-empty' });
    expect(engine.registerKeys()).toEqual([]);
  });

  it('refuses to open a file that is not a SQLite image', async () => {
    const path = await newDbPath();
    await writeFile(path, 'this is definitely not a sqlite database');
    await expect(openEngine({ path })).rejects.toThrow(PersistenceError);
  });
});

describe('PersistentSyncEngine auto-flush', () => {
  it('persists state asynchronously after set without an explicit flush', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'auto' });
    engine.set('async', 'written');
    engine.increment('count', 1);

    await until(async () => {
      const state = await probeState(path);
      return (
        state !== undefined &&
        state.registers.async.value === 'written' &&
        state.counters.count.p.auto === 1
      );
    });
    const state = await probeState(path);
    expect(state?.registers.async.value).toBe('written');
    expect(state?.counters.count.p.auto).toBe(1);
  });

  it('coalesces a burst of mutations into a consistent snapshot', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'burst' });
    for (let i = 0; i < 100; i += 1) {
      engine.increment('ticks', 1);
    }
    await engine.flush();

    const view = await SqliteStateStore.open(path);
    const state = view.loadState();
    expect(state?.counters.ticks.p.burst).toBe(100);
    view.close();
  });

  it('flush resolves once the scheduled write has settled', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'await-flush' });
    engine.set('k', 'v');
    await engine.flush();
    const raw = await readFile(path);
    expect(raw.byteLength).toBeGreaterThan(0);
    expect(raw.toString('latin1')).toContain('aether-node');
  });

  it('reports asynchronous save failures through onFlushError and keeps serving mutations', async () => {
    const flushErrors: unknown[] = [];
    const failing: StateStore = {
      loadState: () => undefined,
      saveState: async () => {
        throw new Error('disk on fire');
      },
      close: () => {},
    };
    const engine = new PersistentSyncEngine(failing, {
      nodeId: 'errors',
      onFlushError: (error) => flushErrors.push(error),
    });
    engine.set('k', 'v');
    await engine.flush();
    expect(flushErrors).toHaveLength(1);
    expect(String(flushErrors[0])).toContain('disk on fire');

    // Mutations themselves never throw because of disk errors.
    expect(() => engine.set('k', 'still works')).not.toThrow();
    expect(engine.get('k')).toBe('still works');
  });
});

describe('PersistentSyncEngine merge and import persistence', () => {
  it('persists merged-in peer state', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'merge-target' });

    const peer = new SyncEngine({ nodeId: 'peer-1' });
    peer.set('remote-key', 'remote-value');
    peer.increment('remote-counter', 11);

    engine.merge(peer.export());
    await engine.flush();
    await engine.close();
    openedEngines.pop();

    const reopened = await openEngine({ path });
    expect(reopened.get('remote-key')).toBe('remote-value');
    expect(reopened.counterValue('remote-counter')).toBe(11);
  });

  it('persists state imported from JSON', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'import-target' });

    const peer = new SyncEngine({ nodeId: 'peer-2' });
    peer.set('imported', true);
    const json = JSON.stringify(peer.export());

    engine.import(json);
    await engine.flush();
    await engine.close();
    openedEngines.pop();

    const reopened = await openEngine({ path });
    expect(reopened.get('imported')).toBe(true);
  });

  it('restores an engine whose persisted version is preserved or bumped only by real merges', async () => {
    const path = await newDbPath();
    const first = await openEngine({ path, nodeId: 'version-1' });
    first.set('k', 'v');
    const before = first.export().version;
    await first.close();
    openedEngines.pop();

    const second = await openEngine({ path });
    // Adopting the persisted snapshot is a merge, so the version is at least
    // as high as what was saved.
    expect(second.export().version).toBeGreaterThanOrEqual(before);
    expect(second.export()).toEqual(expect.objectContaining({ format: SYNC_STATE_FORMAT }));
  });
});

describe('PersistentSyncEngine close', () => {
  it('flushes pending writes before closing the store', async () => {
    const path = await newDbPath();
    const engine = await openEngine({ path, nodeId: 'close-1' });
    engine.set('last', 'write');
    await engine.close();
    openedEngines.pop();

    const view = await SqliteStateStore.open(path);
    const state = view.loadState();
    expect(state?.registers.last.value).toBe('write');
    view.close();
  });

  it('accepts a store injected by reference', async () => {
    const path = await newDbPath();
    const store = await SqliteStateStore.open(path);
    const engine = new PersistentSyncEngine(store, { nodeId: 'injected' });
    engine.set('k', 'injected-value');
    await engine.flush();
    expect(store.loadState()?.registers.k.value).toBe('injected-value');
  });
});
