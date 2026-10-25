/**
 * aether-node :: sync-engine :: Last-Write-Wins Register
 *
 * The simplest CRDT that is actually useful: a single value where the
 * write with the greatest HLC wins, ties broken by node id. It doubles as
 * the reference semantics for the document layer and as a template every
 * future CRDT type should follow.
 */

import { compareHlc } from "./clock.js";
import type { HlcTimestamp, JsonValue, LwwEntry } from "./types.js";

export interface LwwRegisterState {
  readonly hlc: HlcTimestamp;
  readonly value?: JsonValue;
}

/**
 * A single LWW register. Instances are pure values: methods return new
 * states rather than mutating, so merges never corrupt shared data.
 */
export class LwwRegister {
  private constructor(
    private readonly state: LwwRegisterState,
    private readonly _owner: string,
  ) {}

  /** Fabricate an empty register bound to a node (used for unseen keys). */
  static create(nodeId: string): LwwRegister {
    return new LwwRegister(
      { hlc: { wallTimeMs: 0, counter: 0, nodeId } },
      nodeId,
    );
  }

  /** Rebuild a register from a wire entry. */
  static fromEntry(entry: LwwEntry): LwwRegister {
    return new LwwRegister({ hlc: entry.hlc, value: entry.value }, entry.hlc.nodeId);
  }

  /** Apply a write, but only if it wins the ordering. Idempotent. */
  write(value: JsonValue | undefined, hlc: HlcTimestamp): LwwRegister {
    if (compareHlc(hlc, this.state.hlc) <= 0) return this;
    return new LwwRegister({ hlc, value }, hlc.nodeId);
  }

  /** Merge with another replica of the same register. Idempotent/commutative/associative. */
  merge(other: LwwRegister): LwwRegister {
    const cmp = compareHlc(other.state.hlc, this.state.hlc);
    if (cmp < 0) return this;
    if (cmp > 0) return other;
    // Deterministic tie-break is guaranteed by nodeId being part of the
    // total order, so `cmp === 0` means identical timestamps; prefer the
    // state whose value is defined.
    return other.state.value === undefined ? this : other;
  }

  get value(): JsonValue | undefined {
    return this.state.value;
  }

  get hlc(): HlcTimestamp {
    return this.state.hlc;
  }

  /** Serialize to the wire entry format. */
  toEntry(): LwwEntry {
    const entry: LwwEntry = { hlc: this.state.hlc };
    return this.state.value === undefined ? entry : { hlc: this.state.hlc, value: this.state.value };
  }

  get ownerNodeId(): string {
    return this._owner;
  }
}
