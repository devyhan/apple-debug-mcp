import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BoundedOptions, BoundedResult } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { BoundedRunner, SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

function stubBounded(handler: (bin: string, args: string[]) => BoundedResult): BoundedRunner & {
  calls: { bin: string; args: string[]; opts: BoundedOptions }[];
} {
  const calls: { bin: string; args: string[]; opts: BoundedOptions }[] = [];
  const run = (async (bin: string, args: string[], opts: BoundedOptions) => {
    calls.push({ bin, args, opts });
    return handler(bin, args);
  }) as BoundedRunner & { calls: { bin: string; args: string[]; opts: BoundedOptions }[] };
  run.calls = calls;
  return run;
}

class FakeFleet implements FleetOps {
  booted = new Set<string>();
  constructor(private readonly devs: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devs;
  }
  async boot(_udid: string): Promise<void> {}
  async shutdown(_udid: string): Promise<void> {}
  async slim(_udid: string, _opts?: { noReboot?: boolean }): Promise<SlimStatus> {
    return { ok: true, udid: _udid, mode: "local", rebooted: false, alreadySlim: true };
  }
  async uiDescribe(_udid: string): Promise<string> {
    return "<hierarchy/>";
  }
}

async function makeClient(handler: (bin: string, args: string[]) => BoundedResult) {
  const run = stubBounded(handler);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-extras-log-")), "state.json");
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
    serveSim: new ServeSim({ runner: async () => ({ stdout: "", stderr: "" }) }),
    simLog: new SimLog({ runner: run }),
    simApps: new SimApps({ runner: async () => ({ stdout: "", stderr: "" }) }),
    xctrace: new XCTrace({ runner: async () => ({ stdout: "", stderr: "" }) }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, run };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

describe("extras log tools", () => {
  it("sim_log_stream passes level/process through and surfaces flags", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "log-body", truncated: true, timedOut: true }));
    const res = await call(client, "sim_log_stream", {
      udid: "U1",
      predicate: 'eventMessage CONTAINS "x"',
      process: "Preferences",
      level: "info",
      timeout_sec: 7,
      max_chars: 500,
    });
    expect(res.json).toMatchObject({ ok: true, udid: "U1", log: "log-body", truncated: true, timedOut: true });
    expect(run.calls[0]?.args).toEqual([
      "simctl",
      "spawn",
      "U1",
      "log",
      "stream",
      "--style",
      "compact",
      "--level",
      "info",
      "--predicate",
      'process == "Preferences" AND eventMessage CONTAINS "x"',
    ]);
    expect(run.calls[0]?.opts.timeoutMs).toBe(7000);
    expect(run.calls[0]?.opts.maxChars).toBe(500);
  });

  it("sim_log_stream defaults level to default", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "", truncated: false, timedOut: true }));
    const res = await call(client, "sim_log_stream", { udid: "U1" });
    expect(res.json).toMatchObject({ ok: true, timedOut: true });
    expect(run.calls[0]?.args).toContain("default");
    expect(run.calls[0]?.opts.timeoutMs).toBe(5000);
  });

  it("sim_log_show passes info/debug/signpost/process through", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "history", truncated: false, timedOut: false }));
    const res = await call(client, "sim_log_show", {
      udid: "U1",
      last: "30s",
      process: "Preferences",
      info: true,
      debug: true,
      signpost: true,
    });
    expect(res.json).toMatchObject({ ok: true, udid: "U1", log: "history", truncated: false, timedOut: false });
    expect(run.calls[0]?.args).toEqual([
      "simctl",
      "spawn",
      "U1",
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      "30s",
      "--predicate",
      'process == "Preferences"',
      "--info",
      "--debug",
      "--signpost",
    ]);
  });

  it("sim_log_show surfaces predicate validation errors", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "", truncated: false, timedOut: false }));
    const res = await call(client, "sim_log_show", { udid: "U1", predicate: "((unbalanced" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/Invalid predicate/);
    expect(run.calls).toHaveLength(0);
  });
});
