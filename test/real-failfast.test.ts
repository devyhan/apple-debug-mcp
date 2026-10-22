import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import type { Lease } from "../src/store.js";
import { Store } from "../src/store.js";

class FakeFleet implements FleetOps {
  constructor(private readonly devices: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devices.map((d) => ({ ...d }));
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

function sim(udid: string, state = "Booted"): SimDevice {
  return { udid, name: "iPhone 17 Pro", state, platform: "iOS", osVersion: "26.5", set: "default" };
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realfail-")), "state.json");
}

function makeOrch(devices: SimDevice[], env?: NodeJS.ProcessEnv) {
  const store = Store.load(tmpState());
  const orch = new Orchestrator(new FakeFleet(devices), store, { defaultTtlMs: 60_000, ...(env ? { env } : {}) });
  return { store, orch };
}

async function pushLease(store: Store, lease: Lease): Promise<void> {
  await store.mutate((s) => {
    s.leases.push(lease);
    return { value: undefined, dirty: true };
  });
}

function realLease(): Lease {
  return {
    leaseId: "lease_test_real", udid: "REAL-UDID-1",
    sessionId: "s1", client: "vitest",
    createdAt: Date.now(), lastHeartbeat: Date.now(), ttlMs: 60_000,
    deviceKind: "real", transport: "usb",
  };
}

describe("resolveLease kind short-circuit", () => {
  it("returns a store-built real lease without fleet contact", async () => {
    const { store, orch } = makeOrch([]); // empty fleet: any sim lookup would evict
    await pushLease(store, realLease());
    const resolved = await orch.resolveLease("lease_test_real");
    expect(resolved.deviceKind).toBe("real");
    expect(resolved.udid).toBe("REAL-UDID-1");
    // Still held afterwards (not evicted).
    expect(await orch.leaseById("lease_test_real")).not.toBeNull();
  });

  it("still evicts a sim lease whose sim is gone (sim path unchanged)", async () => {
    const { store, orch } = makeOrch([]);
    await pushLease(store, { ...realLease(), leaseId: "lease_test_sim", udid: "GONE-UDID", deviceKind: "sim", transport: undefined });
    await expect(orch.resolveLease("lease_test_sim")).rejects.toThrow(/no longer booted/);
    expect(await orch.leaseById("lease_test_sim")).toBeNull();
  });
});

describe("acquire with deviceKind real", () => {
  it("fail-fasts with P1 text when the hatch is off", async () => {
    const { orch } = makeOrch([sim("UDID-1")], {});
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toContain("P1");
    expect(res.reason).toContain("device_kind");
  });

  it("creates a real lease directly with the hatch on + explicit udid", async () => {
    const { orch } = makeOrch([], { SIM_MCP_REAL_LEASE: "1" });
    const res = await orch.acquire({
      sessionId: "s1", requirements: { deviceKind: "real", udid: "REAL-UDID-9", transport: "wifi" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.deviceKind).toBe("real");
    expect(res.lease.udid).toBe("REAL-UDID-9");
    expect(res.lease.transport).toBe("wifi");
  });

  it("turns stream:true into a warning (never auto-streams) under the hatch", async () => {
    const { orch } = makeOrch([], { SIM_MCP_REAL_LEASE: "1" });
    const res = await orch.acquire({
      sessionId: "s1", stream: true, requirements: { deviceKind: "real", udid: "REAL-UDID-9" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.streamUrl).toBeUndefined();
    expect(res.warnings?.join(" ")).toContain("never auto-stream");
  });

  it("fails without an explicit udid under the hatch", async () => {
    const { orch } = makeOrch([sim("UDID-1")], { SIM_MCP_REAL_LEASE: "1" });
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toContain("explicit udid");
  });
});

describe("real-kind requirements never match sim devices", () => {
  it("a hand-built real ticket is left waiting despite a free sim", async () => {
    const { store, orch } = makeOrch([sim("UDID-1")]);
    await store.mutate((s) => {
      s.tickets.push({
        ticketId: "ticket_real", sessionId: "s1", client: "vitest",
        requirements: { deviceKind: "real" }, autoBoot: true, slim: false,
        createdAt: Date.now(), status: "waiting",
      });
      return { value: undefined, dirty: true };
    });
    const { dispatched } = await orch.sweepStale();
    expect(dispatched).toHaveLength(0);
    expect(await orch.leaseById("ticket_real")).toBeNull();
    const { waiting } = await orch.queueStatus();
    expect(waiting.map((t) => t.ticketId)).toContain("ticket_real");
  });

  it("sim acquires stamp deviceKind sim (additive key only)", async () => {
    const { orch } = makeOrch([sim("UDID-1")]);
    const res = await orch.acquire({ sessionId: "s1", slim: false });
    expect(res.ok).toBe(true);
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.deviceKind).toBe("sim");
    expect("transport" in res.lease).toBe(false);
  });
});
