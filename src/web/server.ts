/**
 * web — the minimal aether-node front end.
 *
 * One {@link AetherWebServer} hosts everything on a single Node `http`
 * server, so the UI and the JSON-RPC service share one origin (no CORS) and
 * one port:
 *
 *   GET  /            → the static index.html "run code in the sandbox" UI
 *   GET  /app.js      → the UI's vanilla-JS controller
 *   POST /            → JSON-RPC 2.0 (vm.execute, sync.*, rpc.discover)
 *   ws://…            → the P2P sync transport, riding the same server
 *
 * No build step, no framework: the UI is hand-written HTML + JS served as-is.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MicroVm } from '../micro-vm/index.js';
import { SyncEngine } from '../sync-engine/index.js';
import { registerSystemMethods } from '../agent-protocol/methods.js';
import { RpcServer } from '../agent-protocol/server.js';
import { WsRpcServer } from '../agent-protocol/ws-transports.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface AetherWebServerOptions {
  port?: number;
  host?: string;
  /** Replica behind `sync.*`. A fresh {@link SyncEngine} when omitted. */
  engine?: SyncEngine;
  /** Sandbox behind `vm.execute`. A fresh {@link MicroVm} when omitted. */
  vm?: MicroVm;
  /** Pre-built RPC router (system methods are still registered on it). */
  rpc?: RpcServer;
  /** Directory holding index.html / app.js (defaults to the repo's `web/`). */
  staticDir?: string;
}

/**
 * Co-host the aether-node UI, its JSON-RPC endpoint and the WebSocket peer
 * transport on one HTTP server.
 */
export class AetherWebServer {
  readonly rpc: RpcServer;
  private readonly http: Server;
  private readonly ws: WsRpcServer;
  private readonly staticDir: string;
  private readonly options: Required<Omit<AetherWebServerOptions, 'engine' | 'vm' | 'rpc' | 'staticDir'>>;
  private listening = false;

  constructor(options: AetherWebServerOptions = {}) {
    this.rpc = options.rpc ?? new RpcServer();
    registerSystemMethods(this.rpc, {
      vm: options.vm ?? new MicroVm(),
      engine: options.engine ?? new SyncEngine(),
    });
    this.http = createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(String(error));
      });
    });
    this.ws = new WsRpcServer(this.rpc, { server: this.http });
    this.staticDir = options.staticDir ?? resolveStaticDir();
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? '127.0.0.1',
    };
  }

  /** Start listening; resolves with the bound address (port 0 → ephemeral). */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.listening) return this.addressOf();
    const { port, host } = this.options;
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => resolve());
    });
    this.listening = true;
    return this.addressOf();
  }

  /** `http://host:port` the browser (and peers) should hit. */
  get url(): string {
    const { host, port } = this.addressOf();
    return `http://${host}:${port}`;
  }

  /** `ws://host:port` P2P peers should connect to. */
  get wsUrl(): string {
    const { host, port } = this.addressOf();
    return `ws://${host}:${port}`;
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    await this.ws.close();
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
    });
  }

  private addressOf(): { host: string; port: number } {
    const address = this.http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('AetherWebServer is not listening');
    }
    return { host: address.address, port: address.port };
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'POST' && request.url === '/') {
      return this.handleRpc(request, response);
    }
    if (request.method === 'GET') {
      return this.handleStatic(request, response);
    }
    response.writeHead(405, { allow: 'GET, POST' });
    response.end('Method Not Allowed');
  }

  private async handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (body === null) {
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Payload Too Large');
      return;
    }
    const answer = await this.rpc.handleRaw(body);
    if (answer === null) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(answer);
  }

  private async handleStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url === '/' || request.url === undefined ? '/index.html' : request.url;
    // `.${path}` keeps the URL relative to the static root — a leading slash
    // would make `resolve` discard the root entirely — and the boundary check
    // below rejects anything that escapes it (`..` or sibling directories
    // that merely share a prefix).
    const root = resolve(this.staticDir);
    const safe = resolve(root, `.${path}`);
    if (safe !== root && !safe.startsWith(root + sep)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    try {
      const content = await readFile(safe);
      response.writeHead(200, { 'content-type': contentTypeFor(path) });
      response.end(content);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
    }
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Where the static UI lives: the `web/` directory next to the package root.
 * Works both when running from source (`src/web/…` → `<repo>/web`) and when
 * running the compiled output (`dist/src/web/…` → `<repo>/web`), by walking
 * up from this module until a `web/index.html` is found.
 */
function resolveStaticDir(): string {
  for (let dir = MODULE_DIR; ; dir = dirname(dir)) {
    const candidate = join(dir, 'web');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    if (dirname(dir) === dir) break; // filesystem root, give up
  }
  return join(process.cwd(), 'web');
}
