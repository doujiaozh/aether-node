import { afterEach, describe, expect, it } from '@jest/globals';

import {
  P2PSyncNode,
  RpcClient,
  RpcError,
  RpcServer,
  WsRpcServer,
  WsRpcTransport,
  registerSystemMethods,
} from '../src/agent-protocol/index.js';
import { MicroVm } from '../src/micro-vm/index.js';
import { SyncEngine, type MergeSummary, type SyncState } from '../src/sync-engine/index.js';

/** Poll until `condition` holds; fails the test instead of hanging forever. */
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition never met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Node ids used across these tests, so exports stay deterministic. */
let nodeCounter = 0;
function nextNodeId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${nodeCounter}`;
}

/** Stop or close anything we started, in reverse order. */
const cleanup: { stop?: () => Promise<void> | void; close?: () => Promise<void> | void }[] = [];

function track(stoppable: {
  stop?: () => Promise<void> | void;
  close?: () => Promise<void> | void;
}): void {
  cleanup.push(stoppable);
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const item = cleanup.pop();
    if (item) await (item.stop?.() ?? item.close?.());
  }
});

describe('agent-protocol — WebSocket transport (WsRpcServer + WsRpcTransport)', () => {
  it('calls rpc.discover over a WebSocket connection', async () => {
    const rpc = new RpcServer();
    registerSystemMethods(rpc, {
      vm: new MicroVm(),
      engine: new SyncEngine({ nodeId: 'ws-node' }),
    });
    const server = new WsRpcServer(rpc);
    track(server);
    const address = await server.listen();
    expect(address.port).toBeGreaterThan(0);

    const transport = new WsRpcTransport(server.url);
    const client = new RpcClient(transport);
    const methods = await client.call<string[]>('rpc.discover');
    expect(methods).toEqual(
      expect.arrayContaining([
        'vm.execute',
        'sync.getState',
        'sync.merge',
        'sync.importState',
        'rpc.discover',
      ]),
    );
    transport.close();
  });

  it('runs vm.execute and sync.getState through the WebSocket transport', async () => {
    const engine = new SyncEngine({ nodeId: 'ws-vm-node' });
    engine.set('boot', 'ok');
    const rpc = new RpcServer();
    registerSystemMethods(rpc, { vm: new MicroVm(), engine });
    const server = new WsRpcServer(rpc);
    track(server);
    await server.listen();

    const client = new RpcClient(new WsRpcTransport(server.url));
    const result = await client.call<{ ok: boolean; value: unknown }>('vm.execute', {
      code: 'return ctx.x + 1',
      context: { ctx: { x: 41 } },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);

    const state = await client.call<SyncState>('sync.getState');
    expect(state.node).toBe('ws-vm-node');
    expect(state.registers.boot.value).toBe('ok');
  });

  it('correlates concurrent in-flight requests on one connection', async () => {
    const rpc = new RpcServer();
    registerSystemMethods(rpc, { vm: new MicroVm(), engine: new SyncEngine() });
    const server = new WsRpcServer(rpc);
    track(server);
    await server.listen();

    const client = new RpcClient(new WsRpcTransport(server.url));
    const calls = Array.from({ length: 8 }, (_, i) =>
      client.call<{ value: unknown }>('vm.execute', { code: `return ${i} * ${i}` }),
    );
    const results = await Promise.all(calls);
    results.forEach((result, i) => expect(result.value).toBe(i * i));
  });

  it('accepts notifications without waiting for a response', async () => {
    const engine = new SyncEngine({ nodeId: 'ws-notify' });
    const rpc = new RpcServer();
    registerSystemMethods(rpc, { vm: new MicroVm(), engine });
    const server = new WsRpcServer(rpc);
    track(server);
    await server.listen();

    const client = new RpcClient(new WsRpcTransport(server.url));
    await client.notify('sync.merge', { registers: { hello: 'world' } });
    await until(() => engine.get('hello') === 'world');
    expect(engine.get('hello')).toBe('world');
  });

  it('rejects calls when the peer goes away', async () => {
    const rpc = new RpcServer();
    registerSystemMethods(rpc, { vm: new MicroVm(), engine: new SyncEngine() });
    const server = new WsRpcServer(rpc);
    track(server);
    await server.listen();

    const transport = new WsRpcTransport(server.url);
    const client = new RpcClient(transport);
    await client.call('rpc.discover');
    transport.close();
    await expect(client.call('rpc.discover')).rejects.toThrow(RpcError);
  });

  it('rejects calls to an unreachable endpoint with a transport error', async () => {
    const transport = new WsRpcTransport('ws://127.0.0.1:1', { connectTimeoutMs: 1000 });
    const client = new RpcClient(transport);
    await expect(client.call('rpc.discover')).rejects.toMatchObject({ code: -32300 });
  }, 10_000);
});

describe('agent-protocol — P2P sync (P2PSyncNode)', () => {
  it('exchanges full state immediately on connect', async () => {
    const nodeA = new P2PSyncNode({ nodeId: nextNodeId('a') });
    const nodeB = new P2PSyncNode({ nodeId: nextNodeId('b') });
    nodeA.engine.set('greeting', 'hello from A');
    nodeA.engine.increment('visits', 3);
    await nodeA.start();
    await nodeB.start();
    track(nodeA);
    track(nodeB);

    await nodeB.connect(nodeA.url);
    expect(nodeB.get('greeting')).toBe('hello from A');
    expect(nodeB.counterValue('visits')).toBe(3);
    // B had nothing new, so A learned nothing — that is correct CRDT behavior.
    expect(Object.keys(nodeA.engine.export().registers)).toEqual(['greeting']);
  });

  it('converges both ways as peers keep editing', async () => {
    const nodeA = new P2PSyncNode({ nodeId: nextNodeId('a'), syncIntervalMs: 40 });
    const nodeB = new P2PSyncNode({ nodeId: nextNodeId('b'), syncIntervalMs: 40 });
    await nodeA.start();
    await nodeB.start();
    track(nodeA);
    track(nodeB);
    await nodeB.connect(nodeA.url);

    nodeA.engine.set('lang', 'typescript');
    nodeB.engine.set('os', 'local-first');
    nodeA.engine.increment('visits', 4);
    nodeB.engine.increment('visits', 6);

    await until(() => {
      const same =
        nodeA.get('lang') === 'typescript' &&
        nodeA.get('os') === 'local-first' &&
        nodeB.get('lang') === 'typescript' &&
        nodeB.get('os') === 'local-first' &&
        nodeA.counterValue('visits') === 10 &&
        nodeB.counterValue('visits') === 10;
      return same;
    });
    expect(nodeA.engine.export().registers).toEqual(nodeB.engine.export().registers);
    expect(nodeA.engine.export().counters).toEqual(nodeB.engine.export().counters);
  });

  it('relays state through intermediate peers in a three-node mesh', async () => {
    const nodeA = new P2PSyncNode({ nodeId: nextNodeId('a'), syncIntervalMs: 40 });
    const hub = new P2PSyncNode({ nodeId: nextNodeId('hub'), syncIntervalMs: 40 });
    const nodeC = new P2PSyncNode({ nodeId: nextNodeId('c'), syncIntervalMs: 40 });
    await nodeA.start();
    await hub.start();
    await nodeC.start();
    track(nodeA);
    track(hub);
    track(nodeC);

    await hub.connect(nodeA.url);
    await nodeC.connect(hub.url);
    nodeA.engine.set('broadcast', 'to everyone');

    // C and the hub must both learn A's register through the relay.
    await until(() => {
      return (
        hub.get('broadcast') === 'to everyone' && nodeC.get('broadcast') === 'to everyone'
      );
    });
    expect(nodeC.get('broadcast')).toBe('to everyone');
  });

  it('reports new peers through onPeer and merges through onSync', async () => {
    const peers: string[] = [];
    const syncs: MergeSummary[] = [];
    const nodeA = new P2PSyncNode({
      nodeId: nextNodeId('a'),
      syncIntervalMs: 40,
      onPeer: (url) => peers.push(url),
      onSync: (summary) => syncs.push(summary),
    });
    const nodeB = new P2PSyncNode({ nodeId: nextNodeId('b'), syncIntervalMs: 40 });
    await nodeA.start();
    await nodeB.start();
    track(nodeA);
    track(nodeB);

    await nodeA.connect(nodeB.url);
    expect(peers).toEqual([nodeB.url]);

    nodeB.engine.set('late', 'edit');
    await until(() => nodeA.get('late') === 'edit');
    expect(nodeA.get('late')).toBe('edit');
    expect(syncs.some((summary) => summary.applied && summary.registersChanged > 0)).toBe(true);
  });

  it('drops peers whose connection fails, and they can reconnect', async () => {
    const nodeA = new P2PSyncNode({ nodeId: nextNodeId('a'), syncIntervalMs: 40 });
    const nodeB = new P2PSyncNode({ nodeId: nextNodeId('b'), syncIntervalMs: 40 });
    await nodeA.start();
    await nodeB.start();
    track(nodeA);
    track(nodeB);
    await nodeA.connect(nodeB.url);
    expect(nodeA.peerUrls).toEqual([nodeB.url]);

    await nodeB.stop();
    await until(() => nodeA.peerUrls.length === 0);
    expect(nodeA.peerUrls).toEqual([]);
  });

  it('keeps any injected SyncEngine, including persistent ones, as the replica', async () => {
    const engine = new SyncEngine({ nodeId: nextNodeId('injected') });
    engine.set('seed', 'value');
    const node = new P2PSyncNode({ nodeId: nextNodeId('outer'), engine });
    expect(node.engine).toBe(engine);
    expect(node.nodeId).toBe(engine.nodeId);
    await node.start();
    track(node);
    const state = await new RpcClient(new WsRpcTransport(node.url)).call<SyncState>(
      'sync.getState',
    );
    expect(state.registers.seed.value).toBe('value');
  });
});

describe('agent-protocol — P2P nodes serve the standard method surface', () => {
  it('exposes vm.execute and sync.merge to peers over WebSocket', async () => {
    const node = new P2PSyncNode({ nodeId: nextNodeId('rpc') });
    await node.start();
    track(node);

    const client = new RpcClient(new WsRpcTransport(node.url));
    const result = await client.call<{ ok: boolean; value: unknown }>('vm.execute', {
      code: 'return "p2p".toUpperCase()',
    });
    expect(result.value).toBe('P2P');

    await client.notify('sync.merge', { counters: { tokens: 7 } });
    await until(() => node.counterValue('tokens') === 7);
  });
});
