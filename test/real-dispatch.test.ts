import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppOps } from "../src/appops.js";
import type { CacheClearOptions, CacheClearResult } from "../src/appcache.js";
import { BoundedOptions, BoundedResult, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import type { LogOps } from "../src/logops.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { PoolDevice } from "../src/realdevices.js";
import type { RealDevices } from "../src/realdevices.js";
import { RealSyslog } from "../src/realsyslog.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { BoundedRunner, SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { Llmdb } from "../src/llmdb.js";
import { XCTrace } from "../src/xctrace.js";

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

/** Recording AppOps fake standing in for the go-ios backend. */
class FakeRealApps implements AppOps {
  calls: string[] = [];
  async openUrl(udid: string, url: string): Promise<void> {
    this.calls.push(`openUrl ${udid} ${url}`);
  }
  async install(udid: string, appPath: string): Promise<void> {
    this.calls.push(`install ${udid} ${appPath}`);
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
  async clearCache(_udid: string, _bundleId: string, _opts: CacheClearOptions = {}): Promise<CacheClearResult> {
    throw new Error("unreachable in these tests");
  }
  async listRunning(_udid: string): Promise<Set<string>> {
    return new Set();
  }
}

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

function stubBounded(stdout: string): BoundedRunner & { calls: { bin: string; args: string[]; opts: BoundedOptions }[] } {
  const calls: { bin: string; args: string[]; opts: BoundedOptions }[] = [];
  const run = (async (bin: string, args: string[], opts: BoundedOptions) => {
    calls.push({ bin, args, opts });
    return { stdout, truncated: false, timedOut: true } as BoundedResult;
  }) as BoundedRunner & { calls: { bin: string; args: string[]; opts: BoundedOptions }[] };
  run.calls = calls;
  return run;
}

function realDev(): PoolDevice {
  return {
    udid: "R1", name: "Test iPhone", state: "available", platform: "iOS", osVersion: "26.1",
    kind: "real", transport: "wifi", trust: { paired: true, developerMode: "enabled" }, coredeviceId: "core-R1",
  };
}

async function makeClient(opts: { withRealBackends?: boolean } = {}) {
  const withReal = opts.withRealBackends ?? true;
  const run = stubRunner((bin, args) => {
    if (bin === "xcrun" && args[1] === "launch") return { stdout: "com.example.App: 31132\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const simBounded = stubBounded("sim-log-line");
  const realBounded = stubBounded('{"relay":"syslog-line"}');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realdisp-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    { defaultTtlMs: 60_000, realFleet: new FakeRealFleet([realDev()]) },
  );
  const realApps = new FakeRealApps();
  const realLog: LogOps = new RealSyslog({ runner: realBounded });
  const server = new McpServer({ name: "test", version: "0" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: run }),
    simLog: new SimLog({ runner: simBounded }),
    simApps: new SimApps({ runner: run }),
    xctrace: new XCTrace({ runner: run, exists: () => true }),
    lldmdb: new Llmdb({ runner: run }),
    ...(withReal ? { realApps, realLog } : {}),
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
    client, orch, run, simBounded, realBounded, realApps,
    simLeaseId: simLease.lease.leaseId, realLeaseId: realLease.lease.leaseId,
  };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

describe("app verb dispatch by lease kind", () => {
  it("routes real app_launch to realApps with pid passthrough + launch marking", async () => {
    const { client, orch, run, realApps, realLeaseId } = await makeClient();
    const res = await call(client, "app_launch", { lease_id: realLeaseId, bundle_id: "com.example.App", args: ["-x"] });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ pid: 777, udid: "R1" });
    expect(realApps.calls).toEqual(["launch R1 com.example.App -x"]);
    expect(run.calls.filter((c) => c.args[1] === "launch")).toHaveLength(0); // no simctl cross-talk
    const actions = orch.leaseActions(realLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain("app_launch launch com.example.App (pid 777)");
  });

  it("routes sim app_launch to simctl (sim path unchanged)", async () => {
    const { client, run, realApps, simLeaseId } = await makeClient();
    const res = await call(client, "app_launch", { lease_id: simLeaseId, bundle_id: "com.example.App" });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ pid: 31132, udid: "U1" });
    expect(realApps.calls).toHaveLength(0);
    expect(run.calls[0]).toMatchObject({ bin: "xcrun", args: ["simctl", "launch", "U1", "com.example.App"] });
  });

  it("routes real install/uninstall/terminate to realApps", async () => {
    const { client, realApps, realLeaseId } = await makeClient();
    await call(client, "app_install", { lease_id: realLeaseId, app_path: "/tmp/A.app" });
    await call(client, "app_uninstall", { lease_id: realLeaseId, bundle_id: "com.example.App" });
    await call(client, "app_terminate", { lease_id: realLeaseId, bundle_id: "com.example.App" });
    expect(realApps.calls).toEqual([
      "install R1 /tmp/A.app",
      "uninstall R1 com.example.App",
      "terminate R1 com.example.App",
    ]);
  });

  it("keeps app_open_url/app_cache_clear fail-fast P2 on real leases", async () => {
    const { client, realLeaseId } = await makeClient();
    const open = await call(client, "app_open_url", { lease_id: realLeaseId, url: "https://x.test" });
    expect(open.isError).toBe(true);
    expect(String(open.json.error)).toContain("P2");
    expect(String(open.json.error)).toContain("no CLI transport");
    const clear = await call(client, "app_cache_clear", { lease_id: realLeaseId, bundle_id: "com.example.App" });
    expect(clear.isError).toBe(true);
    expect(String(clear.json.error)).toContain("P2");
  });

  it("fails real app verbs with a missing-transport error when realApps is absent", async () => {
    const { client, realLeaseId } = await makeClient({ withRealBackends: false });
    const res = await call(client, "app_launch", { lease_id: realLeaseId, bundle_id: "com.example.App" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toContain("go-ios transport");
  });
});

describe("log verb dispatch by holder kind", () => {
  it("routes sim_log_stream to the syslog relay for real holders, simctl log for sims", async () => {
    const { client, simBounded, realBounded, simLeaseId, realLeaseId } = await makeClient();
    const real = await call(client, "sim_log_stream", { udid: "R1", timeout_sec: 5 });
    expect(real.isError).toBe(false);
    expect(real.json).toMatchObject({ udid: "R1", timedOut: true });
    expect(String(real.json.log)).toContain("syslog-line");
    expect(realBounded.calls[0]).toMatchObject({ bin: "ios", args: ["syslog", "--udid=R1"] });
    const sim = await call(client, "sim_log_stream", { udid: "U1", timeout_sec: 5 });
    expect(sim.isError).toBe(false);
    expect(String(sim.json.log)).toContain("sim-log-line");
    expect(simBounded.calls[0]?.bin).toBe("xcrun");
  });

  it("sim_log_show on a real holder fails with stream-instead guidance", async () => {
    const { client } = await makeClient();
    const res = await call(client, "sim_log_show", { udid: "R1", last: "5m" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toContain("sim_log_stream");
  });

  it("sim_log_show on a sim holder still works (sim path unchanged)", async () => {
    const { client } = await makeClient();
    const res = await call(client, "sim_log_show", { udid: "U1", last: "5m" });
    expect(res.isError).toBe(false);
    expect(String(res.json.log)).toContain("sim-log-line");
  });

  it("fails real log verbs with a missing-transport error when realLog is absent", async () => {
    const { client } = await makeClient({ withRealBackends: false });
    const res = await call(client, "sim_log_stream", { udid: "R1", timeout_sec: 5 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toContain("syslog-relay transport");
  });
});

describe("profile_trace on real leases", () => {
  it("invokes xctrace with --device <real-udid> (guard deleted)", async () => {
    const { client, run, realLeaseId } = await makeClient();
    const res = await call(client, "profile_trace", { lease_id: realLeaseId, duration_sec: 5 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ udid: "R1" });
    const trace = run.calls.find((c) => c.args[0] === "xctrace");
    expect(trace).toBeDefined();
    expect(trace!.args).toContain("R1");
    expect(trace!.args).toContain("--device");
  });
});
