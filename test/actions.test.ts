import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";

class FakeFleet implements FleetOps {
  constructor(private devices: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devices.map((d) => ({ ...d }));
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

function makeOrch() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-actions-")), "state.json");
  const fleet = new FakeFleet([
    { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
  ]);
  return new Orchestrator(fleet, Store.load(file), { defaultTtlMs: 60_000 });
}

async function acquireLeaseId(orch: Orchestrator): Promise<string> {
  const res = await orch.acquire({ sessionId: "s1", client: "test", slim: false });
  if (!res.ok || res.queued) throw new Error("expected an immediate lease");
  return res.lease.leaseId;
}

describe("lease action ring", () => {
  it("records actions retrievable newest-last", async () => {
    const orch = makeOrch();
    const leaseId = await acquireLeaseId(orch);
    await orch.logAction(leaseId, "ui_tap", "tap (10,20)");
    await orch.logAction(leaseId, "ui_type", 'type "hi"');
    const actions = orch.leaseActions(leaseId);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ tool: "ui_tap", summary: "tap (10,20)" });
    expect(actions[1]).toMatchObject({ tool: "ui_type", summary: 'type "hi"' });
    expect(typeof actions[0]!.t).toBe("number");
  });

  it("is a no-op for unknown leases", async () => {
    const orch = makeOrch();
    await orch.logAction("lease_nope", "ui_tap", "tap");
    expect(orch.leaseActions("lease_nope")).toEqual([]);
  });

  it("caps the ring at 100 entries", async () => {
    const orch = makeOrch();
    const leaseId = await acquireLeaseId(orch);
    for (let i = 0; i < 120; i++) {
      await orch.logAction(leaseId, "ui_tap", `tap ${i}`);
    }
    const actions = orch.leaseActions(leaseId);
    expect(actions).toHaveLength(100);
    expect(actions[0]!.summary).toBe("tap 20");
    expect(actions[99]!.summary).toBe("tap 119");
  });

  it("honors limit with the newest entries", async () => {
    const orch = makeOrch();
    const leaseId = await acquireLeaseId(orch);
    for (let i = 0; i < 5; i++) {
      await orch.logAction(leaseId, "ui_tap", `tap ${i}`);
    }
    expect(orch.leaseActions(leaseId, 2).map((a) => a.summary)).toEqual(["tap 3", "tap 4"]);
  });

  it("drops the ring on lease release", async () => {
    const orch = makeOrch();
    const leaseId = await acquireLeaseId(orch);
    await orch.logAction(leaseId, "ui_tap", "tap");
    expect(orch.leaseActions(leaseId)).toHaveLength(1);
    await orch.release(leaseId, "s1");
    expect(orch.leaseActions(leaseId)).toEqual([]);
    // Logging after release is a no-op (lease unknown).
    await orch.logAction(leaseId, "ui_tap", "tap again");
    expect(orch.leaseActions(leaseId)).toEqual([]);
  });

  it("drops the ring when an expired lease is swept", async () => {
    const orch = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", client: "test", slim: false, ttlMs: 1 });
    if (!res.ok || res.queued) throw new Error("expected an immediate lease");
    const leaseId = res.lease.leaseId;
    await orch.logAction(leaseId, "ui_tap", "tap");
    await new Promise((r) => setTimeout(r, 10));
    const { swept } = await orch.sweepStale();
    expect(swept).toContain(leaseId);
    expect(orch.leaseActions(leaseId)).toEqual([]);
  });
});
