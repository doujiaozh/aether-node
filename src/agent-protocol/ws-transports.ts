/**
 * WebSocket transports for the agent protocol.
 *
 *  - {@link WsRpcServer} serves a {@link RpcServer} over `ws` (pure JS — no
 *    native compilation, no optional native addons);
 *  - {@link WsRpcTransport} pairs an outbound `ws` connection with an
 *    {@link RpcClient}, correlating response frames back to their requests.
 *
 * Unlike HTTP, one WebSocket carries many requests, so the transport keeps a
 * pending-request table keyed by JSON-RPC id; notifications are fire-and-forget
 * and resolve `null`, matching the {@link RpcTransport} contract.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { RpcError } from './rpc.js';
import type { RpcServer } from './server.js';
import type { RpcTransport } from './client.js';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export interface WsRpcServerOptions {
  port?: number;
  host?: string;
  /**
   * Attach to an existing HTTP server (e.g. the task-3 web server that also
   * serves the UI and the JSON-RPC endpoint) instead of owning one. With this
   * option {@link listen} and {@link close} leave the HTTP server alone.
   */
  server?: HttpServer;
  /** Extra context attached to every handled request (peer id, auth…). */
  context?: unknown;
}

/** Serve a {@link RpcServer} over WebSocket: JSON text frames, one per document. */
export class WsRpcServer {
  private readonly wss: WebSocketServer;
  /** Only set when this object owns the HTTP server it rides on. */
  private readonly httpServer: HttpServer | undefined;
  private readonly options: Required<Omit<WsRpcServerOptions, 'server' | 'context'>> &
    Pick<WsRpcServerOptions, 'context'>;
  private listening = false;

  constructor(
    private readonly rpc: RpcServer,
    options: WsRpcServerOptions = {},
  ) {
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? '127.0.0.1',
      context: options.context,
    };
    if (options.server !== undefined) {
      this.httpServer = undefined;
      this.wss = new WebSocketServer({ server: options.server, maxPayload: MAX_MESSAGE_BYTES });
    } else {
      // Any plain GET on the WS-only server is a 404; JSON-RPC rides on the
      // WebSocket, not over HTTP.
      this.httpServer = createServer((_request, response) => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
      });
      this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: MAX_MESSAGE_BYTES });
    }
    this.wss.on('connection', (socket) => this.handleConnection(socket));
  }

  /** Start listening; resolves with the bound address (port 0 → ephemeral). */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.httpServer === undefined) {
      throw new Error(
        'WsRpcServer is attached to an external HTTP server; start that server instead',
      );
    }
    if (this.listening) return this.addressOf();
    const server = this.httpServer;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => resolve());
    });
    this.listening = true;
    return this.addressOf();
  }

  /**
   * Stop accepting connections and terminate live ones. When attached to an
   * external server, only the WebSocket layer is detached.
   */
  async close(): Promise<void> {
    if (this.httpServer === undefined) {
      for (const client of this.wss.clients) client.terminate();
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
      return;
    }
    if (!this.listening) return;
    this.listening = false;
    const server = this.httpServer;
    for (const client of this.wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** `ws://host:port` URL clients can connect to (after {@link listen}). */
  get url(): string {
    const { family, address, port } = this.boundAddress();
    const host = family === 'IPv6' ? `[${address}]` : address;
    return `ws://${host}:${port}`;
  }

  private boundAddress(): AddressInfo {
    const address = this.wss.address();
    if (address === null || typeof address === 'string') {
      throw new Error('WsRpcServer is not listening');
    }
    return address;
  }

  private addressOf(): { host: string; port: number } {
    const { address, port } = this.boundAddress();
    return { host: address, port };
  }

  private handleConnection(socket: WebSocket): void {
    socket.on('message', async (data) => {
      const raw = data.toString('utf8');
      let answer: string | null;
      try {
        answer = await this.rpc.handleRaw(raw, this.options.context);
      } catch (error) {
        answer = JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      if (answer !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(answer);
      }
    });
  }
}

export interface WsRpcTransportOptions {
  /** Timeout for the initial connection handshake (default 15 s). */
  connectTimeoutMs?: number;
}

/** Post JSON-RPC documents over a WebSocket connection (URL or live socket). */
export class WsRpcTransport implements RpcTransport {
  private readonly socket: WebSocket;
  private readonly connectTimeoutMs: number;
  private readonly pending = new Map<
    number | string,
    { resolve: (document: string | null) => void; reject: (error: unknown) => void }
  >();

  constructor(
    target: string | WebSocket,
    options: WsRpcTransportOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.socket =
      typeof target === 'string'
        ? new WebSocket(target, { maxPayload: MAX_MESSAGE_BYTES })
        : target;
    this.socket.on('message', (data) => this.handleIncoming(data.toString('utf8')));
    this.socket.on('close', () => this.failPending('socket closed'));
    this.socket.on('error', (error) => this.failPending(error));
  }

  async post(document: string): Promise<string | null> {
    await this.whenOpen();
    let id: number | string | undefined;
    try {
      const body = JSON.parse(document) as { id?: number | string };
      id = body.id;
    } catch {
      // Malformed documents are the server's problem to answer, not ours.
    }
    if (id === undefined) {
      // Notification: no id, no response, per JSON-RPC 2.0.
      this.socket.send(document);
      return null;
    }
    return new Promise<string | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(document, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(
            new RpcError(
              -32300,
              `websocket send failure: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      });
    });
  }

  /** Close the underlying socket (only meaningful for sockets this transport owns). */
  close(): void {
    this.socket.close();
  }

  private async whenOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.socket.readyState !== WebSocket.CONNECTING) {
      throw new RpcError(-32300, 'websocket transport is not open');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RpcError(-32300, 'websocket connect timed out')),
        this.connectTimeoutMs,
      );
    });
    const open = new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => reject(error);
      this.socket.once('open', () => {
        this.socket.removeListener('error', onError);
        resolve();
      });
      this.socket.once('error', onError);
    });
    try {
      await Promise.race([open, timeout]);
    } catch (error) {
      throw new RpcError(
        -32300,
        `websocket connect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private handleIncoming(raw: string): void {
    let body: { id?: number | string };
    try {
      body = JSON.parse(raw) as { id?: number | string };
    } catch {
      return; // Not a response document we can correlate; ignore.
    }
    const id = body.id;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.resolve(raw);
  }

  private failPending(reason: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(
        new RpcError(
          -32300,
          `websocket transport failure: ${reason instanceof Error ? reason.message : String(reason)}`,
        ),
      );
    }
  }
}
