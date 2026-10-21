import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselinePrediction, BaselineState } from "../src/eval-baseline.js";
import {
  V1_ALLOWLIST,
  isM4AllowlistEntry,
  matchM4Allowlist,
  parseM4AllowlistFile,
} from "../src/m4-allowlist.js";
import {
  LAST_M4_UI_MAX_LEASES,
  M4_DEFAULT_FRESHNESS_MS,
  M4_ECHO_MAX_CHARS,
  appendM4Audit,
  clearM4Ui,
  evaluateM4,
  isM4DryRun,
  isM4Enabled,
  m4FreshnessMs,
  maybeM4Decide,
  noteM4Ui,
  resolveM4Allowlist,
  resolveM4File,
} from "../src/m4.js";
import type { ShadowPredictor } from "../src/shadow-predictor.js";
import { TRACE_EVENT_MAX_BYTES } from "../src/trace.js";

const M4_KEYS = [
  "SIM_MCP_M4",
  "SIM_MCP_M4_DRY_RUN",
  "SIM_MCP_M4_FRESHNESS_MS",
  "SIM_MCP_M4_FILE",
  "SIM_MCP_M4_DIR",
  "SIM_MCP_M4_ALLOWLIST_FILE",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of M4_KEYS) savedEnv[k] = process.env[k];
  for (const k of M4_KEYS) delete process.env[k];
  clearM4Ui();
});

