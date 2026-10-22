import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BoundedOptions, BoundedResult, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { PoolDevice } from "../src/realdevices.js";
import type { RealDevices } from "../src/realdevices.js";
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

function stubRunner(): Runner {
  return (async () => ({ stdout: "", stderr: "" })) as Runner;
}

function stubBounded(): BoundedRunner {
  return (async (_bin: string, _args: string[], _opts: BoundedOptions) =>
    ({ stdout: "", truncated: false, timedOut: true }) as BoundedResult) as BoundedRunner;
}

async function makeClient() {
  const run = stubRunner();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realp4-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    {
      defaultTtlMs: 60_000,
      realFleet: new FakeRealFleet([
        {
          udid: "R1", name: "Test iPhone", state: "available", platform: "iOS", osVersion: "26.1",
          kind: "real", transport: "wifi", trust: { paired: true, developerMode: "enabled" }, coredeviceId: "core-R1",
        },
      ]),
    },
  );
  const server = new McpServer({ name: "test", version: "0" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: run }),
    simLog: new SimLog({ runner: stubBounded() }),
    simApps: new SimApps({ runner: run }),
    xctrace: new XCTrace({ runner: run, exists: () => true }),
    lldmdb: new Llmdb({ runner: run }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const realLease = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
  if (!realLease.ok || realLease.queued) throw new Error("expected a real lease");
  return { client, realLeaseId: realLease.lease.leaseId };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

// P4-S1 verdict (docs/real-device-p4.md §1): no proxy/capture sub-slice is
// wireable with zero on-device manual steps, so all five mutating verbs stay
// P4-gated. The gate detail must name the measured blockers verbatim.
describe("P4 gate detail (measured blockers)", () => {
  const gated: { tool: string; args: (leaseId: string) => Record<string, unknown> }[] = [
    { tool: "net_proxy_start", args: (id) => ({ lease_id: id }) },
    { tool: "net_proxy_set_rules", args: (id) => ({ lease_id: id, rules: [] }) },
    { tool: "net_assert_flow", args: (id) => ({ lease_id: id, url_regex: "example" }) },
    { tool: "map_local", args: (id) => ({ lease_id: id, url_regex: "example", file: "/tmp/does-not-exist" }) },
    { tool: "map_remote", args: (id) => ({ lease_id: id, url_regex: "example", url: "https://example.com" }) },
  ];
  for (const { tool, args } of gated) {
    it(`${tool} fails fast P4 naming the measured blockers`, async () => {
      const { client, realLeaseId } = await makeClient();
      const res = await call(client, tool, args(realLeaseId));
      expect(res.isError).toBe(true);
      const err = String(res.json.error);
      expect(err).toContain("P4");
      expect(err).toContain(tool);
      expect(err).toContain("Wi-Fi proxy");
      expect(err).toContain("Certificate Trust Settings");
      expect(err).toContain("add-root-cert");
      expect(err).toContain("127.0.0.1");
      expect(err).toContain("sudo -n true");
    });
  }

  it("net_proxy_start names the real lease and udid", async () => {
    const { client, realLeaseId } = await makeClient();
    const res = await call(client, "net_proxy_start", { lease_id: realLeaseId });
    expect(res.isError).toBe(true);
    const err = String(res.json.error);
    expect(err).toContain(realLeaseId);
    expect(err).toContain("R1");
  });
});
