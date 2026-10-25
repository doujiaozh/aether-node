/**
 * aether-node :: micro-vm :: SandboxExecutor interface
 *
 * Implementations of this interface are pluggable backends:
 *
 *   - InProcessSandbox   — zero-dependency reference implementation (NOT a
 *                          security boundary; wiring and testing only).
 *   - WorkerSandbox      — (planned) Node worker_thread with frozen globals.
 *   - WasmSandbox        — (planned) WASI guest with capability tokens.
 *   - FirecrackerSandbox — (planned) a true microVM for hostile code.
 *
 * The contract stay identical across all of them.
 */

import type { ExecRequest, ExecResult, SandboxHealth } from "./types.js";

export interface SandboxExecutor {
  /** Human-readable name of the isolation strategy. */
  readonly name: string;

  /**
   * Execute `request` inside the sandbox and resolve with a structured
   * result. Must never reject: every failure path returns an `ExecFailure`.
   * Must enforce the Timeout/Memory/Network/FS policy regardless of guest
   * cooperation.
   */
  execute(request: ExecRequest): Promise<ExecResult>;

  /** Cheap readiness probe. */
  healthCheck(): Promise<SandboxHealth>;
}
