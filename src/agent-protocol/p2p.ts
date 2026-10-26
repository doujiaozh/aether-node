/**
 * {@link P2PSyncNode} — one node of the aether-node peer-to-peer sync mesh.
 *
 * A node bundles three things: a CRDT replica ({@link SyncEngine}), the
 * JSON-RPC method surface ({@link registerSystemMethods}), and a WebSocket
 * transport ({@link WsRpcServer}) other peers connect to. Two nodes that end
 * up connected — in either direction — converge to the same state:
 *
 *  - on connect, the dialing side immediately exchanges full `export()`
 *    states with the peer: it pushes its own state via `sync.importState`
 *    and pulls the peer's via `sync.getState` + local `merge`;
 *  - every `syncIntervalMs` (5 s by default) it repeats that comparison, so
 *    later edits on either side ripple across the mesh on the next tick.
 *
 * Because the underlying CRDT merges are commutative, associative and
 * idempotent, the periodic full-state exchange converges without conflict
 * and needs no coordination, vector clocks or rollback.
 */

import { MicroVm } from '../micro-vm/index.js';
import {
  SyncEngine,
  type MergeSummary,
  type SyncState,
} from '../sync-engine/index.js';
import { RpcClient } from './client.js';
import { registerSystemMethods } from './methods.js';
import { RpcServer } from './server.js';
import { WsRpcServer, WsRpcTransport } from './ws-transports.js';

/** Default peer state-comparison interval (the spec's 5-second cadence). */
export const DEFAULT_SYNC_INTERVAL_MS = 5_000;

export interface P2PSyncNodeOptions {
  /** Stable replica id (random when omitted, like {@link SyncEngine}). */
  nodeId?: string;
  /** Port to listen on; 0 asks the OS for an ephemeral port (default). */
  port?: number;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  /** Inject a replica — plain or {@link PersistentSyncEngine} — to back the node. */
  engine?: SyncEngine;
  /** Inject a micro-VM (a fresh one is created when omitted). */
  vm?: MicroVm;
  /** Peer state-comparison interval in ms (default 5 s). */
  syncIntervalMs?: number;
  /** Observer fired when a peer connection is established. */
  onPeer?: (peerUrl: string) => void;
  /** Observer fired after every peer comparison that applied new state. */
  onSync?: (summary: MergeSummary) => void;
  /** Observer for peer/link errors that would otherwise be swallowed. */
  onError?: (error: unknown) => void;
}

interface PeerLink {
  url: string;
  client: RpcClient;
  transport: WsRpcTransport;
  /** True while a comparison round is already in flight for this peer. */
  busy: boolean;
}

export class P2PSyncNode {
  readonly engine: SyncEngine;
  private readonly rpc = new RpcServer();
  private readonly server: WsRpcServer;
  private readonly syncIntervalMs: number;
  private readonly onPeer?: (peerUrl: string) => void;
  private readonly onSync?: (summary: MergeSummary) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly peers = new Map<string, PeerLink>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: P2PSyncNodeOptions = {}) {
    this.engine = options.engine ?? new SyncEngine({ nodeId: options.nodeId });
    // A persistent engine auto-flushes after every merge, so anything a peer
    // sends us lands on disk without extra wiring here.
    registerSystemMethods(this.rpc, {
      vm: options.vm ?? new MicroVm(),
      engine: this.engine,
    });
    this.server = new WsRpcServer(this.rpc, { port: options.port, host: options.host });
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.onPeer = options.onPeer;
    this.onSync = options.onSync;
    this.onError = options.onError;
  }

  /** Start listening and begin the periodic peer comparison. */
  async start(): Promise<{ host: string; port: number }> {
    const address = await this.server.listen();
    this.timer = setInterval(() => {
      for (const url of this.peers.keys()) {
        void this.compareWith(url);
      }
    }, this.syncIntervalMs);
    // A bare setInterval keeps the event loop alive; unref lets tests and
    // demos exit cleanly after close.
    this.timer.unref?.();
    return address;
  }

  /** `ws://host:port` other peers should connect to. */
  get url(): string {
    return this.server.url;
  }

  get nodeId(): string {
    return this.engine.nodeId;
  }

  /** Current value of register `key` on this node's replica. */
  get(key: string): unknown {
    return this.engine.get(key);
  }

  /** Current total of counter `key` on this node's replica. */
  counterValue(key: string): number {
    return this.engine.counterValue(key);
  }

  get peerUrls(): string[] {
    return [...this.peers.keys()];
  }

  /**
   * Dial a peer at `url` and exchange state with it immediately. Reconnecting
   * an already-connected peer is a no-op.
   */
  async connect(url: string): Promise<void> {
    if (this.peers.has(url)) return;
    const transport = new WsRpcTransport(url);
    const client = new RpcClient(transport);
    const peer: PeerLink = { url, client, transport, busy: false };
    this.peers.set(url, peer);
    try {
      await this.exchangeWith(peer);
      this.onPeer?.(url);
    } catch (error) {
      this.dropPeer(url);
      throw error;
    }
  }

  /** Run one explicit comparison round against every connected peer. */
  async syncOnce(): Promise<void> {
    await Promise.all([...this.peers.keys()].map((url) => this.compareWith(url)));
  }

  /** Stop the sync loop, drop all peers and close the listening socket. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const url of [...this.peers.keys()]) {
      this.dropPeer(url);
    }
    await this.server.close();
  }

  private dropPeer(url: string): void {
    const peer = this.peers.get(url);
    if (peer === undefined) return;
    this.peers.delete(url);
    peer.transport.close();
  }

  private async compareWith(url: string): Promise<void> {
    const peer = this.peers.get(url);
    if (peer === undefined || peer.busy) return;
    try {
      const summary = await this.exchangeWith(peer);
      if (summary.applied) this.onSync?.(summary);
    } catch (error) {
      // A persistently failing peer is dropped; the caller can reconnect.
      if (error instanceof Error) {
        this.onError?.(error);
      }
      this.dropPeer(url);
    }
  }

  /**
   * One bidirectional round: push our full state into the peer, then pull and
   * merge the peer's state. Both directions are idempotent CRDT merges, so
   * repeating this every interval cannot corrupt either side.
   */
  private async exchangeWith(peer: PeerLink): Promise<MergeSummary> {
    peer.busy = true;
    try {
      await peer.client.call('sync.importState', { state: this.engine.export() });
      const remote = await peer.client.call<SyncState>('sync.getState');
      return this.engine.merge(remote);
    } finally {
      peer.busy = false;
    }
  }
}
