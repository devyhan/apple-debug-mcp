import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Axe } from "../src/axe.js";
import { ExecError, Runner } from "../src/exec.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { GO_IOS_INSTALL_HINT } from "../src/realdevices.js";
import type { PoolDevice, RealDevices } from "../src/realdevices.js";
import { REAL_UI_WDA_DETAIL, RealUiDriver } from "../src/realui.js";
import { createMcpServer } from "../src/server.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, Simslim, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import type { UiDriver } from "../src/uidriver.js";
import { XCTrace } from "../src/xctrace.js";

/** Minimal bytes satisfying the PNG magic check (8-byte signature + payload). */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function stubRunner(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }): Runner & {
  calls: { bin: string; args: string[] }[];
} {
  const calls: { bin: string; args: string[] }[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args: [...args] });
    return handler(bin, args);
  }) as Runner & { calls: { bin: string; args: string[] }[] };
  run.calls = calls;
  return run;
}

/** Fake `ios` that materializes a PNG at the --output=<file> path, like the real CLI. */
function iosShotRunner(opts: { stdout?: string } = {}): Runner & { calls: { bin: string; args: string[] }[] } {
  return stubRunner((bin, args) => {
    if (bin === "ios" && args[0] === "--version") return { stdout: "go-ios local-build\n", stderr: "" };
    const out = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
    if (bin === "ios" && args[0] === "screenshot" && out) fs.writeFileSync(out, PNG_BYTES);
    return { stdout: opts.stdout ?? '{"level":"INFO","msg":"File saved successfully"}', stderr: "" };
  });
}

/** Fake `axe` that materializes a PNG at the --output <file> path, like the real CLI. */
function axeShotRunner(): Runner & { calls: { bin: string; args: string[] }[] } {
  return stubRunner((bin, args) => {
    const flag = args.indexOf("--output");
    if (bin === "axe" && args[0] === "screenshot" && flag !== -1 && args[flag + 1]) {
      fs.writeFileSync(args[flag + 1]!, PNG_BYTES);
    }
    return { stdout: "", stderr: "" };
  });
}

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realui-")), name);
}