afterEach(() => {
  for (const k of M4_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearM4Ui();
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Tiny Settings-main AX fixture with unique rows. */
const SETTINGS_UI = JSON.stringify([
  {
    AXLabel: "Settings",
    children: [
      { AXLabel: "General" },
      { AXLabel: "Display & Brightness" },
      { AXLabel: "Wallpaper" },
      { AXLabel: "Accessibility" },
      { AXLabel: "Battery" },
    ],
  },
]);

const AMBIGUOUS_UI = JSON.stringify([{ AXLabel: "General" }, { AXLabel: "General" }]);

function enableM4(): string {
  const dir = tmpDir("sim-mcp-m4-");
  process.env.SIM_MCP_M4 = "1";
  process.env.SIM_MCP_M4_DIR = dir;
  return dir;
}

function readM4Lines(dir: string): string[] {
  const file = path.join(dir, "m4-audit.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

class ThrowingPredictor implements ShadowPredictor {
  predict(_state: BaselineState): BaselinePrediction {
    throw new Error("boom");
  }
}

/** Deterministic stub: always predicts the queried label at index 7. */
class StubPredictor implements ShadowPredictor {
  predict(state: BaselineState): BaselinePrediction {
    return {
      decision: "predict",
      target: { label: state.query.label, id: state.query.id, index: 7 },
      confidence: 1,
    };
  }
}

describe("m4 gates and env parsing", () => {
  it("master gate is off by default and only \"1\" enables it", () => {
    expect(isM4Enabled()).toBe(false);
    process.env.SIM_MCP_M4 = "true";
    expect(isM4Enabled()).toBe(false);
    process.env.SIM_MCP_M4 = "";
    expect(isM4Enabled()).toBe(false);
    process.env.SIM_MCP_M4 = "1";
    expect(isM4Enabled()).toBe(true);
  });

  it("dry-run is on unless exactly \"0\"", () => {
    expect(isM4DryRun()).toBe(true);
    process.env.SIM_MCP_M4_DRY_RUN = "1";
    expect(isM4DryRun()).toBe(true);
    process.env.SIM_MCP_M4_DRY_RUN = "yes";
    expect(isM4DryRun()).toBe(true);
    process.env.SIM_MCP_M4_DRY_RUN = "";
    expect(isM4DryRun()).toBe(true);
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    expect(isM4DryRun()).toBe(false);
  });

  it("freshness falls back to the default on garbage, zero, or negative", () => {
    expect(m4FreshnessMs()).toBe(M4_DEFAULT_FRESHNESS_MS);
    process.env.SIM_MCP_M4_FRESHNESS_MS = "5000";
    expect(m4FreshnessMs()).toBe(5000);
    for (const bad of ["abc", "0", "-5", "12.5x", ""]) {
      process.env.SIM_MCP_M4_FRESHNESS_MS = bad;
      expect(m4FreshnessMs()).toBe(M4_DEFAULT_FRESHNESS_MS);
    }
  });

  it("resolves destination: file wins over override over env dir over default", () => {
    const file = path.join("tmp", "custom.jsonl");
    process.env.SIM_MCP_M4_FILE = file;
    process.env.SIM_MCP_M4_DIR = path.join("tmp", "env");
    expect(resolveM4File(path.join("tmp", "override"))).toBe(file);
    delete process.env.SIM_MCP_M4_FILE;
    expect(resolveM4File(path.join("tmp", "override"))).toBe(path.join("tmp", "override", "m4-audit.jsonl"));
    expect(resolveM4File()).toBe(path.join("tmp", "env", "m4-audit.jsonl"));
    delete process.env.SIM_MCP_M4_DIR;
    expect(resolveM4File()).toContain("sim-mcp-m4");
  });
});

describe("gate OFF means zero change (M4)", () => {
  it("maybeM4Decide returns null even with auto:true; nothing cached; no audit file", () => {
    const dir = tmpDir("sim-mcp-m4-off-");
    process.env.SIM_MCP_M4_DIR = dir;
    noteM4Ui("lease-1", SETTINGS_UI, "describe-1");
    expect(maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true })).toBeNull();
    // Enable afterwards: nothing was cached while off.
    process.env.SIM_MCP_M4 = "1";
    const decided = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(decided?.decision).toBe("deny");
    expect(decided?.reason).toBe("no-describe");
    expect(fs.existsSync(path.join(dir, "m4-audit.jsonl"))).toBe(false);
  });

  it("manual taps (auto absent/false) return null even with the gate on", () => {
    enableM4();
    noteM4Ui("lease-1", SETTINGS_UI);
    expect(maybeM4Decide({ leaseId: "lease-1", query: { label: "General" } })).toBeNull();
    expect(maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: false })).toBeNull();
  });

  it("appendM4Audit writes no file when off", () => {
    const dir = tmpDir("sim-mcp-m4-off-");
    process.env.SIM_MCP_M4_DIR = dir;
    const result = evaluateM4({ leaseId: "lease-1", query: { label: "General" } });
    appendM4Audit({ leaseId: "lease-1", query: { label: "General" }, result, tapped: false });
    expect(fs.existsSync(path.join(dir, "m4-audit.jsonl"))).toBe(false);
  });
});

describe("freshness gate (M4)", () => {
  it("no entry denies with no-describe and omits later gate blocks", () => {
    enableM4();
    const result = maybeM4Decide({ leaseId: "lease-unknown", query: { label: "General" }, auto: true });
    expect(result?.decision).toBe("deny");
    expect(result?.reason).toBe("no-describe");
    expect(result?.wouldTap).toBe(false);
    expect(result?.gates).toHaveProperty("fresh");
    expect(result?.gates).not.toHaveProperty("predict");
    expect(result?.gates).not.toHaveProperty("allow");
  });

  it("aged entry denies with stale", () => {
    enableM4();
    noteM4Ui("lease-1", SETTINGS_UI);
    process.env.SIM_MCP_M4_FRESHNESS_MS = "1";
    const start = Date.now();
    while (Date.now() - start < 3) {
      // Spin until the 1ms window lapses.
    }
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(result?.reason).toBe("stale");
    expect(result?.gates["fresh"]).toMatchObject({ pass: false });
  });

  it("another lease's entry does not satisfy freshness", () => {
    enableM4();
    noteM4Ui("lease-1", SETTINGS_UI);
    const result = maybeM4Decide({ leaseId: "lease-2", query: { label: "General" }, auto: true });
    expect(result?.reason).toBe("no-describe");
  });

  it("fresh entry passes with age and describe id", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    noteM4Ui("lease-1", SETTINGS_UI, "describe-9");
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(result?.decision).toBe("allow");
    expect(result?.gates["fresh"]).toMatchObject({ pass: true, describeId: "describe-9" });
    expect(typeof (result?.gates["fresh"] as Record<string, unknown>)["ageMs"]).toBe("number");
  });

  it("the lease cache evicts FIFO past its cap", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    for (let i = 0; i < LAST_M4_UI_MAX_LEASES + 1; i++) {
      noteM4Ui(`lease-${i}`, SETTINGS_UI);
    }
    expect(
      maybeM4Decide({ leaseId: "lease-0", query: { label: "General" }, auto: true })?.reason,
    ).toBe("no-describe");
    expect(
      maybeM4Decide({ leaseId: `lease-${LAST_M4_UI_MAX_LEASES}`, query: { label: "General" }, auto: true })
        ?.decision,
    ).toBe("allow");
  });
});

