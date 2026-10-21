import { describe, expect, it } from "vitest";
import { ExactMatchBaseline, type BaselinePrediction, type BaselineState } from "../src/eval-baseline.js";
import type { EvalCase } from "../src/eval-dataset.js";
import { EvalHarness } from "../src/eval-harness.js";

function tapCase(id: string, label: string): EvalCase {
  const ui = JSON.stringify([{ AXLabel: label, AXUniqueId: null, type: "Button", children: [] }]);
  return { id, ui, query: { label }, expected: { kind: "tap", match: { label } } };
}

function abstainCase(id: string): EvalCase {
  const ui = JSON.stringify([{ AXLabel: "only", AXUniqueId: null, type: "Button", children: [] }]);
  return { id, ui, query: { label: "missing" }, expected: { kind: "abstain" } };
}

describe("EvalHarness", () => {
  it("scores a perfect baseline run (accuracy 1, abstains only where expected)", () => {
    const cases = [tapCase("t1", "저장"), tapCase("t2", "취소"), abstainCase("a1")];
    const baseline = new ExactMatchBaseline();
    const report = new EvalHarness().run(cases, (s) => baseline.predict(s), { tau: 0.5 });
    expect(report.total).toBe(3);
    expect(report.correct).toBe(3);
    expect(report.wrong).toBe(0);
    expect(report.abstained).toBe(1);
    expect(report.accuracy).toBe(1);
    expect(report.abstainRate).toBeCloseTo(1 / 3);
    expect(report.decidedAccuracy).toBe(1);
  });

  it("counts a wrong decision and an unexpected abstain as incorrect", () => {
    const cases = [tapCase("t1", "저장"), abstainCase("a1")];
    const alwaysAbstain = (): BaselinePrediction => ({ decision: "abstain", reason: "no-match", confidence: 0 });
    const report = new EvalHarness().run(cases, alwaysAbstain);
    expect(report.correct).toBe(1);
    expect(report.accuracy).toBe(0.5);
    expect(report.decidedAccuracy).toBe(1); // nothing decided: vacuous
  });

  it("demotes low-confidence predictions below tau to abstains", () => {
    const cases = [tapCase("t1", "저장")];
    const shaky = (s: BaselineState): BaselinePrediction => ({
      decision: "predict",
      target: { label: s.query.label, index: 0 },
      confidence: 1,
    });
    const low = (_s: BaselineState): BaselinePrediction => ({
      decision: "predict",
      target: { label: "저장", index: 0 },
      confidence: 0,
    });
    expect(new EvalHarness().run(cases, shaky, { tau: 0.5 }).results[0]?.tauAbstained).toBe(false);
    const demoted = new EvalHarness().run(cases, low, { tau: 0.5 });
    expect(demoted.results[0]?.tauAbstained).toBe(true);
    expect(demoted.results[0]?.predicted.decision).toBe("abstain");
    expect(demoted.correct).toBe(0);
  });

  it("reports sane latency stats for every case", () => {
    const cases = [tapCase("t1", "a"), tapCase("t2", "b"), abstainCase("a1")];
    const baseline = new ExactMatchBaseline();
    const report = new EvalHarness().run(cases, (s) => baseline.predict(s));
    expect(report.results).toHaveLength(3);
    for (const r of report.results) {
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(r.latencyMs).toBeLessThan(1000);
    }
    expect(report.latency.mean).toBeGreaterThanOrEqual(0);
    expect(report.latency.p50).toBeLessThanOrEqual(report.latency.p95);
    expect(report.latency.p95).toBeLessThanOrEqual(report.latency.max);
  });

  it("handles an empty dataset without NaN", () => {
    const report = new EvalHarness().run([], () => ({ decision: "abstain", reason: "no-match", confidence: 0 }));
    expect(report).toMatchObject({ total: 0, accuracy: 1, abstainRate: 0, decidedAccuracy: 1 });
  });
});
