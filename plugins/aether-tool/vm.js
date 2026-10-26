/**
 * `run_in_aether_vm` — the tool `aether-tool` registers.
 *
 * What it does: POST a JSON-RPC 2.0 `vm.execute` request to a running
 * aether-node and hand back the sandbox result (value, logs, status).
 *
 * Contract decisions (mirroring real-world DSH plugin practice):
 * - `execute` **never throws**. Every failure — bad endpoint, connection
 *   refused, RPC error, cancellation, unexpected exception — comes back as
 *   a structured canonical value with a closed `status` set so the model
 *   can decide whether retrying makes sense. A thrown error would surface
 *   as a bare `Error: <message>` and erase the whole verdict.
 * - `exec.signal` is honored: an aborted signal aborts the in-flight
 *   `fetch` and the call resolves as `cancelled` instead of hanging.
 * - Success means "the sandbox ran the code and answered"; even a runtime
 *   crash inside the sandbox is a successful RPC round-trip — the VmResult
 *   envelope's own `ok: false` is passed through so the model sees the
 *   sandbox verdict, not a transport verdict.
 * - The canonical value is free-form JSON (`output.schema`:
 *   `{ type: 'json' }`): the VmResult envelope shape comes from aether-node
 *   and evolves with it, so a strict here-and-now schema would only add a
 *   second place to keep in sync.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from './config.js';

/** Tool name. */
export const TOOL_NAME = 'run_in_aether_vm';

/** Sandbox-side clamp, mirrored from aether-node's MicroVm (vm.ts). */
export const SANDBOX_MIN_TIMEOUT_MS = 50;
export const SANDBOX_MAX_TIMEOUT_MS = 30_000;

/** Cap on rendered log lines, mirroring the "truncated + total" practice. */
const MAX_RENDERED_LOG_LINES = 30;

export const TOOL_DESCRIPTION = {
  what: 'Run JavaScript in an aether-node sandboxed micro-VM through its HTTP RPC (vm.execute).',
  useWhen:
    'Use when you need to evaluate code, compute a value, or see sandbox logs without touching the local filesystem — the sandbox is isolated and returns value, logs, and timing.',
  boundary:
    "Requires a running aether-node reachable from this host (boot it from its repo: `npm run demo:web`; default endpoint http://127.0.0.1:40001, override via this plugin's `endpoint` config or the `endpoint` parameter). The sandbox has no filesystem, no network, no require/import; vm.execute timeouts are clamped to [50, 30000] ms.",
};

/**
 * Normalize plugin config (Schemastery-resolved in the host, a plain object
 * in tests) into the shape the tool closes over.
 *
 * @param config raw config.
 * @returns resolved config with defaults filled in.
 */
export function resolvePluginConfig(config = {}) {
  const endpoint =
    typeof config?.endpoint === 'string' && config.endpoint.trim() !== ''
      ? config.endpoint.trim()
      : DEFAULT_ENDPOINT;
  const timeoutMs =
    typeof config?.timeoutMs === 'number' &&
    Number.isFinite(config.timeoutMs) &&
    config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  return { endpoint, timeoutMs };
}

/**
 * Resolve the per-call endpoint: the parameter wins, then the config, and
 * anything that is not an http(s) URL is rejected explicitly (the DSL cannot
 * express "must look like a URL", so it is hand-checked here, as the tool
 * contract allows).
 *
 * @param config resolved plugin config.
 * @param raw the raw `endpoint` argument (may be undefined).
 * @returns `{ endpoint }` or `undefined` when the value is unusable.
 */
function endpointOf(config, raw) {
  const candidate =
    typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : config.endpoint;
  if (typeof candidate !== 'string') return undefined;
  if (!/^https?:\/\/[^/]+/i.test(candidate)) return undefined;
  return candidate.replace(/\/+$/, '');
}

