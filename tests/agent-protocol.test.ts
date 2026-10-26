import {
  RpcServer,
  RpcClient,
  RpcError,
  RpcErrorCode,
  LoopbackTransport,
  HttpRpcServer,
  HttpRpcTransport,
  registerSystemMethods,
} from '../src/agent-protocol/index.js';
import { MicroVm, type VmResult } from '../src/micro-vm/index.js';
import { SyncEngine, type SyncState, type MergeSummary } from '../src/sync-engine/index.js';

function makeLoopbackClient(): { server: RpcServer; client: RpcClient } {
  const server = new RpcServer();
  const client = new RpcClient(new LoopbackTransport(server));
  return { server, client };
}

describe('agent-protocol — routing and error handling', () => {
  it('routes calls to registered handlers and returns results', async () => {
    const { server, client } = makeLoopbackClient();
    server.register('add', (params) => {
      const p = params as { a: number; b: number };
      return p.a + p.b;
    });
    await expect(client.call('add', { a: 1, b: 2 })).resolves.toBe(3);
  });

  it('reports unknown methods with the standard code', async () => {
    const { client } = makeLoopbackClient();
    await expect(client.call('nope')).rejects.toMatchObject({
      code: RpcErrorCode.METHOD_NOT_FOUND,
    });
  });

  it('maps RpcError thrown by handlers onto error envelopes', async () => {
    const { server, client } = makeLoopbackClient();
    server.register('deny', () => {
      throw new RpcError(-32099, 'custom failure', { detail: 'x' });
    });
    await expect(client.call('deny')).rejects.toMatchObject({
      code: -32099,
      message: 'custom failure',
    });
  });

  it('maps generic exceptions to INTERNAL_ERROR', async () => {
    const { server, client } = makeLoopbackClient();
    server.register('boom', () => {
      throw new Error('unexpected');
    });
    await expect(client.call('boom')).rejects.toMatchObject({
      code: RpcErrorCode.INTERNAL_ERROR,
      message: 'unexpected',
    });
  });

  it('handles notifications without expecting a response', async () => {
    const { server, client } = makeLoopbackClient();
    let seen = 0;
    server.register('ping', () => {
      seen += 1;
      return 'pong';
    });
    await client.notify('ping');
    await client.notify('ping');
    expect(seen).toBe(2);
  });

  it('rejects malformed request documents with INVALID_REQUEST', async () => {
    const { server } = makeLoopbackClient();
    const response = await server.handleRaw('{"jsonrpc":"1.0","method":"x"}');
    const body = JSON.parse(response as string);
    expect(body.error.code).toBe(RpcErrorCode.INVALID_REQUEST);
    expect(body.id).toBeNull();
  });

  it('reports invalid params from handlers', async () => {
    const { server, client } = makeLoopbackClient();
    server.register('inc', (params) => {
      const p = params as { n?: unknown };
      if (typeof p.n !== 'number') {
        throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'params.n must be a number');
      }
      return p.n + 1;
    });
    await expect(client.call('inc', { n: 'x' })).rejects.toMatchObject({
      code: RpcErrorCode.INVALID_PARAMS,
    });
  });

  it('supports batch requests with mixed outcomes', async () => {
    const { server } = makeLoopbackClient();
    server.register('echo', (p) => p);
    const responses = await server.handleBatch([
      { jsonrpc: '2.0', id: 1, method: 'echo', params: { v: 'a' } },
      { jsonrpc: '2.0', method: 'echo', params: 'notification' }, // notification → no response
      { jsonrpc: '2.0', id: 2, method: 'missing' },
      'garbage',
    ]);
    expect(responses).toHaveLength(3);
    expect(responses![0].id).toBe(1);
    expect(responses![1].error?.code).toBe(RpcErrorCode.METHOD_NOT_FOUND);
    expect(responses![2].error?.code).toBe(RpcErrorCode.INVALID_REQUEST);
  });

  it('rejects empty batches', async () => {
    const { server } = makeLoopbackClient();
    await expect(server.handleBatch([])).rejects.toBeInstanceOf(RpcError);
  });

  it('routes the id back to the client even on failures', async () => {
    const { server } = makeLoopbackClient();
    const raw = await server.handleRaw('{"jsonrpc":"2.0","id":"abc","method":"missing"}');
    expect(JSON.parse(raw as string).id).toBe('abc');
  });

  it('rejects when the transport never answers (loopback timeout)', async () => {
    const server = new RpcServer();
    server.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 'late';
    });
    const client = new RpcClient(new LoopbackTransport(server));
    await expect(client.call('slow', undefined, { timeoutMs: 50 })).rejects.toThrow(
      /timed out/,
    );
  });
});

