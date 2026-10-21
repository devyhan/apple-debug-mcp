import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecError, Runner } from "../src/exec.js";
import { findForeignApps, Orchestrator } from "../src/orchestrator.js";
import { SimApps } from "../src/simapps.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";

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

function launchctlOutput(bundles: string[]): string {
  return "PID\tStatus\tLabel\n" + bundles.map((b, i) => `${1000 + i}\t0\tUIKitApplication:${b}\n`).join("");
}

function makeOrch(opts: {
  running?: string[];
  failSpawn?: boolean;
  minIntervalMs?: number;
  check?: boolean;
} = {}) {
  let running = opts.running ?? [];
  const failSpawn = opts.failSpawn ?? false;
  const run = stubRunner(() => {
    if (failSpawn) throw new ExecError("xcrun", ["simctl"], 1, "", "spawn failed");
    return { stdout: launchctlOutput(running), stderr: "" };
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-contam-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    {
      defaultTtlMs: 60_000,
      apps: new SimApps({ runner: run }),
      contaminationCheck: opts.check ?? true,
      contaminationCheckMinIntervalMs: opts.minIntervalMs ?? 0,
    },
  );
  const spawnCalls = () => run.calls.filter((c) => c.args[0] === "simctl" && c.args[1] === "spawn").length;
  return { orch, run, spawnCalls, setRunning: (next: string[]) => { running = next; } };
}

async function acquireLease(orch: Orchestrator): Promise<string> {
  const res = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
  if (!res.ok || res.queued) throw new Error("expected a lease");
  return res.lease.leaseId;
}

describe("findForeignApps (pure diff)", () => {
  it("flags running bundles outside the baseline and lease-launched sets", () => {
    expect(findForeignApps(new Set(["a", "b", "c"]), new Set(["a"]), new Set(["b"]))).toEqual(["c"]);
  });

  it("ignores com.apple.* bundles and sorts the result", () => {
    expect(
      findForeignApps(new Set(["com.apple.Preferences", "z.app", "a.app"]), new Set(), new Set()),
    ).toEqual(["a.app", "z.app"]);
  });

  it("returns empty when everything is baseline or lease-launched", () => {
    expect(findForeignApps(new Set(["a", "b"]), new Set(["a"]), new Set(["b"]))).toEqual([]);
  });
});

describe("orchestrator contamination detection", () => {
  it("captures a baseline at acquire and stays uncontended while nothing foreign runs", async () => {
    const { orch, spawnCalls } = makeOrch({ running: ["com.example.Before"] });
    const leaseId = await acquireLease(orch);
    expect(spawnCalls()).toBeGreaterThanOrEqual(1); // baseline snapshot
    await orch.resolveLease(leaseId);
    expect(orch.contaminationStatus(leaseId)).toMatchObject({ contended: false, contendedSince: null });
  });

  it("flags a foreign bundle once (transition only) and surfaces it in views", async () => {
    const { orch, setRunning } = makeOrch({ running: [] });
    const leaseId = await acquireLease(orch);
    setRunning(["com.evil.Foreign"]);
    await orch.resolveLease(leaseId);
    const status = orch.contaminationStatus(leaseId);
    expect(status.contended).toBe(true);
    expect(typeof status.contendedSince).toBe("number");
    await orch.resolveLease(leaseId);
    await orch.resolveLease(leaseId);
    const externals = orch.leaseActions(leaseId).filter((a) => a.tool === "EXTERNAL");
    expect(externals).toHaveLength(1);
    expect(externals[0]?.summary).toMatch(/com\.evil\.Foreign/);
    const pool = await orch.poolStatus();
    expect(pool.simulators.find((s) => s.udid === "U1")?.lease).toMatchObject({ contended: true });
    const listed = await orch.leasesList();
    expect(listed.leases.find((l) => l.leaseId === leaseId)).toMatchObject({
      contended: true,
      contendedSince: status.contendedSince,
    });
  });

  it("never flags lease-launched bundles, but flags them after terminate", async () => {
    const { orch, setRunning } = makeOrch({ running: [] });
    const leaseId = await acquireLease(orch);
    orch.markAppLaunched(leaseId, "com.example.Mine");
    setRunning(["com.example.Mine"]);
    await orch.resolveLease(leaseId);
    expect(orch.contaminationStatus(leaseId).contended).toBe(false);
    orch.markAppTerminated(leaseId, "com.example.Mine");
    await orch.resolveLease(leaseId);
    expect(orch.contaminationStatus(leaseId).contended).toBe(true);
  });

  it("throttles checks by contaminationCheckMinIntervalMs", async () => {
    const { orch, spawnCalls } = makeOrch({ running: [], minIntervalMs: 60_000 });
    const leaseId = await acquireLease(orch);
    const afterAcquire = spawnCalls();
    await orch.resolveLease(leaseId);
    await orch.resolveLease(leaseId);
    expect(spawnCalls()).toBe(afterAcquire); // baseline counts; per-op checks throttled
    expect(orch.contaminationStatus(leaseId).contended).toBe(false);
  });

  it("skips silently on spawn failure: unknown, not contended, never throws", async () => {
    const { orch } = makeOrch({ failSpawn: true });
    const leaseId = await acquireLease(orch); // baseline failure still acquires
    const lease = await orch.resolveLease(leaseId);
    expect(lease.leaseId).toBe(leaseId);
    expect(orch.contaminationStatus(leaseId)).toMatchObject({ contended: false, contendedSince: null });
    expect(orch.leaseActions(leaseId).some((a) => a.tool === "EXTERNAL")).toBe(false);
  });

  it("records a note when the baseline snapshot fails but the acquire succeeds", async () => {
    const { orch } = makeOrch({ failSpawn: true });
    const leaseId = await acquireLease(orch);
    const notes = orch.leaseActions(leaseId).filter((a) => a.tool === "contamination");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.summary).toMatch(/baseline snapshot failed/i);
  });

  it("cleans up contamination state on release", async () => {
    const { orch, setRunning } = makeOrch({ running: [] });
    const leaseId = await acquireLease(orch);
    setRunning(["com.evil.Foreign"]);
    await orch.resolveLease(leaseId);
    expect(orch.contaminationStatus(leaseId).contended).toBe(true);
    await orch.release(leaseId, "s1");
    expect(orch.contaminationStatus(leaseId)).toEqual({ contended: false, contendedSince: null });
  });

  it("does nothing when the check is disabled", async () => {
    const { orch, setRunning, spawnCalls } = makeOrch({ running: [], check: false });
    const leaseId = await acquireLease(orch);
    setRunning(["com.evil.Foreign"]);
    await orch.resolveLease(leaseId);
    expect(spawnCalls()).toBe(0);
    expect(orch.contaminationStatus(leaseId).contended).toBe(false);
  });

  it("periodic sweep check flags foreign apps without a gated op", async () => {
    const { orch, setRunning } = makeOrch({ running: [], minIntervalMs: 0 });
    const leaseId = await acquireLease(orch);
    setRunning(["com.evil.Foreign"]);
    await orch.sweepStale();
    expect(orch.contaminationStatus(leaseId).contended).toBe(true);
  });
});
