/**
 * agent-protocol — the wire contract between AI agents and aether-node.
 *
 * JSON-RPC 2.0 over any {@link RpcTransport}: route requests on the server,
 * call methods from the client, and keep the protocol concerns (batching,
 * notifications, error envelopes) fully separated from the engine and VM.
 * Transports: loopback (in-process), HTTP, and WebSocket — the last one also
 * powers the {@link P2PSyncNode} peer-to-peer sync mesh.
 */

export { RpcError, RpcErrorCode, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcErrorBody, type RpcId } from './rpc.js';
export {
  RpcServer,
  type RpcHandler,
  type RpcMethodEntry,
  type RpcServerOptions,
} from './server.js';
export {
  RpcClient,
  RpcClientError,
  RpcClientTimeoutError,
  type RpcTransport,
  type RpcCallOptions,
} from './client.js';
export {
  LoopbackTransport,
  HttpRpcTransport,
  HttpRpcServer,
  type HttpRpcServerOptions,
} from './transports.js';
export {
  WsRpcServer,
  WsRpcTransport,
  type WsRpcServerOptions,
  type WsRpcTransportOptions,
} from './ws-transports.js';
export {
  P2PSyncNode,
  DEFAULT_SYNC_INTERVAL_MS,
  type P2PSyncNodeOptions,
} from './p2p.js';
export {
  registerSystemMethods,
  type SystemMethodsDeps,
  type VmExecuteParams,
  type SyncMergeParams,
} from './methods.js';
