import { afterEach, describe, expect, it } from '@jest/globals';

import { RpcClient, WsRpcTransport } from '../src/agent-protocol/index.js';
import { type VmResult } from '../src/micro-vm/index.js';
import { SyncEngine, type SyncState } from '../src/sync-engine/index.js';
import { AetherWebServer } from '../src/web/index.js';

const servers: AetherWebServer[] = [];

async function boot(options?: ConstructorParameters<typeof AetherWebServer>[0]): Promise<AetherWebServer> {
  const server = new AetherWebServer(options);
  await server.listen();
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

/** Fetch helper that always reads the full body (even for error statuses). */
async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(url, init);
  const body = await res.text();
  return { status: res.status, body, contentType: res.headers.get('content-type') };
}

function rpcBody(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

describe('web — static UI and JSON-RPC coexist on one server', () => {
  it('serves the index.html console at GET /', async () => {
    const server = await boot();
    const { status, body, contentType } = await fetchText(`${server.url}/`);
    expect(status).toBe(200);
    expect(contentType).toContain('text/html');
    expect(body).toContain('aether-node');
    expect(body).toContain('vm.execute');
    expect(body).toContain('<script src="/app.js">');
  });

  it('serves the vanilla app.js controller', async () => {
    const server = await boot();
    const { status, body, contentType } = await fetchText(`${server.url}/app.js`);
    expect(status).toBe(200);
    expect(contentType).toContain('javascript');
    expect(body).toContain('fetch');
  });

  it('answers 404 for unknown paths and 405 for unsupported methods', async () => {
    const server = await boot();
    const missing = await fetchText(`${server.url}/no-such-file`);
    expect(missing.status).toBe(404);

    // Encoded traversal must not escape the static directory.
    const escape = await fetchText(`${server.url}/%2e%2e/%2e%2e/package.json`);
    expect(escape.status).toBe(404);

    const weird = await fetchText(`${server.url}/`, { method: 'PUT', body: '' });
    expect(weird.status).toBe(405);
  });

  it('runs vm.execute through POST / from the browser flow', async () => {
    const engine = new SyncEngine({ nodeId: 'web-node' });
    const server = await boot({ engine });
    const { status, body, contentType } = await fetchText(`${server.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody(1, 'vm.execute', { code: 'return "hello".repeat(3)' }),
    });
    expect(status).toBe(200);
    expect(contentType).toContain('application/json');
    const doc = JSON.parse(body);
    expect(doc.result.ok).toBe(true);
    expect(doc.result.value).toBe('hellohellohello');
    expect(Array.isArray(doc.result.logs)).toBe(true);
  });

  it('reports sandbox failures inside the result envelope, like the other transports', async () => {
    const server = await boot();
    const { status, body } = await fetchText(`${server.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody(1, 'vm.execute', { code: 'while (true) {}', timeoutMs: 100 }),
    });
    expect(status).toBe(200);
    const doc = JSON.parse(body);
    // vm.execute never throws: a timeout is a normal result with status.
    expect(doc.result.ok).toBe(false);
    expect(doc.result.status).toBe('timeout');
  });

  it('accepts JSON-RPC notifications with 204 and no body', async () => {
    const engine = new SyncEngine({ nodeId: 'web-notify' });
    const server = await boot({ engine });
    const { status, body } = await fetchText(`${server.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'sync.merge', params: { registers: { k: 'v' } } }),
    });
    expect(status).toBe(204);
    expect(body).toBe('');
    await until(() => engine.get('k') === 'v');
  });

  it('exposes the same methods over WebSocket on the same port', async () => {
    const engine = new SyncEngine({ nodeId: 'web-ws-node' });
    const server = await boot({ engine });
    const transport = new WsRpcTransport(server.wsUrl);
    const client = new RpcClient(transport);
    const state = await client.call<SyncState>('sync.getState');
    expect(state.node).toBe('web-ws-node');
    const result = await client.call<VmResult>('vm.execute', { code: 'return 6 * 7' });
    expect(result.value).toBe(42);
    transport.close();
  });

  it('shares the injected replica between HTTP, WebSocket and P2P callers', async () => {
    const engine = new SyncEngine({ nodeId: 'web-shared' });
    const server = await boot({ engine });
    const transport = new WsRpcTransport(server.wsUrl);
    const client = new RpcClient(transport);
    const summary = await client.call<{ applied: boolean; version: number }>('sync.merge', {
      registers: { shared: 'yes' },
      counters: { hits: 2 },
    });
    expect(summary.applied).toBe(true);
    const state = await client.call<SyncState>('sync.getState');
    expect(state.node).toBe('web-shared');
    expect(state.registers.shared.value).toBe('yes');
    // The HTTP side sees the same replica: state written over WebSocket is
    // immediately readable through the browser-facing endpoint.
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody(7, 'sync.getState', {}),
    });
    const doc = JSON.parse(await res.text());
    expect(doc.result.registers.shared.value).toBe('yes');
    transport.close();
  });
});

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