describe("RealUiDriver", () => {
  it("satisfies UiDriver and captures via ios screenshot", async () => {
    const run = iosShotRunner();
    const driver: UiDriver = new RealUiDriver({ runner: run });
    const out = tmpFile("shot.png");
    await expect(driver.screenshot("R1", out)).resolves.toBe(out);
    expect(run.calls).toEqual([{ bin: "ios", args: ["screenshot", "--udid=R1", `--output=${out}`] }]);
    expect(fs.readFileSync(out)).toEqual(PNG_BYTES);
  });

  it("checkAvailable probes ios --version", async () => {
    const run = iosShotRunner();
    await expect(new RealUiDriver({ runner: run }).checkAvailable()).resolves.toBe("go-ios local-build");
    expect(run.calls).toEqual([{ bin: "ios", args: ["--version"] }]);
  });

  it("validates udid and output without spawning", async () => {
    const run = iosShotRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.screenshot("", tmpFile("a.png"))).rejects.toThrow(/Invalid udid/);
    await expect(driver.screenshot("  ", tmpFile("b.png"))).rejects.toThrow(/Invalid udid/);
    await expect(driver.screenshot("R1", "")).rejects.toThrow(/Invalid output/);
    await expect(driver.screenshot("R1", "  ")).rejects.toThrow(/Invalid output/);
    expect(run.calls).toHaveLength(0);
  });

  it("fails with backend text verbatim when no file appears (never a missing-binary claim)", async () => {
    const run = stubRunner(() => ({ stdout: '{"level":"INFO","msg":"nothing written"}', stderr: "" }));
    const out = tmpFile("missing.png");
    const err = await new RealUiDriver({ runner: run }).screenshot("R1", out).catch((e: Error) => e);
    expect(String(err.message)).toContain("nothing written");
    expect(String(err.message)).toContain(out);
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("fails when the file is not a PNG (magic bytes)", async () => {
    const run = stubRunner((bin, args) => {
      const file = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
      if (file) fs.writeFileSync(file, "this is not a png");
      return { stdout: '{"level":"INFO","msg":"File saved successfully"}', stderr: "" };
    });
    const err = await new RealUiDriver({ runner: run }).screenshot("R1", tmpFile("fake.png")).catch((e: Error) => e);
    expect(String(err.message)).toMatch(/did not produce a PNG/);
    expect(String(err.message)).toContain("File saved successfully");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["screenshot"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(new RealUiDriver({ runner: run }).screenshot("R1", tmpFile("x.png"))).rejects.toThrow(
      GO_IOS_INSTALL_HINT,
    );
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["screenshot"], 1, "", '{"level":"ERROR","msg":"device locked"}');
    });
    const err = await new RealUiDriver({ runner: run }).screenshot("R1", tmpFile("x.png")).catch((e: Error) => e);
    expect(String(err.message)).toContain("device locked");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("throws P2-style errors for the WDA-gated verbs (screenshot-only scope)", async () => {
    const run = iosShotRunner();
    const driver = new RealUiDriver({ runner: run });
    expect(REAL_UI_WDA_DETAIL).toContain("WebDriverAgent");
    await expect(driver.describeUi("R1")).rejects.toThrow(/P2/);
    await expect(driver.tap("R1", { label: "OK" })).rejects.toThrow(/P2/);
    await expect(driver.typeText("R1", "hi")).rejects.toThrow(/P2/);
    await expect(driver.swipe("R1", { x: 0, y: 0 }, { x: 1, y: 1 })).rejects.toThrow(/P2/);
    await expect(driver.gesture("R1", "scroll-up")).rejects.toThrow(/P2/);
    await expect(driver.button("R1", "home")).rejects.toThrow(/P2/);
    await expect(driver.batch("R1", ["tap --label OK"])).rejects.toThrow(/P2/);
    expect(run.calls).toHaveLength(0);
  });
});

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

function realDev(): PoolDevice {
  return {
    udid: "R1", name: "Test iPhone", state: "available", platform: "iOS", osVersion: "26.1",
    kind: "real", transport: "wifi", trust: { paired: true, developerMode: "enabled" }, coredeviceId: "core-R1",
  };
}

async function makeShotClient(opts: { withRealUi?: boolean } = {}) {
  const withRealUi = opts.withRealUi ?? true;
  const axeRun = axeShotRunner();
  const iosRun = iosShotRunner();
  const noop = stubRunner(() => ({ stdout: "", stderr: "" }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-shotdisp-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    { defaultTtlMs: 60_000, realFleet: new FakeRealFleet([realDev()]) },
  );
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-shots-"));
  const server = createMcpServer({
    orchestrator: orch,
    simslim: new Simslim({ runner: noop }),
    axe: new Axe({ runner: axeRun }),
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog({ runner: async () => ({ stdout: "", truncated: false, timedOut: true }) }),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop, exists: () => true }),
    lldmdb: new Llmdb({ runner: noop }),
    screenshotDir,
    ...(withRealUi ? { realUi: new RealUiDriver({ runner: iosRun }) } : {}),
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
    client, orch, axeRun, iosRun, screenshotDir,
    simLeaseId: simLease.lease.leaseId, realLeaseId: realLease.lease.leaseId,
  };
}

describe("ui_screenshot dispatch by lease kind", () => {
  it("routes real leases to the go-ios backend with the sim ok shape", async () => {
    const { client, orch, axeRun, iosRun, screenshotDir, realLeaseId } = await makeShotClient();
    const result = await client.callTool({ name: "ui_screenshot", arguments: { lease_id: realLeaseId } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "R1" });
    expect(String(json["path"])).toContain(screenshotDir);
    expect(axeRun.calls).toHaveLength(0); // no sim cross-talk
    expect(iosRun.calls).toHaveLength(1);
    expect(iosRun.calls[0]?.bin).toBe("ios");
    expect(iosRun.calls[0]?.args.slice(0, 2)).toEqual(["screenshot", "--udid=R1"]);
    const image = result.content.find((c) => c.type === "image") as
      | { type: "image"; data: string; mimeType: string }
      | undefined;
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(PNG_BYTES.toString("base64"));
    const actions = orch.leaseActions(realLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain("ui_screenshot screenshot R1-");
  });

  it("keeps the sim path byte-identical (axe argv + ok shape)", async () => {
    const { client, axeRun, iosRun, simLeaseId } = await makeShotClient();
    const result = await client.callTool({ name: "ui_screenshot", arguments: { lease_id: simLeaseId } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "U1" });
    expect(iosRun.calls).toHaveLength(0);
    expect(axeRun.calls).toHaveLength(1);
    expect(axeRun.calls[0]?.bin).toBe("axe");
    expect(axeRun.calls[0]?.args.slice(0, 3)).toEqual(["screenshot", "--udid", "U1"]);
    expect(axeRun.calls[0]?.args[3]).toBe("--output");
    expect(axeRun.calls[0]?.args[4]).toBe(String(json["path"]));
  });

  it("fails real screenshots with a missing-transport error when realUi is absent", async () => {
    const { client, realLeaseId } = await makeShotClient({ withRealUi: false });
    const result = await client.callTool({ name: "ui_screenshot", arguments: { lease_id: realLeaseId } });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text");
    expect((text as { text: string }).text).toContain("screenshot transport");
  });

  it("keeps the other ui_* verbs fail-fast P2 on real leases", async () => {
    const { client, realLeaseId } = await makeShotClient();
    const tap = await client.callTool({ name: "ui_tap", arguments: { lease_id: realLeaseId, label: "OK" } });
    expect(tap.isError).toBe(true);
    const text = tap.content.find((c) => c.type === "text");
    expect((text as { text: string }).text).toContain("P2");
  });
});
