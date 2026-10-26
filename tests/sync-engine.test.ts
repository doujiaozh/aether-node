import {
  SyncEngine,
  SyncImportError,
  compareHlc,
  counterValue,
  type SyncState,
} from '../src/sync-engine/index.js';

describe('HLC timestamps', () => {
  it('orders by wall time first', () => {
    expect(compareHlc({ wall: 2, logical: 0, node: 'a' }, { wall: 1, logical: 99, node: 'b' })).toBeGreaterThan(0);
  });

  it('breaks wall ties with the logical counter', () => {
    expect(compareHlc({ wall: 5, logical: 2, node: 'a' }, { wall: 5, logical: 1, node: 'a' })).toBeGreaterThan(0);
    expect(compareHlc({ wall: 5, logical: 1, node: 'a' }, { wall: 5, logical: 1, node: 'a' })).toBe(0);
  });

  it('breaks full ties with the node id deterministically', () => {
    expect(compareHlc({ wall: 5, logical: 1, node: 'b' }, { wall: 5, logical: 1, node: 'a' })).toBeGreaterThan(0);
    expect(compareHlc({ wall: 5, logical: 1, node: 'a' }, { wall: 5, logical: 1, node: 'b' })).toBeLessThan(0);
  });

  it('keeps a local clock monotonic even when the wall clock stalls', () => {
    let now = 1_000;
    const engine = new SyncEngine({ nodeId: 'a', now: () => now });
    engine.set('k', 1);
    engine.set('k', 2);
    engine.set('k', 3); // same wall ms → logical increments
    const ts = engine.timestampOf('k');
    expect(ts).toBeDefined();
    expect(ts!.logical).toBeGreaterThanOrEqual(1);
  });
});

describe('LWW-Register replication', () => {
  it('replicates a value to a peer via export/import', () => {
    const alice = new SyncEngine({ nodeId: 'alice' });
    const bob = new SyncEngine({ nodeId: 'bob' });
    alice.set('greeting', 'hello');
    const summary = bob.import(alice.exportJson());
    expect(bob.get('greeting')).toBe('hello');
    expect(summary.registersChanged).toBe(1);
    expect(summary.applied).toBe(true);
  });

  it('last writer wins on concurrent offline edits', () => {
    let now = 1_000;
    const alice = new SyncEngine({ nodeId: 'alice', now: () => now });
    const bob = new SyncEngine({ nodeId: 'bob', now: () => now + 10 });
    alice.set('note', 'from-alice');
    bob.set('note', 'from-bob');
    const winner = bob.get('note');
    bob.import(alice.exportJson());
    expect(bob.get('note')).toBe(winner);
    alice.import(bob.exportJson());
    expect(alice.get('note')).toBe(winner);
    expect(alice.get('note')).toBe('from-bob');
  });

  it('resolves identical wall-clock edits with the deterministic node-id tiebreak', () => {
    let now = 5_000;
    const make = (node: string) => {
      const engine = new SyncEngine({ nodeId: node, now: () => now });
      engine.set('x', `written-by-${node}`);
      return engine;
    };
    const a = make('aaa');
    const b = make('zzz');
    const c = make('mmm');
    a.import(b.export());
    b.import(c.export());
    a.import(b.export());
    c.import(b.export());
    expect(a.get('x')).toBe('written-by-zzz');
    expect(b.get('x')).toBe('written-by-zzz');
    expect(c.get('x')).toBe('written-by-zzz');
  });

  it('merge is idempotent: re-importing nothing new changes nothing', () => {
    const a = new SyncEngine({ nodeId: 'a' });
    const b = new SyncEngine({ nodeId: 'b' });
    a.set('k', 'v1');
    b.import(a.export());
    const before = b.export();
    const summary = b.import(a.export());
    expect(summary.applied).toBe(false);
    expect(b.exportJson()).toBe(JSON.stringify(before));
  });

  it('merge is order-independent: A⊕B⊕C converges for any permutation', () => {
    const make = () => {
      const e = new SyncEngine({ nodeId: 'seed' });
      e.set('name', 'shared');
      e.increment('hits', 5);
      return e.export();
    };
    const states = [make(), make(), make()].map((s, i) => {
      const e = new SyncEngine({ nodeId: `n${i}` });
      e.import(s);
      e.set(`key-${i}`, `value-${i}`);
      e.increment(`hits`, i + 1);
      return e.export();
    });
    const permutations: SyncState[][] = [
      [states[0], states[1], states[2]],
      [states[2], states[0], states[1]],
      [states[1], states[2], states[0]],
    ];
    const snapshots = permutations.map((order) => {
      const engine = new SyncEngine({ nodeId: 'sink' });
      for (const state of order) engine.import(state);
      return engine.exportJson();
    });
    expect(snapshots[1]).toBe(snapshots[0]);
    expect(snapshots[2]).toBe(snapshots[0]);
  });

  it('handles a diverged offline-then-reconnect scenario without conflict', () => {
    const server = new SyncEngine({ nodeId: 'server' });
    server.set('task:1', 'created');
    const laptop = new SyncEngine({ nodeId: 'laptop' });
    laptop.import(server.export());
    // both sides go offline and edit
    server.set('task:1', 'progress-server');
    laptop.set('task:1', 'progress-laptop');
    // reconnect, both directions
    server.import(laptop.export());
    laptop.import(server.export());
    server.import(laptop.export());
    // The converged payload must match byte-for-byte; only each replica's own
    // `node` id and Lamport `version` may differ between the two exports.
    const payload = (json: string) => {
      const { registers, counters } = JSON.parse(json) as SyncState;
      return JSON.stringify({ registers, counters });
    };
    expect(payload(server.exportJson())).toBe(payload(laptop.exportJson()));
    expect(laptop.get('task:1')).toBe(server.get('task:1'));
  });
});

