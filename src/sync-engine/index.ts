/**
 * sync-engine — CRDT replication core of aether-node.
 *
 * Everything needed to keep a set of independent, possibly-offline replicas
 * convergent without a central server: HLC timestamps, LWW-Registers,
 * PN-Counters, and the {@link SyncEngine} that owns a local replica.
 */

export { HlcClock, compareHlc, zeroHlc, isHlcTimestamp, type HlcTimestamp } from './hlc.js';
export {
  mergeRegisterStates,
  registerState,
  emptyRegisterState,
  isLwwRegisterState,
  type LwwRegisterState,
} from './lww-register.js';
export {
  counterValue,
  counterApply,
  mergeCounterStates,
  emptyCounterState,
  isPnCounterState,
  type PnCounterState,
} from './counter.js';
export {
  SyncEngine,
  SyncImportError,
  assertSyncState,
  SYNC_STATE_FORMAT,
  type SyncState,
  type SyncEngineOptions,
  type MergeSummary,
} from './engine.js';
