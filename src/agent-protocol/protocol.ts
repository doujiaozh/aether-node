/**
 * aether-node :: agent-protocol :: ProtocolServer
 *
 * A transport-agnostic JSON-RPC 2.0 dispatcher. It takes a request object
 * (or a raw JSON string) and produces a response, routing `aether.*`
 * methods to the handlers registered by the runtime.
 *
 * Design notes:
 *   - Notifications (requests without an `id`) are executed fire-and-forget
 *     and produce no response, per the JSON-RPC spec.
 *   - Handlers never need to catch their own errors: a thrown `RpcError`
 *     becomes a protocol error with its code, anything else becomes an
 *     INTERNAL_ERROR (or INVALID_PARAMS for validation failures).
 *   - Every call is appended to an audit log — agents act on our machine,
 *     so we owe the user a verifiable record of what was requested.
 */

import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { AetherErrorCode, JsonRpcErrorCode } from "./types.js";

/** Per-call context handed to every handler. */
export interface RpcContext {
  readonly requestId: JsonRpcId;
  readonly receivedAt: number;
  /** Emit an audit-relevant event (reserved for future policy hooks). */
  readonly sandboxIsolated: boolean;
}

/** Handler signature. Params are typed per method by the wiring layer. */
export type RpcHandler<P = unknown, R = unknown> = (
  params: P,
  ctx: RpcContext,
) => Promise<R> | R;

/** Thrown by handlers to produce a structured protocol error. */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** One entry of the call audit trail. */
export interface AuditEntry {
  readonly at: number;
  readonly method: string;
  readonly requestId: JsonRpcId;
  readonly outcome: "ok" | "error";
  readonly errorCode?: number;
  readonly durationMs: number;
}

interface HandlerRecord {
  handler: RpcHandler;
  description: string;
}

export interface ProtocolServerOptions {
  readonly name: string;
  readonly version: string;
  /** Cap of retained audit entries (older ones roll off). */
  readonly auditLimit?: number;
  readonly sandboxIsolated?: boolean;
}

export class ProtocolServer {
  private readonly handlers = new Map<string, HandlerRecord>();
  private readonly auditEntries: AuditEntry[] = [];
  private readonly options: Required<ProtocolServerOptions>;

  constructor(options: ProtocolServerOptions) {
    this.options = {
      name: options.name,
      version: options.version,
      auditLimit: options.auditLimit ?? 512,
      sandboxIsolated: options.sandboxIsolated ?? false,
    };
  }

  /** Register a method handler. Overriding an existing method logs a warning. */
  register<P, R>(method: string, description: string, handler: RpcHandler<P, R>): this {
    if (this.handlers.has(method)) {
      console.warn(`[agent-protocol] handler for "${method}" overridden`);
    }
    this.handlers.set(method, {
      handler: handler as unknown as RpcHandler,
      description,
    });
    return this;
  }

  /** Names of all registered methods. */
  methods(): string[] {
    return [...this.handlers.keys()];
  }

  /** Method registry with human-readable descriptions (capability ads). */
  describe(): Array<{ method: string; description: string }> {
    return [...this.handlers.entries()].map(([method, record]) => ({
      method,
      description: record.description,
    }));
  }

  /** Immutable view of the audit log (newest last). */
  auditLog(): AuditEntry[] {
    return [...this.auditEntries];
  }

  /**
   * Handle a single request object. Always resolves with a response when
   * the request carries an `id`; notifications resolve with `undefined`.
   */
  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const isNotification = request?.id === undefined;
    const id: JsonRpcId = request?.id ?? null;
    const startedAt = performance.now();
    const method = typeof request?.method === "string" ? request.method : "<malformed>";

    const ctx: RpcContext = {
      requestId: id,
      receivedAt: Date.now(),
      sandboxIsolated: this.options.sandboxIsolated,
    };

    if (request == null || request.jsonrpc !== "2.0") {
      this.record(method, id, "error", startedAt, JsonRpcErrorCode.INVALID_REQUEST);
      if (isNotification) return undefined;
      return errorResponse(id, JsonRpcErrorCode.INVALID_REQUEST, "jsonrpc must be \"2.0\"");
    }

    const record = this.handlers.get(method);
    if (!record) {
      this.record(method, id, "error", startedAt, JsonRpcErrorCode.METHOD_NOT_FOUND);
      if (isNotification) return undefined;
      return errorResponse(id, JsonRpcErrorCode.METHOD_NOT_FOUND, `no handler: ${method}`);
    }

    try {
      const result = await record.handler(request.params, ctx);
      this.record(method, id, "ok", startedAt);
      if (isNotification) return undefined;
      return { jsonrpc: "2.0", id, result: result ?? null };
    } catch (e) {
      const payload = toErrorPayload(e);
      this.record(method, id, "error", startedAt, payload.code);
      if (isNotification) return undefined;
      return errorResponse(id, payload.code, payload.message, payload.data);
    }
  }

  /**
   * Handle a raw JSON string: parse it, dispatch, and serialize the answer.
   * Returns the JSON response string, or an empty string for notifications.
   */
  async handleRaw(raw: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.record("<parse>", null, "error", performance.now(), JsonRpcErrorCode.PARSE_ERROR);
      return JSON.stringify(
        errorResponse(null, JsonRpcErrorCode.PARSE_ERROR, "malformed JSON"),
      );
    }

    const respond = async (one: unknown): Promise<string> => {
      const response = await this.handle(one as JsonRpcRequest);
      return response === undefined ? "" : JSON.stringify(response);
    };

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return JSON.stringify(
          errorResponse(null, JsonRpcErrorCode.INVALID_REQUEST, "empty batch"),
        );
      }
      const responses = await Promise.all(parsed.map(respond));
      const kept = responses.filter((s) => s !== "");
      return kept.length === 0 ? "" : `[${kept.join(",")}]`;
    }

    return respond(parsed);
  }

  get meta() {
    return {
      name: this.options.name,
      version: this.options.version,
      sandboxIsolated: this.options.sandboxIsolated,
    };
  }

  private record(
    method: string,
    id: JsonRpcId,
    outcome: "ok" | "error",
    startedAt: number,
    errorCode?: number,
  ): void {
    this.auditEntries.push({
      at: Date.now(),
      method,
      requestId: id,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      durationMs: Math.round(performance.now() - startedAt),
    });
    if (this.auditEntries.length > this.options.auditLimit) {
      this.auditEntries.shift();
    }
  }
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function toErrorPayload(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof RpcError) {
    return e.data === undefined
      ? { code: e.code, message: e.message }
      : { code: e.code, message: e.message, data: e.data };
  }
  // Validation failures thrown by handlers signal "bad params from the model".
  if (e instanceof TypeError) {
    return { code: JsonRpcErrorCode.INVALID_PARAMS, message: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { code: JsonRpcErrorCode.INTERNAL_ERROR, message };
}

export { AetherErrorCode };
