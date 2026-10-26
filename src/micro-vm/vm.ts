/**
 * micro-vm — a sandboxed execution engine for AI-generated code.
 *
 * Every {@link MicroVm.execute} call runs the submitted code inside a fresh
 * `worker_threads` isolate whose V8 heap is hard-capped by
 * `resourceLimits`, with code generation (eval / new Function / WebAssembly)
 * disabled, no host globals (`process`, `require`, `fs`, `net` …), and a
 * wall-clock budget enforced by terminating the worker. The VM shares nothing
 * with the host but the caller-provided context, so untrusted AI code cannot
 * touch the filesystem, the network, or the sync engine.
 */

import { Worker } from 'node:worker_threads';

/** Execution budget for a single run. */
export interface VmExecutionOptions {
  /** Wall-clock limit in ms. Default 5000, clamped to [50, 30000]. */
  timeoutMs?: number;
  /** V8 old-generation heap cap in MB. Default 32, clamped to [32, 1024]. */
  memoryLimitMb?: number;
  /** Reject results whose JSON encoding exceeds this many bytes (default 2 MiB). */
  maxResultBytes?: number;
}

/** Outcome category of a run. */
export type VmStatus =
  | 'ok'
  | 'timeout'
  | 'memory'
  | 'crash'
  | 'input'
  | 'output'
  | 'runtime';

export interface VmErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/** Uniform result envelope — success or failure, never a thrown exception. */
export interface VmResult<T = unknown> {
  ok: boolean;
  status: VmStatus;
  /** The value the code returned. Present when `ok` is true. */
  value?: T;
  /** Failure detail. Present when `ok` is false. */
  error?: VmErrorInfo;
  /** Lines captured from sandbox `console.*` calls. */
  logs: string[];
  /** Wall-clock duration of the execution, in ms. */
  durationMs: number;
}

