import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppOps } from "../src/appops.js";
import type { CacheClearOptions, CacheClearResult } from "../src/appcache.js";
import { Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { PoolDevice } from "../src/realdevices.js";
import type { RealDevices } from "../src/realdevices.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

const BUNDLE = "com.example.App";
const APP_PATH = "/tmp/A.app";

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

function launchctlOutput(bundles: string[]): string {
  return "PID\tStatus\tLabel\n" + bundles.map((b, i) => `${1000 + i}\t0\tUIKitApplication:${b}\n`).join("");
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

class FakeRealFleet implements Pick<RealDevices, "list"> {
  constructor(private readonly devs: PoolDevice[]) {}
  async list(): Promise<PoolDevice[]> {
    return this.devs.map((d) => ({ ...d, trust: { ...d.trust } }));
  }
}

/** Recording AppOps fake for the go-ios backend, with an install-failure hook for half-state tests. */
class FakeRealApps implements AppOps {
  calls: string[] = [];
  failInstall: Error | null = null;
  async openUrl(udid: string, url: string): Promise<void> {
    this.calls.push(`openUrl ${udid} ${url}`);
  }
  async install(udid: string, appPath: string): Promise<void> {
    this.calls.push(`install ${udid} ${appPath}`);
    if (this.failInstall) throw this.failInstall;
  }
  async uninstall(udid: string, bundleId: string): Promise<void> {
    this.calls.push(`uninstall ${udid} ${bundleId}`);
  }
  async launch(udid: string, bundleId: string, argv: string[] = []): Promise<{ pid: number; output: string }> {
    this.calls.push(`launch ${udid} ${bundleId} ${argv.join(",")}`);
    return { pid: 777, output: "fake-launch" };
  }
  async terminate(udid: string, bundleId: string): Promise<void> {
    this.calls.push(`terminate ${udid} ${bundleId}`);
  }
  async clearCache(udid: string, bundleId: string, _opts: CacheClearOptions = {}): Promise<CacheClearResult> {
    this.calls.push(`clearCache ${udid} ${bundleId}`);
    throw new Error("P2");
  }
  async listRunning(_udid: string): Promise<Set<string>> {
    return new Set();
  }
}

function realDev(): PoolDevice {
  return {
    udid: "R1", name: "Test iPhone", state: "available", platform: "iOS", osVersion: "26.1",
    kind: "real", transport: "wifi", trust: { paired: true, developerMode: "enabled" }, coredeviceId: "core-R1",
  };
}

async function makeClient(opts: {
  handler?: (bin: string, args: string[]) => { stdout: string; stderr: string };
  running?: string[];
  contamination?: boolean;
} = {}) {
  let running = opts.running ?? [];
  const run = stubRunner(
    opts.handler ??
      ((bin, args) => {
        void bin;
        if (args[0] === "simctl" && args[1] === "spawn") return { stdout: launchctlOutput(running), stderr: "" };
        if (args[0] === "simctl" && args[1] === "launch") return { stdout: `${BUNDLE}: 4242\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      }),
  );
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-appreinstall-")), "state.json");
  const simApps = new SimApps({ runner: run });
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    {
      defaultTtlMs: 60_000,
      realFleet: new FakeRealFleet([realDev()]),
      ...(opts.contamination ? { apps: simApps, contaminationCheck: true, contaminationCheckMinIntervalMs: 0 } : {}),
    },
  );
  const realApps = new FakeRealApps();
  const server = new McpServer({ name: "test", version: "0" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: run }),
    simLog: new SimLog(),
    simApps,
    xctrace: new XCTrace({ runner: run }),
    lldmdb: new Llmdb({ runner: run }),
    realApps,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const simLease = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
  if (!simLease.ok || simLease.queued) throw new Error("expected a sim lease");
  const realLease = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
  if (!realLease.ok || realLease.queued) throw new Error("expected a real lease");
  return {
    client, orch, run, realApps,
    simLeaseId: simLease.lease.leaseId, realLeaseId: realLease.lease.leaseId,
    setRunning: (next: string[]) => { running = next; },
  };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

/** Raw shape for schema-validation refusals (plain-text MCP error, not JSON). */
async function callRaw(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return { isError: result.isError === true, text: String(text) };
}

describe("app_reinstall", () => {
  it("is registered with the confirm_data_loss gate in its schema", async () => {
    const { client } = await makeClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("app_reinstall");
    const reinstall = (await client.listTools()).tools.find((t) => t.name === "app_reinstall");
    expect(JSON.stringify(reinstall?.inputSchema)).toContain("confirm_data_loss");
  });

  it("sim: uninstalls then installs via simctl and returns the reinstall shape (never CacheClearResult)", async () => {
    const { client, orch, run, simLeaseId } = await makeClient();
    const res = await call(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: true,
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      ok: true, lease_id: simLeaseId, udid: "U1", bundle_id: BUNDLE,
      uninstalled: true, installed: true, logged_out: true,
    });
    for (const cacheKey of ["container", "caches_dir", "deleted", "deleted_count", "plist_keys_removed", "terminated", "errors"]) {
      expect(res.json).not.toHaveProperty(cacheKey);
    }
    expect(run.calls).toEqual([
      { bin: "xcrun", args: ["simctl", "uninstall", "U1", BUNDLE] },
      { bin: "xcrun", args: ["simctl", "install", "U1", APP_PATH] },
    ]);
    const actions = orch.leaseActions(simLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain(`app_reinstall reinstall ${BUNDLE}`);
  });

  it("refuses without confirm_data_loss (missing or false) with zero spawns", async () => {
    const { client, run, simLeaseId } = await makeClient();
    const before = run.calls.length;
    const missing = await callRaw(client, "app_reinstall", { lease_id: simLeaseId, bundle_id: BUNDLE, app_path: APP_PATH });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/confirm_data_loss/);
    expect(missing.text).toMatch(/wipes Documents\/Keychain/);
    const declined = await callRaw(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: false,
    });
    expect(declined.isError).toBe(true);
    expect(declined.text).toMatch(/confirm_data_loss/);
    expect(run.calls.length).toBe(before);
  });

  it("refuses without app_path (missing or empty) with zero spawns", async () => {
    const { client, run, simLeaseId } = await makeClient();
    const before = run.calls.length;
    const missing = await callRaw(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, confirm_data_loss: true,
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/app_path/);
    const empty = await callRaw(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, app_path: "", confirm_data_loss: true,
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/app_path/);
    expect(run.calls.length).toBe(before);
  });

  it("names the half-state when install fails after uninstall (app removed, install failed: reason)", async () => {
    const reason = "simctl install failed: emulator image missing";
    const { client, orch, run, simLeaseId } = await makeClient({
      handler: (_bin, args) => {
        if (args[0] === "simctl" && args[1] === "install") throw new Error(reason);
        return { stdout: "", stderr: "" };
      },
    });
    const res = await call(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: true,
    });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/half-state/);
    expect(String(res.json.error)).toContain(BUNDLE);
    expect(String(res.json.error)).toMatch(/was removed.*install failed/);
    expect(String(res.json.error)).toContain(reason);
    expect(run.calls).toEqual([
      { bin: "xcrun", args: ["simctl", "uninstall", "U1", BUNDLE] },
      { bin: "xcrun", args: ["simctl", "install", "U1", APP_PATH] },
    ]);
    const actions = orch.leaseActions(simLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toMatch(/app_reinstall.*HALF-STATE/);
  });

  it("aborts before install when uninstall fails (no half-state)", async () => {
    const reason = "simctl uninstall failed: device busy";
    const { client, run, simLeaseId } = await makeClient({
      handler: (_bin, args) => {
        if (args[0] === "simctl" && args[1] === "uninstall") throw new Error(reason);
        return { stdout: "", stderr: "" };
      },
    });
    const res = await call(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: true,
    });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toContain(reason);
    expect(String(res.json.error)).not.toMatch(/half-state/);
    expect(run.calls).toEqual([{ bin: "xcrun", args: ["simctl", "uninstall", "U1", BUNDLE] }]);
  });

  it("drops the lease-launched claim like terminate (reinstalled app is not running)", async () => {
    const { client, orch, setRunning, simLeaseId } = await makeClient({ contamination: true });
    const launched = await call(client, "app_launch", { lease_id: simLeaseId, bundle_id: BUNDLE });
    expect(launched.isError).toBe(false);
    setRunning([BUNDLE]);
    await orch.resolveLease(simLeaseId);
    expect(orch.contaminationStatus(simLeaseId).contended).toBe(false); // launched claim live
    const res = await call(client, "app_reinstall", {
      lease_id: simLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: true,
    });
    expect(res.isError).toBe(false);
    await orch.resolveLease(simLeaseId);
    expect(orch.contaminationStatus(simLeaseId).contended).toBe(true); // claim dropped
  });

  it("routes real reinstall to realApps (uninstall→install) with the same shape, no simctl cross-talk", async () => {
    const { client, run, realApps, realLeaseId } = await makeClient();
    const res = await call(client, "app_reinstall", {
      lease_id: realLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: true,
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      ok: true, lease_id: realLeaseId, udid: "R1", bundle_id: BUNDLE,
      uninstalled: true, installed: true, logged_out: true,
    });
    expect(realApps.calls).toEqual([`uninstall R1 ${BUNDLE}`, `install R1 ${APP_PATH}`]);
    expect(run.calls.filter((c) => c.args[1] === "install" || c.args[1] === "uninstall")).toHaveLength(0);
  });

  it("real half-state keeps the device error text verbatim (never a missing-binary claim)", async () => {
    const deviceText = "AMDeviceStartService failed: device locked (passcode required)";
    const { client, realApps, realLeaseId } = await makeClient();
    realApps.failInstall = new Error(deviceText);
    const res = await call(client, "app_reinstall", {
      lease_id: realLeaseId, bundle_id: BUNDLE, app_path: APP_PATH, confirm_data_loss: true,
    });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/half-state/);
    expect(String(res.json.error)).toContain(deviceText);
    expect(String(res.json.error)).not.toMatch(/go-ios|not installed|npm install/);
    expect(realApps.calls).toEqual([`uninstall R1 ${BUNDLE}`, `install R1 ${APP_PATH}`]);
  });
});
