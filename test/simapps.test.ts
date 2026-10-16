import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-simapps-")), "state.json");
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

describe("SimApps wrapper", () => {
  it("openUrl shells out to simctl openurl", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    await new SimApps({ runner: run }).openUrl("U1", "https://www.apple.com");
    expect(run.calls[0]).toMatchObject({ bin: "xcrun", args: ["simctl", "openurl", "U1", "https://www.apple.com"] });
  });

  it("openUrl rejects empty or scheme-less urls without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const apps = new SimApps({ runner: run });
    await expect(apps.openUrl("U1", "")).rejects.toThrow(/invalid url/i);
    await expect(apps.openUrl("U1", "not a url")).rejects.toThrow(/scheme/i);
    await expect(apps.openUrl("", "https://www.apple.com")).rejects.toThrow(/udid/i);
    expect(run.calls).toHaveLength(0);
  });

  it("install/uninstall shell out to simctl", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const apps = new SimApps({ runner: run });
    await apps.install("U1", "/tmp/MyApp.app");
    await apps.uninstall("U1", "com.example.MyApp");
    expect(run.calls.map((c) => c.args)).toEqual([
      ["simctl", "install", "U1", "/tmp/MyApp.app"],
      ["simctl", "uninstall", "U1", "com.example.MyApp"],
    ]);
    expect(run.calls[0]?.bin).toBe("xcrun");
  });

  it("install/uninstall reject blank inputs without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const apps = new SimApps({ runner: run });
    await expect(apps.install("U1", "  ")).rejects.toThrow(/app_path/i);
    await expect(apps.uninstall("U1", "")).rejects.toThrow(/bundle_id/i);
    expect(run.calls).toHaveLength(0);
  });

  it("launch passes argv and parses the pid", async () => {
    const run = stubRunner(() => ({ stdout: "com.apple.Preferences: 31132\n", stderr: "" }));
    const res = await new SimApps({ runner: run }).launch("U1", "com.apple.Preferences", ["-arg", "x"]);
    expect(run.calls[0]?.args).toEqual(["simctl", "launch", "U1", "com.apple.Preferences", "-arg", "x"]);
    expect(res).toMatchObject({ pid: 31132 });
  });

  it("launch reports pid -1 when simctl output is unparseable", async () => {
    const run = stubRunner(() => ({ stdout: "weird output", stderr: "" }));
    const res = await new SimApps({ runner: run }).launch("U1", "com.apple.Preferences");
    expect(res).toMatchObject({ pid: -1, output: "weird output" });
  });

  it("terminate shells out to simctl terminate", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    await new SimApps({ runner: run }).terminate("U1", "com.apple.Preferences");
    expect(run.calls[0]).toMatchObject({ bin: "xcrun", args: ["simctl", "terminate", "U1", "com.apple.Preferences"] });
  });
});

describe("extras app tools", () => {
  it("app_launch returns the pid on the leased sim and logs the action", async () => {
    const { client, orch, run, leaseId } = await makeClient(() => ({
      stdout: "com.apple.Preferences: 42\n",
      stderr: "",
    }));
    const res = await call(client, "app_launch", { lease_id: leaseId, bundle_id: "com.apple.Preferences" });
    expect(res.json).toMatchObject({ ok: true, udid: "U1", bundle_id: "com.apple.Preferences", pid: 42 });
    expect(run.calls[0]?.args).toEqual(["simctl", "launch", "U1", "com.apple.Preferences"]);
    expect(orch.leaseActions(leaseId).map((a) => a.tool)).toContain("app_launch");
  });

  it("app_launch passes argv through", async () => {
    const { client, run, leaseId } = await makeClient(() => ({ stdout: "b: 7\n", stderr: "" }));
    const res = await call(client, "app_launch", { lease_id: leaseId, bundle_id: "b", args: ["-a", "1"] });
    expect(res.json).toMatchObject({ ok: true, pid: 7 });
    expect(run.calls[0]?.args).toEqual(["simctl", "launch", "U1", "b", "-a", "1"]);
  });

  it("app_terminate/app_open_url/app_install/app_uninstall hit simctl and log actions", async () => {
    const { client, orch, run, leaseId } = await makeClient(() => ({ stdout: "", stderr: "" }));
    const term = await call(client, "app_terminate", { lease_id: leaseId, bundle_id: "com.apple.Preferences" });
    expect(term.json).toMatchObject({ ok: true, udid: "U1", bundle_id: "com.apple.Preferences" });
    const open = await call(client, "app_open_url", { lease_id: leaseId, url: "https://www.apple.com" });
    expect(open.json).toMatchObject({ ok: true, udid: "U1" });
    const inst = await call(client, "app_install", { lease_id: leaseId, app_path: "/tmp/MyApp.app" });
    expect(inst.json).toMatchObject({ ok: true, udid: "U1" });
    const uninst = await call(client, "app_uninstall", { lease_id: leaseId, bundle_id: "com.example.MyApp" });
    expect(uninst.json).toMatchObject({ ok: true, udid: "U1" });
    expect(run.calls.map((c) => c.args)).toEqual([
      ["simctl", "terminate", "U1", "com.apple.Preferences"],
      ["simctl", "openurl", "U1", "https://www.apple.com"],
      ["simctl", "install", "U1", "/tmp/MyApp.app"],
      ["simctl", "uninstall", "U1", "com.example.MyApp"],
    ]);
    const tools = orch.leaseActions(leaseId).map((a) => a.tool);
    for (const t of ["app_terminate", "app_open_url", "app_install", "app_uninstall"]) {
      expect(tools).toContain(t);
    }
  });

  it("app tools reject an unknown lease without spawning", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "", stderr: "" }));
    const res = await call(client, "app_launch", { lease_id: "lease_nope", bundle_id: "com.apple.Preferences" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/unknown lease/i);
    expect(run.calls).toHaveLength(0);
  });

  it("app tools surface simctl failures as errors", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const failing: Runner = async (bin, args) => {
      run.calls.push({ bin, args });
      throw new ExecError(bin, args, 1, "", "Unable to find app with bundle id");
    };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-simapps-")), "state.json");
    const orch = new Orchestrator(
      new FakeFleet([{ udid: "U1", name: "iPhone", state: "Booted" }]),
      Store.load(file),
      { defaultTtlMs: 60_000 },
    );
    const server = new McpServer({ name: "test", version: "0" });
    registerDeviceExtras(server, {
      orchestrator: orch,
      serveSim: new ServeSim({ runner: failing }),
      simLog: new SimLog(),
      simApps: new SimApps({ runner: failing }),
      xctrace: new XCTrace({ runner: failing }),
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    const acquired = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
    if (!acquired.ok || acquired.queued) throw new Error("expected a lease");
    const res = await call(client, "app_launch", { lease_id: acquired.lease.leaseId, bundle_id: "com.example.Missing" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/unable to find app/i);
  });
});
