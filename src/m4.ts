/**
 * M4 env-gated autonomous-tap decision + audit for ui_tap.
 *
 * Gate: nothing is cached, decided, or logged unless `SIM_MCP_M4=1`
 * (default OFF, zero behavior change when unset). When the gate is off the
 * `auto` request flag does not exist: it is ignored and the tap proceeds
 * manually. Destination: `SIM_MCP_M4_FILE` (explicit file) wins, else the
 * constructor-style override, `SIM_MCP_M4_DIR`, or the OS temp `sim-mcp-m4`
 * default (mirrors shadow.ts resolve precedence: file > override > env >
 * default).
 *
 * Flow: ui_describe caches its full-hierarchy payload per lease via
 * noteM4Ui (own timestamped cache; the M3 shadow cache has no `t`); ui_tap
 * with `auto: true` runs the fail-fast gate chain in evaluateM4
 * (fresh describe -> predictor non-abstain -> allowlist -> dry-run) before
 * axe.tap is reached. Any failure denies without tapping. Dry-run is ON by
 * default (`SIM_MCP_M4_DRY_RUN !== "0"`), so enabling the master gate alone
 * can never produce a real autonomous tap.
 *
 * Records: one JSONL line per autonomous request in m4-audit.jsonl, plus an
 * `m4` trace-extra fragment (`deny:<reason>` / `allow`) merged into the
 * existing logAction call. Every string echo is scrubbed then capped (200
 * chars) and every JSONL line stays below the 4096B trace cap. Every export
 * is best-effort and never throws, so callers need no try/catch.
 *
 * Scope: v1 navigation-only taps (Settings main rows, About back-nav, Home
 * Settings icon); see m4-allowlist.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BaselinePrediction } from "./eval-baseline.js";
import { V1_ALLOWLIST, matchM4Allowlist, parseM4AllowlistFile } from "./m4-allowlist.js";
import type { M4AllowlistEntry } from "./m4-allowlist.js";
import { ExactMatchShadowPredictor } from "./shadow-predictor.js";
import type { ShadowPredictor } from "./shadow-predictor.js";
import { TRACE_EVENT_MAX_BYTES, scrubText } from "./trace.js";

export const M4_ENABLE_ENV = "SIM_MCP_M4";
export const M4_DRY_RUN_ENV = "SIM_MCP_M4_DRY_RUN";
export const M4_FRESHNESS_ENV = "SIM_MCP_M4_FRESHNESS_MS";
export const M4_FILE_ENV = "SIM_MCP_M4_FILE";
export const M4_DIR_ENV = "SIM_MCP_M4_DIR";
export const M4_ALLOWLIST_FILE_ENV = "SIM_MCP_M4_ALLOWLIST_FILE";
export const M4_FILE_NAME = "m4-audit.jsonl";
/** Head-cap on the cached describe payload per lease. */
export const M4_UI_MAX_CHARS = 32 * 1024;
/** Cap on tracked leases for the M4 UI cache (FIFO eviction). */
export const LAST_M4_UI_MAX_LEASES = 1000;
/** Cap on label/id/lease echoes inside M4 records. */
export const M4_ECHO_MAX_CHARS = 200;
/** Default freshness window for the last-describe cache. */
export const M4_DEFAULT_FRESHNESS_MS = 30000;

/** Master gate. Read per call (one env lookup) so tests can toggle it. */
export function isM4Enabled(): boolean {
  return process.env[M4_ENABLE_ENV] === "1";
}

/** Dry-run is ON unless explicitly disabled with exact "0". Never throws. */
export function isM4DryRun(): boolean {
  try {
    return process.env[M4_DRY_RUN_ENV] !== "0";
  } catch {
    return true;
  }
}

/**
 * Freshness window in ms. Positive ints only; anything unparseable or
 * <= 0 falls back to the default. Never throws.
 */
export function m4FreshnessMs(): number {
  try {
    const raw = process.env[M4_FRESHNESS_ENV];
    if (raw === undefined || raw === "") return M4_DEFAULT_FRESHNESS_MS;
    if (!/^\d+$/.test(raw)) return M4_DEFAULT_FRESHNESS_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return M4_DEFAULT_FRESHNESS_MS;
    return parsed;
  } catch {
    return M4_DEFAULT_FRESHNESS_MS;
  }
}

export function defaultM4Dir(): string {
  return path.join(os.tmpdir(), "sim-mcp-m4");
}

/** Resolve the JSONL file: explicit file > override dir > env dir > default dir. */
export function resolveM4File(dirOverride?: string): string {
  const file = process.env[M4_FILE_ENV];
  if (file !== undefined && file !== "") return file;
  const dir = dirOverride ?? process.env[M4_DIR_ENV] ?? defaultM4Dir();
  return path.join(dir === "" ? defaultM4Dir() : dir, M4_FILE_NAME);
}

