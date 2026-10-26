import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const GATE_ENV = "SIM_MCP_DEBUG_ROBUSTNESS";

interface Call {
  bin: string;
  args: string[];
  opts?: ExecOptions;
}

type Handler = (bin: string, args: string[]) => string;

function stubRunner(handler: Handler): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
    calls.push({ bin, args, opts });
    return { stdout: handler(bin, args), stderr: "" };
  }) as Runner & { calls: Call[] };
  run.calls = calls;
  return run;
}

class FakeFleet implements FleetOps {
  async list(): Promise<SimDevice[]> {
    return [
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ];
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-dbgrob-")), "state.json");
}

async function makeClient(run: Runner & { calls: Call[] }) {
  const lldmdb = new Llmdb({ runner: run });
  const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), {
    defaultTtlMs: 60_000,
    debugger: lldmdb,
  });
  const server = new McpServer({ name: "test", version: "0" });
  const noop = async () => ({ stdout: "", stderr: "" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb,
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
  return { isError: result.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

let savedGate: string | undefined;

beforeEach(() => {
  savedGate = process.env[GATE_ENV];
});

afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE_ENV];
  else process.env[GATE_ENV] = savedGate;
});

describe("D1.1 debug robustness (gate ON)", () => {
  it("interrupt on an already-stopped session returns ok without calling llmdb or auto-stopping", async () => {
    process.env[GATE_ENV] = "1";
    const run = stubRunner((_b, args) => {
      if (args[0] === "attach") return JSON.stringify({ sessionId: "dbg-1", state: "stopped" });
      if (args[0] === "stop") return JSON.stringify({ stopped: true });
      // If the fast-path fails, interrupt would hit this wedged timeout.
      throw new ExecError("llmdb", args, "ETIMEDOUT", "", "");
    });
    const { client, orch, leaseId } = await makeClient(run);
    const attach = await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    expect(attach.json).toMatchObject({ ok: true, session_id: "dbg-1" });

    const res = await call(client, "debug_interrupt", { lease_id: leaseId });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, session_id: "dbg-1", already_stopped: true });
    expect(run.calls.map((c) => c.args[0])).not.toContain("interrupt");
    expect(run.calls.map((c) => c.args[0])).not.toContain("stop");
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-1");
  });

  it("continue wait-elapsed returns a structured ok without auto-stop", async () => {
    process.env[GATE_ENV] = "1";
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      run.calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-2", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      if (args[0] === "continue") {
        throw new ExecError(bin, args, 1, "", "Error: continue timed out waiting for stop (wait elapsed, still running)");
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = [];
    const { client, orch, leaseId } = await makeClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });

    const res = await call(client, "debug_continue", { lease_id: leaseId, wait_sec: 5 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, session_id: "dbg-2", wait_elapsed: true });
    expect(run.calls.map((c) => c.args[0])).not.toContain("stop");
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-2");
  });

  it("continue classifies the measured DAP waitForEvent timeout as wait-elapsed (no auto-stop)", async () => {
    process.env[GATE_ENV] = "1";
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      run.calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-8", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      if (args[0] === "continue") {
        // Exact stderr measured live on iPhone 17 Pro (llmdb daemon responded, code 1).
        throw new ExecError(bin, args, 1, "", "Error: DAP waitForEvent failed: timed out after 5.0s.");
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = [];
    const { client, orch, leaseId } = await makeClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });

    const res = await call(client, "debug_continue", { lease_id: leaseId, wait_sec: 5 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, session_id: "dbg-8", wait_elapsed: true });
    expect(run.calls.map((c) => c.args[0])).not.toContain("stop");
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-8");
  });

  it("daemon errors without wait phrasing still pass through (no auto-stop, no ok)", async () => {
    process.env[GATE_ENV] = "1";
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      run.calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-9", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      if (args[0] === "continue") {
        throw new ExecError(bin, args, 1, "", "Error: no session with id dbg-9");
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = [];
    const { client, orch, leaseId } = await makeClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });

    const res = await call(client, "debug_continue", { lease_id: leaseId, wait_sec: 5 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).not.toMatch(/auto-stopped/);
    expect(run.calls.map((c) => c.args[0])).not.toContain("stop");
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-9");
  });

  it("run-until wait-elapsed returns a structured ok with wait_elapsed (no auto-stop)", async () => {
    process.env[GATE_ENV] = "1";
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      run.calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-10", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      if (args[0] === "run-until") {
        throw new ExecError(bin, args, 1, "", "Error: DAP waitForEvent failed: timed out after 5.0s.");
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = [];
    const { client, orch, leaseId } = await makeClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });

    const res = await call(client, "debug_run_until", { lease_id: leaseId, file: "a.swift", line: 12, wait_sec: 5 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, session_id: "dbg-10", wait_elapsed: true });
    expect(run.calls.map((c) => c.args[0])).not.toContain("stop");
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-10");
  });

  it("wedged timeout on continue still auto-stops", async () => {
    process.env[GATE_ENV] = "1";
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      run.calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-3", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      if (args[0] === "continue") throw new ExecError(bin, args, "ETIMEDOUT", "", "");
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = [];
    const { client, orch, leaseId } = await makeClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });

    const res = await call(client, "debug_continue", { lease_id: leaseId, wait_sec: 5 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/auto-stopped/);
    expect(run.calls.map((c) => c.args[0])).toContain("stop");
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });
});

describe("D1.1 gate OFF preserves legacy behavior", () => {
  it("interrupt calls llmdb and wait-elapsed errors fail with auto-stop", async () => {
    delete process.env[GATE_ENV];
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      run.calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-4", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      if (args[0] === "interrupt") return { stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
      if (args[0] === "continue") {
        throw new ExecError(bin, args, 1, "", "Error: continue timed out waiting for stop (wait elapsed, still running)");
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = [];
    const { client, orch, leaseId } = await makeClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });

    const intr = await call(client, "debug_interrupt", { lease_id: leaseId });
    expect(intr.isError).toBe(false);
    expect(intr.json).not.toHaveProperty("already_stopped");
    expect(run.calls.map((c) => c.args[0])).toContain("interrupt");

    const cont = await call(client, "debug_continue", { lease_id: leaseId, wait_sec: 5 });
    expect(cont.isError).toBe(true);
    expect(String(cont.json.error)).toMatch(/auto-stopped/);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });
});
