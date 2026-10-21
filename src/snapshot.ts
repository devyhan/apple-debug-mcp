/**
 * M1 env-gated UI snapshots: describe payloads, tap echoes, shot links.
 *
 * Gate: nothing is written unless `SIM_MCP_SNAPSHOT=1` (default OFF, zero
 * behavior change when unset). Destination: `SIM_MCP_SNAPSHOT_DIR` or the
 * constructor-style override, else the OS temp `sim-mcp-snapshots` default
 * (mirrors trace.ts resolve precedence: override > env > default).
 *
 * Layout (mirrors data/traces/<run>/{describes,shots,trace}):
 *   <snapshotDir>/describes/<describe-id>.json  full or compact AX text
 *   <snapshotDir>/taps/<tap-id>.json            long tap outputs only
 *   <snapshotDir>/shots/<shot-id>.json          shot basename + describe link
 *
 * Trace linkage: every helper returns a small extra fragment whose ids name
 * the sidecar file (`<id>.json`), so the M1 trace line stays far below its
 * 2000-char field / 4096B line caps while the full bytes live on disk.
 *
 * Privacy: only the lease id is persisted, never the raw UDID (same posture
 * as trace.ts). Describe snapshots hold exactly the AX bytes already returned
 * in the MCP response; tap and shot sidecars are scrubbed with scrubText
 * because axe errors and screenshot basenames embed the raw UDID.
 *
 * Bounds: tap echoes inline up to TAP_ECHO_MAX_CHARS and spill to a sidecar
 * beyond that; sidecars cap at TAP_SIDECAR_MAX_CHARS. Describe snapshots are
 * already bounded by the axe 32MB maxBuffer upstream. Every export is
 * best-effort and never throws, so callers need no try/catch.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubText } from "./trace.js";

export const SNAPSHOT_ENABLE_ENV = "SIM_MCP_SNAPSHOT";
export const SNAPSHOT_DIR_ENV = "SIM_MCP_SNAPSHOT_DIR";
export const SNAPSHOT_DESCRIBES_SUBDIR = "describes";
export const SNAPSHOT_TAPS_SUBDIR = "taps";
export const SNAPSHOT_SHOTS_SUBDIR = "shots";
/** Tap output inlines into trace extra up to this; longer spills to a sidecar. */
export const TAP_ECHO_MAX_CHARS = 500;
/** Upper bound on bytes kept in a tap sidecar file. */
export const TAP_SIDECAR_MAX_CHARS = 32 * 1024;
/** Cap on tracked leases for shot->describe linkage (FIFO eviction). */
export const LAST_DESCRIBE_MAX_LEASES = 1000;

/** Master gate. Read per call (one env lookup) so tests can toggle it. */
export function isSnapshotEnabled(): boolean {
  return process.env[SNAPSHOT_ENABLE_ENV] === "1";
}

export function defaultSnapshotDir(): string {
  return path.join(os.tmpdir(), "sim-mcp-snapshots");
}

/** Resolve the snapshot root: override > env dir > default dir. */
export function resolveSnapshotDir(dirOverride?: string): string {
  if (dirOverride !== undefined && dirOverride !== "") return dirOverride;
  const env = process.env[SNAPSHOT_DIR_ENV];
  if (env !== undefined && env !== "") return env;
  return defaultSnapshotDir();
}

let snapshotSeq = 0;

/** Unique, filesystem-safe, time-sortable id: `<prefix>-<ms>-<seq><rand>`. */
function nextSnapshotId(prefix: string): string {
  snapshotSeq = (snapshotSeq + 1) % 100000;
  const rand = randomBytes(2).toString("hex");
  return `${prefix}-${Date.now()}-${String(snapshotSeq).padStart(3, "0")}${rand}`;
}

// ---------- describe snapshots ----------

export interface DescribeSnapshotInput {
  leaseId: string;
  /** Full payload (pre-truncation): raw AX JSON or compact text. */
  ui: string;
  format: string;
  truncated: boolean;
  dirOverride?: string;
}

