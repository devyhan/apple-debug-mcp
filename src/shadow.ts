/**
 * M3 env-gated shadow agreement harness: predict-then-compare for ui_tap.
 *
 * Gate: nothing is cached, logged, or merged unless `SIM_MCP_SHADOW=1`
 * (default OFF, zero behavior change when unset). Destination:
 * `SIM_MCP_SHADOW_FILE` (explicit file) wins, else the constructor-style
 * override, `SIM_MCP_SHADOW_DIR`, or the OS temp `sim-mcp-shadow` default
 * (mirrors trace.ts resolve precedence: file > override > env > default).
 *
 * Flow: ui_describe caches its full pre-truncation payload per lease via
 * noteShadowUi (in-memory only, independent of the SIM_MCP_SNAPSHOT gate);
 * ui_tap builds a {label?, id?} query from the request selectors only,
 * predicts against the cached UI, and records the outcome. The tap itself
 * always runs first and its MCP response (ok/fail payloads) is untouched.
 *
 * Records: a small trace-extra fragment (`shadow_pred`, `shadow_agree`, plus
 * `describe_id` when the lease has one) merged into the existing logAction
 * call, and one JSONL line per tap in shadow.jsonl. Every string echo is
 * scrubbed then capped (200 chars) and every JSONL line stays below the
 * 4096B trace cap. Every export is best-effort and never throws, so callers
 * need no try/catch.
 *
 * Never acts: no auto-act, no confidence gating, no rollout, no training,
 * no network. Prediction runs after axe.tap resolves; the result is logged
 * only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BaselinePrediction } from "./eval-baseline.js";
import { ExactMatchShadowPredictor } from "./shadow-predictor.js";
import type { ShadowPredictor } from "./shadow-predictor.js";
import { TRACE_EVENT_MAX_BYTES, scrubText } from "./trace.js";

export const SHADOW_ENABLE_ENV = "SIM_MCP_SHADOW";
export const SHADOW_FILE_ENV = "SIM_MCP_SHADOW_FILE";
export const SHADOW_DIR_ENV = "SIM_MCP_SHADOW_DIR";
export const SHADOW_FILE_NAME = "shadow.jsonl";
/** Head-cap on the cached describe payload per lease. */
export const SHADOW_UI_MAX_CHARS = 32 * 1024;
/** Cap on tracked leases for the shadow UI cache (FIFO eviction). */
export const LAST_SHADOW_UI_MAX_LEASES = 1000;
/** Cap on label/id/lease echoes inside shadow records. */
export const SHADOW_ECHO_MAX_CHARS = 200;

/** Master gate. Read per call (one env lookup) so tests can toggle it. */
export function isShadowEnabled(): boolean {
  return process.env[SHADOW_ENABLE_ENV] === "1";
}

export function defaultShadowDir(): string {
  return path.join(os.tmpdir(), "sim-mcp-shadow");
}

/** Resolve the JSONL file: explicit file > override dir > env dir > default dir. */
export function resolveShadowFile(dirOverride?: string): string {
  const file = process.env[SHADOW_FILE_ENV];
  if (file !== undefined && file !== "") return file;
  const dir = dirOverride ?? process.env[SHADOW_DIR_ENV] ?? defaultShadowDir();
  return path.join(dir === "" ? defaultShadowDir() : dir, SHADOW_FILE_NAME);
}

// ---------- last-describe UI cache (in-memory, shadow-owned) ----------

interface ShadowUiEntry {
  ui: string;
  describeId?: string;
}

/** Last full describe payload per lease; independent of the snapshot gate. */
const lastUiByLease = new Map<string, ShadowUiEntry>();

/**
 * Cache one ui_describe payload for later tap prediction. No-op when the
 * shadow gate is off. Never throws.
 */
export function noteShadowUi(leaseId: string, ui: string, describeId?: string): void {
  try {
    if (!isShadowEnabled()) return;
    lastUiByLease.delete(leaseId);
    lastUiByLease.set(leaseId, {
      ui: ui.length > SHADOW_UI_MAX_CHARS ? ui.slice(0, SHADOW_UI_MAX_CHARS) : ui,
      ...(describeId !== undefined ? { describeId } : {}),
    });
    while (lastUiByLease.size > LAST_SHADOW_UI_MAX_LEASES) {
      const oldest = lastUiByLease.keys().next();
      if (oldest.done) break;
      lastUiByLease.delete(oldest.value);
    }
  } catch {
    // Best-effort: callers must never observe a shadow failure.
  }
}

/** Test hook: clear the lease->UI cache map. */
export function clearShadowUi(): void {
  lastUiByLease.clear();
}

// ---------- predict + agree ----------

/** Tap query: request selectors only (label/id); coord-only taps omit both. */
export interface ShadowQuery {
  label?: string;
  id?: string;
}

export interface ShadowTapInput {
  leaseId: string;
  query: ShadowQuery;
  /** Whether the real tap resolved (post-tap outcome, never predicted). */
  tapOk: boolean;
}

