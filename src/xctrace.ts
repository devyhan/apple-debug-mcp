import { existsSync } from "node:fs";
import { Runner, defaultRunner } from "./exec.js";

/** Upper bound for a single profile_trace recording (CI-safe). */
export const MAX_TRACE_SEC = 60;

/** Upper bound for startup grace added on top of the recording (timeout sanity). */
export const MAX_STARTUP_GRACE_SEC = 600;

export interface TraceOptions {
  /** Template name (e.g. "Time Profiler") or path. Defaults to "Time Profiler". */
  template?: string;
  /** Attach to one process (pid or name). Mutually exclusive with allProcesses. */
  attach?: string | number;
  /** Record every process on the device. Defaults to true when attach is omitted. */
  allProcesses?: boolean;
  /** Recording length in seconds, (0, 60]. Defaults to 5. */
  timeLimitSec?: number;
  /** Extra startup grace beyond timeLimitSec for template/device prep. Defaults to 180s. */
  startupGraceSec?: number;
}

export interface TraceResult {
  /** The .trace path xctrace wrote. */
  path: string;
  /** Template actually used. */
  template: string;
}

function assertTemplate(template: string): void {
  if (template.trim().length === 0) throw new Error("Invalid template (expected a non-empty string)");
}

function assertTimeLimitSec(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TRACE_SEC) {
    throw new Error(`Invalid duration_sec ${value} (expected a number in (0, ${MAX_TRACE_SEC}])`);
  }
}

function assertOutputPath(output: string): void {
  if (output.trim().length === 0) throw new Error("Invalid output path (expected a non-empty string)");
}

/**
 * CPU profiling on a simulator via `xcrun xctrace record` (Time Profiler by
 * default). System-tool only: no new npm dependency.
 *
 * Empirically `--attach <pid|name>` cannot resolve simulator app processes
 * ("Cannot find process …"), so recordings default to `--all-processes`;
 * attach is passed through for hosts/templates where it works and xctrace's
 * own error surfaces when it does not.
 */
export class XCTrace {
  private readonly run: Runner;
  private readonly exists: (p: string) => boolean;

  constructor(opts: { runner?: Runner; exists?: (p: string) => boolean } = {}) {
    this.run = opts.runner ?? defaultRunner;
    this.exists = opts.exists ?? existsSync;
  }

  async record(udid: string, output: string, opts: TraceOptions = {}): Promise<TraceResult> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    assertOutputPath(output);
    const template = opts.template ?? "Time Profiler";
    assertTemplate(template);
    const timeLimitSec = opts.timeLimitSec ?? 5;
    assertTimeLimitSec(timeLimitSec);
    const attach = opts.attach;
    const allProcesses = opts.allProcesses ?? attach === undefined;
    if (attach !== undefined && opts.allProcesses === true) {
      throw new Error("Pass either attach or allProcesses, not both");
    }
    if (attach === undefined && !allProcesses) {
      throw new Error("Nothing to record: pass attach or set allProcesses");
    }

    const args = ["xctrace", "record", "--template", template, "--device", udid];
    if (attach !== undefined) args.push("--attach", String(attach));
    else args.push("--all-processes");
    args.push("--time-limit", `${timeLimitSec}s`, "--no-prompt", "--output", output);
    const startupGraceSec = Math.min(opts.startupGraceSec ?? 180, MAX_STARTUP_GRACE_SEC);
    const timeoutMs = (timeLimitSec + startupGraceSec) * 1000;
    await this.run("xcrun", args, { timeoutMs });
    if (!this.exists(output)) throw new Error(`xctrace succeeded but output not found: ${output}`);
    return { path: output, template };
  }
}
