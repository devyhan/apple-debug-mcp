import { DEFAULT_BOUND_MAX_CHARS, runBounded, tailTruncationMarker } from "./exec.js";
import type { BoundedResult } from "./exec.js";
import type { LogOps } from "./logops.js";
import { MAX_STREAM_SEC } from "./simlog.js";
import type { BoundedRunner, ShowOptions, StreamOptions } from "./simlog.js";

/**
 * Real-device log capture via the go-ios syslog relay
 * (`ios syslog --udid=<udid>`), through runBounded with the same
 * timeout/maxChars/tail semantics as SimLog.stream, so `timedOut/truncated`
 * keep their meaning and the sim_log_* response shapes are unchanged.
 *
 * Semantic differences from sim (documented, never silent):
 * - The relay is live-only: `show` (--last history) has no device equivalent
 *   and fails with stream-instead guidance.
 * - NSPredicate syntax is NOT supported: `predicate`/`process` become
 *   client-side substring/regex line filters applied after capture.
 * - `level` is rejected: silently ignoring a level filter would mislead.
 */
export class RealSyslog implements LogOps {
  private readonly run: BoundedRunner;
  private readonly iosBin: string;
  private readonly defaultMaxChars: number;

  constructor(opts: { runner?: BoundedRunner; iosBin?: string; defaultMaxChars?: number } = {}) {
    this.run = opts.runner ?? runBounded;
    this.iosBin = opts.iosBin ?? "ios";
    this.defaultMaxChars = opts.defaultMaxChars ?? DEFAULT_BOUND_MAX_CHARS;
  }

  async stream(udid: string, opts: StreamOptions = {}): Promise<BoundedResult> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    const timeoutSec = opts.timeoutSec ?? 10;
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_STREAM_SEC) {
      throw new Error(`Invalid timeoutSec ${timeoutSec} (expected a number in (0, ${MAX_STREAM_SEC}])`);
    }
    if (opts.level !== undefined && opts.level !== "default") {
      throw new Error(
        `sim_log_stream level ${JSON.stringify(opts.level)} is not supported on real devices: ` +
          `the go-ios syslog relay has no level filter. Omit level.`,
      );
    }
    const maxChars = opts.maxChars ?? this.defaultMaxChars;
    const filters = buildLineFilters(opts.predicate, opts.process);
    const captured = await this.run(this.iosBin, ["syslog", `--udid=${udid}`], {
      timeoutMs: timeoutSec * 1000,
      maxChars,
      keep: "tail",
    });
    const filtered = applyLineFilters(captured.stdout, filters);
    if (filtered.length <= maxChars) {
      return { stdout: filtered, truncated: captured.truncated, timedOut: captured.timedOut };
    }
    return {
      stdout: tailTruncationMarker(filtered.length - maxChars) + filtered.slice(-maxChars),
      truncated: true,
      timedOut: captured.timedOut,
    };
  }

  async show(_udid: string, _opts: ShowOptions = {}): Promise<BoundedResult> {
    throw new Error(
      "sim_log_show has no real-device equivalent: the go-ios syslog relay is live-only (no --last history). " +
        "Use sim_log_stream with a timeout_sec window instead.",
    );
  }
}

/** One line predicate; a line survives only when every filter matches. */
type LineFilter = (line: string) => boolean;

/**
 * `process` shorthand ⇒ literal substring filter. `predicate` ⇒ best-effort
 * `process == "X"` substring extraction; when no such clause is present the
 * whole predicate is a full-text regex, falling back to a literal substring
 * when it is invalid as a regex.
 */
function buildLineFilters(predicate?: string, process?: string): LineFilter[] {
  const filters: LineFilter[] = [];
  if (process !== undefined) {
    if (process.trim().length === 0) {
      throw new Error(`Invalid process ${JSON.stringify(process)} (expected a non-empty string)`);
    }
    filters.push((line) => line.includes(process));
  }
  if (predicate !== undefined) {
    if (predicate.trim().length === 0) {
      throw new Error(`Invalid predicate ${JSON.stringify(predicate)} (expected a non-empty string)`);
    }
    const extracted = extractProcessClauses(predicate);
    if (extracted.length > 0) {
      for (const name of extracted) filters.push((line) => line.includes(name));
    } else {
      filters.push(compileTextFilter(predicate));
    }
  }
  return filters;
}

function extractProcessClauses(predicate: string): string[] {
  const names: string[] = [];
  const re = /process\s*==\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(predicate)) !== null) {
    const name = match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (name.length > 0) names.push(name);
  }
  return names;
}

function compileTextFilter(predicate: string): LineFilter {
  try {
    const re = new RegExp(predicate);
    return (line) => re.test(line);
  } catch {
    return (line) => line.includes(predicate);
  }
}

function applyLineFilters(stdout: string, filters: LineFilter[]): string {
  if (filters.length === 0) return stdout;
  return stdout
    .split("\n")
    .filter((line) => filters.every((f) => f(line)))
    .join("\n");
}
