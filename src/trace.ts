/**
 * M1 env-gated JSONL trace of lease actions and spawned commands.
 *
 * Gate: tracing only happens when `SIM_MCP_TRACE=1`. Destination:
 * `SIM_MCP_TRACE_FILE` (explicit file) wins, else `<traceDir>/trace.jsonl`
 * where traceDir is the constructor override, `SIM_MCP_TRACE_DIR`, or the
 * OS temp `sim-mcp-traces` default (same default as Config.traceDir).
 *
 * Privacy: raw UDIDs are replaced by a deterministic `udid:<12hex>` hash and
 * `key: secret` pairs become `[REDACTED]`; raw values never hit disk.
 *
 * Bounds: every string field is scrubbed then tail-capped (2000 chars) and
 * every JSONL line is below 4096 bytes. Writes use node:fs only, never the
 * injectable Runner (that would recurse). Every export is best-effort and
 * never throws, so callers need no try/catch.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Runner } from "./exec.js";

export const TRACE_ENABLE_ENV = "SIM_MCP_TRACE";
export const TRACE_FILE_ENV = "SIM_MCP_TRACE_FILE";
export const TRACE_DIR_ENV = "SIM_MCP_TRACE_DIR";
export const TRACE_FILE_NAME = "trace.jsonl";
export const TRACE_FIELD_MAX_CHARS = 2000;
export const TRACE_EVENT_MAX_BYTES = 4096;
export const TRACE_ARGV_MAX_ENTRIES = 100;

export interface TraceEvent {
  t: number;
  leaseId: string;
  tool: string;
  summary: string;
  bin?: string;
  argv?: string[];
  extra?: unknown;
}

/** Master gate. Read per call (one env lookup) so tests can toggle it. */
export function isTraceEnabled(): boolean {
  return process.env[TRACE_ENABLE_ENV] === "1";
}

export function defaultTraceDir(): string {
  return path.join(os.tmpdir(), "sim-mcp-traces");
}

/** Resolve the JSONL file: explicit file > override dir > env dir > default dir. */
export function resolveTraceFile(dirOverride?: string): string {
  const file = process.env[TRACE_FILE_ENV];
  if (file !== undefined && file !== "") return file;
  const dir = dirOverride ?? process.env[TRACE_DIR_ENV] ?? defaultTraceDir();
  return path.join(dir === "" ? defaultTraceDir() : dir, TRACE_FILE_NAME);
}

/** Deterministic short hash for a UDID; the raw value is never persisted. */
export function scrubUdid(udid: string): string {
  return `udid:${createHash("sha256").update(udid, "utf8").digest("hex").slice(0, 12)}`;
}

const UDID_RUN_RE = /[0-9A-Fa-f-]{36}/g;
const SECRET_RE = /(password|token|authorization|bearer|api[-_]?key)\s*[:=]\s*\S+/gi;

/** Replace raw UDID runs with their hash and secrets with [REDACTED]. */
export function scrubText(text: string): string {
  return text.replace(UDID_RUN_RE, (m) => scrubUdid(m)).replace(SECRET_RE, "[REDACTED]");
}

/**
 * Scrub then tail-cap a field. The marker mirrors exec.tailTruncationMarker;
 * the copy is deliberate so trace.js stays runtime-standalone (exec.ts
 * re-exports withTrace, so a runtime exec import here would cycle).
 */
function capField(text: string, maxChars: number = TRACE_FIELD_MAX_CHARS): string {
  const scrubbed = scrubText(text);
  if (scrubbed.length <= maxChars) return scrubbed;
  return `…[truncated ${scrubbed.length - maxChars} chars]\n${scrubbed.slice(-maxChars)}`;
}

function sanitizeExtra(extra: unknown, depth = 0): unknown {
  if (typeof extra === "string") return capField(extra);
  if (depth >= 3) return Array.isArray(extra) || (extra !== null && typeof extra === "object") ? "[truncated]" : extra;
  if (Array.isArray(extra)) return extra.slice(0, 20).map((v) => sanitizeExtra(v, depth + 1));
  if (extra !== null && typeof extra === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra).slice(0, 20)) out[capField(k, 200)] = sanitizeExtra(v, depth + 1);
    return out;
  }
  return extra;
}

/** Serialize one event as a JSONL line, shrinking until it fits 4096 bytes. */
function toLine(event: TraceEvent): string {
  let summaryCap = TRACE_FIELD_MAX_CHARS;
  let includeExtra = event.extra !== undefined;
  for (;;) {
    const body: Record<string, unknown> = {
      t: event.t,
      leaseId: capField(event.leaseId, 200),
      tool: capField(event.tool, 200),
      summary: capField(event.summary, summaryCap),
    };
    if (event.bin !== undefined) body["bin"] = capField(event.bin, 200);
    if (event.argv !== undefined) body["argv"] = event.argv.slice(0, TRACE_ARGV_MAX_ENTRIES).map((a) => capField(a));
    if (includeExtra) body["extra"] = sanitizeExtra(event.extra);
    const line = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(line, "utf8") < TRACE_EVENT_MAX_BYTES) return line;
    if (includeExtra) {
      includeExtra = false;
      continue;
    }
    if (summaryCap > 100) {
      summaryCap = 100;
      continue;
    }
    return `${JSON.stringify({
      t: event.t,
      leaseId: capField(event.leaseId, 64),
      tool: capField(event.tool, 64),
      summary: "[trace event exceeded 4096B]",
    })}\n`;
  }
}

/** Append one JSONL line to a file. Never throws. */
export function appendTraceFile(file: string, event: TraceEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, toLine(event), "utf8");
  } catch {
    // Best-effort: callers must never observe a trace failure.
  }
}

/** Append one JSONL line to `<dir>/trace.jsonl`. Never throws. */
export function appendTrace(dir: string, event: TraceEvent): void {
  appendTraceFile(path.join(dir, TRACE_FILE_NAME), event);
}

/** Env-gated action hook called from Orchestrator.logAction. Never throws. */
export function traceHook(event: TraceEvent, dirOverride?: string): void {
  try {
    if (!isTraceEnabled()) return;
    appendTraceFile(resolveTraceFile(dirOverride), event);
  } catch {
    // Never throws.
  }
}

/** Env-gated exec hook: one JSONL line per spawn carrying bin+argv. Never throws. */
export function traceExec(input: { bin: string; argv: string[]; leaseId?: string; dirOverride?: string }): void {
  traceHook(
    {
      t: Date.now(),
      leaseId: input.leaseId ?? "exec",
      tool: "exec",
      summary: `${input.bin} ${input.argv.join(" ")}`.trim(),
      bin: input.bin,
      argv: input.argv,
    },
    input.dirOverride,
  );
}

/**
 * Wrap a Runner so each spawn appends one JSONL line (bin+argv) when tracing
 * is on. The call passes through untouched: same args, same result.
 */
export function withTrace(inner: Runner, opts?: { leaseId?: string }): Runner {
  return async (bin, args, execOpts) => {
    traceExec({ bin, argv: [...args], leaseId: opts?.leaseId });
    return inner(bin, args, execOpts);
  };
}
