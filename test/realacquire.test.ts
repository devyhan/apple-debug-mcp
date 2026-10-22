import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { PoolDevice } from "../src/realdevices.js";
import type { RealDevices } from "../src/realdevices.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import type { Lease } from "../src/store.js";
import { Store } from "../src/store.js";

class FakeFleet implements FleetOps {
  bootCalls: string[] = [];
  slimCalls: string[] = [];
  constructor(private readonly devices: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devices.map((d) => ({ ...d }));
  }
  async boot(udid: string): Promise<void> {
    this.bootCalls.push(udid);
  }
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(udid: string): Promise<void> {
    this.slimCalls.push(udid);
  }
}

class FakeRealFleet implements Pick<RealDevices, "list"> {
  calls = 0;
  constructor(private devices: PoolDevice[]) {}
  async list(): Promise<PoolDevice[]> {
    this.calls += 1;
    return this.devices.map((d) => ({ ...d, trust: { ...d.trust } }));
  }
}

function dev(udid: string, overrides: Partial<PoolDevice> = {}): PoolDevice {
  return {
    udid,
    name: `Phone ${udid}`,
    state: "available",
    platform: "iOS",
    osVersion: "26.1",
    kind: "real",
    transport: "wifi",
    trust: { paired: true, developerMode: "enabled" },
    coredeviceId: `core-${udid}`,
    ...overrides,
  };
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realacq-")), "state.json");
}

function makeOrch(opts: { sims?: SimDevice[]; real?: PoolDevice[]; realApps?: (udid: string) => Promise<Set<string>> }) {
  const fleet = new FakeFleet(opts.sims ?? []);
  const realFleet = opts.real ? new FakeRealFleet(opts.real) : undefined;
  const store = Store.load(tmpState());
  const orch = new Orchestrator(fleet, store, {
    defaultTtlMs: 60_000,
    contaminationCheckMinIntervalMs: 0,
    ...(realFleet ? { realFleet } : {}),
    ...(opts.realApps ? { realApps: { listRunning: opts.realApps } } : {}),
  });
  return { fleet, realFleet, store, orch };
}

