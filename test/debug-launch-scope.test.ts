import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, ExecOptions, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

interface Call {
  bin: string;
  args: string[];
  opts?: ExecOptions;
}

function stubRunner(handler: (bin: string, args: string[]) => string = () => "{}"): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
    calls.push({ bin, args, opts });
    return { stdout: handler(bin, args), stderr: "" };
  }) as Runner & { calls: Call[] };
  run.calls = calls;
  return run;
}

class FakeFleet implements FleetOps {
  bootedUdids = new Set<string>(["U1"]);
  async list(): Promise<SimDevice[]> {
    return [
      { udid: "U1", name: "iPhone 17 Pro", state: this.bootedUdids.has("U1") ? "Booted" : "Shutdown", platform: "iOS", osVersion: "26.5", set: "default" },
    ];
  }
  async boot(udid: string): Promise<void> {
    this.bootedUdids.add(udid);
  }
  async slimStatus(): Promise<SlimStatus | null> {
    return { slim: false, managedDisabled: 0, managedTotal: 168, persistent: true, raw: {} };
  }
  async slimNoReboot(): Promise<void> {}
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-launch-scope-")), "state.json");
}

async function makeScopeClient(llmdbRun: Runner & { calls: Call[] }, simctlRun: Runner & { calls: Call[] }) {
  const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), { defaultTtlMs: 60_000 });
  const server = new McpServer({ name: "test", version: "0" });
  const noop = async () => ({ stdout: "", stderr: "" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: simctlRun }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb: new Llmdb({ runner: llmdbRun }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const res = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
  if (!res.ok || res.queued) throw new Error("expected lease");
  return { client, orch, leaseId: res.lease.leaseId };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content.find((c) => c.type === "text")?.text ?? "") as string;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { isError: result.isError === true, json };
}

function llmdbHandler(_bin: string, args: string[]): string {
  if (args[0] === "attach") return JSON.stringify({ sessionId: "dbg-b", state: "stopped" });
  if (args[0] === "launch") return JSON.stringify({ sessionId: "dbg-p", state: "running" });
  if (args[0] === "sessions") return JSON.stringify([{ sessionId: "dbg-b" }]);
  if (args[0] === "doctor") return JSON.stringify({ lldbDap: "ok" });
  return JSON.stringify({ ok: true });
}

function simctlHandler(_bin: string, args: string[]): string {
  if (args[1] === "launch") return "com.example.App: 4242\n";
  return "";
}