// ---------- last-describe UI cache (in-memory, M4-owned, timestamped) ----------

interface M4UiEntry {
  ui: string;
  t: number;
  describeId?: string;
}

/** Last full-hierarchy describe payload per lease; independent of other gates. */
const lastUiByLease = new Map<string, M4UiEntry>();

/**
 * Cache one full-hierarchy ui_describe payload for later autonomous-tap
 * evaluation. No-op when the M4 gate is off. Point describes (x+y) must
 * not call this: their element-only payloads could false-match. Never
 * throws.
 */
export function noteM4Ui(leaseId: string, ui: string, describeId?: string): void {
  try {
    if (!isM4Enabled()) return;
    lastUiByLease.delete(leaseId);
    lastUiByLease.set(leaseId, {
      ui: ui.length > M4_UI_MAX_CHARS ? ui.slice(0, M4_UI_MAX_CHARS) : ui,
      t: Date.now(),
      ...(describeId !== undefined ? { describeId } : {}),
    });
    while (lastUiByLease.size > LAST_M4_UI_MAX_LEASES) {
      const oldest = lastUiByLease.keys().next();
      if (oldest.done) break;
      lastUiByLease.delete(oldest.value);
    }
  } catch {
    // Best-effort: callers must never observe an M4 failure.
  }
}

/** Test hook: clear the lease->UI cache map. */
export function clearM4Ui(): void {
  lastUiByLease.clear();
}

// ---------- allowlist resolution ----------

/** "builtin" | "custom" | "invalid" (malformed custom file -> deny-all). */
export type M4AllowlistSource = "builtin" | "custom" | "invalid";

interface M4Allowlist {
  entries: readonly M4AllowlistEntry[];
  source: M4AllowlistSource;
}

/** Load the effective allowlist. Never throws; failures resolve to deny-all. */
export function resolveM4Allowlist(): M4Allowlist {
  try {
    const file = process.env[M4_ALLOWLIST_FILE_ENV];
    if (file === undefined || file === "") return { entries: V1_ALLOWLIST, source: "builtin" };
    const body = fs.readFileSync(file, "utf8");
    const entries = parseM4AllowlistFile(body);
    if (entries === null) return { entries: [], source: "invalid" };
    return { entries, source: "custom" };
  } catch {
    return { entries: [], source: "invalid" };
  }
}

// ---------- gate evaluation ----------

/** Tap query: request selectors only (label/id); coord-only taps omit both. */
export interface M4Query {
  label?: string;
  id?: string;
}

export interface M4TapInput {
  leaseId: string;
  query: M4Query;
}

export type M4Decision = "allow" | "deny";

export interface M4Result {
  decision: M4Decision;
  /** First failing gate (fail-fast); "allow" on the allow path. */
  reason: string;
  /** True only on the dry-run allow-path (evaluation passed, tap skipped). */
  wouldTap: boolean;
  gates: Record<string, unknown>;
  dryRun: boolean;
  allowlist: M4AllowlistSource;
}

/** Scrub then head-cap an echo string for M4 records. */
function capEcho(text: string): string {
  const scrubbed = scrubText(text);
  return scrubbed.length <= M4_ECHO_MAX_CHARS ? scrubbed : scrubbed.slice(0, M4_ECHO_MAX_CHARS);
}

function toLogPrediction(prediction: BaselinePrediction): Record<string, unknown> {
  if (prediction.decision === "abstain") {
    return { decision: "abstain", reason: prediction.reason, confidence: 0 };
  }
  const target = prediction.target;
  return {
    decision: "predict",
    target: {
      ...(target.label !== undefined ? { label: capEcho(target.label) } : {}),
      ...(target.id !== undefined ? { id: capEcho(target.id) } : {}),
      index: target.index,
    },
    confidence: 1,
  };
}

/**
 * Fail-fast gate chain: fresh describe -> predictor non-abstain ->
 * allowlist -> dry-run. Pure decision besides reading the fresh-cache.
 * Never throws (catch-all -> deny).
 */