/** Options after normalization and clamping. */
export interface NormalizedVmOptions {
  timeoutMs: number;
  memoryLimitMb: number;
  maxResultBytes: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_MB = 32;
/**
 * 32 MB is the lowest old-generation cap that survives worker-isolate
 * bootstrap reliably: below ~20 MB some Node builds abort the *host* with
 * "GC during deserialization" while snapshotting the new isolate (a fatal
 * V8 OOM, not a catchable error), so we refuse to go lower.
 */
const MIN_MEMORY_MB = 32;
const MAX_MEMORY_MB = 1024;
const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** Clamp and default an options object into a fully-resolved budget. */
export function normalizeVmOptions(
  options: VmExecutionOptions = {},
): NormalizedVmOptions {
  const timeoutMs = clamp(
    Math.round(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const memoryLimitMb = clamp(
    Math.round(options.memoryLimitMb ?? DEFAULT_MEMORY_MB),
    MIN_MEMORY_MB,
    MAX_MEMORY_MB,
  );
  const maxResultBytes = Math.max(
    1024,
    Math.round(options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES),
  );
  return { timeoutMs, memoryLimitMb, maxResultBytes };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Reject values that cannot cross the worker boundary. */
export function clonePlainContext(
  value: unknown,
  path = 'context',
  depth = 0,
): unknown {
  if (typeof value === 'function') {
    throw new TypeError(`${path} cannot contain functions (sandbox inputs must be plain data)`);
  }
  if (typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`${path} cannot contain ${typeof value} values`);
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 32) {
    throw new RangeError(`${path} exceeds the maximum nesting depth of 32`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      clonePlainContext(item, `${path}[${index}]`, depth + 1),
    );
  }
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    // Class instances, Dates, Maps … all become plain objects — anything
    // exotic (proxies, promises) is flattened defensively.
    return clonePlainContext({ ...value }, path, depth);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = clonePlainContext(
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
      depth + 1,
    );
  }
  return out;
}

/**
 * The sandbox worker. Runs as CommonJS so it can be spawned inline via
 * `new Worker(source, { eval: true })` — no file access from the worker,
 * which keeps the sandbox fully self-contained.
 *
 * Wire protocol (host -> worker): { code, context, timeoutMs, maxResultBytes }
 * Wire protocol (worker -> host): { status, value?, error?, logs, durationMs }
 */
const WORKER_SOURCE = `
'use strict';
const vm = require('node:vm');
const util = require('node:util');
const { parentPort } = require('node:worker_threads');

var logs = [];

function makeConsole() {
  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  var c = {};
  for (var i = 0; i < levels.length; i++) {
    (function (level) {
      c[level] = function () {
        var args = [];
        for (var j = 0; j < arguments.length; j++) args.push(arguments[j]);
        logs.push(level.toUpperCase() + ': ' + util.format.apply(util, args));
      };
    })(levels[i]);
  }
  return c;
}

function errorInfo(err) {
  var info = {
    name: (err && err.name) || (typeof err === 'string' ? 'Error' : 'UnknownError'),
    message: (err && err.message) || String(err),
  };
  if (err && err.stack) info.stack = String(err.stack).split('\\n').slice(0, 4).join('\\n');
  return info;
}

function post(message) {
  try {
    parentPort.postMessage(message);
  } catch (e) {
    // The host went away (termination); nothing more to do.
  }
}

parentPort.on('message', function (m) {
  var startedAt = Date.now();
  logs = [];
  try {
    if (typeof m.code !== 'string' || m.code.length === 0) {
      return post({ status: 'input', error: { name: 'TypeError', message: 'code must be a non-empty string' }, logs: logs, durationMs: Date.now() - startedAt });
    }
    var sandbox = { console: makeConsole() };
    if (m.context && typeof m.context === 'object') {
      for (var k in m.context) {
        if (Object.prototype.hasOwnProperty.call(m.context, k)) sandbox[k] = m.context[k];
      }
    }
    var ctx = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
      name: 'aether-node-sandbox',
    });
    // async wrapper so return, top-level await and promises all behave.
    var fn = vm.runInContext('(async function(){' + m.code + '})', ctx, {
      filename: 'sandbox.js',
      timeout: m.timeoutMs,
    });
    fn().then(
      function (value) {
        var encoded;
        try {
          encoded = JSON.stringify(value);
        } catch (e) {
          return post({ status: 'output', error: { name: 'VmResultSerializationError', message: 'result could not be JSON-encoded' }, logs: logs, durationMs: Date.now() - startedAt });
        }
        if (encoded && encoded.length > m.maxResultBytes) {
          return post({ status: 'output', error: { name: 'VmResultTooLargeError', message: 'result exceeds the ' + m.maxResultBytes + '-byte budget (' + encoded.length + ' bytes)' }, logs: logs, durationMs: Date.now() - startedAt });
        }
        post({ status: 'ok', value: value === undefined ? null : value, logs: logs, durationMs: Date.now() - startedAt });
      },
      function (err) {
        post({ status: 'runtime', error: errorInfo(err), logs: logs, durationMs: Date.now() - startedAt });
      }
    ).catch(function (e) {
      post({ status: 'crash', error: errorInfo(e), logs: logs, durationMs: Date.now() - startedAt });
    });
  } catch (e) {
    // Compilation, timeout during call, or sandbox setup failure.
    var status = e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'runtime';
    post({ status: status, error: errorInfo(e), logs: logs, durationMs: Date.now() - startedAt });
  }
});
`;

/**
 * Executes untrusted code in an isolated, resource-capped sandbox.
 *
 * Each call spawns a dedicated worker and terminates it when the run settles
 * (result, timeout, or crash) — executions never share a realm, so there is
 * no cross-request state leakage to worry about.
 */
export class MicroVm {
  async execute<T = unknown>(
    code: string,
    context: Record<string, unknown> = {},
    options: VmExecutionOptions = {},
  ): Promise<VmResult<T>> {
    const normalized = normalizeVmOptions(options);

    if (typeof code !== 'string' || code.length === 0) {
      return {
        ok: false,
        status: 'input',
        error: { name: 'TypeError', message: 'code must be a non-empty string' },
        logs: [],
        durationMs: 0,
      };
    }

    let plainContext: unknown;
    try {
      plainContext = clonePlainContext(context);
    } catch (error) {
      return {
        ok: false,
        status: 'input',
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
        logs: [],
        durationMs: 0,
      };
    }

    const startedAt = performance.now();
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: normalized.memoryLimitMb,
          maxYoungGenerationSizeMb: Math.ceil(normalized.memoryLimitMb / 2),
          codeRangeSizeMb: 32,
          stackSizeMb: 4,
        },
      });
    } catch (error) {
      return {
        ok: false,
        status: 'crash',
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message:
            'failed to start sandbox worker: ' +
            (error instanceof Error ? error.message : String(error)),
        },
        logs: [],
        durationMs: performance.now() - startedAt,
      };
    }

    return await new Promise<VmResult<T>>((resolve) => {
      const finishOnce = once((result: VmResult<T>) => result);

      const finish = (result: VmResult<T>) => {
        const final = finishOnce(result);
        if (final !== undefined) {
          clearTimeout(timer);
          // Always release the worker — a lingering worker keeps the host
          // event loop alive.
          worker.terminate().catch(() => {});
          resolve(setDuration(final, startedAt));
        }
      };

      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            status: 'timeout',
            error: {
              name: 'VmTimeoutError',
              message: `execution exceeded the ${normalized.timeoutMs} ms wall-clock budget and was terminated`,
            },
            logs: [],
            durationMs: normalized.timeoutMs,
          }),
        normalized.timeoutMs,
      );

      worker.on('message', (message) => {
        const m = message as {
          status: VmStatus;
          value?: T;
          error?: VmErrorInfo;
          logs?: string[];
          durationMs?: number;
        };
        const ok = m.status === 'ok';
        finish({
          ok,
          status: m.status,
          value: ok ? m.value : undefined,
          error: ok ? undefined : m.error,
          logs: Array.isArray(m.logs) ? m.logs : [],
          durationMs: m.durationMs ?? 0,
        });
      });

      worker.on('error', (error: Error & { code?: string }) => {
        const isMemory =
          /memory limit|out of memory/i.test(error.message) ||
          error.code === 'ERR_WORKER_OUT_OF_MEMORY';
        finish({
          ok: false,
          status: isMemory ? 'memory' : 'crash',
          error: { name: error.name, message: error.message, stack: error.stack },
          logs: [],
          durationMs: 0,
        });
      });

      worker.on('exit', (code) => {
        finish({
          ok: false,
          status: 'crash',
          error: {
            name: 'VmWorkerExitError',
            message: `sandbox worker exited unexpectedly with code ${code}`,
          },
          logs: [],
          durationMs: 0,
        });
      });

      worker.postMessage({
        code,
        context: plainContext,
        timeoutMs: normalized.timeoutMs,
        maxResultBytes: normalized.maxResultBytes,
      });
    });
  }
}

function once<T>(fn: (arg: T) => T): (arg: T) => T | undefined {
  let done = false;
  return (arg: T) => {
    if (done) return undefined;
    done = true;
    return fn(arg);
  };
}

function setDuration<T extends { durationMs: number }>(
  result: T,
  startedAt: number,
): T {
  if (!result.durationMs || result.durationMs <= 0) {
    result.durationMs = Math.round(performance.now() - startedAt);
  }
  return result;
}
