import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_FILE_ENV,
  BOOT_STATE_FILE_ENV,
  appendAcquire,
  appendBoot,
  isBootTelemetryEnabled,
  resolveBootFile,
} from "../src/boottelemetry.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Store } from "../src/store.js";

class FakeFleet implements FleetOps {
  devices: SimDevice[];
  bootedUdids = new Set<string>();
  slimState = new Map<string, boolean>();
  bootFails = false;
  bootRejectsWith: unknown = new Error("boom: boot failed");
  slimFails = false;

  constructor(devices: SimDevice[]) {
    this.devices = devices.map((d) => ({ ...d }));
    for (const d of this.devices) {
      if (d.state === "Booted") this.bootedUdids.add(d.udid);
      this.slimState.set(d.udid, false);
    }
  }

  async list(): Promise<SimDevice[]> {
    return this.devices.map((d) => ({
      ...d,
      state: this.bootedUdids.has(d.udid) ? "Booted" : "Shutdown",
    }));
  }

  async boot(udid: string): Promise<void> {
    if (this.bootFails) throw this.bootRejectsWith;
    this.bootedUdids.add(udid);
  }

  async slimStatus(udid: string): Promise<SlimStatus | null> {
    if (!this.bootedUdids.has(udid)) return null;
    const slim = this.slimState.get(udid) ?? false;
    return { slim, managedDisabled: slim ? 168 : 0, managedTotal: 168, persistent: true, raw: {} };
  }

  async slimNoReboot(udid: string): Promise<void> {
    if (this.slimFails) throw new Error("slim boom");
    this.slimState.set(udid, true);
  }
}

function sim(udid: string, name = "iPhone 17 Pro", state = "Shutdown", osVersion = "26.5"): SimDevice {
  return { udid, name, state, platform: "iOS", osVersion, set: "default" };
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-boottel-")), "state.json");
}

const SAVED = ["SIM_MCP_BOOT_TELEMETRY", BOOT_FILE_ENV, BOOT_STATE_FILE_ENV] as const;
let savedEnv: Record<string, string | undefined> = {};
let teleFile: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of SAVED) savedEnv[k] = process.env[k];
  delete process.env["SIM_MCP_BOOT_TELEMETRY"];
  teleFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-boottel-")), "boot-telemetry.jsonl");
  process.env[BOOT_FILE_ENV] = teleFile;
  delete process.env[BOOT_STATE_FILE_ENV];
});