export interface DescribeSnapshotRef {
  /** Stable id; the sidecar file is `describes/<id>.json`. */
  id: string;
  file: string;
}

/** Last describe id per lease, for shot->describe linkage. */
const lastDescribeByLease = new Map<string, string>();

export function noteLastDescribe(leaseId: string, id: string): void {
  lastDescribeByLease.delete(leaseId);
  lastDescribeByLease.set(leaseId, id);
  while (lastDescribeByLease.size > LAST_DESCRIBE_MAX_LEASES) {
    const oldest = lastDescribeByLease.keys().next();
    if (oldest.done) break;
    lastDescribeByLease.delete(oldest.value);
  }
}

export function lastDescribeFor(leaseId: string): string | null {
  return lastDescribeByLease.get(leaseId) ?? null;
}

/** Test hook: clear the lease->describe linkage map. */
export function clearLastDescribe(): void {
  lastDescribeByLease.clear();
}

/**
 * Persist one ui_describe payload. Returns the stable id for trace extra,
 * or null when disabled / on any failure. Never throws.
 */
export function saveDescribeSnapshot(input: DescribeSnapshotInput): DescribeSnapshotRef | null {
  try {
    if (!isSnapshotEnabled()) return null;
    const id = nextSnapshotId("describe");
    const dir = path.join(resolveSnapshotDir(input.dirOverride), SNAPSHOT_DESCRIBES_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const body = {
      id,
      t: Date.now(),
      leaseId: input.leaseId,
      format: input.format,
      truncated: input.truncated,
      ui_len: input.ui.length,
      ui: input.ui,
    };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    noteLastDescribe(input.leaseId, id);
    return { id, file };
  } catch {
    return null;
  }
}

// ---------- tap resolution echo ----------

export interface TapEcho {
  /** Capped echo of the axe tap output (head-truncated with a marker). */
  echo: string;
  /** Resolved coordinates when the output names them (heuristic). */
  x?: number;
  y?: number;
}

const TAP_JSON_COORD_RE = /"[xy]"\s*:\s*(-?\d+(?:\.\d+)?)/g;
const TAP_LABELED_RE = /x\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,\s]+\s*y\s*[:=]\s*(-?\d+(?:\.\d+)?)/i;
const TAP_PARENS_RE = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/;

function headCap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

/**
 * Parse axe tap output into a capped echo plus resolved coords when found.
 * Pure and never throws. Coord extraction is a heuristic (JSON x/y, labeled
 * `x=.. y=..`, or a parenthesized pair); bare `a, b` number pairs are NOT
 * treated as coords to avoid false positives.
 */
export function parseTapEcho(output: string): TapEcho {
  try {
    const trimmed = output.trim();
    const echo = headCap(trimmed, TAP_ECHO_MAX_CHARS);
    const coords = extractTapCoords(trimmed);
    return coords ? { echo, x: coords.x, y: coords.y } : { echo };
  } catch {
    return { echo: "" };
  }
}

