import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TAP_ECHO_MAX_CHARS,
  buildTapEchoExtra,
  buildTapFailureExtra,
  clearLastDescribe,
  isSnapshotEnabled,
  lastDescribeFor,
  parseTapEcho,
  resolveSnapshotDir,
  saveDescribeSnapshot,
  saveShotLink,
} from "../src/snapshot.js";
import { appendTrace } from "../src/trace.js";

const SNAPSHOT_KEYS = ["SIM_MCP_SNAPSHOT", "SIM_MCP_SNAPSHOT_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of SNAPSHOT_KEYS) savedEnv[k] = process.env[k];
  for (const k of SNAPSHOT_KEYS) delete process.env[k];
  clearLastDescribe();
});

afterEach(() => {
  for (const k of SNAPSHOT_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearLastDescribe();
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Tiny AX fixture (well under the 4096B data cap). */
const AX_UI = JSON.stringify([
  { AXLabel: "Settings", AXUniqueId: "settings", type: "Button", frame: { x: 1, y: 2, width: 3, height: 4 } },
]);

function enableSnapshots(): string {
  const dir = tmpDir("sim-mcp-snapshot-");
  process.env.SIM_MCP_SNAPSHOT = "1";
  process.env.SIM_MCP_SNAPSHOT_DIR = dir;
  return dir;
}

describe("snapshot gate (M1)", () => {
  it("is off by default and only \"1\" enables it", () => {
    expect(isSnapshotEnabled()).toBe(false);
    process.env.SIM_MCP_SNAPSHOT = "true";
    expect(isSnapshotEnabled()).toBe(false);
    process.env.SIM_MCP_SNAPSHOT = "";
    expect(isSnapshotEnabled()).toBe(false);
    process.env.SIM_MCP_SNAPSHOT = "1";
    expect(isSnapshotEnabled()).toBe(true);
  });

  it("resolves destination: override wins over env over default", () => {
    process.env.SIM_MCP_SNAPSHOT_DIR = path.join("tmp", "env");
    expect(resolveSnapshotDir(path.join("tmp", "override"))).toBe(path.join("tmp", "override"));
    expect(resolveSnapshotDir()).toBe(path.join("tmp", "env"));
    delete process.env.SIM_MCP_SNAPSHOT_DIR;
    expect(resolveSnapshotDir()).toContain("sim-mcp-snapshots");
  });
});

describe("describe snapshots (M1)", () => {
  it("writes the full payload with a stable id when on", () => {
    const dir = enableSnapshots();
    const ref = saveDescribeSnapshot({ leaseId: "lease-1", ui: AX_UI, format: "full", truncated: false });
    expect(ref).not.toBeNull();
    expect(ref!.id).toMatch(/^describe-\d+-/);
    expect(ref!.file).toBe(path.join(dir, "describes", `${ref!.id}.json`));
    const body = JSON.parse(fs.readFileSync(ref!.file, "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ id: ref!.id, leaseId: "lease-1", format: "full", truncated: false, ui_len: AX_UI.length, ui: AX_UI });
    expect(lastDescribeFor("lease-1")).toBe(ref!.id);
  });

  it("writes nothing when the gate is off", () => {
    const dir = tmpDir("sim-mcp-snapshot-off-");
    process.env.SIM_MCP_SNAPSHOT_DIR = dir;
    expect(saveDescribeSnapshot({ leaseId: "lease-1", ui: AX_UI, format: "full", truncated: false })).toBeNull();
    expect(buildTapEchoExtra("tapped", { leaseId: "lease-1" })).toBeNull();
    expect(saveShotLink({ leaseId: "lease-1", shotPath: "a.png" })).toBeNull();
    expect(fs.existsSync(path.join(dir, "describes"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "taps"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "shots"))).toBe(false);
    expect(lastDescribeFor("lease-1")).toBeNull();
  });

  it("never throws when the destination is unwritable", () => {
    const dir = tmpDir("sim-mcp-snapshot-ro-");
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    process.env.SIM_MCP_SNAPSHOT = "1";
    process.env.SIM_MCP_SNAPSHOT_DIR = path.join(blocker, "snaps");
    expect(saveDescribeSnapshot({ leaseId: "l", ui: "[]", format: "full", truncated: false })).toBeNull();
    expect(buildTapEchoExtra("x".repeat(1000), { leaseId: "l" })).not.toBeNull(); // inline echo survives; sidecar skipped
    expect(saveShotLink({ leaseId: "l", shotPath: "a.png" })).toBeNull();
  });
});

describe("tap echo (M1)", () => {
  it("inlines short output with resolved coords and no sidecar", () => {
    const dir = enableSnapshots();
    const extra = buildTapEchoExtra("Tapped (123, 456)", { leaseId: "lease-1" });
    expect(extra).toEqual({ tap_echo: "Tapped (123, 456)", tap_x: 123, tap_y: 456 });
    expect(fs.existsSync(path.join(dir, "taps"))).toBe(false);
  });

  it("spills long output to a sidecar and references its id", () => {
    const dir = enableSnapshots();
    const output = `tapped ok ${"z".repeat(1000)}`; // >500 chars, <4096 bytes
    const extra = buildTapEchoExtra(output, { leaseId: "lease-1" });
    expect(extra).not.toBeNull();
    expect(typeof extra!["tap_echo"]).toBe("string");
    expect((extra!["tap_echo"] as string).length).toBeLessThan(TAP_ECHO_MAX_CHARS + 100);
    expect(extra!["tap_echo_id"]).toMatch(/^tap-\d+-/);
    const sidecar = path.join(dir, "taps", `${extra!["tap_echo_id"] as string}.json`);
    const body = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ output_len: output.trim().length, truncated: false });
    expect(body["output"]).toBe(output.trim());
  });

  it("parses JSON, labeled, and parenthesized coords (pure)", () => {
    expect(parseTapEcho('{"x": 10.5, "y": 20}')).toMatchObject({ x: 10.5, y: 20 });
    expect(parseTapEcho("tapped x=5 y=6")).toMatchObject({ x: 5, y: 6 });
    expect(parseTapEcho("Tapped (7, 8)")).toMatchObject({ x: 7, y: 8 });
    // Bare number pairs are not coords (no false positives).
    const plain = parseTapEcho("retried 5, failed 3 times");
    expect(plain).toEqual({ echo: "retried 5, failed 3 times" });
    expect(parseTapEcho("  spaced  ").echo).toBe("spaced");
  });
});

describe("tap failure echo (M1)", () => {
  it("returns null and writes nothing when the gate is off", () => {
    const dir = tmpDir("sim-mcp-snapshot-failoff-");
    process.env.SIM_MCP_SNAPSHOT_DIR = dir;
    expect(buildTapFailureExtra(new Error("No accessibility element matched"), { leaseId: "l", selectors: { label: "x" } })).toBeNull();
    expect(fs.existsSync(path.join(dir, "taps"))).toBe(false);
  });

  it("records ok:false with selectors and a capped error excerpt", () => {
    enableSnapshots();
    const extra = buildTapFailureExtra(new Error("No accessibility element matched label"), {
      leaseId: "lease-1",
      selectors: { label: "Missing", element_type: "Button" },
    });
    expect(extra).toMatchObject({ tap_ok: false, label: "Missing", element_type: "Button" });
    expect(extra!["tap_echo"]).toBe("No accessibility element matched label");
    expect(extra!["tap_echo_id"]).toBeUndefined();
  });

  it("spills long errors to a sidecar and never throws on odd input", () => {
    const dir = enableSnapshots();
    const extra = buildTapFailureExtra(new Error(`boom ${"z".repeat(1000)}`), { leaseId: "lease-1" });
    expect(extra).toMatchObject({ tap_ok: false });
    expect(extra!["tap_echo_id"]).toMatch(/^tap-\d+-/);
    const sidecar = path.join(dir, "taps", `${extra!["tap_echo_id"] as string}.json`);
    const body = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ leaseId: "lease-1" });
    expect(JSON.stringify(body)).not.toMatch(/[0-9A-Fa-f-]{36}/);
    // Non-Error input and missing selectors are tolerated.
    expect(buildTapFailureExtra("plain string", { leaseId: "l" })).toMatchObject({ tap_ok: false, tap_echo: "plain string" });
    expect(buildTapFailureExtra(undefined, { leaseId: "l" })).toMatchObject({ tap_ok: false });
  });

  it("scrubs raw UDIDs from tap and shot sidecars (real-device shape)", () => {
    const dir = enableSnapshots();
    const udid = "6D00435A-80AC-4D39-A285-C11FC70C7C64";
    const extra = buildTapFailureExtra(
      new Error(`axe tap --udid ${udid} --label x failed (code 1): Warning: ${"z".repeat(600)}`),
      { leaseId: "lease-1" },
    );
    const tapFile = path.join(dir, "taps", `${extra!["tap_echo_id"] as string}.json`);
    const tapBody = fs.readFileSync(tapFile, "utf8");
    expect(tapBody).not.toContain(udid);
    expect(tapBody).toContain("udid:");
    const shot = saveShotLink({ leaseId: "lease-1", shotPath: path.join(dir, `${udid}-123.png`) })!;
    const shotFile = path.join(dir, "shots", `${shot["shot_id"] as string}.json`);
    const shotBody = fs.readFileSync(shotFile, "utf8");
    expect(shotBody).not.toContain(udid);
    expect(shotBody).toContain("udid:");
  });
});

describe("shot linkage (M1)", () => {
  it("links a shot to the last describe id for the lease", () => {
    const dir = enableSnapshots();
    const snap = saveDescribeSnapshot({ leaseId: "lease-1", ui: AX_UI, format: "compact", truncated: true });
    const extra = saveShotLink({ leaseId: "lease-1", shotPath: path.join(dir, "U1-123.png") });
    expect(extra).toEqual({ shot_id: expect.stringMatching(/^shot-\d+-/), describe_id: snap!.id });
    const sidecar = path.join(dir, "shots", `${extra!["shot_id"] as string}.json`);
    const body = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ leaseId: "lease-1", describe_id: snap!.id, path: "U1-123.png" });
  });

  it("omits describe_id when the lease has no describe yet", () => {
    enableSnapshots();
    expect(saveShotLink({ leaseId: "lease-9", shotPath: "U1-1.png" })).toEqual({
      shot_id: expect.stringMatching(/^shot-\d+-/),
    });
  });
});

