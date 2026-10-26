/**
 * web-demo — boot the aether-node web console.
 *
 * One server, one port: open the printed URL in a browser to run code in the
 * sandbox through the UI; the same origin also answers JSON-RPC POSTs and
 * WebSocket P2P peers. Ctrl+C stops the node (state is persisted first).
 */

import { AetherWebServer } from './src/web/index.js';
import { PersistentSyncEngine } from './src/persistence/index.js';

const DB_PATH = 'aether.db';

/** Default port; override with `AETHER_PORT=<port> npm run demo:web`. */
const DEFAULT_PORT = 40001;

/** Boot the web console; falls back to an OS-assigned port when 40001 is busy. */
async function boot(engine: PersistentSyncEngine): Promise<AetherWebServer> {
  const wanted = Number.parseInt(process.env.AETHER_PORT ?? '', 10);
  const port = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : DEFAULT_PORT;
  const server = new AetherWebServer({ engine, port });
  try {
    await server.listen();
    return server;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    await server.close();
    console.log(`port ${port} busy — picking an OS-assigned port instead`);
    const fallback = new AetherWebServer({ engine, port: 0 });
    await fallback.listen();
    return fallback;
  }
}

async function main(): Promise<void> {
  const engine = await PersistentSyncEngine.open({ path: DB_PATH });
  const server = await boot(engine);
  const { host, port } = await server.listen();

  // Self-check: the page and the JSON-RPC endpoint really coexist.
  const page = await fetch(`http://${host}:${port}/`);
  const doc = await fetch(`http://${host}:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover', params: {} }),
  });
  const body = (await doc.json()) as { result?: unknown };
  const methods = Array.isArray(body.result) ? (body.result as string[]) : [];
  console.log(`page: ${page.status} ${page.headers.get('content-type')}`);
  console.log(`rpc: ${doc.status} → ${methods.join(', ')}`);
  console.log(`\nopen http://${host}:${port} in a browser — Ctrl+C to stop (state persists to ${DB_PATH})`);

  const shutdown = async (): Promise<void> => {
    await engine.close();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await new Promise<void>(() => {
    /* serve until interrupted */
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