afterEach(() => {
  for (const k of SAVED) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function readLines(): Record<string, unknown>[] {
  if (!fs.existsSync(teleFile)) return [];
  const raw = fs.readFileSync(teleFile, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("boot-telemetry sink", () => {
  it("is default-ON with a SIM_MCP_BOOT_TELEMETRY=0 kill-switch", () => {
    delete process.env["SIM_MCP_BOOT_TELEMETRY"];
    expect(isBootTelemetryEnabled()).toBe(true);
    process.env["SIM_MCP_BOOT_TELEMETRY"] = "0";
    expect(isBootTelemetryEnabled()).toBe(false);
  });

  it("resolves explicit file > state-file dirname default", () => {
    process.env[BOOT_FILE_ENV] = "/tmp/explicit/boot-telemetry.jsonl";
    expect(resolveBootFile()).toBe("/tmp/explicit/boot-telemetry.jsonl");
    delete process.env[BOOT_FILE_ENV];
    process.env[BOOT_STATE_FILE_ENV] = "/scratch/daemon/state.json";
    expect(resolveBootFile()).toBe(path.join("/scratch/daemon", "boot-telemetry.jsonl"));
  });

  it("never throws on an unwritable destination", () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-boottel-")), "blocker");
    fs.writeFileSync(blocker, "not a dir");
    process.env[BOOT_FILE_ENV] = path.join(blocker, "boot-telemetry.jsonl");
    expect(() =>
      appendBoot({
        t: Date.now(), kind: "boot", ok: true, udidHash: "udid:abc", deviceName: "x",
        osVersion: "26", platform: "iOS", coldWarm: "cold", slim: "slim", slimMs: 1, bootMs: 2, readyMs: -1,
      }),
    ).not.toThrow();
    expect(() =>
      appendAcquire({ t: Date.now(), kind: "acquire", outcome: "HIT", leaseId: "l1", waitMs: 1, bootMs: -1, slimMs: -1, baselineMs: 0, via: "acquire" }),
    ).not.toThrow();
  });
});

describe("LW0 acquire outcomes", () => {
  it("MISS path logs one BOOT ok:true + one ACQUIRE MISS with the lease id", async () => {
    const orch = new Orchestrator(new FakeFleet([sim("BOOT-UDID-1")]), Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const res = await orch.acquire({ sessionId: "s1" });
    if (!res.ok || res.queued) throw new Error("expected lease");
    const lines = readLines();
    expect(lines).toHaveLength(2);
    const boot = lines[0]!;
    expect(boot).toMatchObject({ kind: "boot", ok: true, deviceName: "iPhone 17 Pro", osVersion: "26.5", platform: "iOS", coldWarm: "cold", slim: "slim", readyMs: -1 });
    expect(boot["udidHash"]).toMatch(/^udid:[0-9a-f]{12}$/);
    expect(typeof boot["bootMs"]).toBe("number");
    expect(typeof boot["slimMs"]).toBe("number");
    expect(boot).not.toHaveProperty("err");
    const acq = lines[1]!;
    expect(acq).toMatchObject({ kind: "acquire", outcome: "MISS", leaseId: res.lease.leaseId, via: "acquire" });
    expect(acq).not.toHaveProperty("ticketId");
    expect(typeof acq["waitMs"]).toBe("number");
    expect(typeof acq["bootMs"]).toBe("number");
    // Names-only rule: raw UDID never hits disk.
    expect(fs.readFileSync(teleFile, "utf8")).not.toContain("BOOT-UDID-1");
  });

  it("HIT path logs one ACQUIRE HIT and no BOOT line", async () => {
    const orch = new Orchestrator(new FakeFleet([sim("HIT-UDID-1", "iPhone 17 Pro", "Booted")]), Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const res = await orch.acquire({ sessionId: "s1" });
    if (!res.ok || res.queued) throw new Error("expected lease");
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "acquire", outcome: "HIT", leaseId: res.lease.leaseId, bootMs: -1, via: "acquire" });
    expect(typeof lines[0]!["slimMs"]).toBe("number");
    expect(typeof lines[0]!["baselineMs"]).toBe("number");
  });

  it("QUEUE path (autoBoot:false) logs one ACQUIRE QUEUE with the ticket id", async () => {
    const orch = new Orchestrator(new FakeFleet([sim("Q-UDID-1")]), Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const res = await orch.acquire({ sessionId: "s1", autoBoot: false });
    if (!res.ok || !res.queued) throw new Error("expected ticket");
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "acquire", outcome: "QUEUE", ticketId: res.ticket.ticketId, bootMs: -1, via: "acquire" });
    expect(lines[0]).not.toHaveProperty("leaseId");
  });

  it("failed boot logs BOOT ok:false + err then ACQUIRE QUEUE", async () => {
    const fleet = new FakeFleet([sim("FAIL-UDID-1")]);
    fleet.bootFails = true;
    const orch = new Orchestrator(fleet, Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const res = await orch.acquire({ sessionId: "s1" });
    if (!res.ok || !res.queued) throw new Error("expected ticket");
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "boot", ok: false, slim: "unknown", slimMs: -1 });
    expect(typeof lines[0]!["err"]).toBe("string");
    expect(lines[1]).toMatchObject({ kind: "acquire", outcome: "QUEUE", ticketId: res.ticket.ticketId, bootMs: -1 });
  });

  it("dispatch of a waiter logs ACQUIRE HIT via dispatch with queue wait", async () => {
    const orch = new Orchestrator(new FakeFleet([sim("D-UDID-1", "iPhone 17 Pro", "Booted")]), Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const first = await orch.acquire({ sessionId: "sess-a", autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected first lease");
    const second = await orch.acquire({ sessionId: "sess-b", autoBoot: false });
    if (!second.ok || !second.queued) throw new Error("expected ticket");
    const createdAt = second.ticket.createdAt;
    await orch.release(first.lease.leaseId, "sess-a");
    const lines = readLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ kind: "acquire", outcome: "HIT", via: "dispatch" });
    expect(lines[2]).toHaveProperty("leaseId");
    expect(lines[2]!["waitMs"] as number).toBeGreaterThanOrEqual(0);
    expect((lines[2]!["t"] as number) - (lines[2]!["waitMs"] as number)).toBe(createdAt);
  });

  it("slim failure classifies slim unknown and keeps the warning", async () => {
    const fleet = new FakeFleet([sim("SLIMFAIL-UDID-1")]);
    fleet.slimFails = true;
    const orch = new Orchestrator(fleet, Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const res = await orch.acquire({ sessionId: "s1" });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.warnings?.join(" ")).toContain("Slimming");
    const lines = readLines();
    expect(lines[0]).toMatchObject({ kind: "boot", ok: true, slim: "unknown" });
    expect(typeof lines[0]!["slimMs"]).toBe("number");
  });

  it("non-Error boot rejection never throws and still logs BOOT ok:false", async () => {
    const fleet = new FakeFleet([sim("STRFAIL-UDID-1")]);
    fleet.bootFails = true;
    fleet.bootRejectsWith = "string failure, not an Error";
    const orch = new Orchestrator(fleet, Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const res = await orch.acquire({ sessionId: "s1" });
    if (!res.ok || !res.queued) throw new Error("expected ticket");
    const lines = readLines();
    expect(lines[0]).toMatchObject({ kind: "boot", ok: false });
    expect(typeof lines[0]!["err"]).toBe("string");
  });

  it("writes nothing when SIM_MCP_BOOT_TELEMETRY=0", async () => {
    process.env["SIM_MCP_BOOT_TELEMETRY"] = "0";
    const orch = new Orchestrator(new FakeFleet([sim("OFF-UDID-1", "iPhone 17 Pro", "Booted")]), Store.load(tmpState()), { defaultTtlMs: 60_000 });
    await orch.acquire({ sessionId: "s1" });
    expect(fs.existsSync(teleFile)).toBe(false);
  });
});
