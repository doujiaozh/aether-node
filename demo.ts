/**
 * aether-node end-to-end demo.
 *
 * Boots one aether-node replica, exposes it over JSON-RPC 2.0 (HTTP), then
 * plays the role of an AI agent that:
 *   1. discovers the RPC surface,
 *   2. runs generated analytics code inside the sandboxed micro-VM,
 *   3. writes the computed insight into the CRDT sync engine,
 *   4. syncs bidirectionally with an offline peer that went its own way.
 *
 * Run with: npm run demo
 */

import { SyncEngine } from './src/sync-engine/index.js';
import { MicroVm } from './src/micro-vm/index.js';
import {
  HttpRpcServer,
  HttpRpcTransport,
  RpcClient,
  RpcServer,
} from './src/agent-protocol/index.js';
import { registerSystemMethods } from './src/agent-protocol/methods.js';
import type { SyncState } from './src/sync-engine/index.js';
import type { VmResult } from './src/micro-vm/index.js';
import type { MergeSummary } from './src/sync-engine/index.js';

const hr = (label: string): void => {
  console.log('\n' + '─'.repeat(72));
  console.log(label);
  console.log('─'.repeat(72));
};

async function main(): Promise<void> {
  console.log('aether-node — decentralized local-first AI OS core (demo)');

  // --- 1. Boot a node: CRDT engine + sandbox + JSON-RPC over HTTP -----------
  hr('1 · booting node "aether-01"');
  const engine = new SyncEngine({ nodeId: 'aether-01' });
  engine.set('device:status', 'online');
  const vm = new MicroVm();

  const rpcServer = new RpcServer();
  registerSystemMethods(rpcServer, { vm, engine });

  const httpServer = new HttpRpcServer(rpcServer);
  const { host, port } = await httpServer.listen();
  const url = `http://${host}:${port}/`;
  console.log(`JSON-RPC 2.0 endpoint listening on ${url}`);

  // The "agent" is just a client talking the protocol over the wire.
  const agent = new RpcClient(new HttpRpcTransport(url));

  try {
    // --- 2. Discover the protocol surface -----------------------------------
    hr('2 · agent calls rpc.discover');
    const methods = await agent.call<string[]>('rpc.discover');
    console.log('methods exposed:', methods.join(', '));

    // --- 3. Run AI-generated code in the sandbox -----------------------------
    hr('3 · agent runs generated code in the sandbox (vm.execute)');
    const sensorReadings = [21.4, 22.1, 19.8, 23.9, 22.5, 21.1, 24.0, 20.2];
    const code = `
      const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
      const max = Math.max(...readings);
      const min = Math.min(...readings);
      const anomalies = readings.filter((r) => Math.abs(r - mean) > 1.5).length;
      return { mean: Math.round(mean * 100) / 100, max, min, anomalies, n: readings.length };
    `;
    const vmResult = await agent.call<VmResult>('vm.execute', {
      code,
      context: { readings: sensorReadings },
      timeoutMs: 2000,
      memoryLimitMb: 32,
    });
    console.log('sandbox result:', JSON.stringify(vmResult));
    if (!vmResult.ok || !vmResult.value) {
      throw new Error(`sandbox execution failed: ${JSON.stringify(vmResult.error)}`);
    }
    console.log(`sandboxed analytics finished in ${vmResult.durationMs} ms`);

    // --- 4. Persist the insight through the CRDT engine ----------------------
    hr('4 · agent persists the insight via sync.merge');
    const mergeSummary = await agent.call<MergeSummary>('sync.merge', {
      registers: {
        'insights:thermal-mean': (vmResult.value as { mean: number }).mean,
        'insights:thermal-anomalies': (vmResult.value as { anomalies: number }).anomalies,
      },
      counters: { 'telemetry:samples': sensorReadings.length },
    });
    console.log('merge summary:', JSON.stringify(mergeSummary));

    // --- 5. Sandbox safety net (a runaway loop gets terminated) --------------
    hr('5 · sandbox enforces its limits');
    const runaway = await agent.call<VmResult>('vm.execute', {
      code: 'while (true) { /* burn the budget */ }',
      timeoutMs: 500,
    });
    console.log(`runaway loop → ok=${runaway.ok} status=${runaway.status} (${runaway.error?.name})`);

    // --- 6. Offline peer forks, then reconnects and converges ----------------
    hr('6 · offline peer "mobile-01" forks, reconnects, converges');
    const mobile = new SyncEngine({ nodeId: 'mobile-01' });

    // pull the server's current state over the protocol and go "offline"
    const serverState = await agent.call<SyncState>('sync.getState');
    mobile.import(serverState);
    console.log('mobile pulled state; thermal-mean =', mobile.get('insights:thermal-mean'));

    // offline divergence: both sides write the same register, counter grows
    mobile.set('insights:thermal-mean', 22.55);
    mobile.increment('telemetry:samples', 3);
    engine.set('device:note', 'server-side annotation');

    // push the offline replica back through the protocol
    const importSummary = await agent.call<MergeSummary>('sync.importState', {
      state: mobile.export(),
    });
    console.log('server imported mobile state:', JSON.stringify(importSummary));

    // pull again so both sides see the merged result
    const merged = await agent.call<SyncState>('sync.getState');
    const summary = mobile.import(merged);

    const payload = (state: SyncState) =>
      JSON.stringify({ registers: state.registers, counters: state.counters });
    console.log('mobile applied:', summary.applied, '| converged payload identical:',
      payload(mobile.export()) === payload(engine.export()));
    console.log('thermal-mean (server):', engine.get('insights:thermal-mean'));
    console.log('thermal-mean (mobile):', mobile.get('insights:thermal-mean'));
    console.log('telemetry:samples total:', engine.counterValue('telemetry:samples'));

    hr('demo finished — state converged across both replicas');
  } finally {
    await httpServer.close();
  }
}

main().catch((error) => {
  console.error('demo failed:', error);
  process.exitCode = 1;
});
