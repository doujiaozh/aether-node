/**
 * aether-node :: micro-vm :: sandbox execution contracts
 *
 * The micro-vm layer answers one question, safely:
 *
 *     "Here is some code the AI produced. Run it. Give me the result."
 *
 * "Safely" is enforced through an explicit, declarative ExecutionPolicy and
 * an isolation strategy chosen by the executor implementation. The types
 * below are deliberately independent of *how* isolation is achieved —
 * today a Worker thread, tomorrow WASM or a microVM, same contract.
 */

/** Supported code input. The skeleton speaks JavaScript/TypeScript-flavored ES. */
export type ExecLanguage = "javascript" | "expression";

/** The permission boundary for one execution. */
export interface ExecutionPolicy {
  /** Wall-clock budget before the run is cancelled. */
  readonly timeoutMs: number;
  /** Ceiling on resident memory for the guest, in MiB (best effort). */
  readonly memoryLimitMb: number;
  /** Guest may open network sockets. Defaults to `false` — always deny by default. */
  readonly network: boolean;
  /** Guest may touch the host filesystem. Defaults to `false`. */
  readonly filesystem: boolean;
  /** Maximum bytes captured from each stdio stream. */
  readonly maxStdioBytes: number;
}

/** Conservative defaults: deny everything, short timeout, tight memory. */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  timeoutMs: 5_000,
  memoryLimitMb: 64,
  network: false,
  filesystem: false,
  maxStdioBytes: 64 * 1024,
};

/** Code the AI (or any agent client) wants executed. */
export interface ExecRequest {
  /** Caller-chosen correlation id, echoed back untouched in the result. */
  readonly id: string;
  /** The program itself. Statements when language is "javascript",
   *  a single expression when "expression". */
  readonly code: string;
  /** Dialect of the `code` string. Defaults to "javascript". */
  readonly language?: ExecLanguage;
  /** Policy overrides, merged over the defaults. Everything else is denied. */
  readonly policy?: Partial<ExecutionPolicy>;
  /** Environment variables surfaced to the guest (never host secrets). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Machine-readable failure categories. */
export type ExecErrorCode =
  | "TIMEOUT"
  | "OUT_OF_MEMORY"
  | "POLICY_DENIED"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "INVALID_REQUEST";

export interface ExecError {
  readonly code: ExecErrorCode;
  /** Human-readable detail, safe to surface back to the model. */
  readonly message: string;
  /** Captured stderr, when any. */
  readonly stderr?: string;
}

/** Success shape. */
export interface ExecSuccess {
  readonly id: string;
  readonly ok: true;
  /** Whatever the guest's final expression resolved to (JSON-serializable). */
  readonly returnValue: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Failure shape. */
export interface ExecFailure {
  readonly id: string;
  readonly ok: false;
  readonly error: ExecError;
  readonly durationMs: number;
}

/** The one result type every executor must produce. */
export type ExecResult = ExecSuccess | ExecFailure;

/** Liveness probe answer. */
export interface SandboxHealth {
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly executor: string;
  /** True only when the executor provides genuine OS-level isolation. */
  readonly isolated: boolean;
  readonly detail?: string;
}
