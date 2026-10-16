import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecOptions, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

function stubRunner(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }): Runner & {
  calls: { bin: string; args: string[]; opts?: ExecOptions }[];
} {
  const calls: { bin: string; args: string[]; opts?: ExecOptions }[] = [];
  const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
    calls.push({ bin, args, opts });
    return handler(bin, args);
  }) as Runner & { calls: { bin: string; args: string[]; opts?: ExecOptions }[] };
  run.calls = calls;
  return run;
}

class FakeFleet implements FleetOps {
  constructor(private readonly devs: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devs.map((d) => ({ ...d }));
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

async function makeClient(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }) {
  const run = stubRunner(handler);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-xctrace-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    { defaultTtlMs: 60_000 },
  );
  const server = new McpServer({ name: "test", version: "0" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: run }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: run }),
    xctrace: new XCTrace({ runner: run }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const acquired = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
  if (!acquired.ok || acquired.queued) throw new Error("expected a lease");
  return { client, orch, run, leaseId: acquired.lease.leaseId };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

describe("XCTrace wrapper", () => {
  it("records all-processes with Time Profiler by default", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const res = await new XCTrace({ runner: run }).record("U1", "/tmp/x.trace");
    expect(res).toMatchObject({ path: "/tmp/x.trace", template: "Time Profiler" });
    expect(run.calls[0]).toMatchObject({
      bin: "xcrun",
      args: [
        "xctrace", "record", "--template", "Time Profiler", "--device", "U1",
        "--all-processes", "--time-limit", "5s", "--no-prompt", "--output", "/tmp/x.trace",
      ],
    });
    // Timeout covers the recording plus startup grace (device/template prep).
    expect(run.calls[0]?.opts?.timeoutMs).toBe((5 + 180) * 1000);
  });

  it("passes attach through instead of all-processes", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    await new XCTrace({ runner: run }).record("U1", "/tmp/x.trace", {
      attach: 1234,
      template: "System Trace",
      timeLimitSec: 10,
    });
    expect(run.calls[0]?.args).toEqual([
      "xctrace", "record", "--template", "System Trace", "--device", "U1",
      "--attach", "1234", "--time-limit", "10s", "--no-prompt", "--output", "/tmp/x.trace",
    ]);
    expect(run.calls[0]?.opts?.timeoutMs).toBe((10 + 180) * 1000);
  });

  it("rejects out-of-range durations without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const trace = new XCTrace({ runner: run });
    await expect(trace.record("U1", "/tmp/x.trace", { timeLimitSec: 0 })).rejects.toThrow(/duration_sec/i);
    await expect(trace.record("U1", "/tmp/x.trace", { timeLimitSec: 61 })).rejects.toThrow(/duration_sec/i);
    await expect(trace.record("U1", "/tmp/x.trace", { timeLimitSec: Number.NaN })).rejects.toThrow(/duration_sec/i);
    expect(run.calls).toHaveLength(0);
  });

  it("rejects conflicting or empty target selection without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const trace = new XCTrace({ runner: run });
    await expect(trace.record("U1", "/tmp/x.trace", { attach: 1, allProcesses: true })).rejects.toThrow(/either attach/i);
    await expect(trace.record("U1", "/tmp/x.trace", { allProcesses: false })).rejects.toThrow(/nothing to record/i);
    await expect(trace.record("U1", "/tmp/x.trace", { template: "  " })).rejects.toThrow(/template/i);
    await expect(trace.record("U1", "  ")).rejects.toThrow(/output path/i);
    await expect(trace.record("", "/tmp/x.trace")).rejects.toThrow(/udid/i);
    expect(run.calls).toHaveLength(0);
  });
});

describe("extras profile_trace tool", () => {
  it("records on the leased sim into output_dir and logs the action", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-trace-out-"));
    const { client, orch, run, leaseId } = await makeClient(() => ({ stdout: "", stderr: "" }));
    const res = await call(client, "profile_trace", {
      lease_id: leaseId,
      duration_sec: 7,
      template: "System Trace",
      output_dir: dir,
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, udid: "U1", template: "System Trace", duration_sec: 7 });
    const outPath = String(res.json.path);
    expect(outPath.startsWith(dir)).toBe(true);
    expect(outPath).toMatch(/U1-.*\.trace$/);
    expect(run.calls[0]?.args).toEqual([
      "xctrace", "record", "--template", "System Trace", "--device", "U1",
      "--all-processes", "--time-limit", "7s", "--no-prompt", "--output", outPath,
    ]);
    expect(orch.leaseActions(leaseId).map((a) => a.tool)).toContain("profile_trace");
  });

  it("defaults to Time Profiler, 5s, and the temp dir", async () => {
    const { client, run, leaseId } = await makeClient(() => ({ stdout: "", stderr: "" }));
    const res = await call(client, "profile_trace", { lease_id: leaseId });
    expect(res.json).toMatchObject({ ok: true, template: "Time Profiler", duration_sec: 5 });
    const outPath = String(res.json.path);
    expect(outPath.startsWith(os.tmpdir())).toBe(true);
    expect(run.calls[0]?.args).toContain("Time Profiler");
    expect(run.calls[0]?.args).toEqual(expect.arrayContaining(["--time-limit", "5s"]));
  });

  it("rejects an unknown lease without spawning", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "", stderr: "" }));
    const res = await call(client, "profile_trace", { lease_id: "lease_nope" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/unknown lease/i);
    expect(run.calls).toHaveLength(0);
  });

  it("rejects an over-max duration before invoking xctrace", async () => {
    const { client, run, leaseId } = await makeClient(() => ({ stdout: "", stderr: "" }));
    // zod inputSchema violations fail at the MCP layer as plain-text errors (never reach the handler).
    const raw = await client.callTool({ name: "profile_trace", arguments: { lease_id: leaseId, duration_sec: 999 } });
    expect(raw.isError).toBe(true);
    expect(JSON.stringify(raw.content)).toMatch(/less than or equal to 60/);
    expect(run.calls).toHaveLength(0);
  });

  it("rejects a blank template at the handler without invoking xctrace", async () => {
    const { client, run, leaseId } = await makeClient(() => ({ stdout: "", stderr: "" }));
    const res = await call(client, "profile_trace", { lease_id: leaseId, template: "  " });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/template/i);
    expect(run.calls).toHaveLength(0);
  });
});
