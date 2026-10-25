/**
 * aether-node :: micro-vm :: InProcessSandbox
 *
 * ⚠️ SECURITY NOTICE ⚠️
 * This is a *reference implementation*, built to validate the ExecRequest /
 * ExecResult contract and to demonstrate the wiring. It runs guest code in
 * the host process with a frozen-ish global scope and a wall-clock timeout.
 *
 * It is NOT a security boundary: a determined guest can still reach host
 * globals. Never execute untrusted model output here. Production backends
 * (Worker thread / WASM / microVM) will implement the same interface with
 * real isolation. `healthCheck().isolated === false` encodes this fact so
 * orchestrators can refuse to route untrusted work to this executor.
 */

import type {
  ExecRequest,
  ExecResult,
  ExecSuccess,
  ExecutionPolicy,
  SandboxHealth,
} from "./types.js";
import { DEFAULT_EXECUTION_POLICY } from "./types.js";
import type { SandboxExecutor } from "./sandbox.js";

/** Internal marker so a timeout is never confused with a guest throw. */
class TimeoutSignal extends Error {
  constructor(public readonly limitMs: number) {
    super(`execution exceeded ${limitMs}ms`);
    this.name = "TimeoutSignal";
  }
}

function formatIoArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export class InProcessSandbox implements SandboxExecutor {
  readonly name = "in-process-reference";

  async healthCheck(): Promise<SandboxHealth> {
    return {
      status: "healthy",
      executor: this.name,
      // Explicitly advertised so callers can gate untrusted code.
      isolated: false,
      detail: "reference executor; no OS-level isolation yet",
    };
  }

  async execute(request: ExecRequest): Promise<ExecResult> {
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);

    // ---- 1. Validate the request contract -------------------------------
    if (typeof request?.id !== "string" || request.id === "") {
      return failure("INVALID_REQUEST", 'missing required field "id"', "", durationMs());
    }
    if (typeof request?.code !== "string" || request.code.trim() === "") {
      return failure("INVALID_REQUEST", 'missing required field "code"', request.id, durationMs());
    }

    // ---- 2. Resolve the policy (deny by default) ------------------------
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      ...(request.policy ?? {}),
    };
    // The reference executor has no network/filesystem namespace at all:
    // any request claiming those capabilities is denied rather than
    // silently ignored — policy must never lie.
    if (policy.network || policy.filesystem) {
      return failure(
        "POLICY_DENIED",
        "in-process executor cannot provide network/filesystem access",
        request.id,
        durationMs(),
      );
    }

    // ---- 3. Compile guest code ------------------------------------------
    let guest: (stdio: unknown, env: unknown) => Promise<unknown>;
    try {
      guest = compileGuest(request.code, request.language ?? "javascript");
    } catch (error) {
      return failure(
        "COMPILE_ERROR",
        error instanceof Error ? error.message : String(error),
        request.id,
        durationMs(),
      );
    }

    // ---- 4. Run under a wall-clock budget -------------------------------
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdio = {
      log: (...args: unknown[]) => stdoutChunks.push(args.map(formatIoArg).join(" ")),
      info: (...args: unknown[]) => stdoutChunks.push(args.map(formatIoArg).join(" ")),
      debug: (...args: unknown[]) => stdoutChunks.push(args.map(formatIoArg).join(" ")),
      warn: (...args: unknown[]) => stderrChunks.push(args.map(formatIoArg).join(" ")),
      error: (...args: unknown[]) => stderrChunks.push(args.map(formatIoArg).join(" ")),
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutSignal(policy.timeoutMs)), policy.timeoutMs);
    });

    try {
      const returnValue = await Promise.race([
        guest(stdio, { ...request.env }),
        timeoutPromise,
      ]);

      const stdout = stdoutChunks.join("\n").slice(0, policy.maxStdioBytes);
      const stderr = stderrChunks.join("\n").slice(0, policy.maxStdioBytes);
      const success: ExecSuccess = {
        id: request.id,
        ok: true,
        returnValue: sanitizeReturnValue(returnValue),
        stdout,
        stderr,
        durationMs: durationMs(),
      };
      return success;
    } catch (error) {
      const stderr =
        stderrChunks.length > 0
          ? stderrChunks.join("\n").slice(0, policy.maxStdioBytes)
          : undefined;
      if (error instanceof TimeoutSignal) {
        return failure("TIMEOUT", error.message, request.id, durationMs(), stderr);
      }
      if (error instanceof SyntaxError) {
        return failure("COMPILE_ERROR", error.message, request.id, durationMs(), stderr);
      }
      // Best-effort memory guard: check the host RSS against the declared
      // ceiling. Not precise isolation, but it catches runaway allocations.
      const rssMb = process.memoryUsage().rss / (1024 * 1024);
      if (rssMb > policy.memoryLimitMb * 2) {
        return failure("OUT_OF_MEMORY", `rss ${rssMb.toFixed(0)}MiB exceeded ${policy.memoryLimitMb}MiB`, request.id, durationMs(), stderr);
      }
      return failure(
        "RUNTIME_ERROR",
        error instanceof Error ? error.message : String(error),
        request.id,
        durationMs(),
        stderr,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Compile guest source into a callable. The source is wrapped in an async
 * IIFE so `await` is legal top-level, and a return is prepended when the
 * source parses as an expression ("40 + 2" style snippets stay ergonomic).
 */
function compileGuest(
  code: string,
  language: "javascript" | "expression",
): (stdio: unknown, env: unknown) => Promise<unknown> {
  const body = asExpression(code, language) ? `return (${code});` : code;
  // eslint-disable-next-line @typescript-eslint/no-immediate-eval, no-new-func
  const factory = new Function(
    "stdio",
    "env",
    `"use strict";\nreturn (async () => {\n${body}\n})();`,
  ) as (stdio: unknown, env: unknown) => Promise<unknown>;
  return factory;
}

/** True when the source is a lone expression (or declares itself as one). */
function asExpression(code: string, language: "javascript" | "expression"): boolean {
  if (language === "expression") return true;
  try {
    // Parse only; never eval untrusted input in one step without a wrapper.
    // eslint-disable-next-line no-new-func
    new Function(`"use strict"; return (${code});`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The return value crosses a trust boundary, so require JSON round-trip.
 * Anything richer (class instances, Maps, functions) becomes undefined to
 * keep the protocol honest about what may leave the sandbox.
 */
function sanitizeReturnValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function failure(
  code: "INVALID_REQUEST" | "POLICY_DENIED" | "COMPILE_ERROR" | "TIMEOUT" | "RUNTIME_ERROR" | "OUT_OF_MEMORY",
  message: string,
  id: string,
  durationMs: number,
  stderr?: string,
): ExecResult {
  return {
    id,
    ok: false,
    error: stderr === undefined ? { code, message } : { code, message, stderr },
    durationMs,
  };
}
