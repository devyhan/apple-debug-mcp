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

function assertThread(thread: number): void {
  if (!Number.isInteger(thread) || thread <= 0) {
    throw new Error(`Invalid thread ${String(thread)} (expected a positive integer thread id)`);
  }
}

function assertRef(ref: number): void {
  if (!Number.isInteger(ref) || ref <= 0) {
    throw new Error(`Invalid ref ${String(ref)} (expected a non-zero variablesReference integer)`);
  }
}

function assertTarget(target: string): void {
  if (target.trim().length === 0) throw new Error("Invalid target (expected a non-empty string)");
}

function assertValue(value: string): void {
  if (value.length === 0) throw new Error("Invalid value (expected a non-empty string)");
}

function assertBreakId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid breakpoint id ${String(id)} (expected a positive integer)`);
  }
}

function assertFilter(filter: string): void {
  if (filter.trim().length === 0) throw new Error("Invalid exception filter (expected a non-empty string)");
}

function assertPath(path: string): void {
  if (path.trim().length === 0) throw new Error("Invalid path (expected a non-empty string)");
}

function assertTimeoutSec(timeoutSec: number): void {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_CONTINUE_WAIT_SEC) {
    throw new Error(`Invalid timeout ${String(timeoutSec)} (expected a number in (0, ${MAX_CONTINUE_WAIT_SEC}])`);
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

  /**
   * Launch a binary (or .app bundle) under lldb-dap; returns the new session
   * id plus the raw launch response. llmdb 0.2.0 takes a filesystem path only
   * (no bundle-id form — use app_launch + attach for sim apps by bundle id).
   */
  async launch(path: string, args: string[] = []): Promise<AttachResult> {
    assertPath(path);
    for (const arg of args) {
      if (typeof arg !== "string") throw new Error("Invalid args (expected an array of strings)");
    }
    const { stdout } = await this.run(this.bin, ["launch", path, ...args], { timeoutMs: this.execTimeoutMs });
    const response = parseJson<Record<string, unknown>>(stdout, "llmdb launch");
    if (typeof response["sessionId"] !== "string" || (response["sessionId"] as string).length === 0) {
      throw new Error(`llmdb launch returned no sessionId\n${stdout.slice(0, 500)}`);
    }
    return { sessionId: response["sessionId"] as string, response };
  }

  /** Diagnose the local llmdb environment (lldb-dap, socket dir, daemon). */
  async doctor(): Promise<unknown> {
    const { stdout } = await this.run(this.bin, ["doctor"], { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb doctor");
  }

  /** List threads in a stopped session. */
  async threads(sessionId: string): Promise<unknown> {
    assertSessionId(sessionId);
    const { stdout } = await this.run(this.bin, ["threads", "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb threads");
  }

  /**
   * Set a source breakpoint at file:line. llmdb 0.2.0 has no symbol
   * breakpoints. Optional condition (fire only when the expression is true)
   * and hitCondition (fire on a hit-count match, e.g. ">5" or "3").
   */
  async breakSet(
    sessionId: string,
    file: string,
    line: number,
    opts: { condition?: string; hitCondition?: string } = {},
  ): Promise<unknown> {
    assertSessionId(sessionId);
    assertFileLine(file, line);
    const args = ["break", "set", `${file}:${line}`];
    if (opts.condition !== undefined) {
      if (opts.condition.trim().length === 0) throw new Error("Invalid condition (expected a non-empty string)");
      args.push("--condition", opts.condition);
    }
    if (opts.hitCondition !== undefined) {
      if (opts.hitCondition.trim().length === 0) throw new Error("Invalid hit_condition (expected a non-empty string)");
      args.push("--hit-condition", opts.hitCondition);
    }
    args.push("--session", sessionId);
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb break set");
  }

  /** List breakpoints in a session. */
  async breakList(sessionId: string): Promise<unknown> {
    assertSessionId(sessionId);
    const { stdout } = await this.run(this.bin, ["break", "list", "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb break list");
  }

  /** Delete a breakpoint by id; returns the remaining breakpoints. */
  async breakDelete(sessionId: string, id: number): Promise<unknown> {
    assertSessionId(sessionId);
    assertBreakId(id);
    const { stdout } = await this.run(this.bin, ["break", "delete", String(id), "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb break delete");
  }

  /**
   * Stop on thrown exceptions. Pass filter ids to enable (e.g. swift_throw);
   * an empty list clears and reports what is available.
   */
  async breakException(sessionId: string, filters: string[] = []): Promise<unknown> {
    assertSessionId(sessionId);
    for (const filter of filters) assertFilter(filter);
    const { stdout } = await this.run(this.bin, ["break", "exception", ...filters, "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb break exception");
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

  /**
   * Structured backtrace, optionally depth-capped and/or for an explicit
   * thread id (default: the stopped thread; see threads() for ids).
   */
  async backtrace(sessionId: string, depth?: number, thread?: number): Promise<unknown> {
    assertSessionId(sessionId);
    const args = ["bt"];
    if (thread !== undefined) {
      assertThread(thread);
      args.push("--thread", String(thread));
    }
    if (depth !== undefined) {
      assertDepth(depth);
      args.push("--depth", String(depth));
    }
    args.push("--session", sessionId);
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb bt");
  }

  /** List a frame's variable scopes (Locals, Globals, Registers); expand a ref to read it. */
  async scopes(sessionId: string, frame = 0): Promise<unknown> {
    assertSessionId(sessionId);
    assertFrame(frame);
    const { stdout } = await this.run(this.bin, ["scopes", "--frame", String(frame), "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb scopes");
  }

  /**
   * Expand a structured value into its children by variablesReference (the
   * non-zero ref from a locals/scopes/expand entry). Takes a ref, not an
   * expression — use eval() to evaluate expressions.
   */
  async expand(sessionId: string, ref: number): Promise<unknown> {
    assertSessionId(sessionId);
    assertRef(ref);
    const { stdout } = await this.run(this.bin, ["expand", String(ref), "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb expand");
  }

  /**
   * Assign a new value to a variable during a stop. Target is a local name or
   * an expression like `self.count` / `arr[0]`; value is in the target's
   * language (e.g. 42, true, "hi").
   */
  async setVar(sessionId: string, target: string, value: string, frame = 0): Promise<unknown> {
    assertSessionId(sessionId);
    assertTarget(target);
    assertValue(value);
    assertFrame(frame);
    const { stdout } = await this.run(
      this.bin,
      ["set-var", target, value, "--frame", String(frame), "--session", sessionId],
      { timeoutMs: this.execTimeoutMs },
    );
    return parseJson<unknown>(stdout, "llmdb set-var");
  }

  /**
   * Print the target's captured stdout/stderr/console output. clear drains
   * the buffer so the next call returns only newer output.
   */
  async output(sessionId: string, clear = false): Promise<unknown> {
    assertSessionId(sessionId);
    const args = ["output"];
    if (clear) args.push("--clear");
    args.push("--session", sessionId);
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb output");
  }

  /**
   * Set a breakpoint at file:line and continue; returns when it hits (or the
   * target terminates). The exec timeout adds grace on top of waitSec.
   */
  async runUntil(sessionId: string, file: string, line: number, waitSec = 60): Promise<unknown> {
    assertSessionId(sessionId);
    assertFileLine(file, line);
    assertWaitSec(waitSec);
    const { stdout } = await this.run(
      this.bin,
      ["run-until", `${file}:${line}`, "--wait", String(waitSec), "--session", sessionId],
      { timeoutMs: (waitSec + 30) * 1000 },
    );
    return parseJson<unknown>(stdout, "llmdb run-until");
  }

  /**
   * Block until the session leaves `running` (stops or terminates). Pairs
   * with fire-and-forget continues. The exec timeout adds grace on top.
   */
  async wait(sessionId: string, timeoutSec = 60): Promise<unknown> {
    assertSessionId(sessionId);
    assertTimeoutSec(timeoutSec);
    const { stdout } = await this.run(
      this.bin,
      ["wait", "--timeout", String(timeoutSec), "--session", sessionId],
      { timeoutMs: (timeoutSec + 30) * 1000 },
    );
    return parseJson<unknown>(stdout, "llmdb wait");
  }

  /** Pause a running session; returns once stopped (llmdb default wait 10s). */
  async interrupt(sessionId: string, waitSec = 10): Promise<unknown> {
    assertSessionId(sessionId);
    assertWaitSec(waitSec);
    const { stdout } = await this.run(
      this.bin,
      ["interrupt", "--wait", String(waitSec), "--session", sessionId],
      { timeoutMs: (waitSec + 30) * 1000 },
    );
    return parseJson<unknown>(stdout, "llmdb interrupt");
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
