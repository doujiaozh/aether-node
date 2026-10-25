/**
 * ⚡ aether-node
 *
 * Core engine for a decentralized, local-first AI operating system.
 *
 *     createAetherNode() wires three engines into one runtime:
 *
 *        sync-engine      CRDT state, offline-first, peer mergeable
 *        micro-vm         sandboxed code execution for agents
 *        agent-protocol   JSON-RPC 2.0 surface the AI actually calls
 *
 * Running this file (`pnpm start`) executes the bootstrap self-check:
 * identity -> sync write -> sandbox run -> protocol round-trip.
 */

import { createAetherProtocolServer } from "./agent-protocol/index.js";
import type { ProtocolServer } from "./agent-protocol/index.js";
import { InProcessSandbox } from "./micro-vm/index.js";
import type { SandboxExecutor } from "./micro-vm/index.js";
import { SyncEngine } from "./sync-engine/index.js";

export const VERSION = "0.0.1";

/** Options for booting a node. */
export interface AetherNodeOptions {
  /** Stable peer identity. Generated when omitted. */
  readonly nodeId?: string;
  /** Alias shown in logs, defaults to the generated node id. */
  readonly alias?: string;
  /** Sandbox backend. Defaults to the in-process reference executor. */
  readonly sandbox?: SandboxExecutor;
  /** Runtime name exposed to agents via the protocol. */
  readonly name?: string;
}

/** A live aether node: three modules + one protocol surface. */
export interface AetherNode {
  readonly version: string;
  readonly startedAt: number;
  readonly alias: string;
  readonly sync: SyncEngine;
  readonly vm: SandboxExecutor;
  readonly protocol: ProtocolServer;
}

/**
 * Bootstrap a node: mint (or adopt) an identity, spin up the sync engine,
 * the sandbox, and the JSON-RPC protocol server, and wire them together.
 */
export async function createAetherNode(options: AetherNodeOptions = {}): Promise<AetherNode> {
  const sync = new SyncEngine(options.nodeId ? { nodeId: options.nodeId } : {});
  const vm = options.sandbox ?? new InProcessSandbox();
  const protocol = await createAetherProtocolServer({
    sync,
    vm,
    name: options.name ?? "aether-node",
    version: VERSION,
  });

  return {
    version: VERSION,
    startedAt: Date.now(),
    alias: options.alias ?? sync.identity.nodeId,
    sync,
    vm,
    protocol,
  };
}

// ---------------------------------------------------------------- bootstrap

const header = (text: string) => `\n── ${text} ${"─".repeat(Math.max(0, 52 - text.length))}`;

async function main(): Promise<void> {
  console.log("⚡ aether-node — local-first AI OS core engine");
  console.log(`   version ${VERSION}\n`);

  // ---- 1. bootstrap the runtime ------------------------------------------
  process.stdout.write(header("1/4  bootstrap"));
  const node = await createAetherNode({ alias: "skeleton-node" });
  console.log(`\n  node id      : ${node.sync.identity.nodeId}`);
  console.log(`  alias        : ${node.alias}`);
  console.log(`  sandbox      : ${node.vm.name}`);
  const health = await node.vm.healthCheck();
  console.log(`  isolation    : ${health.isolated ? "real" : "reference (not a security boundary)"}`);

  // ---- 2. exercise the sync engine (CRDT write + snapshot) ---------------
  process.stdout.write(header("2/4  sync-engine"));
  const op = node.sync.applyLocal({ key: "note/1", value: { text: "hello aether", done: false } });
  console.log(`\n  minted op    : ${op.opId}`);
  console.log(`  vector clock : ${JSON.stringify(node.sync.vectorClock())}`);
  const snapshot = node.sync.snapshot();
  console.log(`  snapshot     : ${Object.keys(snapshot.entries).length} entries, kind=${snapshot.kind}`);

  // ---- 3. exercise the sandbox -------------------------------------------
  process.stdout.write(header("3/4  micro-vm"));
  const exec = await node.vm.execute({ id: "selftest", code: "40 + 2" });
  console.log(exec.ok ? `\n  guest code   : 40 + 2` : "\n  sandbox failed");
  console.log(`  returned     : ${exec.ok ? String(exec.returnValue) : exec.error.message} (${exec.durationMs}ms)`);

  // ---- 4. drive everything through the agent protocol --------------------
  process.stdout.write(header("4/4  agent-protocol"));
  // agent computes something inside the sandbox, via the protocol
  const rpcExec = await node.protocol.handleRaw(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "aether.vm.execute",
      params: { code: "stdio.log('computing...'); return [1,2,3].map((x) => x * 2)" },
    }),
  );
  console.log(`\n  vm.execute   : ${jsonExtract(rpcExec, "result.returnValue")} (${jsonExtract(rpcExec, "result.durationMs")}ms)`);
  // agent reads the store back through the protocol
  const rpcGet = await node.protocol.handleRaw(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "aether.sync.get", params: { key: "note/1" } }),
  );
  console.log(`  sync.get     : "${jsonExtract(rpcGet, "result.value.text")}"`);
  // unknown method -> structured JSON-RPC error, nothing else
  const rpcErr = await node.protocol.handleRaw(
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "aether.bogus" }),
  );
  console.log(`  error path   : code ${jsonExtract(rpcErr, "error.code")} (${jsonExtract(rpcErr, "error.message")})`);
  // what does this node advertise to agents?
  const rpcCaps = await node.protocol.handleRaw(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "aether.agent.capabilities" }),
  );
  console.log(`  capabilities : ${jsonExtract(rpcCaps, "result.methods.length")} tools advertised`);
  console.log(`  audit log    : ${node.protocol.auditLog().length} entries recorded`);

  console.log(header("done"));
  console.log("\naether-node initialized successfully. ✅\n");
}

/** Tiny helper to pull nested fields out of a JSON response for logging. */
function jsonExtract(raw: string, path: string): string {
  try {
    const value = path.split(".").reduce<unknown>(
      (acc, key) => (acc as Record<string, unknown>)[key] as unknown,
      JSON.parse(raw) as unknown,
    );
    return value === undefined ? "undefined" : String(value);
  } catch {
    return "<unparsable>";
  }
}

// Run main() only when executed directly (`node dist/index.js`), not when
// imported as a library.
const isDirectRun =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file://").href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("fatal:", error);
    process.exitCode = 1;
  });
}
