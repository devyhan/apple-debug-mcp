import { BoundedOptions, BoundedResult, DEFAULT_BOUND_MAX_CHARS, runBounded } from "./exec.js";

/** Injectable bounded runner so unit tests can stub `xcrun` (defaults to runBounded). */
export type BoundedRunner = (bin: string, args: string[], opts: BoundedOptions) => Promise<BoundedResult>;

/** `log stream --level` values. */
export type LogLevel = "default" | "info" | "debug";

export interface StreamOptions {
  predicate?: string;
  /** Process-name shorthand; builds `process == "<name>"`, ANDed with predicate. */
  process?: string;
  /** Level filter, passed as `--level`. Defaults to "default". */
  level?: LogLevel;
  /** Wall-clock capture window, (0, 60]. Defaults to 10. Stream always ends by timeout. */
  timeoutSec?: number;
  maxChars?: number;
}

export interface ShowOptions {
  /** Historical window, e.g. "30s", "5m", "2h". Defaults to "1m". */
  last?: string;
  predicate?: string;
  /** Process-name shorthand; builds `process == "<name>"`, ANDed with predicate. */
  process?: string;
  /** Pass `--info` (informational messages). */
  info?: boolean;
  /** Pass `--debug` (debug messages). */
  debug?: boolean;
  /** Pass `--signpost` (signposts). */
  signpost?: boolean;
  timeoutMs?: number;
  maxChars?: number;
}

const LAST_RE = /^\d+[smh]$/;
export const MAX_STREAM_SEC = 60;

function assertTimeoutSec(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_STREAM_SEC) {
    throw new Error(`Invalid timeoutSec ${value} (expected a number in (0, ${MAX_STREAM_SEC}])`);
  }
}

function assertLast(value: string): void {
  if (!LAST_RE.test(value)) {
    throw new Error(`Invalid last ${JSON.stringify(value)} (expected e.g. "30s", "5m", "2h")`);
  }
}

function assertLevel(value: string): asserts value is LogLevel {
  if (value !== "default" && value !== "info" && value !== "debug") {
    throw new Error(`Invalid level ${JSON.stringify(value)} (expected "default", "info" or "debug")`);
  }
}

function assertProcess(value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid process ${JSON.stringify(value)} (expected a non-empty string)`);
  }
}

/**
 * Validate an NSPredicate-format filter: non-empty with balanced double-quotes
 * and balanced parentheses (parens inside quoted strings don't count).
 */
export function validatePredicate(predicate: string): void {
  if (predicate.trim().length === 0) {
    throw new Error(`Invalid predicate ${JSON.stringify(predicate)} (expected a non-empty string)`);
  }
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const ch of predicate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`Invalid predicate ${JSON.stringify(predicate)} (unbalanced parentheses)`);
      }
    }
  }
  if (inString) {
    throw new Error(`Invalid predicate ${JSON.stringify(predicate)} (unbalanced double-quotes)`);
  }
  if (depth !== 0) {
    throw new Error(`Invalid predicate ${JSON.stringify(predicate)} (unbalanced parentheses)`);
  }
}

/** Escape a value for embedding in a double-quoted predicate string literal. */
export function escapePredicateValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the `process == "<escaped>"` clause for a process-name shorthand. */
export function processPredicate(processName: string): string {
  return `process == "${escapePredicateValue(processName)}"`;
}

/** Combine the process shorthand with an explicit predicate into one --predicate value. */
function buildPredicate(predicate?: string, process?: string): string | undefined {
  const parts: string[] = [];
  if (process !== undefined) {
    assertProcess(process);
    parts.push(processPredicate(process));
  }
  if (predicate !== undefined) {
    validatePredicate(predicate);
    parts.push(predicate);
  }
  if (parts.length === 0) return undefined;
  return parts.join(" AND ");
}

/**
 * Simulator unified-log capture via `xcrun simctl spawn <udid> log ...`.
 * Empirically both `log show --last` (historical, exits on its own) and
 * `log stream` (runs until killed; stdout carries entries, stderr noise) work
 * in-sim, so both go through runBounded: show resolves on natural exit, stream
 * resolves with timedOut=true and whatever was captured in the window.
 */
export class SimLog {
  private readonly run: BoundedRunner;
  private readonly defaultMaxChars: number;
  private readonly showTimeoutMs: number;

  constructor(opts: { runner?: BoundedRunner; defaultMaxChars?: number; showTimeoutMs?: number } = {}) {
    this.run = opts.runner ?? runBounded;
    this.defaultMaxChars = opts.defaultMaxChars ?? DEFAULT_BOUND_MAX_CHARS;
    this.showTimeoutMs = opts.showTimeoutMs ?? 60_000;
  }

  async stream(udid: string, opts: StreamOptions = {}): Promise<BoundedResult> {
    const timeoutSec = opts.timeoutSec ?? 10;
    assertTimeoutSec(timeoutSec);
    const level: string = opts.level ?? "default";
    assertLevel(level);
    const args = ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", level];
    const combined = buildPredicate(opts.predicate, opts.process);
    if (combined !== undefined) args.push("--predicate", combined);
    return this.run("xcrun", args, {
      timeoutMs: timeoutSec * 1000,
      maxChars: opts.maxChars ?? this.defaultMaxChars,
      keep: "tail",
    });
  }

  async show(udid: string, opts: ShowOptions = {}): Promise<BoundedResult> {
    const last = opts.last ?? "1m";
    assertLast(last);
    const args = ["simctl", "spawn", udid, "log", "show", "--style", "compact", "--last", last];
    const combined = buildPredicate(opts.predicate, opts.process);
    if (combined !== undefined) args.push("--predicate", combined);
    if (opts.info === true) args.push("--info");
    if (opts.debug === true) args.push("--debug");
    if (opts.signpost === true) args.push("--signpost");
    return this.run("xcrun", args, {
      timeoutMs: opts.timeoutMs ?? this.showTimeoutMs,
      maxChars: opts.maxChars ?? this.defaultMaxChars,
      keep: "tail",
    });
  }
}
