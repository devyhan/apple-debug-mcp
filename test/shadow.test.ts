import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselinePrediction, BaselineState } from "../src/eval-baseline.js";
import {
  LAST_SHADOW_UI_MAX_LEASES,
  SHADOW_ECHO_MAX_CHARS,
  SHADOW_UI_MAX_CHARS,
  appendShadowLog,
  buildShadowExtra,
  clearShadowUi,
  computeShadowAgree,
  isShadowEnabled,
  noteShadowUi,
  resolveShadowFile,
} from "../src/shadow.js";
import { ExactMatchShadowPredictor, type ShadowPredictor } from "../src/shadow-predictor.js";
import { TRACE_EVENT_MAX_BYTES } from "../src/trace.js";

const SHADOW_KEYS = ["SIM_MCP_SHADOW", "SIM_MCP_SHADOW_FILE", "SIM_MCP_SHADOW_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of SHADOW_KEYS) savedEnv[k] = process.env[k];
  for (const k of SHADOW_KEYS) delete process.env[k];
  clearShadowUi();
});

afterEach(() => {
  for (const k of SHADOW_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearShadowUi();
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Tiny AX fixture (well under the 4096B data cap). */
const AX_UI = JSON.stringify([
  { AXLabel: "Settings", AXUniqueId: "settings", children: [{ AXLabel: "Done", AXUniqueId: "done" }] },
]);

const AMBIGUOUS_UI = JSON.stringify([{ AXLabel: "Same" }, { AXLabel: "Same" }]);

function enableShadow(): string {
  const dir = tmpDir("sim-mcp-shadow-");
  process.env.SIM_MCP_SHADOW = "1";
  process.env.SIM_MCP_SHADOW_DIR = dir;
  return dir;
}

function readShadowLines(dir: string): string[] {
  const file = path.join(dir, "shadow.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

class ThrowingPredictor implements ShadowPredictor {
  predict(_state: BaselineState): BaselinePrediction {
    throw new Error("boom");
  }
}

describe("shadow gate (M3)", () => {
  it("is off by default and only \"1\" enables it", () => {
    expect(isShadowEnabled()).toBe(false);
    process.env.SIM_MCP_SHADOW = "true";
    expect(isShadowEnabled()).toBe(false);
    process.env.SIM_MCP_SHADOW = "";
    expect(isShadowEnabled()).toBe(false);
    process.env.SIM_MCP_SHADOW = "1";
    expect(isShadowEnabled()).toBe(true);
  });

  it("resolves destination: file wins over override over env dir over default", () => {
    const file = path.join("tmp", "custom.jsonl");
    process.env.SIM_MCP_SHADOW_FILE = file;
    process.env.SIM_MCP_SHADOW_DIR = path.join("tmp", "env");
    expect(resolveShadowFile(path.join("tmp", "override"))).toBe(file);
    delete process.env.SIM_MCP_SHADOW_FILE;
    expect(resolveShadowFile(path.join("tmp", "override"))).toBe(path.join("tmp", "override", "shadow.jsonl"));
    expect(resolveShadowFile()).toBe(path.join("tmp", "env", "shadow.jsonl"));
    delete process.env.SIM_MCP_SHADOW_DIR;
    expect(resolveShadowFile()).toContain("sim-mcp-shadow");
  });
});

describe("gate OFF means zero change (M3)", () => {
  it("buildShadowExtra returns null and noteShadowUi caches nothing", () => {
    noteShadowUi("lease-1", AX_UI, "describe-1");
    expect(buildShadowExtra({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true })).toBeNull();
    // Enable afterwards: nothing was cached while off, so the tap is skipped.
    process.env.SIM_MCP_SHADOW = "1";
    const extra = buildShadowExtra({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true });
    expect(extra?.["shadow_pred"]).toBe("skipped");
    expect(extra?.["shadow_agree"]).toBeNull();
  });

  it("appendShadowLog writes no file when off", () => {
    const dir = tmpDir("sim-mcp-shadow-off-");
    process.env.SIM_MCP_SHADOW_DIR = dir;
    appendShadowLog({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true });
    expect(fs.existsSync(path.join(dir, "shadow.jsonl"))).toBe(false);
  });
});

describe("predictor adapter (M3)", () => {
  const predictor = new ExactMatchShadowPredictor();

  it("predicts a unique label match", () => {
    const pred = predictor.predict({ ui: AX_UI, query: { label: "Done" } });
    expect(pred.decision).toBe("predict");
    if (pred.decision === "predict") {
      expect(pred.target.label).toBe("Done");
      expect(pred.target.index).toBe(1);
      expect(pred.confidence).toBe(1);
    }
  });

  it("abstains on empty query, no match, ambiguous, and invalid UI", () => {
    expect(predictor.predict({ ui: AX_UI, query: {} }).decision).toBe("abstain");
    expect(predictor.predict({ ui: AX_UI, query: {} })).toMatchObject({ reason: "empty-query" });
    expect(predictor.predict({ ui: AX_UI, query: { label: "Missing" } })).toMatchObject({ reason: "no-match" });
    expect(predictor.predict({ ui: AMBIGUOUS_UI, query: { label: "Same" } })).toMatchObject({
      reason: "ambiguous",
    });
    expect(predictor.predict({ ui: "not json", query: { label: "Settings" } })).toMatchObject({
      reason: "invalid-ui",
    });
  });
});

describe("agreement (M3)", () => {
  it("predict + tapOk + matching target agrees", () => {
    enableShadow();
    noteShadowUi("lease-1", AX_UI, "describe-1");
    const extra = buildShadowExtra({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true });
    expect(extra?.["shadow_pred"]).toBe("predict:Settings#0");
    expect(extra?.["shadow_agree"]).toBe(true);
    expect(extra?.["describe_id"]).toBe("describe-1");
  });

  it("abstain vs success disagrees; abstain vs failure agrees", () => {
    enableShadow();
    noteShadowUi("lease-1", AX_UI);
    const missOk = buildShadowExtra({ leaseId: "lease-1", query: { label: "Missing" }, tapOk: true });
    expect(missOk?.["shadow_pred"]).toBe("abstain:no-match");
    expect(missOk?.["shadow_agree"]).toBe(false);
    const missFail = buildShadowExtra({ leaseId: "lease-1", query: { label: "Missing" }, tapOk: false });
    expect(missFail?.["shadow_agree"]).toBe(true);
  });

  it("predict vs failed tap disagrees", () => {
    enableShadow();
    noteShadowUi("lease-1", AX_UI);
    const extra = buildShadowExtra({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: false });
    expect(extra?.["shadow_pred"]).toBe("predict:Settings#0");
    expect(extra?.["shadow_agree"]).toBe(false);
  });

  it("coordinate tap (empty query) is skipped with null agreement", () => {
    enableShadow();
    noteShadowUi("lease-1", AX_UI);
    const extra = buildShadowExtra({ leaseId: "lease-1", query: {}, tapOk: true });
    expect(extra?.["shadow_pred"]).toBe("skipped");
    expect(extra?.["shadow_agree"]).toBeNull();
  });

  it("missing snapshot is skipped with null agreement", () => {
    enableShadow();
    const extra = buildShadowExtra({ leaseId: "lease-unknown", query: { label: "Settings" }, tapOk: true });
    expect(extra?.["shadow_pred"]).toBe("skipped");
    expect(extra?.["shadow_agree"]).toBeNull();
    expect(extra).not.toHaveProperty("describe_id");
  });

  it("computeShadowAgree is pure across the decision matrix", () => {
    const predict = { decision: "predict", target: { label: "A", index: 0 }, confidence: 1 } as const;
    const abstain = { decision: "abstain", reason: "no-match", confidence: 0 } as const;
    expect(computeShadowAgree({ label: "A" }, predict, true)).toBe(true);
    expect(computeShadowAgree({ label: "B" }, predict, true)).toBe(false);
    expect(computeShadowAgree({ label: "A" }, predict, false)).toBe(false);
    expect(computeShadowAgree({ label: "A" }, abstain, true)).toBe(false);
    expect(computeShadowAgree({ label: "A" }, abstain, false)).toBe(true);
    expect(computeShadowAgree({}, predict, true)).toBeNull();
    expect(computeShadowAgree({ label: "A" }, null, true)).toBeNull();
  });
});

describe("shadow JSONL log (M3)", () => {
  it("appends one capped line per tap with the agreement record", () => {
    const dir = enableShadow();
    noteShadowUi("lease-1", AX_UI, "describe-1");
    appendShadowLog({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true });
    const lines = readShadowLines(dir);
    expect(lines).toHaveLength(1);
    for (const line of lines) expect(Buffer.byteLength(line, "utf8")).toBeLessThan(TRACE_EVENT_MAX_BYTES);
    const body = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(body["tool"]).toBe("ui_tap");
    expect(body["tap_ok"]).toBe(true);
    expect(body["agree"]).toBe(true);
    expect(body["describe_id"]).toBe("describe-1");
    expect(body["shadow_pred"]).toMatchObject({ decision: "predict", confidence: 1 });
  });

  it("logs skips and failures without throwing", () => {
    const dir = enableShadow();
    appendShadowLog({ leaseId: "lease-unknown", query: { label: "Settings" }, tapOk: false });
    const lines = readShadowLines(dir);
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(body["shadow_pred"]).toMatchObject({ decision: "skipped" });
    expect(body["agree"]).toBeNull();
  });
});

describe("never-throw posture (M3)", () => {
  it("a throwing predictor yields an error marker and the tap result stands", () => {
    enableShadow();
    noteShadowUi("lease-1", AX_UI);
    const input = { leaseId: "lease-1", query: { label: "Settings" }, tapOk: true };
    let extra: Record<string, unknown> | null = null;
    expect(() => {
      extra = buildShadowExtra(input, new ThrowingPredictor());
    }).not.toThrow();
    expect(extra?.["shadow_pred"]).toBe("error");
    expect(extra?.["shadow_agree"]).toBeNull();
    expect(() => appendShadowLog(input, new ThrowingPredictor())).not.toThrow();
  });

  it("unwritable destination never throws and returns null extra", () => {
    enableShadow();
    noteShadowUi("lease-1", AX_UI);
    const blocker = path.join(tmpDir("sim-mcp-shadow-block-"), "file");
    fs.writeFileSync(blocker, "x");
    const badDir = path.join(blocker, "sub");
    expect(() =>
      appendShadowLog({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true, dirOverride: badDir }),
    ).not.toThrow();
    // buildShadowExtra does no I/O, so it still evaluates.
    expect(
      buildShadowExtra({ leaseId: "lease-1", query: { label: "Settings" }, tapOk: true })?.["shadow_pred"],
    ).toBe("predict:Settings#0");
  });
});

describe("caps and bounds (M3)", () => {
  it("long label echoes stay capped and lines stay under 4096B", () => {
    const dir = enableShadow();
    const longLabel = `L${"x".repeat(5000)}`;
    const ui = JSON.stringify([{ AXLabel: longLabel }]);
    noteShadowUi("lease-1", ui);
    const extra = buildShadowExtra({ leaseId: "lease-1", query: { label: longLabel }, tapOk: true });
    const marker = extra?.["shadow_pred"];
    expect(typeof marker).toBe("string");
    expect((marker as string).length).toBeLessThanOrEqual(SHADOW_ECHO_MAX_CHARS + 32);
    expect(extra?.["shadow_agree"]).toBe(true);
    appendShadowLog({ leaseId: "lease-1", query: { label: longLabel }, tapOk: true });
    for (const line of readShadowLines(dir)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThan(TRACE_EVENT_MAX_BYTES);
    }
  });

  it("oversized UI payloads are head-capped in the cache", () => {
    enableShadow();
    const big = `[{"AXLabel":"Pad","pad":"${"y".repeat(SHADOW_UI_MAX_CHARS + 1000)}"}]`;
    noteShadowUi("lease-1", big);
    // Head truncation breaks JSON parsing, so prediction abstains invalid-ui.
    const extra = buildShadowExtra({ leaseId: "lease-1", query: { label: "Pad" }, tapOk: true });
    expect(extra?.["shadow_pred"]).toBe("abstain:invalid-ui");
    expect(extra?.["shadow_agree"]).toBe(false);
  });

  it("the lease cache evicts FIFO past its cap", () => {
    enableShadow();
    for (let i = 0; i < LAST_SHADOW_UI_MAX_LEASES + 1; i++) {
      noteShadowUi(`lease-${i}`, AX_UI);
    }
    expect(
      buildShadowExtra({ leaseId: "lease-0", query: { label: "Settings" }, tapOk: true })?.["shadow_pred"],
    ).toBe("skipped");
    expect(
      buildShadowExtra({
        leaseId: `lease-${LAST_SHADOW_UI_MAX_LEASES}`,
        query: { label: "Settings" },
        tapOk: true,
      })?.["shadow_agree"],
    ).toBe(true);
  });
});

describe("never acts (M3)", () => {
  it("shadow modules import only node builtins, trace caps, and baseline types", () => {
    const allowed = new Set([
      "node:fs",
      "node:os",
      "node:path",
      "./eval-baseline.js",
      "./shadow-predictor.js",
      "./trace.js",
    ]);
    for (const file of ["src/shadow.ts", "src/shadow-predictor.ts"]) {
      const raw = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const text = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      expect(text).not.toMatch(/\b(fetch|Runner|child_process|node:http|axios)\b/);
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        expect(allowed.has(match[1] as string), `${file} imports ${match[1]}`).toBe(true);
      }
    }
  });
});