describe("debug_launch bundle_id form", () => {
  it("composes simctl launch + llmdb attach --app and stores the session", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const simctlRun = stubRunner(simctlHandler);
    const { client, orch, leaseId } = await makeScopeClient(llmdbRun, simctlRun);
    const res = await call(client, "debug_launch", { lease_id: leaseId, bundle_id: "com.example.App", args: ["--x"] });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, session_id: "dbg-b", bundle_id: "com.example.App", pid: 4242 });
    expect(simctlRun.calls[0]).toMatchObject({
      bin: "xcrun",
      args: ["simctl", "launch", "U1", "com.example.App", "--x"],
    });
    expect(llmdbRun.calls[0]?.args).toEqual(["attach", "--app", "com.example.App"]);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-b");
    expect(orch.leaseActions(leaseId).map((a) => a.tool)).toEqual(["debug_launch"]);
  });

  it("needs exactly one of path or bundle_id and spawns nothing otherwise", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const simctlRun = stubRunner(simctlHandler);
    const { client, leaseId } = await makeScopeClient(llmdbRun, simctlRun);
    const both = await call(client, "debug_launch", { lease_id: leaseId, path: "/tmp/A", bundle_id: "com.example.App" });
    expect(both.isError).toBe(true);
    expect(String(both.json.error)).toMatch(/exactly one of path or bundle_id/);
    const neither = await call(client, "debug_launch", { lease_id: leaseId });
    expect(neither.isError).toBe(true);
    expect(String(neither.json.error)).toMatch(/exactly one of path or bundle_id/);
    expect(llmdbRun.calls).toHaveLength(0);
    expect(simctlRun.calls).toHaveLength(0);
  });

  it("keeps the path form on llmdb launch with no simctl spawn", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const simctlRun = stubRunner(simctlHandler);
    const { client, leaseId } = await makeScopeClient(llmdbRun, simctlRun);
    const res = await call(client, "debug_launch", { lease_id: leaseId, path: "/tmp/DebugApp", args: ["--x"] });
    expect(res.json).toMatchObject({ ok: true, session_id: "dbg-p" });
    expect(llmdbRun.calls[0]?.args).toEqual(["launch", "/tmp/DebugApp", "--x"]);
    expect(simctlRun.calls).toHaveLength(0);
  });

  it("attach failure after simctl launch surfaces the llmdb error and stores no session", async () => {
    const simctlRun = stubRunner(simctlHandler);
    const llmdbRun = (async (bin: string, args: string[], opts?: ExecOptions) => {
      llmdbRun.calls.push({ bin, args, opts });
      throw new ExecError(bin, args, 1, "", "Error: DAP attach failed: no process found with bundle ID com.example.App");
    }) as Runner & { calls: Call[] };
    llmdbRun.calls = [];
    const { client, orch, leaseId } = await makeScopeClient(llmdbRun, simctlRun);
    const res = await call(client, "debug_launch", { lease_id: leaseId, bundle_id: "com.example.App" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/no process found/);
    expect(simctlRun.calls).toHaveLength(1);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });

  it("simctl launch failure surfaces without an llmdb spawn or stored session", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const simctlRun = (async (bin: string, args: string[], opts?: ExecOptions) => {
      simctlRun.calls.push({ bin, args, opts });
      throw new ExecError(bin, args, 1, "", "Unable to launch com.example.App: app is not installed");
    }) as Runner & { calls: Call[] };
    simctlRun.calls = [];
    const { client, orch, leaseId } = await makeScopeClient(llmdbRun, simctlRun);
    const res = await call(client, "debug_launch", { lease_id: leaseId, bundle_id: "com.example.App" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/Unable to launch/);
    expect(llmdbRun.calls).toHaveLength(0);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });
});

describe("leaseless debug_doctor/debug_sessions", () => {
  it("runs doctor and sessions without a lease", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const { client } = await makeScopeClient(llmdbRun, stubRunner(simctlHandler));
    const doctor = await call(client, "debug_doctor", {});
    expect(doctor.isError).toBe(false);
    expect(doctor.json).toMatchObject({ ok: true, result: { lldbDap: "ok" } });
    expect(doctor.json).not.toHaveProperty("lease_id");
    const sessions = await call(client, "debug_sessions", {});
    expect(sessions.isError).toBe(false);
    expect(sessions.json).toMatchObject({ ok: true });
    expect(sessions.json).not.toHaveProperty("lease_id");
    expect(llmdbRun.calls.map((c) => c.args)).toEqual([["doctor"], ["sessions"]]);
  });

  it("keeps the lease form validating, logging, and echoing udid", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const { client, orch, leaseId } = await makeScopeClient(llmdbRun, stubRunner(simctlHandler));
    const doctor = await call(client, "debug_doctor", { lease_id: leaseId });
    expect(doctor.json).toMatchObject({ ok: true, lease_id: leaseId, udid: "U1" });
    const sessions = await call(client, "debug_sessions", { lease_id: leaseId });
    expect(sessions.json).toMatchObject({ ok: true, lease_id: leaseId, udid: "U1" });
    expect(orch.leaseActions(leaseId).map((a) => a.tool)).toEqual(["debug_doctor", "debug_sessions"]);
  });

  it("still rejects unknown leases before spawning llmdb", async () => {
    const llmdbRun = stubRunner(llmdbHandler);
    const { client } = await makeScopeClient(llmdbRun, stubRunner(simctlHandler));
    for (const tool of ["debug_doctor", "debug_sessions"] as const) {
      const res = await call(client, tool, { lease_id: "lease_nope" });
      expect(res.isError, tool).toBe(true);
      expect(String(res.json.error), tool).toMatch(/unknown lease/i);
    }
    expect(llmdbRun.calls).toHaveLength(0);
  });
});
