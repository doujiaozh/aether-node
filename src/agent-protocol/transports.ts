/**
 * Transports wire {@link RpcClient} and {@link RpcServer} together.
 *
 *  - {@link LoopbackTransport}: in-process pairing — used by tests and any
 *    co-located agent;
 *  - {@link HttpRpcTransport} / {@link HttpRpcServer}: plain JSON-over-HTTP,
 *    used by the demo and any external agent process.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { RpcError } from './rpc.js';
import type { RpcServer } from './server.js';
import type { RpcTransport } from './client.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** Route client documents straight into an in-process {@link RpcServer}. */
export class LoopbackTransport implements RpcTransport {
  constructor(
    private readonly server: RpcServer,
    private readonly context?: unknown,
  ) {}

  async post(document: string): Promise<string | null> {
    return this.server.handleRaw(document, this.context);
  }
}

/** POST JSON-RPC documents to a remote HTTP endpoint. */
export class HttpRpcTransport implements RpcTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly url: string,
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async post(document: string): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: document,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RpcError(
        -32300,
        `transport failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 204 || response.status === 202) return null;
    if (!response.ok) {
      let data: string | undefined;
      try {
        data = await response.text();
      } catch {
        // ignore body read failures
      }
      throw new RpcError(
        -32300,
        `HTTP transport failure: ${response.status} ${response.statusText}`,
        data === '' ? undefined : data,
      );
    }
    return response.text();
  }
}

export interface HttpRpcServerOptions {
  port?: number;
  host?: string;
  /** Extra context attached to every handled request (auth info, peer id…). */
  context?: unknown;
}

/** Serve a {@link RpcServer} over plain HTTP: `POST /` with a JSON body. */
export class HttpRpcServer {
  private readonly server: http.Server;
  private readonly options: Required<Omit<HttpRpcServerOptions, 'context'>> &
    Pick<HttpRpcServerOptions, 'context'>;
  private readonly sockets = new Set<Socket>();
  private listening = false;

  constructor(
    private readonly rpc: RpcServer,
    options: HttpRpcServerOptions = {},
  ) {
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? '127.0.0.1',
      context: options.context,
    };
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
      });
    });
  }

  /** Start listening; resolves with the bound address (port 0 → ephemeral). */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.listening) {
      const addr = this.server.address() as AddressInfo;
      return { host: addr.address, port: addr.port };
    }
    await new Promise<void>((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
    this.listening = true;
    const address = this.server.address() as AddressInfo;
    return { host: address.address, port: address.port };
  }

  /** Stop accepting connections and close idle sockets. */
  async close(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    for (const socket of this.serverListeners()) {
      socket.destroy();
    }
  }

  get url(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://${addr.address}:${addr.port}/`;
  }

  private serverListeners(): Socket[] {
    return [...this.sockets];
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      respond(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `method not allowed: ${req.method}` } });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        respond(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request body too large' } });
        req.destroy();
        break;
      }
      chunks.push(chunk as Buffer);
    }
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const answer = await this.rpc.handleRaw(raw, this.options.context);
      if (answer === null) {
        respond(res, 204);
      } else {
        respond(res, 200, answer);
      }
    } catch (error) {
      respond(res, 200, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

function respond(
  res: http.ServerResponse,
  status: number,
  body?: string | object,
): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res
    .writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    })
    .end(text);
}
