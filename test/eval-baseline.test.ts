import { describe, expect, it } from "vitest";
import { ExactMatchBaseline } from "../src/eval-baseline.js";

const UI = JSON.stringify([
  {
    AXLabel: "설정",
    AXUniqueId: null,
    type: "Application",
    children: [
      { AXLabel: "일반", AXUniqueId: "com.apple.settings.general", type: "Cell", children: [] },
      { AXLabel: "카메라", AXUniqueId: null, type: "Cell", children: [] },
    ],
  },
]);

describe("ExactMatchBaseline", () => {
  it("predicts the unique exact label match with confidence 1", () => {
    const res = new ExactMatchBaseline().predict({ ui: UI, query: { label: "일반" } });
    expect(res).toMatchObject({
      decision: "predict",
      target: { label: "일반", id: "com.apple.settings.general" },
      confidence: 1,
    });
  });

  it("predicts by exact id match", () => {
    const res = new ExactMatchBaseline().predict({ ui: UI, query: { id: "com.apple.settings.general" } });
    expect(res.decision).toBe("predict");
    if (res.decision === "predict") expect(res.target.label).toBe("일반");
  });

  it("abstains with no-match when nothing matches exactly", () => {
    const res = new ExactMatchBaseline().predict({ ui: UI, query: { label: "없는항목" } });
    expect(res).toMatchObject({ decision: "abstain", reason: "no-match", confidence: 0 });
  });

  it("does not substring-match (exact equality only)", () => {
    const res = new ExactMatchBaseline().predict({ ui: UI, query: { label: "일" } });
    expect(res).toMatchObject({ decision: "abstain", reason: "no-match" });
  });

  it("abstains with ambiguous when the label matches twice", () => {
    const dup = JSON.stringify([
      { AXLabel: "저장", AXUniqueId: null, type: "Button", children: [] },
      { AXLabel: "저장", AXUniqueId: null, type: "Button", children: [] },
    ]);
    const res = new ExactMatchBaseline().predict({ ui: dup, query: { label: "저장" } });
    expect(res).toMatchObject({ decision: "abstain", reason: "ambiguous", confidence: 0 });
  });

  it("abstains when id+label never co-occur on one node", () => {
    const res = new ExactMatchBaseline().predict({
      ui: UI,
      query: { id: "com.apple.settings.general", label: "카메라" },
    });
    expect(res).toMatchObject({ decision: "abstain", reason: "no-match" });
  });

  it("never throws on malformed ui (abstains invalid-ui)", () => {
    for (const bad of ["not json", "{\"AXLabel\":\"x\"}", "[]"]) {
      const res = new ExactMatchBaseline().predict({ ui: bad, query: { label: "x" } });
      expect(res.decision).toBe("abstain");
    }
    expect(new ExactMatchBaseline().predict({ ui: "not json", query: { label: "x" } })).toMatchObject({
      reason: "invalid-ui",
    });
  });

  it("is synchronous and offline (returns a plain value, no promise)", () => {
    const res = new ExactMatchBaseline().predict({ ui: UI, query: { label: "일반" } });
    expect(res).not.toBeInstanceOf(Promise);
  });
});
