import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runner, withTrace } from "../src/exec.js";
import { Orchestrator } from "../src/orchestrator.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { appendTrace, resolveTraceFile, scrubText, scrubUdid } from "../src/trace.js";

/** stubRunner pattern reused from test/netproxy.test.ts. */
function stubRunner(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }): Runner & {
  calls: { bin: string; args: string[] }[];
} {
  const calls: { bin: string; args: string[] }[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return handler(bin, args);
  }) as Runner & { calls: { bin: string; args: string[] }[] };
  run.calls = calls;
  return run;
}

class FakeFleet implements FleetOps {
  constructor(private devices: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devices.map((d) => ({ ...d }));
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

function makeOrch(traceDir?: string): Orchestrator {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-exec-trace-")), "state.json");
  const fleet = new FakeFleet([
    { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
  ]);
  return new Orchestrator(fleet, Store.load(file), { defaultTtlMs: 60_000, traceDir });
}

async function acquireLeaseId(orch: Orchestrator): Promise<string> {
  const res = await orch.acquire({ sessionId: "s1", client: "test", slim: false });
  if (!res.ok || res.queued) throw new Error("expected an immediate lease");
  return res.lease.leaseId;
}

const TRACE_KEYS = ["SIM_MCP_TRACE", "SIM_MCP_TRACE_FILE", "SIM_MCP_TRACE_DIR"] as const;
let savedTraceEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedTraceEnv = {};
  for (const k of TRACE_KEYS) savedTraceEnv[k] = process.env[k];
  for (const k of TRACE_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of TRACE_KEYS) {
    const v = savedTraceEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-exec-trace-")), name);
}

describe("exec trace (M1)", () => {
  it("writes one JSON line per spawn containing bin+argv when enabled", async () => {
    const file = tmpFile("trace.jsonl");
    process.env.SIM_MCP_TRACE = "1";
    process.env.SIM_MCP_TRACE_FILE = file;
    const stub = stubRunner(() => ({ stdout: "ok", stderr: "" }));
    const res = await withTrace(stub)("xcrun", ["simctl", "list"]);
    expect(res).toEqual({ stdout: "ok", stderr: "" });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: "exec", bin: "xcrun", argv: ["simctl", "list"] });
    expect(Buffer.byteLength(lines[0]!, "utf8")).toBeLessThan(4096);
    await withTrace(stub)("axe", ["describe-ui"]);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("creates no file when the gate is off", async () => {
    const file = tmpFile("trace.jsonl");
    process.env.SIM_MCP_TRACE_FILE = file;
    const stub = stubRunner(() => ({ stdout: "ok", stderr: "" }));
    await withTrace(stub)("xcrun", ["simctl", "list"]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never throws when the trace destination is unwritable", async () => {
    const dir = path.dirname(tmpFile("x"));
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    process.env.SIM_MCP_TRACE = "1";
    process.env.SIM_MCP_TRACE_FILE = path.join(blocker, "trace.jsonl");
    const stub = stubRunner(() => ({ stdout: "fine", stderr: "" }));
    const res = await withTrace(stub)("xcrun", ["simctl", "list"]);
    expect(res).toEqual({ stdout: "fine", stderr: "" });
  });

  it("leaves argv untouched with trace on vs off", async () => {
    const args = ["tap", "--label", "Sign In"];
    const off = stubRunner(() => ({ stdout: "", stderr: "" }));
    await withTrace(off)("axe", args);
    process.env.SIM_MCP_TRACE = "1";
    process.env.SIM_MCP_TRACE_FILE = tmpFile("trace.jsonl");
    const on = stubRunner(() => ({ stdout: "", stderr: "" }));
    await withTrace(on)("axe", args);
    expect(on.calls).toEqual(off.calls);
    expect(args).toEqual(["tap", "--label", "Sign In"]);
  });
});

describe("trace scrub and caps (M1)", () => {
  it("hashes UDIDs and redacts secrets, never persisting raw values", () => {
    const udid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    const hash = scrubUdid(udid);
    expect(hash).toMatch(/^udid:[0-9a-f]{12}$/);
    const scrubbed = scrubText(`using ${udid} with token: abc123 password=hunter2`);
    expect(scrubbed).not.toContain(udid);
    expect(scrubbed).toContain(hash);
    expect(scrubbed).not.toContain("abc123");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("caps fields at 2000 chars and total events under 4096 bytes", () => {
    const dir = path.dirname(tmpFile("x"));
    appendTrace(dir, {
      t: Date.now(),
      leaseId: "lease-1",
      tool: "ui_describe",
      summary: "x".repeat(10_000),
      extra: { blob: "y".repeat(10_000) },
    });
    const line = fs.readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim();
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(4096);
    const evt = JSON.parse(line) as { summary: string };
    expect(evt.summary).toContain("…[truncated ");
    expect(evt.summary.length).toBeLessThan(2300);
  });

  it("resolves destination: explicit file wins over dir", () => {
    process.env.SIM_MCP_TRACE_FILE = path.join("tmp", "x", "t.jsonl");
    expect(resolveTraceFile(path.join("tmp", "override"))).toBe(path.join("tmp", "x", "t.jsonl"));
    delete process.env.SIM_MCP_TRACE_FILE;
    process.env.SIM_MCP_TRACE_DIR = path.join("tmp", "d");
    expect(resolveTraceFile()).toBe(path.join("tmp", "d", "trace.jsonl"));
    expect(resolveTraceFile(path.join("tmp", "override"))).toBe(path.join("tmp", "override", "trace.jsonl"));
  });
});

describe("action trace (M1)", () => {
  it("logAction appends a JSONL line when tracing is on", async () => {
    const file = tmpFile("trace.jsonl");
    process.env.SIM_MCP_TRACE = "1";
    process.env.SIM_MCP_TRACE_FILE = file;
    const orch = makeOrch();
    const leaseId = await acquireLeaseId(orch);
    await orch.logAction(leaseId, "ui_tap", "tap (10,20)");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ leaseId, tool: "ui_tap", summary: "tap (10,20)" });
  });

  it("logAction writes nothing when tracing is off but keeps the ring", async () => {
    const file = tmpFile("trace.jsonl");
    process.env.SIM_MCP_TRACE_FILE = file;
    const orch = makeOrch();
    const leaseId = await acquireLeaseId(orch);
    await orch.logAction(leaseId, "ui_tap", "tap (10,20)");
    expect(fs.existsSync(file)).toBe(false);
    expect(orch.leaseActions(leaseId)).toHaveLength(1);
  });

  it("uses the orchestrator traceDir when no explicit file is set", async () => {
    const dir = path.dirname(tmpFile("x"));
    process.env.SIM_MCP_TRACE = "1";
    const orch = makeOrch(dir);
    const leaseId = await acquireLeaseId(orch);
    await orch.logAction(leaseId, "ui_tap", "tap");
    expect(fs.existsSync(path.join(dir, "trace.jsonl"))).toBe(true);
  });
});
