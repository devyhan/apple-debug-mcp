import { ExecError, Runner, defaultRunner, parseJson } from "./exec.js";

export const STEP_MODES = ["over", "in", "out"] as const;
export type StepMode = (typeof STEP_MODES)[number];

/** Upper bound for a single debug_continue wait (keeps the exec timeout sane). */
export const MAX_CONTINUE_WAIT_SEC = 600;

const TIMEOUT_RE = /timed?\s*-?\s*out|ETIMEDOUT/i;

/**
 * True when err looks like a client-side timeout: the exec wall-clock killed
 * the llmdb call, so the session may be wedged mid-op. llmdb daemon failures
 * always carry "Error: ..." on stderr; an ExecError with empty stdout+stderr
 * means the process died without a server response (timeout kill or crash).
 * ENOENT (missing binary) never counts.
 */
export function isDebugTimeoutError(err: unknown): boolean {
  if (err instanceof ExecError) {
    if (err.code === "ENOENT") return false;
    // NB: err.message embeds the argv (e.g. `wait --timeout 5`), so timeout
    // text is only meaningful in stdout/stderr — never in message.
    if (err.code === "ETIMEDOUT") return true;
    if (TIMEOUT_RE.test(err.stdout) || TIMEOUT_RE.test(err.stderr)) return true;
    return err.stdout.trim().length === 0 && err.stderr.trim().length === 0;
  }
  return err instanceof Error && TIMEOUT_RE.test(err.message);
}

/** Tolerant id extractor for `llmdb break list` JSON (shape varies by version). */
export function extractBreakpointIds(listJson: unknown): number[] {
  const ids = new Set<number>();
  const visit = (node: unknown): void => {
    if (typeof node === "number") {
      if (Number.isInteger(node) && node > 0) ids.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const el of node) visit(el);
      return;
    }
    if (typeof node === "object" && node !== null) {
      const o = node as Record<string, unknown>;
      for (const key of ["id", "breakpointId", "breakpoint_id", "bid"]) {
        const v = o[key];
        if (typeof v === "number" && Number.isInteger(v) && v > 0) ids.add(v);
      }
      for (const key of ["breakpoints", "breakPoints", "list", "ids", "breakpoint"]) {
        if (o[key] !== undefined) visit(o[key]);
      }
    }
  };
  visit(listJson);
  return [...ids].sort((a, b) => a - b);
}

/** Map common llmdb failures to an actionable hint; null when nothing matches. */
export function hintForDebugError(message: string): string | null {
  if (/no session with id|unknown session|session (not found|expired|closed|gone|invalid)/i.test(message)) {
    return "debug session expired; re-run debug_attach to open a new session, then retry";
  }
  if (/no process found|no such process|\bESRCH\b|exited|process .*(terminated|died|gone|not running)|target .*(terminated|died|gone|lost)/i.test(message)) {
    return "target process exited; relaunch it (app_launch) and debug_attach again";
  }
  if (/attach (refused|denied|failed)|not permitted|\bEPERM\b|get-task-allow|not debuggable|developer tools|DevToolsSecurity|authori[sz]ation denied|sec ?task/i.test(message)) {
    return "attach refused: use a Debug build with get-task-allow (Release/stock Apple apps refuse attach) and approve Developer Tools access, then retry debug_attach";
  }
  return null;
}

/** Minimal debugger surface the orchestrator needs (implemented by Llmdb, faked in tests). */
export interface DebugOps {
  stop(sessionId: string): Promise<unknown>;
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

/** One source breakpoint for breakSetMany (same fields as breakSet). */
export interface BreakpointSpec {
  file: string;
  line: number;
  condition?: string;
  hitCondition?: string;
}

export interface RunUntilOptions {
  /**
   * Delete the run-until breakpoint afterwards (best-effort): snapshot break
   * ids before, then delete ids that appeared. llmdb 0.2.0 has no cleanup
   * flag (verified `llmdb run-until --help`), so this composes the existing
   * break list/delete verbs. Default false (no behavior change).
   */
  cleanup?: boolean;
}

export interface RunUntilCleanup {
  /** Ids deleted as the run-until breakpoint ([] when none appeared). */
  removed: number[];
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("Invalid session_id (expected a non-empty string)");
  }
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
  /**
   * Per-session op mutex for cont/wait/interrupt: llmdb sessions are stateful
   * (running vs stopped), so overlapping resume/wait/pause calls from parallel
   * clients corrupt each other's results. One session's ops run strictly in
   * arrival order; different sessions proceed concurrently.
   */
  private readonly opChains = new Map<string, Promise<unknown>>();