describe('PN-Counter replication', () => {
  it('sets and reads a counter', () => {
    const engine = new SyncEngine({ nodeId: 'n' });
    engine.increment('tokens');
    engine.increment('tokens', 4);
    engine.decrement('tokens', 2);
    expect(engine.counterValue('tokens')).toBe(3);
  });

  it('sums increments across replicas on merge', () => {
    const a = new SyncEngine({ nodeId: 'a' });
    const b = new SyncEngine({ nodeId: 'b' });
    const c = new SyncEngine({ nodeId: 'c' });
    a.increment('views', 5);
    b.increment('views', 7);
    c.increment('views');
    c.merge(a.export());
    c.merge(b.export());
    expect(c.counterValue('views')).toBe(13);
  });

  it('handles decrement-then-replicate on both sides', () => {
    const a = new SyncEngine({ nodeId: 'a' });
    const b = new SyncEngine({ nodeId: 'b' });
    a.increment('stock', 10);
    b.import(a.export());
    a.decrement('stock', 4);
    b.decrement('stock', 3);
    a.import(b.export());
    b.import(a.export());
    expect(a.counterValue('stock')).toBe(3);
    expect(b.counterValue('stock')).toBe(3);
  });

  it('converges on identical totals even with equal-sum relays', () => {
    const a = new SyncEngine({ nodeId: 'a' });
    const b = new SyncEngine({ nodeId: 'b' });
    a.increment('k', 5);
    b.increment('k', 5);
    expect(counterValue({ p: { a: 5 }, n: {} })).toBe(5);
    a.merge(b.export());
    const afterFirst = a.counterKeys();
    expect(afterFirst).toContain('k');
    a.merge(b.export());
    expect(a.counterValue('k')).toBe(10);
  });
});

describe('export / import (JSON)', () => {
  it('round-trips registers and counters through a JSON string', () => {
    const engine = new SyncEngine({ nodeId: 'rt' });
    engine.set('answer', 42);
    engine.set('nested', { deep: { array: [1, 2, 3] } });
    engine.increment('qty', 11);
    const json = engine.exportJson();
    const replayed = SyncEngine.fromJson(json);
    expect(replayed.get('answer')).toBe(42);
    expect(replayed.get('nested')).toEqual({ deep: { array: [1, 2, 3] } });
    expect(replayed.counterValue('qty')).toBe(11);
  });

  it('produces stable, sorted-keys output', () => {
    const engine = new SyncEngine({ nodeId: 'stable' });
    engine.set('b', 2);
    engine.set('a', 1);
    engine.set('d', 4);
    engine.set('c', 3);
    const export1 = engine.exportJson();
    // Key order is alphabetical regardless of write order.
    expect(Object.keys(JSON.parse(export1).registers)).toEqual(['a', 'b', 'c', 'd']);
    // Repeating the export is byte-identical.
    expect(engine.exportJson()).toBe(export1);
    // Replaying the state through fromJson reproduces the same bytes.
    const replayed = SyncEngine.fromJson(export1);
    expect(replayed.exportJson()).toBe(export1);
  });

  it('rejects malformed imports without corrupting local state', () => {
    const engine = new SyncEngine({ nodeId: 'safe' });
    engine.set('keep', 'me');
    const before = engine.exportJson();
    const bad: unknown[] = [
      'not json',
      JSON.stringify({ format: 'other/v9' }),
      JSON.stringify({ format: 'aether-node/v1', node: 42, version: 1 }),
      JSON.stringify({
        format: 'aether-node/v1',
        node: 'x',
        version: 1,
        registers: { bad: { value: 1, ts: { wall: 'x', logical: 0, node: 'x' } } },
      }),
      JSON.stringify({ format: 'aether-node/v1' }),
    ];
    for (const badCase of bad) {
      expect(() => engine.import(badCase as string)).toThrowError(SyncImportError);
    }
    expect(engine.exportJson()).toBe(before);
  });

  it('accepts an already-parsed state object as well as a string', () => {
    const engine = new SyncEngine({ nodeId: 'obj' });
    engine.set('a', 1);
    const state = engine.export();
    const other = new SyncEngine({ nodeId: 'other' });
    other.import(state);
    expect(other.get('a')).toBe(1);
  });

  it('bumps the version on every mutation and merge', () => {
    const engine = new SyncEngine({ nodeId: 'v' });
    const v0 = engine.version;
    engine.set('a', 1);
    engine.increment('c', 1);
    expect(engine.version).toBe(v0 + 2);
    const peer = new SyncEngine({ nodeId: 'peer' });
    peer.set('z', 9);
    engine.import(peer.export());
    expect(engine.version).toBeGreaterThan(v0 + 2);
  });
});
