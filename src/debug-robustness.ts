/**
 * D1.1 debug robustness (TS-side only; the llmdb binary is external).
 *
 * Gate: nothing changes unless `SIM_MCP_DEBUG_ROBUSTNESS=1` (default OFF,
 * zero behavior change when unset). All helpers are fail-soft: they never
 * throw and return a conservative default on unexpected input.
 *
 * Two fixes, both needed because llmdb has no state query verb:
 * 1. Last-known-state tracking (attach marks stopped) so interrupt on an
 *    already-stopped session returns an informative ok instead of timing
 *    out and auto-stopping.
 * 2. Error classification distinguishing wait-elapsed (llmdb responded that
 *    the wait expired with no stop; structured ok, no auto-stop) from
 *    wedged-timeout (exec wall-clock killed the call; keep auto-stop).
 */

export const DEBUG_ROBUSTNESS_ENV = "SIM_MCP_DEBUG_ROBUSTNESS";

export function debugRobustnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return env[DEBUG_ROBUSTNESS_ENV] === "1";
  } catch {
    return false;
  }
}

export type DebugKnownState = "stopped" | "running" | "unknown";

/** Last-known debugger state per session id. In-memory only; never throws. */
export class DebugStateTracker {
  private readonly states = new Map<string, DebugKnownState>();

  /** Attach lands stopped; trust an explicit state field when present. */
  markAttached(sessionId: string, response?: unknown): void {
    try {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
      const s = extractDebugState(response);
      this.states.set(sessionId, s === "unknown" ? "stopped" : s);
    } catch {
      // fail-soft: tracking must never break the tool path.
    }
  }

  /** Launch state comes from the response only; never assume. */
  markLaunched(sessionId: string, response?: unknown): void {
    try {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
      this.states.set(sessionId, extractDebugState(response));
    } catch {
      // fail-soft: tracking must never break the tool path.
    }
  }

  /** Refresh from a cont/wait/interrupt/step/run-until result; unknown keeps the old value. */
  updateFromResult(sessionId: string, result: unknown): void {
    try {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
      if (isWaitElapsedResponse(result)) {
        this.states.set(sessionId, "running");
        return;
      }
      if (isAlreadyStoppedResponse(result)) {
        this.states.set(sessionId, "stopped");
        return;
      }
      const s = extractDebugState(result);
      if (s !== "unknown") this.states.set(sessionId, s);
    } catch {
      // fail-soft: tracking must never break the tool path.
    }
  }

