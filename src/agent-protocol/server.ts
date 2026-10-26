/**
 * {@link RpcServer} — a transport-agnostic JSON-RPC 2.0 request router.
 *
 * Server-side responsibilities:
 *  - validate envelopes (parse, request shape, id handling);
 *  - route `method` to a registered handler;
 *  - convert thrown {@link RpcError}s (and unexpected Errors) into proper
 *    JSON-RPC error envelopes;
 *  - honor notifications (requests without `id`) by executing the handler but
 *    producing no response;
 *  - support batched requests per spec §6.
 *
 * The server knows nothing about HTTP, WebSockets, or the micro-vm — the
 * transport and the method registry are plugged in from the outside.
 */

import {
  isJsonRpcRequest,
  RpcError,
  RpcErrorCode,
  type JsonRpcErrorBody,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcId,
} from './rpc.js';

/** Handler invoked for a routed request. Throws RpcError for protocol faults. */
export type RpcHandler<ContextT = unknown> = (
  params: unknown,
  context: ContextT,
) => Promise<unknown> | unknown;

export interface RpcMethodEntry<ContextT = unknown> {
  handler: RpcHandler<ContextT>;
  description?: string;
}

export interface RpcServerOptions {
  /** Invoked for every handler rejection that is not already an RpcError. */
  onError?: (error: unknown, request: JsonRpcRequest | null) => void;
}

function isValidId(value: unknown): value is RpcId {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value === null
  );
}

export class RpcServer<ContextT = unknown> {
  private readonly methods = new Map<string, RpcMethodEntry<ContextT>>();
  private readonly options: RpcServerOptions;

  constructor(options: RpcServerOptions = {}) {
    this.options = options;
  }

  /** Register a method. Overwrites any previous binding for `method`. */
  register(
    method: string,
    handler: RpcHandler<ContextT>,
    description?: string,
  ): this {
    this.methods.set(method, { handler, description });
    return this;
  }

  /** Remove a method binding. */
  unregister(method: string): this {
    this.methods.delete(method);
    return this;
  }

  has(method: string): boolean {
    return this.methods.has(method);
  }

  /** All registered method names, sorted. */
  listMethods(): string[] {
    return [...this.methods.keys()].sort();
  }

  /**
   * Route a single (already-parsed) request object.
   *
   * Returns `null` for notifications, otherwise the response envelope. Never
   * throws — every failure is mapped onto an error envelope.
   */
  async handleRequest(
    request: unknown,
    context?: ContextT,
  ): Promise<JsonRpcResponse | null> {
    // Structural validation ---------------------------------------------------
    let id: RpcId = null;
    if (isJsonRpcRequest(request)) {
      id = request.id !== undefined ? request.id : null;
    } else {
      // Preserve the id when it survives validation, else null per spec §4.
      const maybeId = (request as Record<string, unknown> | null)?.id;
      id = isValidId(maybeId) ? maybeId : null;
      return errorResponse(id, RpcErrorCode.INVALID_REQUEST, 'invalid request: not a JSON-RPC 2.0 request object');
    }
    if (id === undefined) id = null;

    const isNotification = request.id === undefined || request.id === null;
    const method = request.method;
    const entry = this.methods.get(method);

    if (entry === undefined) {
      return isNotification
        ? null
        : errorResponse(id, RpcErrorCode.METHOD_NOT_FOUND, `method not found: ${method}`);
    }

    let result: unknown;
    try {
      result = await entry.handler(request.params, context as ContextT);
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError(
              RpcErrorCode.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? { name: error.name } : undefined,
            );
      this.options.onError?.(error, request);
      return isNotification ? null : errorResponse(id, rpcError.code, rpcError.message, rpcError.data);
    }

    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  }

  /**
   * Handle a batch. Invalid members get error envelopes; notification members
   * produce no responses. Returns `null` when the batch produced nothing.
   */
  async handleBatch(
    batch: unknown,
    context?: ContextT,
  ): Promise<JsonRpcResponse[] | null> {
    if (!Array.isArray(batch)) {
      throw new RpcError(RpcErrorCode.INVALID_REQUEST, 'invalid request: batch must be an array');
    }
    if (batch.length === 0) {
      throw new RpcError(RpcErrorCode.INVALID_REQUEST, 'invalid request: batch must not be empty');
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of batch) {
      const response = await this.handleRequest(item, context);
      if (response !== null) responses.push(response);
    }
    return responses.length > 0 ? responses : null;
  }

  /**
   * Full end-to-end handling of a raw request document (string or object).
   * Returns the JSON response string, or `null` when the caller sent a
   * notification (or a batch of only notifications).
   */
  async handleRaw(
    raw: string | unknown,
    context?: ContextT,
  ): Promise<string | null> {
    let document: unknown = raw;
    if (typeof raw === 'string') {
      try {
        document = JSON.parse(raw);
      } catch {
        return JSON.stringify(
          errorResponse(null, RpcErrorCode.PARSE_ERROR, 'parse error: malformed JSON'),
        );
      }
    }

    let response: JsonRpcResponse | JsonRpcResponse[] | null;
    try {
      response = Array.isArray(document)
        ? await this.handleBatch(document, context)
        : await this.handleRequest(document, context);
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError(RpcErrorCode.INTERNAL_ERROR, String(error));
      return JSON.stringify(errorResponse(null, rpcError.code, rpcError.message));
    }

    return response === null ? null : JSON.stringify(response);
  }
}

function errorResponse(
  id: RpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcErrorBody = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