function extractTapCoords(trimmed: string): { x: number; y: number } | null {
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const rec = (typeof parsed === "object" && parsed !== null ? parsed : null) as Record<string, unknown> | null;
      const x = rec?.["x"];
      const y = rec?.["y"];
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y };
      }
    } catch {
      // Fall through to regex heuristics.
    }
    // JSON-shaped but unparseable: still try a `"x": n, "y": n` scan.
    const found: number[] = [];
    TAP_JSON_COORD_RE.lastIndex = 0;
    for (let m = TAP_JSON_COORD_RE.exec(trimmed); m !== null; m = TAP_JSON_COORD_RE.exec(trimmed)) {
      found.push(Number(m[1]));
      if (found.length >= 2) break;
    }
    if (found.length >= 2 && Number.isFinite(found[0]) && Number.isFinite(found[1])) {
      return { x: found[0]!, y: found[1]! };
    }
  }
  const labeled = TAP_LABELED_RE.exec(trimmed);
  if (labeled) {
    const x = Number(labeled[1]);
    const y = Number(labeled[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  const parens = TAP_PARENS_RE.exec(trimmed);
  if (parens) {
    const x = Number(parens[1]);
    const y = Number(parens[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return null;
}

export interface TapEchoInput {
  leaseId: string;
  dirOverride?: string;
}

/**
 * Build the trace-extra fragment for a tap (`tap_echo`, `tap_x`/`tap_y`,
 * plus `tap_echo_id` when the output spilled to a sidecar). Returns null
 * when disabled / on any failure. Never throws.
 */
export function buildTapEchoExtra(output: string, input: TapEchoInput): Record<string, unknown> | null {
  try {
    if (!isSnapshotEnabled()) return null;
    const parsed = parseTapEcho(output);
    const extra: Record<string, unknown> = { tap_echo: parsed.echo };
    if (parsed.x !== undefined) extra["tap_x"] = parsed.x;
    if (parsed.y !== undefined) extra["tap_y"] = parsed.y;
    if (output.trim().length > TAP_ECHO_MAX_CHARS) {
      const ref = saveTapSidecar(output, input);
      if (ref) extra["tap_echo_id"] = ref.id;
    }
    return extra;
  } catch {
    return null;
  }
}

export interface TapFailureInput {
  leaseId: string;
  /** Request selector fields echoed for context (small keys only). */
  selectors?: Record<string, unknown>;
  dirOverride?: string;
}

/**
 * Build the trace-extra fragment for a failed tap (`tap_ok: false` plus the
 * capped error excerpt, spilling to a taps/ sidecar when long). Returns null
 * when disabled / on any failure. Never throws.
 */
export function buildTapFailureExtra(error: unknown, input: TapFailureInput): Record<string, unknown> | null {
  try {
    if (!isSnapshotEnabled()) return null;
    const message = error instanceof Error ? error.message : String(error);
    const echo = buildTapEchoExtra(message, input) ?? { tap_echo: headCap(message.trim(), TAP_ECHO_MAX_CHARS) };
    return { tap_ok: false, ...(input.selectors ?? {}), ...echo };
  } catch {
    return null;
  }
}

function saveTapSidecar(output: string, input: TapEchoInput): { id: string; file: string } | null {
  try {
    const id = nextSnapshotId("tap");
    const dir = path.join(resolveSnapshotDir(input.dirOverride), SNAPSHOT_TAPS_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const scrubbed = scrubText(output.trim());
    const body = {
      id,
      t: Date.now(),
      leaseId: input.leaseId,
      output_len: scrubbed.length,
      truncated: scrubbed.length > TAP_SIDECAR_MAX_CHARS,
      output:
        scrubbed.length > TAP_SIDECAR_MAX_CHARS
          ? `${scrubbed.slice(0, TAP_SIDECAR_MAX_CHARS)}\n…[truncated ${scrubbed.length - TAP_SIDECAR_MAX_CHARS} chars]`
          : scrubbed,
    };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    return { id, file };
  } catch {
    return null;
  }
}

// ---------- screenshot linkage ----------

export interface ShotLinkInput {
  leaseId: string;
  /** Full screenshot path; only the basename is persisted. */
  shotPath: string;
  dirOverride?: string;
}

/**
 * Persist a shot->describe link and return the trace-extra fragment
 * (`shot_id`, plus `describe_id` when this lease has one). Returns null
 * when disabled / on any failure. Never throws.
 */
export function saveShotLink(input: ShotLinkInput): Record<string, unknown> | null {
  try {
    if (!isSnapshotEnabled()) return null;
    const id = nextSnapshotId("shot");
    const describeId = lastDescribeFor(input.leaseId);
    const dir = path.join(resolveSnapshotDir(input.dirOverride), SNAPSHOT_SHOTS_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const body = {
      id,
      t: Date.now(),
      leaseId: input.leaseId,
      describe_id: describeId,
      path: scrubText(path.basename(input.shotPath)),
    };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    return describeId ? { shot_id: id, describe_id: describeId } : { shot_id: id };
  } catch {
    return null;
  }
}