  get(sessionId: string): DebugKnownState {
    try {
      return this.states.get(sessionId) ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  clear(sessionId: string): void {
    try {
      this.states.delete(sessionId);
    } catch {
      // fail-soft.
    }
  }
}

/** Tolerant state extractor for llmdb JSON (field names vary; OPEN PROBE in the spec). */
export function extractDebugState(response: unknown): DebugKnownState {
  try {
    if (typeof response !== "object" || response === null) return "unknown";
    const o = response as Record<string, unknown>;
    const raw = o["state"] ?? o["status"];
    if (typeof raw !== "string") return "unknown";
    const s = raw.trim().toLowerCase();
    if (s === "stopped") return "stopped";
    if (s === "running") return "running";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Phrasing for "the wait expired, the target is still running" (daemon responded). */
const WAIT_ELAPSED_RE = /wait\s*elapsed|no\s*stop|still\s*running|wait\s*expired|waited?\s*out/i;

/**
 * True when a SUCCESSFUL llmdb JSON response means wait-elapsed (no stop).
 * Conservative: needs an explicit flag or wait-elapsed phrasing; a bare
 * running state alone does not count.
 */
export function isWaitElapsedResponse(result: unknown): boolean {
  try {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
    const o = result as Record<string, unknown>;
    for (const k of ["waitElapsed", "wait_elapsed", "timedOut", "didTimeout"]) {
      if (o[k] === true) return true;
    }
    const reason = [o["stopReason"], o["stop_reason"], o["reason"], o["message"], o["detail"], o["error"]]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if (WAIT_ELAPSED_RE.test(reason)) return true;
    if (typeof o["state"] === "string" && (o["state"] as string).toLowerCase() === "running") {
      return /timed?\s*-?\s*out|elapsed/i.test(JSON.stringify(o).slice(0, 2000));
    }
    return false;
  } catch {
    return false;
  }
}

/** True when a result (real or synthetic) means already-stopped. */
export function isAlreadyStoppedResponse(result: unknown): boolean {
  try {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
    const o = result as Record<string, unknown>;
    return o["alreadyStopped"] === true || o["already_stopped"] === true;
  } catch {
    return false;
  }
}

const ALREADY_STOPPED_RE =
  /already\s*(stopped|paused|interrupted)|not\s*currently\s*running|not\s*running|no\s*running\s*(process|target|session)|session\s*(is\s*)?already\s*stopped/i;

function execOutput(err: unknown): { code: unknown; out: string } | null {
  // Structural read (no instanceof import): ExecError carries code/stdout/stderr.
  if (typeof err !== "object" || err === null) return null;
  const o = err as Record<string, unknown>;
  if (typeof o["stdout"] !== "string" || typeof o["stderr"] !== "string") return null;
  return { code: o["code"], out: `${o["stdout"] as string}\n${o["stderr"] as string}` };
}

/**
 * True when err is a wait-elapsed FAILURE: the llmdb daemon responded
 * (non-empty output with an Error: body or explicit flag) that the wait
 * expired. Wedged calls (ETIMEDOUT, empty output, killed without a server
 * response) return false so they keep auto-stop.
 */
export function isWaitElapsedError(err: unknown): boolean {
  try {
    const exec = execOutput(err);
    if (exec !== null) {
      if (exec.code === "ENOENT" || exec.code === "ETIMEDOUT") return false;
      if (exec.out.trim().length === 0) return false;
      if (/"(waitElapsed|wait_elapsed|timedOut|didTimeout)"\s*:\s*true/.test(exec.out)) return true;
      if (!/Error:/.test(exec.out)) return false;
      // Measured live shape (llmdb daemon responded, exit code 1): the
      // daemon's own event-wait expired, so the session is healthy.
      // "Error: DAP waitForEvent failed: timed out after 5.0s."
      if (/wait\s*for\s*event/i.test(exec.out) && /timed?\s*-?\s*out/i.test(exec.out)) return true;
      return WAIT_ELAPSED_RE.test(exec.out);
    }
    if (err instanceof Error) {
      // Bare "timed out" stays wedged; only explicit wait-elapsed phrasing counts.
      return /wait\s*elapsed|still\s*running|no\s*stop/i.test(err.message);
    }
    return false;
  } catch {
    return false;
  }
}

/** True when err means the session was already stopped (daemon responded). */
export function isAlreadyStoppedError(err: unknown): boolean {
  try {
    const exec = execOutput(err);
    if (exec !== null) {
      if (exec.code === "ENOENT" || exec.code === "ETIMEDOUT") return false;
      if (exec.out.trim().length === 0) return false;
      return ALREADY_STOPPED_RE.test(exec.out);
    }
    if (err instanceof Error) return ALREADY_STOPPED_RE.test(err.message);
    return false;
  } catch {
    return false;
  }
}

/** Structured ok payload for a wait-elapsed continue/interrupt/wait (no auto-stop). */
export function waitElapsedResult(op: string, detail?: string): Record<string, unknown> {
  try {
    const r: Record<string, unknown> = {
      state: "running",
      waitElapsed: true,
      op: typeof op === "string" && op.length > 0 ? op : "debug",
    };
    if (typeof detail === "string" && detail.length > 0) r["detail"] = detail.slice(0, 300);
    return r;
  } catch {
    return { state: "running", waitElapsed: true };
  }
}

/** Structured ok payload for interrupt skipped on an already-stopped session. */
export function alreadyStoppedResult(): Record<string, unknown> {
  try {
    return { state: "stopped", alreadyStopped: true, skipped: "interrupt-skipped-already-stopped" };
  } catch {
    return { state: "stopped", alreadyStopped: true };
  }
}
