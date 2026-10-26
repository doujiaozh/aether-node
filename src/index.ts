/**
 * aether-node — core engine of a decentralized, local-first AI OS.
 *
 *  - sync-engine:      CRDT replicas (LWW-Register + PN-Counter on HLC) that
 *                      merge without conflicts, online or fully offline;
 *  - persistence:      SQLite (sql.js, pure JS/WASM) state store so a node
 *                      survives restarts, plus a SyncEngine that flushes to it;
 *  - micro-vm:         a sandboxed, resource-capped VM for AI-generated code;
 *  - agent-protocol:   JSON-RPC 2.0 surface agents talk to the node through,
 *                      over loopback, HTTP or WebSocket — the last one also
 *                      powering the P2P sync mesh;
 *  - web:              the minimal vanilla HTML/JS console, co-hosted with the
 *                      JSON-RPC endpoint and the P2P transport on one server.
 *
 * Runtime dependencies are sql.js (pure JS/WASM SQLite) and ws (pure JS
 * WebSocket); no native compilation is required anywhere.
 */

export * from './sync-engine/index.js';
export * from './persistence/index.js';
export * from './micro-vm/index.js';
export * from './agent-protocol/index.js';
export * from './web/index.js';