function sim(udid: string): SimDevice {
  return { udid, name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" };
}

async function pushLease(store: Store, lease: Lease): Promise<void> {
  await store.mutate((s) => {
    s.leases.push(lease);
    return { value: undefined, dirty: true };
  });
}

describe("real acquire", () => {
  it("leases the lowest free available udid with no boot/slim calls", async () => {
    const { fleet, orch } = makeOrch({ sims: [sim("S1")], real: [dev("R2"), dev("R1")] });
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    expect(res.ok).toBe(true);
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.deviceKind).toBe("real");
    expect(res.lease.udid).toBe("R1");
    expect(fleet.bootCalls).toHaveLength(0);
    expect(fleet.slimCalls).toHaveLength(0);
  });

  it("excludes held and unavailable devices", async () => {
    const { orch } = makeOrch({ real: [dev("R1"), dev("R2", { state: "unavailable" }), dev("R3")] });
    const first = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!first.ok || first.queued) throw new Error("expected lease");
    expect(first.lease.udid).toBe("R1");
    const second = await orch.acquire({ sessionId: "s2", requirements: { deviceKind: "real" } });
    if (!second.ok || second.queued) throw new Error("expected lease");
    expect(second.lease.udid).toBe("R3"); // R2 unavailable, skipped
  });

  it("filters on transport when requested", async () => {
    const { orch } = makeOrch({ real: [dev("R1", { transport: "wifi" }), dev("R2", { transport: "usb" })] });
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real", transport: "usb" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.udid).toBe("R2");
    expect(res.lease.transport).toBe("usb");
  });

  it("matches name/os/platform like the sim branch", async () => {
    const { orch } = makeOrch({
      real: [dev("R1", { name: "Seungtae's iPhone", osVersion: "18.0.1" }), dev("R2", { name: "Lab iPad", platform: "iPadOS" })],
    });
    const res = await orch.acquire({
      sessionId: "s1",
      requirements: { deviceKind: "real", device: "lab ipad", osVersion: "26", platform: "ipados" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    if (res.queued) throw new Error("expected no queue: R2 matches name+os-prefix+platform-ci");
    expect(res.lease.udid).toBe("R2");
  });

  it("queue=false with nothing free fails with a pool_status checklist reason", async () => {
    const { orch } = makeOrch({ real: [dev("R1", { state: "unavailable" })] });
    const res = await orch.acquire({ sessionId: "s1", queue: false, requirements: { deviceKind: "real" } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toContain("pool_status");
    expect(res.reason).toContain("queue=false");
  });

  it("queues when nothing is free (ticket keeps deviceKind real)", async () => {
    const { orch } = makeOrch({ real: [dev("R1", { state: "unavailable" })] });
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.queued) throw new Error("expected ticket");
    expect(res.ticket.requirements.deviceKind).toBe("real");
  });

  it("turns stream:true into a warning (never auto-streams)", async () => {
    const { orch } = makeOrch({ real: [dev("R1")] });
    const res = await orch.acquire({ sessionId: "s1", stream: true, requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.streamUrl).toBeUndefined();
    expect(res.warnings?.join(" ")).toContain("never auto-stream");
  });

  it("fails without an injected real fleet", async () => {
    const { orch } = makeOrch({ sims: [sim("S1")] });
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toContain("devicectl");
  });

  it("inventory failure queues with a note (or fails when queue=false)", async () => {
    const store = Store.load(tmpState());
    const orch = new Orchestrator(new FakeFleet([]), store, {
      defaultTtlMs: 60_000,
      realFleet: { list: async () => { throw new Error("tunnel down"); } },
    });
    const queued = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    expect(queued.ok).toBe(true);
    if (!queued.ok || !queued.queued) throw new Error("expected ticket");
    expect(queued.note).toContain("Real-device inventory failed");
    const refused = await orch.acquire({ sessionId: "s1", queue: false, requirements: { deviceKind: "real" } });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected failure");
    expect(refused.reason).toContain("Real-device inventory failed");
  });
});

describe("real dispatch + liveness", () => {
  it("dispatches a waiting real ticket on release (sim waiter unaffected)", async () => {
    const { orch } = makeOrch({ sims: [sim("S1")], real: [dev("R1")] });
    const held = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!held.ok || held.queued) throw new Error("expected lease");
    const queued = await orch.acquire({ sessionId: "s2", requirements: { deviceKind: "real" } });
    if (!queued.ok || !queued.queued) throw new Error("expected ticket");
    const { dispatched } = await orch.release(held.lease.leaseId, "s1");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ ticketId: queued.ticket.ticketId, udid: "R1", sessionId: "s2" });
  });

  it("a dispatched real ticket with stream:true lands streamError (no serve-sim call)", async () => {
    const { orch } = makeOrch({ real: [dev("R1")] });
    const held = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!held.ok || held.queued) throw new Error("expected lease");
    const queued = await orch.acquire({ sessionId: "s2", stream: true, requirements: { deviceKind: "real" } });
    if (!queued.ok || !queued.queued) throw new Error("expected ticket");
    const { dispatched } = await orch.release(held.lease.leaseId, "s1");
    expect(dispatched[0]?.streamError).toContain("never auto-stream");
    expect(dispatched[0]?.streamUrl).toBeUndefined();
  });

  it("resolveLease evicts a real lease whose device left the fleet", async () => {
    const realFleet = new FakeRealFleet([dev("R1")]);
    const store = Store.load(tmpState());
    const orch = new Orchestrator(new FakeFleet([]), store, { defaultTtlMs: 60_000, realFleet });
    await pushLease(store, {
      leaseId: "lease_real_gone", udid: "R-GONE", sessionId: "s1", client: "vitest",
      createdAt: Date.now(), lastHeartbeat: Date.now(), ttlMs: 60_000, deviceKind: "real",
    });
    await expect(orch.resolveLease("lease_real_gone")).rejects.toThrow(/no longer available/);
    expect(await orch.leaseById("lease_real_gone")).toBeNull();
    expect(realFleet.calls).toBeGreaterThan(0);
  });

  it("resolveLease keeps the lease when inventory fails (unknown, not gone)", async () => {
    const store = Store.load(tmpState());
    const orch = new Orchestrator(new FakeFleet([]), store, {
      defaultTtlMs: 60_000,
      realFleet: { list: async () => { throw new Error("tunnel down"); } },
    });
    await pushLease(store, {
      leaseId: "lease_real_kept", udid: "R1", sessionId: "s1", client: "vitest",
      createdAt: Date.now(), lastHeartbeat: Date.now(), ttlMs: 60_000, deviceKind: "real",
    });
    await expect(orch.resolveLease("lease_real_kept")).resolves.toMatchObject({ leaseId: "lease_real_kept" });
    expect(await orch.leaseById("lease_real_kept")).not.toBeNull();
  });
});

