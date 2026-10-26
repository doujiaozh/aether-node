/**
 * aether-node — core engine of a decentralized, local-first AI OS.
 *
 *  - sync-engine:      CRDT replicas (LWW-Register + PN-Counter on HLC) that
 *                      merge without conflicts, online or fully offline;
 *  - micro-vm:         a sandboxed, resource-capped VM for AI-generated code;
 *  - agent-protocol:   JSON-RPC 2.0 surface agents talk to the node through.
 *
 * Zero runtime dependencies — Node.js built-ins only.
 */

export * from './sync-engine/index.js';
export * from './micro-vm/index.js';
export * from './agent-protocol/index.js';
