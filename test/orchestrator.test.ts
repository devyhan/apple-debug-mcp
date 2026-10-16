import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Store } from "../src/store.js";

class FakeFleet implements FleetOps {
  devices: SimDevice[];
  bootedUdids = new Set<string>();
  slimState = new Map<string, boolean>();
  bootFails = false;

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
    if (this.bootFails) throw new Error("boom: boot failed");
    this.bootedUdids.add(udid);
  }

  async slimStatus(udid: string): Promise<SlimStatus | null> {
    if (!this.bootedUdids.has(udid)) return null;
    const slim = this.slimState.get(udid) ?? false;
    return { slim, managedDisabled: slim ? 168 : 0, managedTotal: 168, persistent: true, raw: {} };
  }

  async slimNoReboot(udid: string): Promise<void> {
    this.slimState.set(udid, true);
  }
}

function sim(udid: string, name = "iPhone 17 Pro", state = "Shutdown", osVersion = "26.5"): SimDevice {
  return { udid, name, state, platform: "iOS", osVersion, set: "default" };
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-test-")), "state.json");
}

function makeOrch(devices: SimDevice[], opts: { ttlMs?: number; maxSims?: number } = {}) {
  const fleet = new FakeFleet(devices);
  const store = Store.load(tmpState());
  const orch = new Orchestrator(fleet, store, {
    defaultTtlMs: opts.ttlMs ?? 60_000,
    maxSims: opts.maxSims ?? 0,
  });
  return { fleet, store, orch };
}

describe("acquire", () => {
  it("leases a free booted sim and slims it", async () => {
    const { fleet, orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    const res = await orch.acquire({ sessionId: "sess-orca-1", client: "orca", task: "login flow" });
    expect(res.ok).toBe(true);
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.udid).toBe("UDID-1");
    expect(res.lease.sessionId).toBe("sess-orca-1");
    expect(fleet.slimState.get("UDID-1")).toBe(true);
  });

  it("boots a matching shutdown sim when autoBoot", async () => {
    const { fleet, orch } = makeOrch([sim("UDID-1")]);
    const res = await orch.acquire({ sessionId: "s1", requirements: { device: "iphone 17" } });
    expect(res.ok).toBe(true);
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(fleet.bootedUdids.has("UDID-1")).toBe(true);
  });

  it("queues when busy and auto-dispatches on release", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    const first = await orch.acquire({ sessionId: "sess-a", client: "orca", autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected first lease");

    const second = await orch.acquire({ sessionId: "sess-b", client: "tma", autoBoot: false });
    expect(second.ok).toBe(true);
    if (!second.ok || !second.queued) throw new Error("expected ticket");
    expect(second.position).toBe(1);

    const released = await orch.release(first.lease.leaseId, "sess-a");
    expect(released.dispatched).toHaveLength(1);
    expect(released.dispatched[0]).toMatchObject({ ticketId: second.ticket.ticketId, sessionId: "sess-b", udid: "UDID-1" });

    const status = await orch.queueStatus(second.ticket.ticketId);
    expect(status.ticket?.status).toBe("assigned");
    expect(status.ticket?.assignedUdid).toBe("UDID-1");
  });

  it("honors requirements when dispatching (FIFO with matching)", async () => {
    const { orch } = makeOrch([
      sim("UDID-PRO", "iPhone 17 Pro", "Booted"),
      sim("UDID-MAX", "iPhone 17 Pro Max", "Booted"),
    ]);
    const a = await orch.acquire({ sessionId: "a", requirements: { device: "Pro Max" }, autoBoot: false });
    const b = await orch.acquire({ sessionId: "b", requirements: { udid: "UDID-PRO" }, autoBoot: false });
    if (!a.ok || a.queued || !b.ok || b.queued) throw new Error("expected leases");
    // UDID-MAX held by a; UDID-PRO held by b.

    const waiter = await orch.acquire({ sessionId: "w", requirements: { device: "Pro Max" }, autoBoot: false });
    if (!waiter.ok || !waiter.queued) throw new Error("expected ticket");

    // Releasing the non-matching sim must NOT dispatch the waiter.
    const r1 = await orch.release(b.lease.leaseId, "b");
    expect(r1.dispatched).toHaveLength(0);
    expect((await orch.queueStatus(waiter.ticket.ticketId)).ticket?.status).toBe("waiting");

    // Releasing the matching sim dispatches.
    const r2 = await orch.release(a.lease.leaseId, "a");
    expect(r2.dispatched).toHaveLength(1);
    expect(r2.dispatched[0]?.udid).toBe("UDID-MAX");
  });

  it("respects maxSims by queueing instead of booting", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted"), sim("UDID-2")], { maxSims: 1 });
    const first = await orch.acquire({ sessionId: "a" });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const second = await orch.acquire({ sessionId: "b" });
    expect(second.ok).toBe(true);
    if (!second.ok || !second.queued) throw new Error("expected ticket at capacity");
  });

  it("returns an error when queue=false and nothing is free", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    const first = await orch.acquire({ sessionId: "a", autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const res = await orch.acquire({ sessionId: "b", autoBoot: false, queue: false });
    expect(res.ok).toBe(false);
  });

  it("matches osVersion prefix and platform", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17", "Booted", "26.1")]);
    const good = await orch.acquire({ sessionId: "a", requirements: { osVersion: "26", platform: "iOS" }, autoBoot: false });
    expect(good.ok && !good.queued).toBe(true);
  });

  it("queues with a note when boot fails", async () => {
    const { fleet, orch } = makeOrch([sim("UDID-1")]);
    fleet.bootFails = true;
    const res = await orch.acquire({ sessionId: "a" });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.queued) throw new Error("expected ticket");
    expect(res.note).toMatch(/boot/i);
  });
});

