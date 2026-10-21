import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExactMatchBaseline } from "../src/eval-baseline.js";
import { EVAL_CASE_MAX_BYTES, EvalDataset } from "../src/eval-dataset.js";
import { EvalHarness } from "../src/eval-harness.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const V1_DIR = path.join(ROOT, "data", "eval", "v1");
const V2_DIR = path.join(ROOT, "data", "eval", "v2");

describe("EvalDataset v2 (measured)", () => {
  it("loads the v2 manifest with tap and abstain cases", () => {
    const dataset = EvalDataset.loadDir(V2_DIR);
    expect(dataset.cases.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(dataset.cases.map((c) => c.expected.kind));
    expect(kinds).toContain("tap");
    expect(kinds).toContain("abstain");
  });

  it("keeps every v2 dataset file under the byte cap", () => {
    for (const file of fs.readdirSync(V2_DIR)) {
      const bytes = fs.statSync(path.join(V2_DIR, file)).size;
      expect(bytes, file).toBeLessThanOrEqual(EVAL_CASE_MAX_BYTES);
    }
  });

  it("tags every v2 case with an existing collected-artifact source", () => {
    const dataset = EvalDataset.loadDir(V2_DIR);
    expect(dataset.cases.length).toBeGreaterThan(0);
    for (const c of dataset.cases) {
      expect(c.source, c.id).toBeDefined();
      const full = path.join(ROOT, c.source as string);
      expect(fs.existsSync(full), `${c.id} source ${c.source}`).toBe(true);
      expect(path.relative(ROOT, full).startsWith("data" + path.sep + "traces"), c.id).toBe(true);
    }
  });

  it("still loads the v1 manifest after versioning was extended (no v1 changes)", () => {
    const dataset = EvalDataset.loadDir(V1_DIR);
    expect(dataset.cases.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects an unknown manifest version", () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "eval-version-"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 99, cases: ["x.json"] }));
    expect(() => EvalDataset.loadDir(dir)).toThrow();
  });

  it("scores the measured v2 cases perfectly with the exact-match baseline", () => {
    const dataset = EvalDataset.loadDir(V2_DIR);
    const baseline = new ExactMatchBaseline();
    const report = new EvalHarness().run(dataset.cases, (s) => baseline.predict(s), { tau: 0.5 });
    expect(report.total).toBe(dataset.cases.length);
    expect(report.correct).toBe(dataset.cases.length);
    expect(report.accuracy).toBe(1);
  });

  it("carries per-case source tags through the harness report", () => {
    const dataset = EvalDataset.loadDir(V2_DIR);
    const baseline = new ExactMatchBaseline();
    const report = new EvalHarness().run(dataset.cases, (s) => baseline.predict(s));
    expect(report.results).toHaveLength(dataset.cases.length);
    for (const r of report.results) {
      const original = dataset.cases.find((c) => c.id === r.caseId);
      expect(original).toBeDefined();
      expect(r.source).toBe(original?.source);
    }
  });
});
