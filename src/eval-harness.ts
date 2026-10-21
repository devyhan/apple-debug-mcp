import { performance } from "node:perf_hooks";
import type { BaselinePrediction, BaselineState } from "./eval-baseline.js";
import type { EvalCase } from "./eval-dataset.js";

/**
 * M2 offline eval harness: accuracy / abstain-rate / latency metrics.
 *
 * Pure and synchronous apart from the clock: no network, no subprocess, no
 * model calls. The `tau` knob demotes any prediction with
 * `confidence < tau` to an abstain before scoring, so future probabilistic
 * predictors can trade coverage for precision on the same harness.
 */

export type Predictor = (state: BaselineState) => BaselinePrediction;

export interface HarnessOptions {
  /** Confidence threshold; predictions below it count as abstains. Default 0.5. */
  tau?: number;
}

export interface CaseResult {
  caseId: string;
  /** Provenance tag copied from the case (v2 datasets). */
  source?: string;
  predicted: BaselinePrediction;
  /** True when the prediction was demoted by tau. */
  tauAbstained: boolean;
  correct: boolean;
  latencyMs: number;
}

export interface LatencyStats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface EvalReport {
  total: number;
  correct: number;
  wrong: number;
  abstained: number;
  /** correct / total (abstains count as not-correct unless expected). */
  accuracy: number;
  abstainRate: number;
  /** correct / (total - abstained); 1 when everything abstained. */
  decidedAccuracy: number;
  latency: LatencyStats;
  tau: number;
  results: CaseResult[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export class EvalHarness {
  run(cases: EvalCase[], predictor: Predictor, opts: HarnessOptions = {}): EvalReport {
    const tau = opts.tau ?? 0.5;
    const results: CaseResult[] = [];
    const latencies: number[] = [];
    for (const c of cases) {
      const t0 = performance.now();
      const predicted = predictor({ ui: c.ui, query: c.query });
      const latencyMs = performance.now() - t0;
      latencies.push(latencyMs);
      const tauAbstained = predicted.decision === "predict" && predicted.confidence < tau;
      const effective: BaselinePrediction = tauAbstained
        ? { decision: "abstain", reason: "no-match", confidence: 0 }
        : predicted;
      results.push({
        caseId: c.id,
        ...(c.source !== undefined ? { source: c.source } : {}),
        predicted: effective,
        tauAbstained,
        correct: isCorrect(c, effective),
        latencyMs,
      });
    }
    const correct = results.filter((r) => r.correct).length;
    const abstained = results.filter((r) => r.predicted.decision === "abstain").length;
    const wrong = results.filter((r) => !r.correct && r.predicted.decision === "predict").length;
    const decidedCorrect = results.filter((r) => r.correct && r.predicted.decision === "predict").length;
    const total = results.length;
    const decided = total - abstained;
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      total,
      correct,
      wrong,
      abstained,
      accuracy: total === 0 ? 1 : correct / total,
      abstainRate: total === 0 ? 0 : abstained / total,
      decidedAccuracy: decided === 0 ? 1 : decidedCorrect / decided,
      latency: {
        mean: latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
      },
      tau,
      results,
    };
  }
}

function isCorrect(c: EvalCase, predicted: BaselinePrediction): boolean {
  if (c.expected.kind === "abstain") return predicted.decision === "abstain";
  if (predicted.decision !== "predict") return false;
  const { match } = c.expected;
  if (match.label !== undefined && predicted.target.label !== match.label) return false;
  if (match.id !== undefined && predicted.target.id !== match.id) return false;
  return true;
}
