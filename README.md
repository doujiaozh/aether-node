# aether-node

> The core engine of a **decentralized, local-first AI operating system** — every device gets a CRDT-synced state core with SQLite persistence, a sandboxed micro-VM for running AI-generated code, a JSON-RPC agent protocol over loopback/HTTP/**WebSocket** (with automatic P2P convergence), a minimal **Web UI**, and a **DSH plugin** that lets DeepSeek Harness agents use it all as a tool.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                        aether-node  (one replica)                    │
 │                                                                      │
 │   ┌──────────────┐    ┌──────────────┐    ┌────────────────────┐     │
 │   │ sync-engine  │    │  micro-vm    │    │  agent-protocol    │     │
 │   │  (CRDT)      │    │  (sandbox)   │    │  (JSON-RPC 2.0)    │     │
 │   │              │    │              │    │                    │     │
 │   │ HLC clock    │    │ worker       │    │ vm.execute         │     │
 │   │ LWW-Register │◄───│ isolate + vm │◄───│ sync.getState      │     │
 │   │ PN-Counter   │    │ resourceLims │    │ sync.merge         │     │
 │   │ merge/export │    │ codegen off  │    │ sync.importState   │     │
 │   └──────┬───────┘    └──────────────┘    └─────────┬──────────┘     │
 │          │                                        │ HTTP / WebSocket│
 │   ┌──────┴──────────────────────┐      ┌───────────┴────────────┐   │
 │   │ persistence (sql.js WASM)   │      │ ws-transports + p2p     │   │
 │   │ PersistentSyncEngine        │      │ WsRpcServer/Transport   │   │
 │   │ auto-flush → aether.db      │      │ full-state swap on      │   │
 │   │ restart restores the replica│      │ connect, then merge     │   │
 │   └─────────────────────────────┘      │ every 5 s → convergence │   │
 │          ▲                             └───────────┬────────────┘   │
 │   ┌──────┴──────────────────┐           same port │ ws:// + http:// │
 │   │  web/ (native HTML/JS)  │◄────────────────────┤ static + RPC    │
 │   │  vm.execute console     │                    └────────────────┘   │
 │   └─────────────────────────┘                                        │
 └────────┬──────────────────────────────────┬──────────────────────────┘
          │ export/import (JSON)            │
   sync with peers                         AI agents (LLM tool calls ── also via
   (auto every 5 s)                        the DSH plugin `run_in_aether_vm`)
```

## Why

An AI OS that lives on your laptop has three hard constraints:

1. **It must work offline.** State is local-first: `sync-engine` keeps a per-device CRDT replica, and since v0.2.0 it is **persisted to a local SQLite file** (`sql.js`, pure JS/WASM — no native compilation) so a restart restores the exact replica. Edits made on a subway merge without conflicts when connectivity returns.
2. **AI-generated code is untrusted.** `micro-vm` executes it inside a dedicated `worker_threads` isolate with a hard-capped V8 heap, no host globals, and string/WASM code generation disabled.
3. **Agents need a stable, discoverable interface.** `agent-protocol` exposes the engine and the VM over JSON-RPC 2.0 — over loopback, HTTP, and **WebSocket** — one shape agents can call, route, and extend.

The whole package is TypeScript with two pure-JS runtime dependencies (`sql.js`, `ws`) and runs on Node ≥ 18.19.

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

Transport-agnostic router (`RpcServer`), a timeout-aware client (`RpcClient`), and three transports: `LoopbackTransport`, `HttpRpcServer`/`HttpRpcTransport` over `node:http`, and **`WsRpcServer`/`WsRpcTransport`** over the pure-JS `ws` library.

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

### 4. `persistence` — SQLite-backed state (v0.2.0)

`SqliteStateStore` keeps the whole replica (`registers`, `counters`, node id, version) in a local SQLite database via **sql.js** — SQLite compiled to WebAssembly, so there is no native C++ addon to build. `PersistentSyncEngine` wraps `SyncEngine`:

- every `set` / `increment` / `merge` / `import` schedules an **async flush** (at most one in flight + one queued, so mutations never block on disk I/O; flush errors surface through `onFlushError` instead of crashing the replica);
- `PersistentSyncEngine.open({ path })` **restores** the replica on boot by re-merging the persisted state — CRDT semantics make this equivalent to peer sync, and the local HLC is pushed past every observed timestamp so post-restore writes stay causally dominant;
- `close()` flushes and closes the database.

```ts
import { PersistentSyncEngine } from 'aether-node';

const engine = await PersistentSyncEngine.open({ path: 'aether.db' });
engine.set('task:1', 'survives restart');      // async flush behind the scenes
await engine.flush();                           // or wait for durability explicitly
await engine.close();
```

### 5. WebSocket transport + P2P sync (v0.2.0)

`WsRpcServer` exposes an `RpcServer` over `ws://` (JSON text frames, 8 MB cap; it can also be **attached to an existing `node:http` server** so HTTP, WebSocket, and static assets share one port), and `WsRpcTransport` is its client-side counterpart.

On top of them, `P2PSyncNode` implements a deliberately simple convergence protocol:

1. **on connect** — each side pushes its full `export()` state to the peer (`sync.importState`) and merges the peer's `sync.getState` reply;
2. **every 5 s** (`syncIntervalMs`, configurable) — both sides repeat the full-state comparison.

Because the underlying CRDT merge is associative, commutative, and idempotent, this "gossip full state on a timer" scheme is enough for multi-node real-time convergence with no coordinator, even while both nodes keep editing.

```ts
import { P2PSyncNode } from 'aether-node';

const node = new P2PSyncNode({ engine, port: 0 });
await node.start();
const peer = new P2PSyncNode({ engine: otherEngine, port: 0 });
await peer.start();
await peer.connect(node.url);   // handshake swaps full state; 5 s timer keeps them converged
```

### 6. `web` — minimal Web UI (v0.2.0)

A **framework-free** HTML + JS console (`web/index.html`, `web/app.js`) served by `AetherWebServer` on the **same port** as the JSON-RPC endpoint and the WebSocket P2P transport — one `node:http` server, three responsibilities:

- a code editor (textarea) + **Run** button → `POST /` with `vm.execute`;
- the result envelope (value, status, duration) and the **sandbox logs** are printed on the page;
- a "node state" button renders `sync.getState` (node id, version, registers, counters).

```bash
npm run demo:web    # boots a persisted replica + the web console on http://127.0.0.1:40001
```

### 7. `plugins/aether-tool` — DSH plugin (v0.2.0)

A DeepSeek Harness plugin that registers the model-facing tool **`run_in_aether_vm`**: it POSTs code to a running aether-node's HTTP RPC and returns the sandbox result (value, logs, status, timing) as structured JSON — failures are closed-set statuses (`network-error`, `timeout`, `invalid-endpoint`, `cancelled`, …), never thrown errors. It only uses the documented plugin mechanism (`name` + `apply` + Schemastery `Config` + `defineTool` + a one-line `cordis.patch.yml` bundle patch); **no DSH core code is modified**. See [plugins/aether-tool/README.md](./plugins/aether-tool/README.md).

## Try it

```bash
npm install     # dev deps + sql.js + ws (both pure JS)
npm test        # 103 unit tests across the modules
npm run demo        # boots a node, simulates an agent, syncs with an offline peer
npm run demo:p2p    # two nodes sync live over WebSocket, then restart-from-disk
npm run demo:web    # persisted replica + Web UI + RPC + WS on one port
npm run build   # tsc → dist/
```

The demos tell the whole story: `demo.ts` boots a replica → exposes JSON-RPC over HTTP → an agent discovers the protocol, runs analytics in the sandbox, persists the insight via `sync.merge` → an offline peer forks, reconnects, both converge. `ws-demo.ts` replays the same story over **WebSocket with live P2P editing** plus a restart-from-disk check, and `web-demo.ts` puts the async-flush persistence, the Web UI, and both transports behind one URL.

## Project layout

```
aether-node/
├── src/
│   ├── sync-engine/     hlc.ts · lww-register.ts · counter.ts · engine.ts
│   ├── micro-vm/        vm.ts (inline worker isolate)
│   ├── agent-protocol/  rpc · server · client · transports · ws-transports · p2p · methods
│   ├── persistence/     sqlite-store.ts (sql.js) · persistent-engine.ts
│   └── web/             server.ts (static + JSON-RPC + WS on one port)
├── web/                 index.html · app.js (no build step, no framework)
├── plugins/aether-tool/ DSH plugin registering the run_in_aether_vm tool
├── tests/               one suite per module (Jest, ESM via babel)
├── demo.ts · ws-demo.ts · web-demo.ts
├── tsconfig.json        strict, NodeNext
└── jest config inside package.json
```

## Roadmap

v0.2.0 closed the MVP's three biggest gaps: **SQLite persistence**, a **WebSocket transport with P2P convergence**, and an **agent-facing Web UI**, plus a **DSH plugin** bridge. Still explicitly out of scope: transport-level auth & encryption (TLS, capability tokens), richer CRDTs (ORSets, RGA text), agent ACLs for the sandbox, and a peer discovery layer. The protocol surface above is where those hook in.

## License

[Apache-2.0](./LICENSE) — © 2026 doujiaozh
