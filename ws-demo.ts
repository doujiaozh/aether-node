/**
 * ws-demo — two aether-node peers syncing in real time over WebSocket.
 *
 * Runs entirely on 127.0.0.1 with ephemeral ports:
 *
 *   1. boots `ws-node-a` (a *persistent* node backed by aether.db) and
 *      `ws-node-b` (in-memory);
 *   2. runs a snippet in a's sandbox through the peer-facing JSON-RPC;
 *   3. connects b → a: the two exchange full export() state immediately;
 *   4. both nodes keep editing on their own, and the 5-second (here 400 ms,
 *      demo-tuned) peer comparison ripples every edit both ways until the
 *      states converge byte-for-byte;
 *   5. restarts a from disk to prove the mesh rehydrates from SQLite.
 *
 * Run with:  npm run demo:p2p
 */

import { PersistentSyncEngine } from './src/persistence/index.js';
import {
  P2PSyncNode,
  RpcClient,
  WsRpcTransport,
} from './src/agent-protocol/index.js';

const DEMO_DB = 'aether-ws-demo.db';
const SYNC_INTERVAL_MS = 400;

function log(actor: string, message: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`[${stamp}] ${actor.padEnd(10)} ${message}`);
}

/** Resolve once `condition` holds; rejects after `timeoutMs` of no progress. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never met');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  console.log('ws-demo — WebSocket peer-to-peer sync\n');

  // --- 1. boot two nodes -------------------------------------------------
  const nodeA = new P2PSyncNode({
    nodeId: 'ws-node-a',
    syncIntervalMs: SYNC_INTERVAL_MS,
    engine: await PersistentSyncEngine.open({ path: DEMO_DB, nodeId: 'ws-node-a' }),
    onSync: (summary) =>
      log('ws-node-a', `<- peer merge applied: ${JSON.stringify(summary)}`),
    onError: (error) => log('ws-node-a', `peer error: ${String(error)}`),
  });
  const nodeB = new P2PSyncNode({
    nodeId: 'ws-node-b',
    syncIntervalMs: SYNC_INTERVAL_MS,
    onSync: (summary) =>
      log('ws-node-b', `<- peer merge applied: ${JSON.stringify(summary)}`),
    onError: (error) => log('ws-node-b', `peer error: ${String(error)}`),
  });
  await nodeA.start();
  await nodeB.start();
  log('ws-node-a', `listening at ${nodeA.url} (state persisted to ${DEMO_DB})`);
  log('ws-node-b', `listening at ${nodeB.url}`);

  // --- 2. run code inside a's sandbox, peer-facing -----------------------
  const transport = new WsRpcTransport(nodeA.url);
  const client = new RpcClient(transport);
  const result = await client.call<{ ok: boolean; value: unknown; logs: unknown[] }>(
    'vm.execute',
    {
      code: `
        const Fib = { at: (n) => (n < 2 ? n : Fib.at(n - 1) + Fib.at(n - 2)) };
        console.log('computing fib(10) inside the sandbox');
        return Fib.at(10);
      `,
    },
  );
  log('demo', `vm.execute on ws-node-a -> ok=${result.ok} value=${String(result.value)} logs=${JSON.stringify(result.logs)}`);
  nodeA.engine.set('fib10', String(result.value));
  nodeA.engine.increment('compute.calls', 1);
  transport.close();

  // --- 3. connect: full export() exchange happens immediately ------------
  await nodeB.connect(nodeA.url);
  log('ws-node-b', `connected to ${nodeA.url}`);
  log('ws-node-b', `after handshake: fib10=${String(nodeB.get('fib10'))} compute.calls=${nodeB.counterValue('compute.calls')}`);

  // --- 4. concurrent edits on both sides converge ------------------------
  nodeA.engine.set('editing', 'started on A');
  nodeB.engine.set('editing', 'started on B');
  nodeA.engine.increment('write.race', 3);
  nodeB.engine.increment('write.race', 4);
  log('demo', 'both peers edited concurrently — waiting for the periodic comparison…');

  // CRDT merges are deterministic: both peers settle on the SAME register
  // value (the later HLC write wins) and the SAME counter totals, even though
  // the replicas keep their own node id.
  await until(() => {
    const a = nodeA.engine.export();
    const b = nodeB.engine.export();
    return (
      JSON.stringify(a.registers) === JSON.stringify(b.registers) &&
      JSON.stringify(a.counters) === JSON.stringify(b.counters)
    );
  });
  log('ws-node-a', `converged: editing=${String(nodeA.get('editing'))} write.race=${nodeA.counterValue('write.race')}`);
  log('ws-node-b', `converged: editing=${String(nodeB.get('editing'))} write.race=${nodeB.counterValue('write.race')}`);

  // --- 5. persistence across restart -------------------------------------
  await nodeA.stop();
  log('demo', `ws-node-a stopped — state is on disk in ${DEMO_DB}`);
  const reincarnated = await PersistentSyncEngine.open({ path: DEMO_DB, nodeId: 'ws-node-a' });
  log('demo', `ws-node-a reopened aether.db: fib10=${String(reincarnated.get('fib10'))} write.race=${reincarnated.counterValue('write.race')}`);
  await nodeB.stop();
  await reincarnated.close();

  console.log('\nws-demo complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
