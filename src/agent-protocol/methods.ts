/**
 * The aether-node agent method surface.
 *
 * {@link registerSystemMethods} wires the two core JSON-RPC methods AI agents
 * call —
 *  - `vm.execute`   — run generated code in the sandboxed micro-VM;
 *  - `sync.getState`— read the current CRDT sync state —
 * plus two conveniences used by the demo and by agent tooling:
 *  - `sync.merge`   — merge agent-produced data into the local replica;
 *  - `rpc.discover` — list the methods the server exposes.
 *
 * Every method validates its params and maps domain failures onto JSON-RPC
 * error envelopes ({@link RpcError}) rather than letting exceptions escape.
 */

import { MicroVm, type VmResult } from '../micro-vm/index.js';
import {
  SyncEngine,
  SyncImportError,
  type MergeSummary,
  type SyncState,
} from '../sync-engine/index.js';
import { RpcError, RpcErrorCode } from './rpc.js';
import type { RpcServer } from './server.js';

export interface SystemMethodsDeps {
  vm: MicroVm;
  engine: SyncEngine;
}

export interface VmExecuteParams {
  code: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxResultBytes?: number;
}

export interface SyncMergeParams {
  /** Values to write as LWW-Registers, keyed by register name. */
  registers?: Record<string, unknown>;
  /** Counter deltas to apply, keyed by counter name (may be negative). */
  counters?: Record<string, number>;
}

function assertObject(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${what} must be an object`);
  }
}

function assertFiniteNumber(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${what} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${what} must be within [${min}, ${max}]`);
  }
  return value;
}

/**
 * Registers the aether-node method surface on `server`. The JSON-RPC layer
 * stays transport-agnostic; these handlers close the loop between the agent
 * protocol and the engine/VM they drive.
 */
export function registerSystemMethods(server: RpcServer, deps: SystemMethodsDeps): RpcServer {
  const { vm, engine } = deps;

  server.register(
    'vm.execute',
    async (params): Promise<VmResult> => {
      assertObject(params, 'params');
      if (typeof params.code !== 'string' || params.code.length === 0) {
        throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'params.code must be a non-empty string');
      }
      const context = params.context;
      if (context !== undefined) assertObject(context, 'params.context');
      const options: {
        timeoutMs?: number;
        memoryLimitMb?: number;
        maxResultBytes?: number;
      } = {};
      if (params.timeoutMs !== undefined) {
        options.timeoutMs = assertFiniteNumber(params.timeoutMs, 'params.timeoutMs', 50, 30_000);
      }
      if (params.memoryLimitMb !== undefined) {
        options.memoryLimitMb = assertFiniteNumber(params.memoryLimitMb, 'params.memoryLimitMb', 32, 1024);
      }
      if (params.maxResultBytes !== undefined) {
        options.maxResultBytes = assertFiniteNumber(params.maxResultBytes, 'params.maxResultBytes', 1024, 32 * 1024 * 1024);
      }
      return vm.execute(params.code, context as Record<string, unknown> | undefined, options);
    },
    'Execute code inside the sandboxed micro-VM',
  );

  server.register(
    'sync.getState',
    (params): SyncState => {
      if (params !== undefined) assertObject(params, 'params');
      return engine.export();
    },
    'Return the current CRDT sync state (full replica export)',
  );

  server.register(
    'sync.merge',
    (params): MergeSummary => {
      assertObject(params, 'params');
      const summary: MergeSummary = {
        registersChanged: 0,
        countersChanged: 0,
        version: engine.version,
        applied: false,
      };
      if (params.registers !== undefined) {
        assertObject(params.registers, 'params.registers');
        for (const key of Object.keys(params.registers)) {
          engine.set(key, params.registers[key]);
          summary.registersChanged += 1;
        }
      }
      if (params.counters !== undefined) {
        assertObject(params.counters, 'params.counters');
        for (const key of Object.keys(params.counters)) {
          const delta = assertFiniteNumber(params.counters[key], `params.counters["${key}"]`, -1e9, 1e9);
          engine.increment(key, delta);
          summary.countersChanged += 1;
        }
      }
      summary.version = engine.version;
      summary.applied = summary.registersChanged > 0 || summary.countersChanged > 0;
      return summary;
    },
    'Merge agent-produced values into the local replica (LWW registers, PN counters)',
  );

  server.register(
    'sync.importState',
    (params): MergeSummary => {
      assertObject(params, 'params');
      const state = params.state;
      try {
        return engine.import(state as string | SyncState);
      } catch (error) {
        if (error instanceof SyncImportError) {
          throw new RpcError(RpcErrorCode.INVALID_PARAMS, `invalid sync state: ${error.message}`);
        }
        throw error;
      }
    },
    'Import and merge a peer sync-state blob (string or object)',
  );

  server.register(
    'rpc.discover',
    (): string[] => server.listMethods(),
    'List the JSON-RPC methods exposed by this server',
  );

  return server;
}
