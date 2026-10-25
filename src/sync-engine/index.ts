/**
 * aether-node :: sync-engine :: public API
 */

export type {
  ApplyResult,
  CrdtKey,
  CrdtSnapshot,
  HlcTimestamp,
  JsonValue,
  LwwEntry,
  Mergeable,
  NodeId,
  Op,
  OpKind,
  SyncEngineOptions,
  VectorClock,
} from "./types.js";

export { compareHlc, hlcToString, HybridLogicalClock, minHlc, parseHlc } from "./clock.js";
export { LwwRegister } from "./lww-register.js";
export type { LocalChange, NodeIdentity } from "./engine.js";
export { SyncEngine } from "./engine.js";