describe("predictor gate (M4)", () => {
  it("abstains map to deny:abstain:<reason>", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    noteM4Ui("lease-amb", AMBIGUOUS_UI);
    noteM4Ui("lease-ok", SETTINGS_UI);
    noteM4Ui("lease-bad", "not json");
    expect(
      maybeM4Decide({ leaseId: "lease-amb", query: { label: "General" }, auto: true })?.reason,
    ).toBe("abstain:ambiguous");
    expect(
      maybeM4Decide({ leaseId: "lease-ok", query: { label: "Missing" }, auto: true })?.reason,
    ).toBe("abstain:no-match");
    expect(maybeM4Decide({ leaseId: "lease-ok", query: {}, auto: true })?.reason).toBe(
      "abstain:empty-query",
    );
    expect(
      maybeM4Decide({ leaseId: "lease-bad", query: { label: "General" }, auto: true })?.reason,
    ).toBe("abstain:invalid-ui");
  });

  it("accepts an injectable predictor for determinism", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    noteM4Ui("lease-1", "not json at all");
    const result = evaluateM4({ leaseId: "lease-1", query: { label: "General" } }, new StubPredictor());
    expect(result.decision).toBe("allow");
    expect(result.gates["predict"]).toMatchObject({ decision: "predict", confidence: 1 });
  });
});