/**
 * Pure agreement between a prediction and the tap outcome. Empty queries
 * (coordinate taps) and missing predictions (no cached UI, predictor error)
 * yield null (skipped/unknown) rather than false.
 */
export function computeShadowAgree(
  query: ShadowQuery,
  prediction: BaselinePrediction | null,
  tapOk: boolean,
): boolean | null {
  try {
    if (query.label === undefined && query.id === undefined) return null;
    if (prediction === null) return null;
    if (prediction.decision === "predict") {
      if (!tapOk) return false;
      const target = prediction.target;
      const labelOk = query.label === undefined || target.label === query.label;
      const idOk = query.id === undefined || target.id === query.id;
      return labelOk && idOk;
    }
    return tapOk ? false : true;
  } catch {
    return null;
  }
}

/** Scrub then head-cap an echo string for shadow records. */
function capEcho(text: string): string {
  const scrubbed = scrubText(text);
  return scrubbed.length <= SHADOW_ECHO_MAX_CHARS ? scrubbed : scrubbed.slice(0, SHADOW_ECHO_MAX_CHARS);
}

interface ShadowEvaluation {
  marker: string;
  agree: boolean | null;
  describeId?: string;
  prediction: BaselinePrediction | null;
  error: boolean;
}

function toMarker(prediction: BaselinePrediction): string {
  if (prediction.decision === "abstain") return `abstain:${prediction.reason}`;
  const target = prediction.target;
  return `predict:${capEcho(target.label ?? target.id ?? "?")}#${target.index}`;
}

/** Predict against the cached UI and score agreement. Never throws. */
function evaluateShadow(input: ShadowTapInput, predictor?: ShadowPredictor): ShadowEvaluation {
  try {
    const entry = lastUiByLease.get(input.leaseId) ?? null;
    const describeId = entry?.describeId;
    const withId = describeId !== undefined ? { describeId } : {};
    if (input.query.label === undefined && input.query.id === undefined) {
      return { marker: "skipped", agree: null, ...withId, prediction: null, error: false };
    }
    if (entry === null) {
      return { marker: "skipped", agree: null, ...withId, prediction: null, error: false };
    }
    const active = predictor ?? new ExactMatchShadowPredictor();
    const prediction = active.predict({ ui: entry.ui, query: input.query });
    return {
      marker: toMarker(prediction),
      agree: computeShadowAgree(input.query, prediction, input.tapOk),
      ...withId,
      prediction,
      error: false,
    };
  } catch {
    const describeId = lastUiByLease.get(input.leaseId)?.describeId;
    return {
      marker: "error",
      agree: null,
      ...(describeId !== undefined ? { describeId } : {}),
      prediction: null,
      error: true,
    };
  }
}

/**
 * Build the trace-extra fragment for a tap (`shadow_pred`, `shadow_agree`,
 * plus `describe_id` when the lease has one). Returns null when disabled.
 * Never throws.
 */
export function buildShadowExtra(
  input: ShadowTapInput,
  predictor?: ShadowPredictor,
): Record<string, unknown> | null {
  try {
    if (!isShadowEnabled()) return null;
    const ev = evaluateShadow(input, predictor);
    return {
      shadow_pred: ev.marker,
      shadow_agree: ev.agree,
      ...(ev.describeId !== undefined ? { describe_id: ev.describeId } : {}),
    };
  } catch {
    return null;
  }
}

// ---------- shadow JSONL log ----------

export interface ShadowLogInput extends ShadowTapInput {
  dirOverride?: string;
}

function toLogPrediction(ev: ShadowEvaluation): Record<string, unknown> {
  if (ev.error) return { decision: "error" };
  const prediction = ev.prediction;
  if (prediction === null) return { decision: "skipped" };
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
 * Append one JSONL line per tap to shadow.jsonl. No-op when disabled / on
 * any failure. Never throws.
 */
export function appendShadowLog(input: ShadowLogInput, predictor?: ShadowPredictor): void {
  try {
    if (!isShadowEnabled()) return;
    const ev = evaluateShadow(input, predictor);
    const body: Record<string, unknown> = {
      t: Date.now(),
      leaseId: capEcho(input.leaseId),
      tool: "ui_tap",
      query: {
        ...(input.query.label !== undefined ? { label: capEcho(input.query.label) } : {}),
        ...(input.query.id !== undefined ? { id: capEcho(input.query.id) } : {}),
      },
      tap_ok: input.tapOk,
      shadow_pred: toLogPrediction(ev),
      agree: ev.agree,
      ...(ev.describeId !== undefined ? { describe_id: capEcho(ev.describeId) } : {}),
    };
    let line = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(line, "utf8") >= TRACE_EVENT_MAX_BYTES) {
      line = `${JSON.stringify({
        t: Date.now(),
        leaseId: capEcho(input.leaseId).slice(0, 64),
        tool: "ui_tap",
        summary: "[shadow event exceeded 4096B]",
      })}\n`;
    }
    const file = resolveShadowFile(input.dirOverride);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // Best-effort: callers must never observe a shadow failure.
  }
}
