# aether-node

> The core engine of a **decentralized, local-first AI operating system** — an MVP that gives every device a CRDT-synced state core, a sandboxed micro-VM for running AI-generated code, and a JSON-RPC protocol that lets agents use both.

```
 ┌────────────────────────────────────────────────────────────────────┐
 │                        aether-node  (one replica)                  │
 │                                                                    │
 │   ┌──────────────┐    ┌──────────────┐    ┌────────────────────┐  │
 │   │ sync-engine  │    │  micro-vm    │    │  agent-protocol    │  │
 │   │  (CRDT)      │    │  (sandbox)   │    │  (JSON-RPC 2.0)    │  │
 │   │              │    │              │    │                    │  │
 │   │ HLC clock    │    │ worker       │    │ vm.execute         │  │
 │   │ LWW-Register │◄───│ isolate + vm │◄───│ sync.getState      │  │
 │   │ PN-Counter   │    │ resourceLims │    │ sync.merge         │  │
 │   │ merge/export │    │ codegen off  │    │ sync.importState   │  │
 │   └──────┬───────┘    └──────────────┘    └─────────┬──────────┘  │
 │          │  export/import (JSON)                    │ HTTP / any  │
 └──────────┼──────────────────────────────────────────┼─────────────┘
            │                                          │
      sync with peers                          AI agents (LLM tool calls)
```

## Why

An AI OS that lives on your laptop has three hard constraints:

1. **It must work offline.** State is local-first: `sync-engine` keeps a per-device CRDT replica. Edits made on a subway merge without conflicts when connectivity returns.
2. **AI-generated code is untrusted.** `micro-vm` executes it inside a dedicated `worker_threads` isolate with a hard-capped V8 heap, no host globals, and string/WASM code generation disabled.
3. **Agents need a stable, discoverable interface.** `agent-protocol` exposes the engine and the VM over JSON-RPC 2.0 — one shape agents can call, route, and extend.

The whole package is TypeScript, ships **zero runtime dependencies** (Node.js built-ins only), and runs on Node ≥ 18.19.

## Modules

### 1. `sync-engine` — CRDT synchronization

Per-replica state core. All mutations are timestamped with a **Hybrid Logical Clock** (wall clock + logical counter + node id), which gives a total order without wall-clock agreement.

| Primitive | Semantics |
| --- | --- |
| `HlcClock` | `tick()` for local events, `observe(remote)` to absorb peer timestamps (causally-safe monotonicity even with clock skew) |
| LWW-Register | last-writer-wins per key, HLC order, deterministic node-id tiebreak; commutative + idempotent merge |
| PN-Counter | per-replica positive/negative buckets; merge takes the element-wise max; decrements survive any merge order |

```ts
import { SyncEngine } from 'aether-node';

const local = new SyncEngine({ nodeId: 'laptop' });
local.set('task:1', 'draft');        // HLC-stamped write
local.increment('tokens', 5);        // PN-Counter

const peer = new SyncEngine({ nodeId: 'phone' });
peer.set('task:1', 'edited offline');

local.import(peer.export());         // conflict-free merge — LWW by HLC
```

Merges are associative, commutative, and idempotent: `import()` of an identical state is a no-op (no version bump), and any relay topology converges every replica. `export()`/`exportJson()` produce stable, sorted-key JSON; `import()` deep-validates untrusted blobs (`SyncImportError`, never silent corruption).

### 2. `micro-vm` — sandboxed execution

```ts
import { MicroVm } from 'aether-node';

const vm = new MicroVm();
const result = await vm.execute('return readings.reduce((a, b) => a + b, 0);', {
  readings: [1, 2, 3],
});
// { ok: true, status: 'ok', value: 6, logs: [], durationMs: 41 }
```

Defense in depth:

- **Process-level isolation** — every execution runs in its own `worker_threads` worker, terminated when the run settles.
- **Hard resource caps** — V8 `resourceLimits` (heap/stack/code-range) clamp the blast radius; defaults 32 MB heap, 5 s wall clock (clamped to `[50 ms, 30 s]` / `[32 MB, 1 GB]`, because lower heap caps can abort the host process during isolate bootstrap).
- **No host surface** — the sandbox has no `process`, `require`, `fs`, or network. Host and sandbox communicate only via structured-clone `postMessage`.
- **No code generation** — `eval`, `new Function`, and `WebAssembly.Module` are refused (`codeGeneration: { strings: false, wasm: false }`).
- **Plain data in/out** — contexts are validated and cloned (functions, symbols, bigints, and >32-deep nesting rejected; dates become ISO strings); oversized or non-serializable results surface as typed errors.

`execute()` **never throws**: the result envelope carries `ok`, `status` (`ok | runtime | timeout | memory | crash | input`), `error`, captured `console.*` logs, and `durationMs`.

### 3. `agent-protocol` — JSON-RPC 2.0

Transport-agnostic router (`RpcServer`), a timeout-aware client (`RpcClient`), and two transports (`LoopbackTransport`, `HttpRpcServer`/`HttpRpcTransport` over `node:http`).

```
--> {"jsonrpc":"2.0","id":1,"method":"vm.execute","params":{"code":"...","context":{...}}}
<-- {"jsonrpc":"2.0","id":1,"result":{"ok":true,"status":"ok","value":42,...}}
```

System methods registered by `registerSystemMethods(server, { vm, engine })`:

| Method | Purpose |
| --- | --- |
| `vm.execute` | run AI-generated code in the sandbox (validated `code`/`context`/limits) |
| `sync.getState` | return the current CRDT replica export |
| `sync.merge` | merge agent-produced registers/counter deltas into the local replica |
| `sync.importState` | import and merge a peer state blob |
| `rpc.discover` | list the exposed method surface |

Errors are JSON-RPC envelopes: parse error, invalid request, method not found, invalid params, and a custom range (`-32000 … -32002`) for server/VM/sync failures. Batches and notifications are supported.

## Try it

```bash
npm install     # dev-only deps (typescript, jest, babel)
npm test        # 62 unit tests across the three modules
npm run demo    # boots a node, simulates an agent, syncs with an offline peer
npm run build   # tsc → dist/
```

The demo (`demo.ts`) is the whole story in one script: boot a replica → expose JSON-RPC over HTTP → an agent discovers the protocol, runs analytics code in the sandbox, persists the insight via `sync.merge` → a second replica forks offline, reconnects, and both converge on identical state.

## Project layout

```
aether-node/
├── src/
│   ├── sync-engine/   hlc.ts · lww-register.ts · counter.ts · engine.ts
│   ├── micro-vm/      vm.ts (inline worker isolate)
│   └── agent-protocol/ rpc.ts · server.ts · client.ts · transports.ts · methods.ts
├── tests/             one suite per module (Jest, ESM via babel)
├── demo.ts            end-to-end entry point
├── tsconfig.json      strict, NodeNext
└── jest config inside package.json
```

## Roadmap (explicitly out of scope for this MVP)

Persistence (localStorage/SQLite backing), transport-level auth & encryption (TLS, capability tokens), richer CRDTs (ORSets, RGA text), agent ACLs for the sandbox, and a peer discovery layer. The protocol surface above is where those hook in.

## License

[Apache-2.0](./LICENSE) — © 2026 doujiaozh