  constructor(opts: { bin?: string; runner?: Runner; execTimeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "llmdb";
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  /** Run fn after the session's in-flight op settles (either way); never blocks other sessions. */
  private withOpMutex<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.opChains.get(sessionId) ?? Promise.resolve();
    const task = prev.then(fn, fn);
    const settled: Promise<unknown> = task.then(
      () => undefined,
      () => undefined,
    );
    this.opChains.set(sessionId, settled);
    void settled.then(() => {
      if (this.opChains.get(sessionId) === settled) this.opChains.delete(sessionId);
    });
    return task;
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
   * (verified `llmdb launch --help` — no bundle-id form, so debug_launch
   * composes simctl launch + attach for sim apps by bundle id instead of
   * inventing flags).
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
   * breakpoints (verified: `break set <location>` takes `<file>:<line>` only,
   * with no address form — see `llmdb break set --help`). Optional condition
   * (fire only when the expression is true) and hitCondition (fire on a
   * hit-count match, e.g. ">5" or "3").
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

  /**
   * Set several source breakpoints with one call (sequential `break set` —
   * llmdb 0.2.0 takes one location per invocation). Returns one result per
   * spec, in order. Aborts on the first failure, reporting its index.
   */
  async breakSetMany(sessionId: string, specs: BreakpointSpec[]): Promise<unknown[]> {
    assertSessionId(sessionId);
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new Error("Invalid breakpoints (expected a non-empty array)");
    }
    const results: unknown[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (typeof spec !== "object" || spec === null) {
        throw new Error(`breakpoint[${i}] failed: Invalid breakpoint (expected {file, line})`);
      }
      try {
        results.push(
          await this.breakSet(sessionId, spec.file, spec.line, {
            ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
            ...(spec.hitCondition !== undefined ? { hitCondition: spec.hitCondition } : {}),
          }),
        );
      } catch (err) {
        throw new Error(`breakpoint[${i}] failed: ${(err as Error).message}`);
      }
    }
    return results;
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
   * Delete several breakpoints by id with one call (sequential `break
   * delete` — llmdb 0.2.0 takes one id per invocation). Returns one result
   * per id, in order. Aborts on the first failure, reporting its index.
   */
  async breakDeleteMany(sessionId: string, ids: number[]): Promise<unknown[]> {
    assertSessionId(sessionId);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error("Invalid delete ids (expected a non-empty array)");
    }
    const results: unknown[] = [];
    for (let i = 0; i < ids.length; i++) {
      try {
        results.push(await this.breakDelete(sessionId, ids[i] as number));
      } catch (err) {
        throw new Error(`breakpoint[${i}] failed: ${(err as Error).message}`);
      }
    }
    return results;
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
    return this.withOpMutex(sessionId, async () => {
      const { stdout } = await this.run(
        this.bin,
        ["continue", "--wait", String(waitSec), "--session", sessionId],
        { timeoutMs: (waitSec + 30) * 1000 },
      );
      return parseJson<unknown>(stdout, "llmdb continue");
    });
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
  async runUntil(
    sessionId: string,
    file: string,
    line: number,
    waitSec = 60,
    opts: RunUntilOptions = {},
  ): Promise<unknown> {
    assertSessionId(sessionId);
    assertFileLine(file, line);
    assertWaitSec(waitSec);
    const cleanup = opts.cleanup === true;
    const before = cleanup ? await this.safeBreakIds(sessionId) : null;
    let result: unknown;
    try {
      const { stdout } = await this.run(
        this.bin,
        ["run-until", `${file}:${line}`, "--wait", String(waitSec), "--session", sessionId],
        { timeoutMs: (waitSec + 30) * 1000 },
      );
      result = parseJson<unknown>(stdout, "llmdb run-until");
    } catch (err) {
      if (cleanup) await this.cleanupRunUntilBreakpoint(sessionId, before);
      throw err;
    }
    if (!cleanup) return result;
    const removed = await this.cleanupRunUntilBreakpoint(sessionId, before);
    const summary: RunUntilCleanup = { removed };
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), cleanup: summary };
    }
    return { result, cleanup: summary };
  }

  /** Best-effort break-id snapshot; null when the list itself is unreadable. */
  private async safeBreakIds(sessionId: string): Promise<number[] | null> {
    try {
      return extractBreakpointIds(await this.breakList(sessionId));
    } catch {
      return null;
    }
  }

  /** Delete break ids that appeared since `before`; always best-effort, never throws. */
  private async cleanupRunUntilBreakpoint(sessionId: string, before: number[] | null): Promise<number[]> {
    if (before === null) return [];
    let after: number[];
    try {
      after = extractBreakpointIds(await this.breakList(sessionId));
    } catch {
      return [];
    }
    const known = new Set(before);
    const removed: number[] = [];
    for (const id of after) {
      if (known.has(id)) continue;
      try {
        await this.breakDelete(sessionId, id);
        removed.push(id);
      } catch {
        // The session may be gone (target terminated); the run-until result stands.
      }
    }
    return removed;
  }

  /**
   * Block until the session leaves `running` (stops or terminates). Pairs
   * with fire-and-forget continues. The exec timeout adds grace on top.
   */
  async wait(sessionId: string, timeoutSec = 60): Promise<unknown> {
    assertSessionId(sessionId);
    assertTimeoutSec(timeoutSec);
    return this.withOpMutex(sessionId, async () => {
      const { stdout } = await this.run(
        this.bin,
        ["wait", "--timeout", String(timeoutSec), "--session", sessionId],
        { timeoutMs: (timeoutSec + 30) * 1000 },
      );
      return parseJson<unknown>(stdout, "llmdb wait");
    });
  }

  /** Pause a running session; returns once stopped (llmdb default wait 10s). */
  async interrupt(sessionId: string, waitSec = 10): Promise<unknown> {
    assertSessionId(sessionId);
    assertWaitSec(waitSec);
    return this.withOpMutex(sessionId, async () => {
      const { stdout } = await this.run(
        this.bin,
        ["interrupt", "--wait", String(waitSec), "--session", sessionId],
        { timeoutMs: (waitSec + 30) * 1000 },
      );
      return parseJson<unknown>(stdout, "llmdb interrupt");
    });
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

  /** Detach (or terminate) a session; sessionId is always required. */
  async stop(sessionId: string): Promise<unknown> {
    assertSessionId(sessionId);
    const { stdout } = await this.run(this.bin, ["stop", "--session", sessionId], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<unknown>(stdout, "llmdb stop");
  }

  /** List active debug sessions across all agents on this host's daemon. */
  async sessions(): Promise<unknown> {
    const { stdout } = await this.run(this.bin, ["sessions"], { timeoutMs: this.execTimeoutMs });
    return parseJson<unknown>(stdout, "llmdb sessions");
  }
}
