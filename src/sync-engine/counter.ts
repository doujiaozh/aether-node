/**
 * PN-Counter (Positive-Negative Counter) — a state-based CRDT counter.
 *
 * Each replica keeps two grow-only maps: `p` (positive increments) and
 * `n` (negative increments), both keyed by replica id. The observed value is
 * sum(p) - sum(n); merging takes the element-wise max per replica, so every
 * replica converges to the same total no matter the order of merges.
 */

/** Serialized form of a PN-Counter. */
export interface PnCounterState {
  /** Per-replica positive increments. */
  p: Record<string, number>;
  /** Per-replica negative increments. */
  n: Record<string, number>;
}

/** Value observed by summing both maps. */
export function counterValue(state: PnCounterState): number {
  let total = 0;
  for (const node in state.p) total += state.p[node];
  for (const node in state.n) total -= state.n[node];
  return total;
}

/** Apply `by` (may be negative) on behalf of `node`. Returns a new state. */
export function counterApply(
  state: PnCounterState,
  node: string,
  by: number,
): PnCounterState {
  if (!Number.isFinite(by)) {
    throw new Error(`PN-Counter delta must be a finite number, got ${by}`);
  }
  const next: PnCounterState = { p: { ...state.p }, n: { ...state.n } };
  if (by >= 0) {
    next.p[node] = (next.p[node] ?? 0) + by;
  } else {
    next.n[node] = (next.n[node] ?? 0) - by;
  }
  return next;
}

function maxMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const node in b) {
    const av = out[node] ?? 0;
    const bv = b[node];
    out[node] = av >= bv ? av : bv;
  }
  return out;
}

/**
 * State merge of two counters: element-wise max per replica across `p` and `n`.
 * Commutative, associative, idempotent.
 */
export function mergeCounterStates(
  a: PnCounterState | undefined,
  b: PnCounterState | undefined,
): PnCounterState | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === b) return a;
  return { p: maxMaps(a.p, b.p), n: maxMaps(a.n, b.n) };
}

/** Empty counter state. */
export function emptyCounterState(): PnCounterState {
  return { p: {}, n: {} };
}

/** Structural check for values deserialized from untrusted JSON. */
export function isPnCounterState(value: unknown): value is PnCounterState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isNumberMap(v.p) && isNumberMap(v.n);
}

function isNumberMap(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object') return false;
  for (const key in value as Record<string, unknown>) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false;
  }
  return true;
}
