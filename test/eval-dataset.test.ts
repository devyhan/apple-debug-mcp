import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_CASE_MAX_BYTES, EvalDataset } from "../src/eval-dataset.js";

const DATASET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "eval", "v1");

describe("EvalDataset", () => {
  it("loads the v1 manifest with tap and abstain cases", () => {
    const dataset = EvalDataset.loadDir(DATASET_DIR);
    expect(dataset.cases.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(dataset.cases.map((c) => c.expected.kind));
    expect(kinds).toContain("tap");
    expect(kinds).toContain("abstain");
  });

  it("keeps every dataset file under the byte cap", () => {
    for (const file of fs.readdirSync(DATASET_DIR)) {
      const bytes = fs.statSync(path.join(DATASET_DIR, file)).size;
      expect(bytes, file).toBeLessThanOrEqual(EVAL_CASE_MAX_BYTES);
    }
  });

  it("rejects a case with an empty query", () => {
    expect(() => EvalDataset.parseCase({ id: "bad", ui: "[]", query: {}, expected: { kind: "abstain" } })).toThrow();
  });

  it("rejects a tap case with an empty match", () => {
    expect(() =>
      EvalDataset.parseCase({
        id: "bad",
        ui: "[]",
        query: { label: "x" },
        expected: { kind: "tap", match: {} },
      }),
    ).toThrow();
  });
});
