/**
 * JSON-RPC 2.0 primitives — request/response envelopes, the standard error
 * codes, and the {@link RpcError} thrown by handlers and transports.
 *
 * @see https://www.jsonrpc.org/specification
 */

/** Valid JSON-RPC id: string, number, or null (never undefined on responses). */
export type RpcId = string | number | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: P;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: RpcId;
  result?: R;
  error?: JsonRpcErrorBody;
}

/** Standard protocol error codes (JSON-RPC 2.0 §5.1). */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Reserved band for implementation-defined server errors (-32000..-32099).
  SERVER_ERROR: -32000,
  VM_EXECUTION_FAILED: -32001,
  SYNC_ENGINE_FAILED: -32002,
} as const;

/**
 * Protocol-level error. Handlers throw {@link RpcError} (or a plain Error) and
 * the server maps them onto the JSON-RPC error envelope; the client re-throws
 * them on `call`.
 */
export class RpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  static fromBody(body: JsonRpcErrorBody): RpcError {
    return new RpcError(body.code, body.message, body.data);
  }

  toBody(): JsonRpcErrorBody {
    const body: JsonRpcErrorBody = { code: this.code, message: this.message };
    if (this.data !== undefined) body.data = this.data;
    return body;
  }
}

/** Structural check on a JSON-RPC id after deserialization. */
export function isValidRpcId(value: unknown): value is RpcId {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value === null ||
    value === undefined
  );
}

/** Is this deserialized object a minimally-well-formed request? */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== '2.0') return false;
  if (typeof v.method !== 'string' || v.method.length === 0) return false;
  if (!isValidRpcId(v.id)) return false;
  if (v.params !== undefined && v.params === null) return false;
  return true;
}
