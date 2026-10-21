import { describe, expect, it } from "vitest";
import { compactAx, compactAxText, isInteractiveType, parseAxRoots } from "../src/ax-prune.js";
import { ExactMatchBaseline } from "../src/eval-baseline.js";

const FULL = JSON.stringify([
  {
    AXFrame: "{{0, 0}, {402, 874}}",
    AXUniqueId: null,
    frame: { y: 0, x: 0, width: 402, height: 874 },
    role_description: "application",
    AXLabel: " ",
    content_required: false,
    type: "Application",
    title: null,
    help: null,
    custom_actions: [],
    AXValue: null,
    enabled: true,
    role: "AXApplication",
    pid: 85317,
    subrole: null,
    children: [
      {
        AXFrame: "{{24.33, 88}, {168.33, 191}}",
        AXUniqueId: "지도",
        frame: { y: 88, x: 24.333333333333314, width: 168.33333333333334, height: 191 },
        role_description: "button",
        AXLabel: "지도",
        type: "Button",
        title: null,
        help: null,
        custom_actions: ["편집 모드"],
        AXValue: "위젯",
        enabled: true,
        role: "AXButton",
        children: [],
        subrole: null,
        pid: 85317,
      },
      {
        AXFrame: "{{0, 800}, {402, 74}}",
        AXUniqueId: null,
        frame: { y: 800, x: 0, width: 402, height: 74 },
        AXLabel: "하단 설명",
        type: "StaticText",
        title: null,
        children: [],
      },
    ],
  },
]);

describe("ax-prune", () => {
  it("keeps only label/id/type/frame/children and drops nulls/empties", () => {
    const { nodes, kept, dropped } = compactAx(FULL);
    expect(kept).toBe(3);
    expect(dropped).toBe(0);
    const root = nodes[0]!;
    // Whitespace-only root label is dropped; null id is dropped.
    expect(root).toEqual({
      type: "Application",
      frame: { x: 0, y: 0, w: 402, h: 874 },
      children: expect.any(Array),
    });
    expect("AXFrame" in root).toBe(false);
    expect("AXUniqueId" in root).toBe(false);
    const button = root.children![0]!;
    expect(button).toEqual({
      label: "지도",
      id: "지도",
      type: "Button",
      frame: { x: 24.3, y: 88, w: 168.3, h: 191 },
    });
    expect("children" in button).toBe(false); // empty children omitted
  });

  it("dedupes AXFrame+frame into a single x,y,w,h", () => {
    const { nodes } = compactAx(FULL);
    const text = JSON.stringify(nodes);
    expect(text).not.toContain("AXFrame");
    expect(text).not.toContain("width");
    expect(text).not.toContain("height");
    expect(nodes[0]!.frame).toEqual({ x: 0, y: 0, w: 402, h: 874 });
  });

  it("parses the AXFrame string when the frame object is missing", () => {
    const ui = JSON.stringify([{ AXLabel: "x", type: "Button", AXFrame: "{{1.5, 2.5}, {10, 20}}", children: [] }]);
    const { nodes } = compactAx(ui);
    expect(nodes[0]!.frame).toEqual({ x: 1.5, y: 2.5, w: 10, h: 20 });
  });

  it("orders interactive children first, stably", () => {
    // StaticText listed first in input; Button must win in output.
    const ui = JSON.stringify([
      {
        type: "Application",
        children: [
          { AXLabel: "a", type: "StaticText", children: [] },
          { AXLabel: "b", type: "Button", children: [] },
          { AXLabel: "c", type: "Cell", children: [] },
          { AXLabel: "d", type: "StaticText", children: [] },
        ],
      },
    ]);
    const { nodes } = compactAx(ui);
    expect(nodes[0]!.children!.map((n) => n.label)).toEqual(["b", "c", "a", "d"]);
    expect(isInteractiveType("Button")).toBe(true);
    expect(isInteractiveType("StaticText")).toBe(false);
    expect(isInteractiveType(undefined)).toBe(false);
  });

  it("prunes children beyond maxDepth and counts dropped nodes", () => {
    const { nodes, kept, dropped } = compactAx(FULL, { maxDepth: 0 });
    expect(nodes[0]!.children).toBeUndefined();
    expect(kept).toBe(1);
    expect(dropped).toBe(2);
    const one = compactAx(FULL, { maxDepth: 1 });
    expect(one.kept).toBe(3);
    expect(one.dropped).toBe(0);
  });

  it("rejects invalid maxDepth and invalid ui", () => {
    expect(() => compactAx(FULL, { maxDepth: -1 })).toThrow(/maxDepth/);
    expect(() => compactAx(FULL, { maxDepth: 1.5 })).toThrow(/maxDepth/);
    expect(() => compactAx("not json")).toThrow(/not valid JSON/);
    expect(() => compactAx('{"a":1,"children":"nope"}')).not.toThrow(); // single root object ok
    expect(() => compactAx("42")).toThrow(/not an AX node array/);
  });

  it("accepts a single root object (point query shape)", () => {
    const { nodes, kept } = compactAx(JSON.stringify({ AXLabel: "x", type: "Button" }));
    expect(kept).toBe(1);
    expect(nodes).toEqual([{ label: "x", type: "Button" }]);
  });

  it("parseAxRoots skips non-record entries", () => {
    expect(parseAxRoots('[null, 42, {"type":"Button"}]')).toHaveLength(1);
  });

  it("emits single-line JSON text with kept/dropped counts", () => {
    const { text, kept, dropped } = compactAxText(FULL);
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toHaveLength(1);
    expect(kept).toBe(3);
    expect(dropped).toBe(0);
    expect(text.length).toBeLessThan(FULL.length);
  });

  it("compact output evaluates identically under the alias-tolerant baseline", () => {
    const baseline = new ExactMatchBaseline();
    const query = { label: "지도" };
    const fullRes = baseline.predict({ ui: FULL, query });
    const { text } = compactAxText(FULL);
    const compactRes = baseline.predict({ ui: text, query });
    expect(fullRes).toMatchObject({ decision: "predict" });
    expect(compactRes).toMatchObject({ decision: "predict" });
    if (fullRes.decision === "predict" && compactRes.decision === "predict") {
      // Same node identity (label+id); index may differ (ordering is by design).
      expect(compactRes.target.label).toBe(fullRes.target.label);
      expect(compactRes.target.id).toBe(fullRes.target.id);
    }
  });
});