describe("allowlist gate (M4)", () => {
  it("v1 entries allow exactly; case/substring/unknown deny", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    noteM4Ui("lease-1", SETTINGS_UI);
    for (const label of ["General", "Display & Brightness", "Wallpaper", "Accessibility", "Battery"]) {
      expect(maybeM4Decide({ leaseId: "lease-1", query: { label }, auto: true })?.decision).toBe("allow");
    }
    // "Settings" is allowlisted (home bootstrap icon), so it allows too.
    expect(maybeM4Decide({ leaseId: "lease-1", query: { label: "Settings" }, auto: true })?.decision).toBe(
      "allow",
    );
    // Unknown/case/substring variants fail at the predictor first (exact
    // match), so use the stub to isolate the allowlist comparison.
    for (const label of ["Bluetooth", "general", "GENERAL", "Gener", "General "] ) {
      const result = evaluateM4({ leaseId: "lease-1", query: { label } }, new StubPredictor());
      expect(result.reason).toBe("not-allowlisted");
    }
  });

  it("entry with id requires an id match", () => {
    expect(matchM4Allowlist([{ screen: "home", label: "Settings", id: "a" }], { label: "Settings" })).toBeNull();
    expect(
      matchM4Allowlist([{ screen: "home", label: "Settings", id: "a" }], { label: "Settings", id: "b" }),
    ).toBeNull();
    expect(
      matchM4Allowlist([{ screen: "home", label: "Settings", id: "a" }], { label: "Settings", id: "a" }),
    ).toMatchObject({ screen: "home", label: "Settings" });
    expect(matchM4Allowlist(V1_ALLOWLIST, { label: "General" })).toMatchObject({ screen: "settings-main" });
    expect(matchM4Allowlist(V1_ALLOWLIST, {})).toBeNull();
  });

  it("custom allowlist file overrides the builtin list", () => {
    const dir = enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    const file = path.join(dir, "allow.json");
    fs.writeFileSync(file, JSON.stringify([{ screen: "home", label: "Custom" }]), "utf8");
    process.env.SIM_MCP_M4_ALLOWLIST_FILE = file;
    noteM4Ui("lease-1", JSON.stringify([{ AXLabel: "Custom" }, { AXLabel: "General" }]));
    const allowed = maybeM4Decide({ leaseId: "lease-1", query: { label: "Custom" }, auto: true });
    expect(allowed?.decision).toBe("allow");
    expect(allowed?.allowlist).toBe("custom");
    // Builtin General is no longer listed.
    expect(maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true })?.reason).toBe(
      "not-allowlisted",
    );
  });

  it("malformed custom file fails closed (deny-all, allowlist invalid)", () => {
    const dir = enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    const file = path.join(dir, "allow.json");
    fs.writeFileSync(file, "{not json", "utf8");
    process.env.SIM_MCP_M4_ALLOWLIST_FILE = file;
    noteM4Ui("lease-1", SETTINGS_UI);
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(result?.reason).toBe("not-allowlisted");
    expect(result?.allowlist).toBe("invalid");
    // Missing file and wrong shape also fail closed.
    process.env.SIM_MCP_M4_ALLOWLIST_FILE = path.join(dir, "absent.json");
    expect(resolveM4Allowlist().source).toBe("invalid");
    fs.writeFileSync(file, JSON.stringify([{ screen: "nope", label: "X" }]), "utf8");
    process.env.SIM_MCP_M4_ALLOWLIST_FILE = file;
    expect(resolveM4Allowlist().source).toBe("invalid");
    expect(parseM4AllowlistFile(JSON.stringify({ label: "X" }))).toBeNull();
    expect(isM4AllowlistEntry({ screen: "home", label: "X", id: 7 })).toBe(false);
  });
});

describe("dry-run gate (M4)", () => {
  it("default and \"1\" convert allow to deny:dry-run with wouldTap", () => {
    enableM4();
    noteM4Ui("lease-1", SETTINGS_UI);
    for (const value of [undefined, "1"] as const) {
      if (value === undefined) delete process.env.SIM_MCP_M4_DRY_RUN;
      else process.env.SIM_MCP_M4_DRY_RUN = value;
      const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
      expect(result?.decision).toBe("deny");
      expect(result?.reason).toBe("dry-run");
      expect(result?.wouldTap).toBe(true);
      expect(result?.dryRun).toBe(true);
      // All earlier gates passed and are recorded.
      expect(result?.gates["allow"]).toMatchObject({ pass: true });
    }
  });

  it("exact \"0\" lets a passing evaluation allow", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    noteM4Ui("lease-1", SETTINGS_UI);
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(result?.decision).toBe("allow");
    expect(result?.reason).toBe("allow");
    expect(result?.wouldTap).toBe(false);
    expect(result?.dryRun).toBe(false);
  });
});