/**
 * Resolve the per-call timeout (parameter wins over config; both are passed
 * through to the sandbox, which clamps to its own bounds).
 *
 * @param config resolved plugin config.
 * @param raw the raw `timeoutMs` argument (may be undefined).
 */
function timeoutOf(config, raw) {
  const candidate =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : config.timeoutMs;
  return Math.min(Math.max(Math.trunc(candidate), SANDBOX_MIN_TIMEOUT_MS), SANDBOX_MAX_TIMEOUT_MS);
}

/**
 * Build the tool.
 *
 * @param config resolved plugin config.
 * @returns the `defineTool` definition, ready for `ctx.tools.register`.
 */
export function createRunInAetherVmTool(config = resolvePluginConfig()) {
  return defineTool({
    name: TOOL_NAME,
    description: composeDescription(TOOL_DESCRIPTION),
    parameters: {
      code: {
        type: 'string',
        required: true,
        description:
          'JavaScript to evaluate. Runs in an isolated worker; top-level return and await are supported. No filesystem, no network, no require/import.',
      },
      timeoutMs: {
        type: 'integer',
        description: `Optional timeout in milliseconds, clamped to [${SANDBOX_MIN_TIMEOUT_MS}, ${SANDBOX_MAX_TIMEOUT_MS}]. Defaults to the plugin's timeoutMs config.`,
      },
      endpoint: {
        type: 'string',
        description:
          "Optional aether-node HTTP RPC base URL (e.g. http://127.0.0.1:40001); defaults to the plugin's endpoint config.",
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    timeoutMs: Math.min(config.timeoutMs, SANDBOX_MAX_TIMEOUT_MS),
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      try {
        return await executeRemote(rawArgs, exec, config);
      } catch (error) {
        // The contract's carrying condition: a thrown error would erase the
        // structured verdict entirely. Every unexpected failure still gets a
        // closed status the model can act on.
        return failure('internal-error', describeError(error), {
          hint: 'this is a bug in the aether-tool plugin, not in the aether-node sandbox',
        });
      }
    },
  });
}

/** Compose the four-segment description (newline-joined, empty segments dropped). */
function composeDescription(segments) {
  return [segments.what, segments.useWhen, segments.boundary, segments.cost]
    .map((segment) => (segment ?? '').trim())
    .filter((segment) => segment !== '')
    .join('\n');
}

/**
 * The callable core (separated from `execute` so the try/catch stays the
 * outermost layer and can never be pushed behind a business branch).
 */
async function executeRemote(rawArgs, exec, config) {
  const args = rawArgs ?? {};
  const endpoint = endpointOf(config, args.endpoint);
  if (endpoint === undefined) {
    return failure('invalid-endpoint', 'endpoint must be an http(s) URL', {
      raw: args.endpoint ?? config.endpoint,
      hint: "set this plugin's `endpoint` config, or pass the `endpoint` parameter",
    });
  }

  const timeoutMs = timeoutOf(config, args.timeoutMs);
  const code = args.code;
  if (typeof code !== 'string' || code === '') {
    return failure('invalid-code', 'code must be a non-empty string');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  // Cancel the fetch when the caller cancels the tool call. A signal that is
  // already aborted never fires its event again, so trigger the abort here.
  const callerSignal = exec?.signal;
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort);
  if (callerSignal?.aborted) controller.abort();
  const cancelled = () => callerSignal?.aborted === true;

  try {
    const response = await fetch(joinRpc(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'vm.execute',
        params: { code, timeoutMs },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return failure('http-error', `aether-node answered HTTP ${response.status}`, {
        endpoint,
        hint: 'check that the endpoint really points at an aether-node RPC (it answers JSON-RPC POSTs on /)',
      });
    }

    let document;
    try {
      document = await response.json();
    } catch (error) {
      return failure('http-error', `response was not JSON: ${describeError(error)}`, { endpoint });
    }

    if (isRpcError(document)) {
      return failure('rpc-error', `${document.error.code} ${document.error.message}`, {
        endpoint,
        data: document.error.data,
      });
    }

    const result = document?.result;
    if (!isVmResult(result)) {
      return failure('http-error', 'aether-node answered a non-VmResult payload', {
        endpoint,
        data: tryStringify(document?.result),
      });
    }

    // Pass the sandbox verdict through verbatim; `ok` means "the sandbox ran it".
    // `error` is aether-node's VmErrorInfo ({ name, message, stack? }) — kept as
    // an object so the model sees the same detail the local CLI would print.
    return {
      ok: result.ok === true,
      status: typeof result.status === 'string' ? result.status : 'unknown',
      value: result.value,
      error: result.error,
      logs: Array.isArray(result.logs) ? result.logs.filter((line) => typeof line === 'string') : [],
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : undefined,
      endpoint,
    };
  } catch (error) {
    if (cancelled()) {
      return failure('cancelled', 'the caller aborted the tool call before aether-node answered', {
        endpoint,
      });
    }
    if (controller.signal.aborted) {
      return failure('timeout', `no answer from aether-node within ${config.timeoutMs} ms`, {
        endpoint,
        hint: 'raise the timeoutMs config or retry when the node is less busy',
      });
    }
    return failure('network-error', describeError(error), {
      endpoint,
      hint: 'is aether-node running? boot it with `npm run demo:web` in the aether-node repo',
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/** `endpoint` + '/', tolerating a trailing slash already present. */
function joinRpc(endpoint) {
  return endpoint.endsWith('/') ? `${endpoint}` : `${endpoint}/`;
}

/** Closed-set failure envelope with an optional hint. */
function failure(status, message, extra = {}) {
  return {
    ok: false,
    status,
    error: message,
    ...extra,
  };
}

function describeError(error) {
  if (error instanceof Error) return error.message || error.name;
  return tryStringify(error) ?? 'unknown error';
}

function tryStringify(value) {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}

function isRpcError(document) {
  return (
    typeof document === 'object' &&
    document !== null &&
    typeof document.error === 'object' &&
    document.error !== null &&
    (typeof document.error.code === 'number' || typeof document.error.code === 'string') &&
    typeof document.error.message === 'string'
  );
}

function isVmResult(value) {
  return typeof value === 'object' && value !== null && typeof value.status === 'string';
}

/**
 * Human-readable rendering (the Native content the model sees).
 *
 * Keep it compact: one header line, the value (when any), then sandbox logs.
 *
 * @param value the canonical tool result.
 */
function renderResult(value) {
  const data = isStructured(value) ? value : undefined;
  if (data === undefined) {
    return `[${TOOL_NAME}] ${tryStringify(value) ?? 'no result'}`;
  }
  const lines = [
    `[${TOOL_NAME}] ${data.ok ? 'ok' : `failed (${data.status})`}` +
      (data.endpoint !== undefined ? ` · ${data.endpoint}` : '') +
      (typeof data.durationMs === 'number' ? ` · ${data.durationMs} ms` : ''),
  ];
  if (data.ok !== true && data.error !== undefined) {
    lines.push(`error: ${tryStringify(data.error) ?? String(data.error)}`);
  }
  if (data.ok === true && data.value !== undefined) {
    lines.push('value:', tryStringify(data.value) ?? String(data.value));
  }
  if (Array.isArray(data.logs) && data.logs.length > 0) {
    const shown = data.logs.slice(0, MAX_RENDERED_LOG_LINES);
    lines.push(
      'logs:',
      ...shown.map((line) => `  · ${line}`),
    );
    if (data.logs.length > shown.length) {
      lines.push(`  · … ${data.logs.length - shown.length} more line(s) not shown`);
    }
  }
  if (typeof data.hint === 'string' && data.hint !== '') {
    lines.push(`hint: ${data.hint}`);
  }
  return lines.join('\n');
}

function isStructured(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.status === 'string' &&
    typeof value.ok === 'boolean'
  );
}
