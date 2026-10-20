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

describe("Llmdb batch breakpoints", () => {
  it("sets several breakpoints in order, threading conditions", async () => {
    let id = 0;
    const run = stubRunner(() => JSON.stringify({ breakpoint: { id: ++id } }));
    const lldmdb = new Llmdb({ runner: run });
    const results = await lldmdb.breakSetMany("sess-1", [
      { file: "a.swift", line: 10 },
      { file: "b.swift", line: 20, condition: "n > 1", hitCondition: ">2" },
    ]);
    expect(results).toHaveLength(2);
    expect(run.calls.map((c) => c.args)).toEqual([
      ["break", "set", "a.swift:10", "--session", "sess-1"],
      ["break", "set", "b.swift:20", "--condition", "n > 1", "--hit-condition", ">2", "--session", "sess-1"],
    ]);
  });

  it("rejects empty spec lists and reports the failing index", async () => {
    const lldmdb = new Llmdb({ runner: stubRunner() });
    await expect(lldmdb.breakSetMany("sess-1", [])).rejects.toThrow(/non-empty array/);
    await expect(lldmdb.breakSetMany("  ", [{ file: "a.swift", line: 1 }])).rejects.toThrow(/session_id/);
    await expect(lldmdb.breakSetMany("sess-1", [{ file: "a.swift", line: 0 }])).rejects.toThrow(
      /breakpoint\[0\].*line/,
    );
    const flaky = stubRunner((_bin, args) => {
      if (args[2] === "b.swift:2") throw new ExecError("llmdb", args, 1, "", "boom");
      return JSON.stringify({ ok: true });
    });
    await expect(
      new Llmdb({ runner: flaky }).breakSetMany("sess-1", [
        { file: "a.swift", line: 1 },
        { file: "b.swift", line: 2 },
      ]),
    ).rejects.toThrow(/breakpoint\[1\].*boom/);
    expect(flaky.calls).toHaveLength(2); // aborts on first failure
  });

  it("deletes several breakpoints in order", async () => {
    const run = stubRunner(() => JSON.stringify({ ok: true }));
    const lldmdb = new Llmdb({ runner: run });
    const results = await lldmdb.breakDeleteMany("sess-1", [2, 5]);
    expect(results).toHaveLength(2);
    expect(run.calls.map((c) => c.args)).toEqual([
      ["break", "delete", "2", "--session", "sess-1"],
      ["break", "delete", "5", "--session", "sess-1"],
    ]);
    await expect(lldmdb.breakDeleteMany("sess-1", [])).rejects.toThrow(/non-empty array/);
    await expect(lldmdb.breakDeleteMany("sess-1", [1, 0])).rejects.toThrow(/breakpoint\[1\]/);
  });
});

class FakeFleet implements FleetOps {
  async list(): Promise<SimDevice[]> {
    return [{ udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" }];
  }
  async boot(_udid: string): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return { slim: false, managedDisabled: 0, managedTotal: 168, persistent: true, raw: {} };
  }
  async slimNoReboot(): Promise<void> {}
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-break-batch-")), "state.json");
}

async function makeDebugClient(llmdbrun: Runner & { calls: Call[] }) {
  const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), { defaultTtlMs: 60_000 });
  const server = new McpServer({ name: "test", version: "0" });
  const noop = async () => ({ stdout: "", stderr: "" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb: new Llmdb({ runner: llmdbrun }),
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

function debugHandler(_bin: string, args: string[]): string {
  if (args[0] === "attach") return JSON.stringify({ sessionId: "dbg-9", state: "stopped" });
  return JSON.stringify({ ok: true });
}

describe("debug_break batch ops", () => {
  it("sets several breakpoints with breakpoints=[...]", async () => {
    const run = stubRunner(debugHandler);
    const { client, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const res = await call(client, "debug_break", {
      lease_id: leaseId,
      breakpoints: [
        { file: "a.swift", line: 1 },
        { file: "b.swift", line: 2, condition: "n > 1" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, op: "set", session_id: "dbg-9" });
    expect(res.json.result).toHaveLength(2);
    expect(run.calls.map((c) => c.args)).toContainEqual([
      "break", "set", "a.swift:1", "--session", "dbg-9",
    ]);
    expect(run.calls.map((c) => c.args)).toContainEqual([
      "break", "set", "b.swift:2", "--condition", "n > 1", "--session", "dbg-9",
    ]);
  });

  it("deletes several breakpoints with delete=[...], single id still works", async () => {
    const run = stubRunner(debugHandler);
    const { client, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const many = await call(client, "debug_break", { lease_id: leaseId, delete: [2, 3] });
    expect(many.isError).toBe(false);
    expect(many.json).toMatchObject({ ok: true, op: "delete" });
    expect(many.json.result).toHaveLength(2);
    const one = await call(client, "debug_break", { lease_id: leaseId, delete: 4 });
    expect(one.isError).toBe(false);
    expect(one.json).toMatchObject({ ok: true, op: "delete" });
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "delete", "2", "--session", "dbg-9"]);
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "delete", "3", "--session", "dbg-9"]);
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "delete", "4", "--session", "dbg-9"]);
  });

  it("rejects batch/single combos and requires a session", async () => {
    const run = stubRunner(debugHandler);
    const { client, leaseId } = await makeDebugClient(run);
    const noSession = await call(client, "debug_break", {
      lease_id: leaseId,
      breakpoints: [{ file: "a.swift", line: 1 }],
    });
    expect(noSession.isError).toBe(true);
    expect(String(noSession.json.error)).toMatch(/no debug session/i);

    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const both = await call(client, "debug_break", {
      lease_id: leaseId,
      file: "a.swift",
      line: 1,
      breakpoints: [{ file: "b.swift", line: 2 }],
    });
    expect(both.isError).toBe(true);
    expect(String(both.json.error)).toMatch(/either file\+line or breakpoints/);
    const combo = await call(client, "debug_break", {
      lease_id: leaseId,
      list: true,
      breakpoints: [{ file: "a.swift", line: 1 }],
    });
    expect(combo.isError).toBe(true);
    expect(String(combo.json.error)).toMatch(/exactly one op/);
    expect(run.calls.map((c) => c.args[0])).toEqual(["attach"]); // no break calls issued
  });
});
