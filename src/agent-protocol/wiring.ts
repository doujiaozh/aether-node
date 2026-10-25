/**
 * aether-node :: agent-protocol :: standard toolset wiring
 *
 * Binds the canonical `aether.*` methods onto a live SyncEngine and
 * SandboxExecutor. The result is the "tool list" an AI agent sees when it
 * asks what this node can do.
 *
 * Security posture: reading the store is always available; writing is
 * allowed (it is local-first: data lives on *this* machine); sandbox
 * execution is delegated to the executor, which owns isolation.
 */

import type { SandboxExecutor } from "../micro-vm/sandbox.js";
import type { ExecRequest } from "../micro-vm/types.js";
import type { CrdtSnapshot, JsonValue, Op } from "../sync-engine/types.js";
import { AetherMethod, JsonRpcErrorCode } from "./types.js";
import type {
  AgentCapabilitiesResult,
  SyncApplyOpsParams,
  SyncApplyOpsResult,
  SyncGetParams,
  SyncGetResult,
  SyncGetSnapshotResult,
  SyncPutParams,
  SyncPutResult,
  VmExecuteParams,
  VmExecuteResult,
  VmHealthResult,
} from "./types.js";
import { ProtocolServer, RpcError } from "./protocol.js";
import type { RpcContext } from "./protocol.js";

/** Capabilities the wiring layer needs from a sync engine (structural). */
export interface SyncEngineLike {
  readonly identity: { readonly nodeId: string };
  applyLocal(change: { key: string; value?: JsonValue }): Op;
  applyRemote(ops: Iterable<Op>): SyncApplyOpsResult;
  snapshot(): CrdtSnapshot;
  get(key: string): JsonValue | undefined;
}

export interface AetherRuntimeDeps {
  readonly sync: SyncEngineLike;
  readonly vm: SandboxExecutor;
  /** Runtime name surfaced via aether.agent.capabilities. */
  readonly name?: string;
  /** Runtime version surfaced via aether.agent.capabilities. */
  readonly version?: string;
}

const DEFAULT_NAME = "aether-node";
const DEFAULT_VERSION = "0.0.1";

export async function createAetherProtocolServer(
  deps: AetherRuntimeDeps,
): Promise<ProtocolServer> {
  const health = await deps.vm.healthCheck();
  const server = new ProtocolServer({
    name: deps.name ?? DEFAULT_NAME,
    version: deps.version ?? DEFAULT_VERSION,
    sandboxIsolated: health.isolated,
  });

  // ---- read path --------------------------------------------------------
  server.register<undefined, SyncGetSnapshotResult>(
    AetherMethod.SyncGetSnapshot,
    "return a full CRDT snapshot of the local data store (peer catch-up)",
    () => ({
      nodeId: deps.sync.identity.nodeId,
      snapshot: deps.sync.snapshot(),
    }),
  );

  server.register<SyncGetParams, SyncGetResult>(
    AetherMethod.SyncGet,
    "read a single key from the local data store",
    (params) => {
      assertObject(params, "params");
      const key = params.key;
      if (typeof key !== "string" || key === "") {
        throw new RpcError(JsonRpcErrorCode.INVALID_PARAMS, 'params.key must be a non-empty string');
      }
      const value = deps.sync.get(key);
      return value === undefined
        ? { key, found: false }
        : { key, found: true, value };
    },
  );

  // ---- write path -------------------------------------------------------
  server.register<SyncPutParams, SyncPutResult>(
    AetherMethod.SyncPut,
    "write a key/value pair into the local data store; returns the minted CRDT op",
    (params) => {
      assertObject(params, "params");
      if (typeof params.key !== "string" || params.key === "") {
        throw new RpcError(JsonRpcErrorCode.INVALID_PARAMS, "params.key must be a non-empty string");
      }
      if (params.value === undefined) {
        throw new RpcError(JsonRpcErrorCode.INVALID_PARAMS, "params.value is required");
      }
      const op = deps.sync.applyLocal({ key: params.key, value: params.value });
      return { op };
    },
  );

  server.register<SyncApplyOpsParams, SyncApplyOpsResult>(
    AetherMethod.SyncApplyOps,
    "merge CRDT operations received from another node (idempotent)",
    (params) => {
      assertObject(params, "params");
      if (!Array.isArray(params.ops)) {
        throw new RpcError(JsonRpcErrorCode.INVALID_PARAMS, "params.ops must be an array of ops");
      }
      return deps.sync.applyRemote(params.ops);
    },
  );

  // ---- computation path -------------------------------------------------
  server.register<VmExecuteParams, VmExecuteResult>(
    AetherMethod.VmExecute,
    "execute code inside the sandboxed execution environment and return the result",
    async (params, ctx) => {
      assertObject(params, "params");
      if (typeof params.code !== "string" || params.code === "") {
        throw new RpcError(JsonRpcErrorCode.INVALID_PARAMS, "params.code must be a non-empty string");
      }
      const request: ExecRequest = {
        id: `rpc:${String(ctx.requestId)}`,
        code: params.code,
        ...(params.language === undefined ? {} : { language: params.language }),
        ...(params.timeoutMs === undefined ? {} : { policy: { timeoutMs: params.timeoutMs } }),
        ...(params.env === undefined ? {} : { env: params.env }),
      };
      const result = await deps.vm.execute(request);
      if (result.ok) {
        return {
          ok: true,
          durationMs: result.durationMs,
          returnValue: result.returnValue,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
      return {
        ok: false,
        durationMs: result.durationMs,
        error: { code: result.error.code, message: result.error.message },
        ...(result.error.stderr === undefined ? {} : { stderr: result.error.stderr }),
      };
    },
  );

  server.register<undefined, VmHealthResult>(
    AetherMethod.VmHealth,
    "probe the sandbox executor's liveness and isolation level",
    () => deps.vm.healthCheck(),
  );

  server.register<undefined, AgentCapabilitiesResult>(
    AetherMethod.AgentCapabilities,
    "advertise the tools this node exposes to AI agents",
    () => ({
      name: server.meta.name,
      version: server.meta.version,
      methods: server.describe(),
      sandboxIsolated: server.meta.sandboxIsolated,
    }),
  );

  return server;
}

function assertObject(params: unknown, label: string): void {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new RpcError(JsonRpcErrorCode.INVALID_PARAMS, `${label} must be an object`);
  }
}