describe('agent-protocol — HTTP transport', () => {
  let httpServer: HttpRpcServer | undefined;

  afterEach(async () => {
    if (httpServer !== undefined) {
      await httpServer.close();
      httpServer = undefined;
    }
  });

  it('serves JSON-RPC over HTTP end to end', async () => {
    const rpc = new RpcServer();
    rpc.register('add', (p) => {
      const params = p as { a: number; b: number };
      return params.a + params.b;
    });
    httpServer = new HttpRpcServer(rpc);
    const { port } = await httpServer.listen();
    const client = new RpcClient(new HttpRpcTransport(`http://127.0.0.1:${port}/`));
    await expect(client.call('add', { a: 40, b: 2 })).resolves.toBe(42);
  });

  it('exposes a deterministic URL after listen()', async () => {
    httpServer = new HttpRpcServer(new RpcServer(), { port: 0 });
    await httpServer.listen();
    expect(httpServer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('answers 204 for notifications over HTTP', async () => {
    const rpc = new RpcServer();
    let calls = 0;
    rpc.register('note', () => {
      calls += 1;
    });
    httpServer = new HttpRpcServer(rpc);
    const { port } = await httpServer.listen();
    const transport = new HttpRpcTransport(`http://127.0.0.1:${port}/`);
    await transport.post(JSON.stringify({ jsonrpc: '2.0', method: 'note' }));
    expect(calls).toBe(1);
  });

  it('rejects non-POST requests with 405', async () => {
    httpServer = new HttpRpcServer(new RpcServer());
    const { port } = await httpServer.listen();
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
    expect(response.status).toBe(405);
  });
});

describe('agent-protocol — system methods (vm.execute + sync.getState)', () => {
  const makeNode = () => {
    const server = new RpcServer();
    registerSystemMethods(server, {
      vm: new MicroVm(),
      engine: new SyncEngine({ nodeId: 'rpc-node' }),
    });
    return new RpcClient(new LoopbackTransport(server));
  };

  it('runs code through vm.execute over JSON-RPC', async () => {
    const client = makeNode();
    const result = await client.call<VmResult>('vm.execute', {
      code: 'return ctx.n * 3;',
      context: { ctx: { n: 14 } },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('returns sandbox failures as error envelopes, not exceptions', async () => {
    const client = makeNode();
    const result = await client.call<VmResult>('vm.execute', {
      code: 'while (true) {}',
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('timeout');
  });

  it('reads the current sync state via sync.getState', async () => {
    const client = makeNode();
    const state = await client.call<SyncState>('sync.getState');
    expect(state.format).toBe('aether-node/v1');
    expect(state.node).toBe('rpc-node');
    expect(state.registers).toEqual({});
  });

  it('validates vm.execute params', async () => {
    const client = makeNode();
    await expect(client.call('vm.execute', { code: 42 })).rejects.toMatchObject({
      code: RpcErrorCode.INVALID_PARAMS,
    });
    await expect(client.call('vm.execute', {})).rejects.toMatchObject({
      code: RpcErrorCode.INVALID_PARAMS,
    });
  });

  it('writes agent data through sync.merge and reads it back', async () => {
    const client = makeNode();
    const summary = await client.call<MergeSummary>('sync.merge', {
      registers: { thought: 'hello world' },
      counters: { tokens: 128 },
    });
    expect(summary.applied).toBe(true);
    expect(summary.registersChanged).toBe(1);
    expect(summary.countersChanged).toBe(1);
    const state = await client.call<SyncState>('sync.getState');
    expect(state.registers.thought.value).toBe('hello world');
    expect(Object.keys(state.counters.tokens.p)).toEqual(['rpc-node']);
  });

  it('lists methods via rpc.discover', async () => {
    const client = makeNode();
    const methods = await client.call('rpc.discover');
    expect(methods).toEqual(
      expect.arrayContaining(['vm.execute', 'sync.getState', 'sync.merge', 'rpc.discover']),
    );
  });
});
