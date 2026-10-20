import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb, hintForDebugError } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

describe("hintForDebugError", () => {
  it("attach refused -> get-task-allow/Developer Tools guidance", () => {
    for (const m of ["attach refused by target", "attach denied: Operation not permitted", "missing get-task-allow", "Developer Tools authorization required"]) {
      expect(hintForDebugError(m), m).toMatch(/get-task-allow/);
      expect(hintForDebugError(m), m).toMatch(/Developer Tools/);
    }
  });
  it("session expired / target exited hints", () => {
    expect(hintForDebugError("no session with id dbg-9")).toMatch(/debug_attach/);
    expect(hintForDebugError("target process exited with code 1")).toMatch(/relaunch/);
    expect(hintForDebugError("no process found with process ID 99")).toMatch(/relaunch/);
  });
  it("null for validation errors and unknown failures", () => {
    expect(hintForDebugError("Invalid pid 0 (expected a positive integer)")).toBeNull();
    expect(hintForDebugError("something totally novel")).toBeNull();
  });
});

describe("debug tools surface hints", () => {
  it("debug_attach failure carries the Hint suffix", async () => {
    const run = (async (bin: string, args: string[]) => {
      throw new ExecError(bin, args, 1, "", "attach refused: missing get-task-allow");
    }) as Runner & { calls: unknown[] };
    run.calls = [];
    const fleet = { list: async () => [{ udid: "U1", name: "iP", state: "Booted", platform: "iOS", osVersion: "26", set: "d" }], boot: async () => {}, slimStatus: async () => null, slimNoReboot: async () => {} };
    const orch = new Orchestrator(fleet as never, Store.load(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eh-")), "s.json")), { defaultTtlMs: 60_000 });
    const server = new McpServer({ name: "t", version: "0" });
    const noop = async () => ({ stdout: "", stderr: "" });
    registerDeviceExtras(server, { orchestrator: orch, serveSim: new ServeSim({ runner: noop }), simLog: new SimLog(), simApps: new SimApps({ runner: noop }), xctrace: new XCTrace({ runner: noop }), lldmdb: new Llmdb({ runner: run }) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const acq = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
    if (!acq.ok || acq.queued) throw new Error("expected lease");
    const res = await client.callTool({ name: "debug_attach", arguments: { lease_id: acq.lease.leaseId, pid: 1 } });
    const text = (res.content.find((c) => c.type === "text")?.text ?? "") as string;
    expect(res.isError).toBe(true);
    expect(text).toMatch(/Hint: .*get-task-allow/);
    expect(text).toMatch(/Developer Tools/);
  });
});