describe("poolStatus real section", () => {
  it("lists devices[] with lease overlay plus countsReal", async () => {
    const { orch } = makeOrch({ sims: [sim("S1")], real: [dev("R1"), dev("R2", { state: "unavailable" })] });
    const acquired = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!acquired.ok || acquired.queued) throw new Error("expected lease");
    const pool = await orch.poolStatus();
    expect(pool.simulators.map((s) => s.udid)).toEqual(["S1"]);
    expect(pool.devices.map((d) => d.udid).sort()).toEqual(["R1", "R2"]);
    const held = pool.devices.find((d) => d.udid === "R1")!;
    expect(held.lease).toMatchObject({ leaseId: acquired.lease.leaseId, sessionId: "s1" });
    expect(held).toMatchObject({ slim: null, slimDetail: null, ramBytes: null, kind: "real" });
    expect(pool.devices.find((d) => d.udid === "R2")!.lease).toBeNull();
    expect(pool.countsReal).toEqual({ total: 2, available: 1, leased: 1 });
    expect("realError" in pool).toBe(false);
  });

  it("real-fleet failure sets realError and keeps the sim view intact", async () => {
    const store = Store.load(tmpState());
    const orch = new Orchestrator(new FakeFleet([sim("S1")]), store, {
      defaultTtlMs: 60_000,
      realFleet: { list: async () => { throw new Error("tunnel down"); } },
    });
    const pool = await orch.poolStatus();
    expect(pool.devices).toEqual([]);
    expect(pool.countsReal).toEqual({ total: 0, available: 0, leased: 0 });
    expect(pool.realError).toContain("tunnel down");
    expect(pool.simulators.map((s) => s.udid)).toEqual(["S1"]);
  });
});

describe("real contamination baselines", () => {
  it("uses the real listRunning backend (sim backend untouched)", async () => {
    let simCalls = 0;
    let running: Set<string> = new Set(["com.fixture.pre"]);
    const store = Store.load(tmpState());
    const orch = new Orchestrator(new FakeFleet([]), store, {
      defaultTtlMs: 60_000,
      contaminationCheckMinIntervalMs: 0,
      realFleet: new FakeRealFleet([dev("R1")]),
      apps: { listRunning: async () => { simCalls += 1; return new Set<string>(); } },
      realApps: { listRunning: async () => new Set(running) },
    });
    const acquired = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!acquired.ok || acquired.queued) throw new Error("expected lease");
    running = new Set(["com.fixture.pre", "com.evil.foreign"]);
    await orch.resolveLease(acquired.lease.leaseId); // rides a contamination check
    expect(orch.contaminationStatus(acquired.lease.leaseId).contended).toBe(true);
    expect(simCalls).toBe(0);
  });
});
