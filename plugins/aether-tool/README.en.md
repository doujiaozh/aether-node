# aether-tool

`aether-tool` is the DeepSeek Harness (DSH) plugin for [aether-node](https://github.com/deepseek-ai): it registers one model-facing tool, **`run_in_aether_vm`**, which sends JavaScript to a running aether-node's HTTP JSON-RPC endpoint, executes it inside its sandboxed micro-VM, and brings the result back (value, status, sandbox logs, timing).

It extends DSH only through the plugin mechanism — no DSH core code is modified.

## Prerequisite: run an aether-node

In the aether-node repository:

```bash
npm install
npm run demo:web        # binds http://127.0.0.1:40001 by default
```

`demo:web` serves the Web UI, the JSON-RPC endpoint (`POST /`) and the WebSocket P2P transport on one port. If 40001 is busy it falls back to an OS-assigned port — put the real URL into the plugin config. Use `AETHER_PORT=5000 npm run demo:web` to choose a port.

## Install

```bash
dsh plugin add ./plugins/aether-tool
# or install this directory as a bundle into your profile
```

Tune it through the plugin configuration form:

| Field | Default | Meaning |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:40001` | Base URL of the aether-node HTTP RPC |
| `timeoutMs` | `20000` | Transport timeout per `vm.execute` call (ms); the sandbox clamps the effective value to [50, 30000] |

## Tool: `run_in_aether_vm`

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `code` | string | yes | JavaScript to run (no filesystem, no network, no require/import inside the sandbox; top-level `return` and `await` supported) |
| `timeoutMs` | integer | no | Per-call timeout, clamped to [50, 30000]; defaults to the plugin config |
| `endpoint` | string | no | Per-call aether-node URL override; defaults to the plugin config |

The return value passes aether-node's `VmResult` envelope through (`ok` / `status` / `value` / `error` / `logs` / `durationMs`) plus the `endpoint` that was hit. Transport failures come back as structured results with a closed `status` set instead of exceptions:

| `status` | Meaning |
| --- | --- |
| `ok` / `timeout` / `memory` / `crash` / `runtime` … | sandbox verdict, passed through (aether-node's `vm.execute` never throws) |
| `invalid-endpoint` / `invalid-code` | unusable arguments |
| `network-error` | cannot reach aether-node (start it first) |
| `timeout` | transport timeout |
| `http-error` / `rpc-error` | the peer did not answer with the expected RPC result |
| `cancelled` | the caller aborted this tool call |
| `internal-error` | unexpected failure inside this plugin (a bug) |

`execute` never throws, and `exec.signal` is honored (an aborted call resolves as `cancelled` immediately).

## Self-contained verification

The whole chain can be exercised without a DSH runtime (stub modules replace `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`, and a real aether-node web server is started as the backend):

```bash
# from the aether-node repository root
npm run build
node plugins/aether-tool/verify.mjs
```

## Layout

```
plugins/aether-tool/
├── package.json        # bundle metadata: peer deps, dsh.bundle.patch, icon, locale
├── cordis.patch.yml    # the single patch line that injects this plugin into a profile
├── index.js            # plugin entry: name / inject / apply
├── config.js           # Schemastery Config (endpoint / timeoutMs)
├── vm.js               # the run_in_aether_vm tool (JSON-RPC client + rendering)
├── locale/{zh,en}.json # presentation metadata
├── icon.svg
├── verify.mjs          # self-contained smoke test
└── tests/              # stubs (ESM loader hook + dsh-tools/schemastery stubs)
```

## License

Apache-2.0, same as aether-node.
