import { Runner, defaultRunner, parseJson } from "./exec.js";

export const STEP_MODES = ["over", "in", "out"] as const;
export type StepMode = (typeof STEP_MODES)[number];

/** Upper bound for a single debug_continue wait (keeps the exec timeout sane). */
export const MAX_CONTINUE_WAIT_SEC = 600;

/** Minimal debugger surface the orchestrator needs (implemented by Llmdb, faked in tests). */
export interface DebugOps {
  stop(sessionId?: string): Promise<unknown>;
}

export interface AttachTarget {
  bundleId?: string;
  pid?: number;
}

export interface AttachResult {
  sessionId: string;
  /** Raw parsed attach response (state, stopReason, …). */
  response: unknown;
}

function assertSessionId(sessionId: string): void {
  if (sessionId.trim().length === 0) throw new Error("Invalid session_id (expected a non-empty string)");
}

function assertBundleId(bundleId: string): void {
  if (bundleId.trim().length === 0) throw new Error("Invalid bundle_id (expected a non-empty string)");
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid ${String(pid)} (expected a positive integer)`);
  }
}

function assertFileLine(file: string, line: number): void {
  if (file.trim().length === 0) throw new Error("Invalid file (expected a non-empty string)");
  if (!Number.isInteger(line) || line <= 0) {
    throw new Error(`Invalid line ${String(line)} (expected a positive integer)`);
  }
}

function assertWaitSec(waitSec: number): void {
  if (!Number.isFinite(waitSec) || waitSec <= 0 || waitSec > MAX_CONTINUE_WAIT_SEC) {
    throw new Error(`Invalid wait_sec ${String(waitSec)} (expected a number in (0, ${MAX_CONTINUE_WAIT_SEC}])`);
  }
}

function assertDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth <= 0) {
    throw new Error(`Invalid depth ${String(depth)} (expected a positive integer)`);
  }
}

function assertFrame(frame: number): void {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`Invalid frame ${String(frame)} (expected a non-negative integer)`);
  }
}

function assertExpr(expr: string): void {
  if (expr.trim().length === 0) throw new Error("Invalid expr (expected a non-empty string)");
}

function assertStepMode(mode: string): asserts mode is StepMode {
  if (!(STEP_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Invalid mode ${JSON.stringify(mode)} (expected ${STEP_MODES.join("|")})`);
  }
}

/**
 * Thin wrapper over the llmdb CLI (lldb-dap sessions for macOS / Simulator
 * processes). Argv shapes follow `llmdb --help` + per-verb help of llmdb
 * 0.2.0 exactly; every verb returns parsed JSON (default --format json).
 *
 * Simulator apps are plain macOS processes, so attach needs no debugserver —
 * but it does need a debuggable (get-task-allow) build plus the host's
 * one-time Developer-Tools authorization. Stock Apple apps refuse attach.
 */
export class Llmdb implements DebugOps {
  private readonly bin: string;
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { bin?: string; runner?: Runner; execTimeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "llmdb";
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.bin, ["--version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  /**
   * Attach to a running target — exactly one of bundleId (app in the booted
   * Simulator, resolved via simctl) or pid (host process). Returns the new
   * session id plus the raw attach response.
   */
  async attach(target: AttachTarget): Promise<AttachResult> {
    const { bundleId, pid } = target;
    if ((bundleId === undefined) === (pid === undefined)) {
      throw new Error("Pass exactly one of bundle_id or pid");
    }
    const args = ["attach"];
    if (bundleId !== undefined) {
      assertBundleId(bundleId);
      args.push("--app", bundleId);
    } else {
      assertPid(pid as number);
      args.push("--pid", String(pid));
    }
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    const response = parseJson<Record<string, unknown>>(stdout, "llmdb attach");
    if (typeof response["sessionId"] !== "string" || (response["sessionId"] as string).length === 0) {
      throw new Error(`llmdb attach returned no sessionId\n${stdout.slice(0, 500)}`);
    }
    return { sessionId: response["sessionId"] as string, response };
  }

  /** Set a source breakpoint at file:line. llmdb 0.2.0 has no symbol breakpoints. */
  async breakSet(sessionId: string, file: string, line: number): Promise<unknown> {
    assertSessionId(sessionId);
    assertFileLine(file, line);
    const { stdout } = await this.run(this.bin, ["break", "set", `${file}:${line}`, "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb break set");
  }

  /**
   * Resume until the next stop, blocking up to waitSec (llmdb default 60).
   * The exec timeout adds grace on top: llmdb blocks server-side for the full
   * wait, so the runner must outlive it.
   */
  async cont(sessionId: string, waitSec = 60): Promise<unknown> {
    assertSessionId(sessionId);
    assertWaitSec(waitSec);
    const { stdout } = await this.run(
      this.bin,
      ["continue", "--wait", String(waitSec), "--session", sessionId],
      { timeoutMs: (waitSec + 30) * 1000 },
    );
    return parseJson<unknown>(stdout, "llmdb continue");
  }

  /** Structured backtrace for the stopped thread, optionally depth-capped. */
  async backtrace(sessionId: string, depth?: number): Promise<unknown> {
    assertSessionId(sessionId);
    const args = ["bt"];
    if (depth !== undefined) {
      assertDepth(depth);
      args.push("--depth", String(depth));
    }
    args.push("--session", sessionId);
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb bt");
  }

  /** Typed locals for a stack frame (default frame 0, the top frame). */
  async locals(sessionId: string, frame = 0): Promise<unknown> {
    assertSessionId(sessionId);
    assertFrame(frame);
    const { stdout } = await this.run(this.bin, ["locals", "--frame", String(frame), "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb locals");
  }

  /** Evaluate an expression in the context of a frame (default frame 0). */
  async eval(sessionId: string, expr: string, frame = 0): Promise<unknown> {
    assertSessionId(sessionId);
    assertExpr(expr);
    assertFrame(frame);
    const { stdout } = await this.run(
      this.bin,
      ["expr", expr, "--frame", String(frame), "--session", sessionId],
      { timeoutMs: this.execTimeoutMs },
    );
    return parseJson<unknown>(stdout, "llmdb expr");
  }

  /**
   * Step one source line: over (default) | in | out. Uses llmdb's own default
   * 30s wait (no --wait flag), so the default exec timeout always outlives it.
   */
  async step(sessionId: string, mode: string = "over"): Promise<unknown> {
    assertSessionId(sessionId);
    assertStepMode(mode);
    const flag = mode === "in" ? "--in" : mode === "out" ? "--out" : "--over";
    const { stdout } = await this.run(this.bin, ["step", flag, "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb step");
  }

  /**
   * Detach (or terminate) a session. sessionId may be omitted when only one
   * session is active, but lease-scoped callers always pass it.
   */
  async stop(sessionId?: string): Promise<unknown> {
    const args = ["stop"];
    if (sessionId !== undefined) {
      assertSessionId(sessionId);
      args.push("--session", sessionId);
    }
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb stop");
  }

  /** List active debug sessions across all agents on this host's daemon. */
  async sessions(): Promise<unknown> {
    const { stdout } = await this.run(this.bin, ["sessions"], { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb sessions");
  }
}