describe("snapshot trace caps (M1)", () => {
  it("keeps every extra fragment far below the 2000-char field cap", () => {
    enableSnapshots();
    const snap = saveDescribeSnapshot({ leaseId: "lease-1", ui: AX_UI, format: "full", truncated: false });
    const describeExtra = { truncated: false, format: "full", snapshot_id: snap!.id };
    const tapExtra = buildTapEchoExtra(`ok ${"y".repeat(1000)}`, { leaseId: "lease-1" })!;
    const shotExtra = saveShotLink({ leaseId: "lease-1", shotPath: "U1-1.png" })!;
    const failExtra = buildTapFailureExtra(new Error(`no match ${"e".repeat(1000)}`), {
      leaseId: "lease-1",
      selectors: { label: "L".repeat(500) },
    })!;
    for (const extra of [describeExtra, tapExtra, shotExtra, failExtra]) {
      for (const v of Object.values(extra)) {
        if (typeof v === "string") expect(v.length).toBeLessThan(2000);
      }
    }
    // End to end: a trace line carrying each fragment stays under 4096 bytes.
    const traceDir = tmpDir("sim-mcp-snapshot-trace-");
    const now = Date.now();
    appendTrace(traceDir, { t: now, leaseId: "lease-1", tool: "ui_describe", summary: "describe", extra: describeExtra });
    appendTrace(traceDir, { t: now, leaseId: "lease-1", tool: "ui_tap", summary: "tap", extra: tapExtra });
    appendTrace(traceDir, { t: now, leaseId: "lease-1", tool: "ui_screenshot", summary: "shot", extra: shotExtra });
    appendTrace(traceDir, { t: now, leaseId: "lease-1", tool: "ui_tap", summary: "tap failed", extra: failExtra });
    for (const line of fs.readFileSync(path.join(traceDir, "trace.jsonl"), "utf8").trim().split("\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThan(4096);
    }
  });
});
