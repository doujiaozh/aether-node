/**
 * aether-node :: agent-protocol :: JSON-RPC 2.0 tool protocol
 *
 * The protocol is the border crossing between an AI agent (which may be a
 * local model, a cloud LLM, or another aether node) and the host runtime
 * (sync engine + micro-vm). Speaking vanilla JSON-RPC 2.0 keeps that border
 * boring: any JSON-RPC client in any language can drive an aether node.
 *
 * Every method lives in the `aether.*` namespace and returns either a
 * structured `result` or a JSON-RPC `error` with an aether error code.
 */

import type { ApplyResult, CrdtSnapshot, JsonValue, Op } from "../sync-engine/types.js";
import type { ExecLanguage, SandboxHealth } from "../micro-vm/types.js";

// --------------------------------------------------------------- envelope

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorPayload;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

// ------------------------------------------------------------- method ids

export const AetherMethod = {
  SyncGetSnapshot: "aether.sync.getSnapshot",
  SyncGet: "aether.sync.get",
  SyncPut: "aether.sync.put",
  SyncApplyOps: "aether.sync.applyOps",
  VmExecute: "aether.vm.execute",
  VmHealth: "aether.vm.healthCheck",
  AgentCapabilities: "aether.agent.capabilities",
} as const;

export type AetherMethodId = (typeof AetherMethod)[keyof typeof AetherMethod];

// ------------------------------------------------------- params and results

/** aether.sync.getSnapshot */
export interface SyncGetSnapshotResult {
  readonly nodeId: string;
  readonly snapshot: CrdtSnapshot;
}

/** aether.sync.get */
export interface SyncGetParams {
  readonly key: string;
}
export interface SyncGetResult {
  readonly key: string;
  /** undefined when the key is absent or tombstoned. */
  readonly value?: JsonValue;
  readonly found: boolean;
}

/** aether.sync.put */
export interface SyncPutParams {
  readonly key: string;
  readonly value: JsonValue;
}
export interface SyncPutResult {
  /** The op minted locally; gossip it to peers to spread the change. */
  readonly op: Op;
}

/** aether.sync.applyOps */
export interface SyncApplyOpsParams {
  readonly ops: Op[];
}
export type SyncApplyOpsResult = ApplyResult;

/** aether.vm.execute */
export interface VmExecuteParams {
  readonly code: string;
  readonly language?: ExecLanguage;
  /** Convenience override for the execution timeout in milliseconds. */
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}
export type VmExecuteResult = VmExecuteResponse;

export interface VmExecuteResponse {
  readonly ok: boolean;
  readonly returnValue?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs: number;
  /** Present only when ok === false; mirrors the sandbox ExecError. */
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/** aether.vm.healthCheck */
export type VmHealthResult = SandboxHealth;

/** aether.agent.capabilities */
export interface AgentCapabilitiesResult {
  readonly name: string;
  readonly version: string;
  readonly methods: ReadonlyArray<{
    readonly method: string;
    readonly description: string;
  }>;
  /** True when the attached sandbox provides real OS-level isolation. */
  readonly sandboxIsolated: boolean;
}

// ------------------------------------------------------------ error codes

/** Standard JSON-RPC error codes (subset of the spec). */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * aether-specific codes in the implementation-defined -32000 band.
 * The AI-facing contract: on these errors, retry policies should differ —
 * TOOL_UNAVAILABLE is transient, POLICY_DENIED is permanent, SANDBOX_ERROR
 * usually means fixing the code is worth a retry.
 */
export const AetherErrorCode = {
  SYNC_ERROR: -32000,
  TOOL_UNAVAILABLE: -32001,
  SANDBOX_ERROR: -32002,
  POLICY_DENIED: -32003,
} as const;