describe("release / heartbeat / expiry", () => {
  it("rejects release from a different session", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    const res = await orch.acquire({ sessionId: "owner" });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await expect(orch.release(res.lease.leaseId, "impostor")).rejects.toThrow(/not owner|held by/i);
  });

  it("sweeps expired leases and hands the sim to the queue", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")], { ttlMs: 20 });
    const first = await orch.acquire({ sessionId: "a", autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const waiter = await orch.acquire({ sessionId: "b", autoBoot: false });
    if (!waiter.ok || !waiter.queued) throw new Error("expected ticket");

    await new Promise((r) => setTimeout(r, 40));
    const swept = await orch.sweepStale();
    expect(swept.swept).toContain(first.lease.leaseId);
    expect(swept.dispatched).toHaveLength(1);
    expect(swept.dispatched[0]?.sessionId).toBe("b");
  });

  it("heartbeat renews the lease", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")], { ttlMs: 60 });
    const res = await orch.acquire({ sessionId: "a", autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await new Promise((r) => setTimeout(r, 40));
    await orch.heartbeat(res.lease.leaseId, "a");
    await new Promise((r) => setTimeout(r, 40));
    const swept = await orch.sweepStale();
    expect(swept.swept).toHaveLength(0);
  });
});

describe("resolveLease", () => {
  it("releases the lease when the sim is no longer booted", async () => {
    const { fleet, orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    const res = await orch.acquire({ sessionId: "a", autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    fleet.bootedUdids.delete("UDID-1"); // external shutdown
    await expect(orch.resolveLease(res.lease.leaseId)).rejects.toThrow(/no longer booted/);
    const { leases } = await orch.leasesList();
    expect(leases).toHaveLength(0);
  });
});

describe("sessions", () => {
  it("groups leases and tickets by sessionId across clients", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    await orch.acquire({ sessionId: "sess-1", client: "orca", autoBoot: false });
    await orch.acquire({ sessionId: "sess-2", client: "claude-code", autoBoot: false });
    await orch.acquire({ sessionId: "sess-2", client: "tma", autoBoot: false });
    const { sessions } = await orch.sessionsList();
    expect(sessions).toHaveLength(2);
    const s2 = sessions.find((s) => s.sessionId === "sess-2");
    expect(s2?.clients.sort()).toEqual(["claude-code", "tma"]);
    expect(s2?.tickets).toHaveLength(2);
  });
});

describe("tickets", () => {
  it("cancel removes a waiting ticket", async () => {
    const { orch } = makeOrch([sim("UDID-1", "iPhone 17 Pro", "Booted")]);
    const first = await orch.acquire({ sessionId: "a", autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const w = await orch.acquire({ sessionId: "b", autoBoot: false });
    if (!w.ok || !w.queued) throw new Error("expected ticket");
    await orch.cancelTicket(w.ticket.ticketId, "b");
    await expect(orch.queueStatus(w.ticket.ticketId)).rejects.toThrow(/unknown ticket/i);
  });
});