export function evaluateM4(input: M4TapInput, predictor?: ShadowPredictor): M4Result {
  try {
    const gates: Record<string, unknown> = {};
    const deny = (reason: string, wouldTap: boolean, dryRun: boolean, source: M4AllowlistSource): M4Result => ({
      decision: "deny",
      reason,
      wouldTap,
      gates,
      dryRun,
      allowlist: source,
    });

    // Gate 1: fresh same-lease describe.
    const entry = lastUiByLease.get(input.leaseId) ?? null;
    const freshnessMs = m4FreshnessMs();
    if (entry === null) {
      gates["fresh"] = { pass: false };
      return deny("no-describe", false, isM4DryRun(), "builtin");
    }
    const ageMs = Date.now() - entry.t;
    if (ageMs > freshnessMs) {
      gates["fresh"] = { pass: false, ageMs };
      return deny("stale", false, isM4DryRun(), "builtin");
    }
    gates["fresh"] = {
      pass: true,
      ageMs,
      ...(entry.describeId !== undefined ? { describeId: capEcho(entry.describeId) } : {}),
    };

    // Gate 2: predictor non-abstain over the cached UI.
    let prediction: BaselinePrediction;
    try {
      const active = predictor ?? new ExactMatchShadowPredictor();
      prediction = active.predict({ ui: entry.ui, query: input.query });
    } catch {
      gates["predict"] = { decision: "error", confidence: 0 };
      return deny("predict-error", false, isM4DryRun(), "builtin");
    }
    gates["predict"] = toLogPrediction(prediction);
    if (prediction.decision === "abstain") {
      return deny(`abstain:${prediction.reason}`, false, isM4DryRun(), "builtin");
    }

    // Gate 3: explicit allowlist membership.
    const allowlist = resolveM4Allowlist();
    gates["allow"] = {
      pass: false,
      ...(allowlist.source !== "builtin" ? { source: allowlist.source } : {}),
    };
    const matched = matchM4Allowlist(allowlist.entries, input.query);
    if (matched === null) {
      return deny("not-allowlisted", false, isM4DryRun(), allowlist.source);
    }
    gates["allow"] = {
      pass: true,
      entry: {
        screen: matched.screen,
        label: capEcho(matched.label),
        ...(matched.id !== undefined ? { id: capEcho(matched.id) } : {}),
      },
      ...(allowlist.source !== "builtin" ? { source: allowlist.source } : {}),
    };

    // Gate 4: dry-run (default ON) converts allow -> logged deny.
    const dryRun = isM4DryRun();
    if (dryRun) {
      return { decision: "deny", reason: "dry-run", wouldTap: true, gates, dryRun, allowlist: allowlist.source };
    }
    return { decision: "allow", reason: "allow", wouldTap: false, gates, dryRun, allowlist: allowlist.source };
  } catch {
    return { decision: "deny", reason: "error", wouldTap: false, gates: {}, dryRun: true, allowlist: "builtin" };
  }
}

export interface M4DecideInput extends M4TapInput {
  /** Request `auto` flag; anything but literal true means manual. */
  auto?: boolean;
}

/**
 * Entry point for the ui_tap call site. Returns null when the tap is
 * manual (`auto !== true`) or the master gate is off, so the manual path
 * falls through byte-identical. Never throws (catch-all -> deny).
 */
export function maybeM4Decide(input: M4DecideInput, predictor?: ShadowPredictor): M4Result | null {
  try {
    if (input.auto !== true) return null;
    if (!isM4Enabled()) return null;
    return evaluateM4(input, predictor);
  } catch {
    return { decision: "deny", reason: "error", wouldTap: false, gates: {}, dryRun: true, allowlist: "builtin" };
  }
}

// ---------- M4 JSONL audit log ----------

export interface M4AuditInput {
  leaseId: string;
  query: M4Query;
  result: M4Result;
  /** Whether axe.tap actually ran for this request. */
  tapped: boolean;
  dirOverride?: string;
}

/**
 * Append one JSONL line per autonomous request to m4-audit.jsonl. No-op
 * when disabled / on any failure. Never throws.
 */
export function appendM4Audit(input: M4AuditInput): void {
  try {
    if (!isM4Enabled()) return;
    const result = input.result;
    const body: Record<string, unknown> = {
      t: Date.now(),
      leaseId: capEcho(input.leaseId),
      tool: "ui_tap",
      auto: true,
      query: {
        ...(input.query.label !== undefined ? { label: capEcho(input.query.label) } : {}),
        ...(input.query.id !== undefined ? { id: capEcho(input.query.id) } : {}),
      },
      gates: result.gates,
      decision: result.decision,
      reason: result.reason,
      dryRun: result.dryRun,
      wouldTap: result.wouldTap,
      tapped: input.tapped,
      ...(result.allowlist !== "builtin" ? { allowlist: result.allowlist } : {}),
    };
    let line = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(line, "utf8") >= TRACE_EVENT_MAX_BYTES) {
      line = `${JSON.stringify({
        t: Date.now(),
        leaseId: capEcho(input.leaseId).slice(0, 64),
        tool: "ui_tap",
        summary: "[m4 event exceeded 4096B]",
      })}\n`;
    }
    const file = resolveM4File(input.dirOverride);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // Best-effort: callers must never observe an M4 failure.
  }
}
