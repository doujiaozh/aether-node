/**
 * LWW-Register (Last-Writer-Wins Register) — the simplest state-based CRDT.
 *
 * A register holds one opaque value plus an HLC timestamp. Merging two
 * registers picks the timestamp that is greater under the total HLC order,
 * so concurrent offline edits never conflict: whichever replica wins, every
 * node converges to the same choice thanks to the deterministic node-id
 * tiebreaker.
 */

import { compareHlc, zeroHlc, type HlcTimestamp, isHlcTimestamp } from './hlc.js';

/** Serialized form of a register value + its timestamp. */
export interface LwwRegisterState<T = unknown> {
  value: T;
  ts: HlcTimestamp;
}

/**
 * Stateless merge of two register states. `undefined` inputs are treated as
 * "no value on that side" so the caller can use optional lookups directly.
 * The merge is commutative, associative and idempotent.
 */
export function mergeRegisterStates<T = unknown>(
  a: LwwRegisterState<T> | undefined,
  b: LwwRegisterState<T> | undefined,
): LwwRegisterState<T> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareHlc(a.ts, b.ts) >= 0 ? a : b;
}

/** Build a fresh register state from a local write. */
export function registerState<T>(value: T, ts: HlcTimestamp): LwwRegisterState<T> {
  return { value, ts };
}

/** The state a key holds before it has ever been written. */
export function emptyRegisterState(): LwwRegisterState {
  return { value: undefined, ts: zeroHlc() };
}

/** Structural check for values deserialized from untrusted JSON. */
export function isLwwRegisterState(value: unknown): value is LwwRegisterState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.hasOwnProperty('value') && isHlcTimestamp(v.ts);
}