describe("m4 audit log", () => {
  it("appends one JSON line per autonomous request with the decision record", () => {
    const dir = enableM4();
    noteM4Ui("lease-1", SETTINGS_UI, "describe-1");
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(result?.reason).toBe("dry-run");
    appendM4Audit({ leaseId: "lease-1", query: { label: "General" }, result: result!, tapped: false });
    const lines = readM4Lines(dir);
    expect(lines).toHaveLength(1);
    for (const line of lines) expect(Buffer.byteLength(line, "utf8")).toBeLessThan(TRACE_EVENT_MAX_BYTES);
    const body = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(body["tool"]).toBe("ui_tap");
    expect(body["auto"]).toBe(true);
    expect(body["decision"]).toBe("deny");
    expect(body["reason"]).toBe("dry-run");
    expect(body["dryRun"]).toBe(true);
    expect(body["wouldTap"]).toBe(true);
    expect(body["tapped"]).toBe(false);
    expect(body["query"]).toMatchObject({ label: "General" });
    expect(body["gates"]).toMatchObject({ fresh: { pass: true } });
    expect(body).not.toHaveProperty("allowlist");
  });

  it("caps echoes at 200 chars and scrubs UDID runs", () => {
    const dir = enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    const udid = "12345678-9ABC-DEF0-1234-56789ABCDEF0";
    const longLabel = `General ${udid} ${"x".repeat(5000)}`;
    noteM4Ui("lease-1", JSON.stringify([{ AXLabel: longLabel }]));
    // Predictor passes (unique); the allowlist denies, but the audit echoes
    // still carry the scrubbed, capped label.
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: longLabel }, auto: true });
    expect(result?.reason).toBe("not-allowlisted");
    appendM4Audit({ leaseId: "lease-1", query: { label: longLabel }, result: result!, tapped: false });
    const lines = readM4Lines(dir);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0] as string, "utf8")).toBeLessThan(TRACE_EVENT_MAX_BYTES);
    const body = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const query = body["query"] as Record<string, string>;
    expect(query["label"].length).toBeLessThanOrEqual(M4_ECHO_MAX_CHARS);
    expect(query["label"]).not.toContain(udid);
    expect(query["label"]).toContain("udid:");
    const predict = (body["gates"] as Record<string, Record<string, unknown>>)["predict"];
    const target = predict["target"] as Record<string, string>;
    expect(target["label"].length).toBeLessThanOrEqual(M4_ECHO_MAX_CHARS);
    expect(target["label"]).not.toContain(udid);
  });
});

describe("never-throw posture (M4)", () => {
  it("a throwing predictor denies instead of throwing", () => {
    enableM4();
    process.env.SIM_MCP_M4_DRY_RUN = "0";
    noteM4Ui("lease-1", SETTINGS_UI);
    let result: ReturnType<typeof evaluateM4> | null = null;
    expect(() => {
      result = evaluateM4({ leaseId: "lease-1", query: { label: "General" } }, new ThrowingPredictor());
    }).not.toThrow();
    expect(result?.decision).toBe("deny");
    expect(result?.reason).toBe("predict-error");
  });

  it("unwritable audit destination never throws", () => {
    enableM4();
    noteM4Ui("lease-1", SETTINGS_UI);
    const blocker = path.join(tmpDir("sim-mcp-m4-block-"), "file");
    fs.writeFileSync(blocker, "x");
    const badDir = path.join(blocker, "sub");
    const result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    expect(() =>
      appendM4Audit({ leaseId: "lease-1", query: { label: "General" }, result: result!, tapped: false, dirOverride: badDir }),
    ).not.toThrow();
  });

  it("garbage env values deny or fall back, never throw", () => {
    enableM4();
    process.env.SIM_MCP_M4_FRESHNESS_MS = "garbage";
    process.env.SIM_MCP_M4_DRY_RUN = "garbage";
    noteM4Ui("lease-1", SETTINGS_UI);
    let result: ReturnType<typeof maybeM4Decide> | undefined;
    expect(() => {
      result = maybeM4Decide({ leaseId: "lease-1", query: { label: "General" }, auto: true });
    }).not.toThrow();
    // Garbage dry-run is not exact "0", so dry-run stays on.
    expect(result?.reason).toBe("dry-run");
  });
});

describe("m4 module hygiene", () => {
  it("m4 modules import only node builtins, trace caps, baseline types, and each other", () => {
    const allowed = new Set([
      "node:fs",
      "node:os",
      "node:path",
      "./eval-baseline.js",
      "./m4-allowlist.js",
      "./shadow-predictor.js",
      "./trace.js",
    ]);
    for (const file of ["src/m4.ts", "src/m4-allowlist.ts"]) {
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
