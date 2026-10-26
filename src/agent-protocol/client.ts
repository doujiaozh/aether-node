/**
 * {@link RpcClient} — a minimal JSON-RPC 2.0 client over a request/response
 * transport. Generates ids, rejects protocol errors as {@link RpcError}, and
 * supports notifications (`notify`) and per-call timeouts.
 */

import { RpcError, type JsonRpcResponse } from './rpc.js';

/** A transport moves one request document and returns its response document. */
export interface RpcTransport {
  post(document: string): Promise<string | null>;
}

/** Client-side timeout — the transport failed to answer in time. */
export class RpcClientTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`json-rpc call "${method}" timed out after ${timeoutMs} ms`);
    this.name = 'RpcClientTimeoutError';
  }
}

/** Unexpected (non-error-envelope) transport output. */
export class RpcClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcClientError';
  }
}

export interface RpcCallOptions {
  /** Per-call timeout in ms (default 15 s). */
  timeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 15_000;

export class RpcClient {
  private idCounter = 0;

  constructor(private readonly transport: RpcTransport) {}

  /** Execute a method call and resolve with `result`. Rejects on error envelopes / timeouts. */
  async call<T = unknown>(
    method: string,
    params?: unknown,
    options: RpcCallOptions = {},
  ): Promise<T> {
    const id = ++this.idCounter;
    const document = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const response = await this.postWithTimeout(document, method, timeoutMs);
    if (response === null) {
      throw new RpcClientError(
        `transport returned no response for "${method}" (id=${id})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response);
    } catch {
      throw new RpcClientError(`transport returned malformed JSON for "${method}"`);
    }
    const body = parsed as JsonRpcResponse<T>;
    if (
      body === null ||
      typeof body !== 'object' ||
      body.jsonrpc !== '2.0' ||
      body.id !== id
    ) {
      throw new RpcClientError(`transport returned an invalid response for "${method}"`);
    }
    if (body.error !== undefined) {
      throw RpcError.fromBody(body.error);
    }
    return body.result as T;
  }

  /** Fire a notification — no id, no response, no rejection on protocol errors. */
  async notify(method: string, params?: unknown): Promise<void> {
    const document = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
    await this.transport.post(document);
  }

  private async postWithTimeout(
    document: string,
    method: string,
    timeoutMs: number,
  ): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RpcClientTimeoutError(method, timeoutMs)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.transport.post(document), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
