import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { PoolDevice } from "../src/realdevices.js";
import type { StreamInfo, StreamOps } from "../src/servesim.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { REAL_STREAM_PORT, RealStreamer, StreamChild } from "../src/realstream.js";

// ---------- stubs ----------

class StubChild implements StreamChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: (NodeJS.Signals | undefined)[] = [];
  failKill = false;
  private listeners: ((chunk: unknown) => void)[] = [];
  readonly stderr = {
    on: (event: "data", cb: (chunk: unknown) => void): void => {
      if (event === "data") this.listeners.push(cb);
    },
  };

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.failKill) throw new Error("kill ESRCH (stub)");
    // Signal death, like node: signalCode set, exitCode stays null.
    this.signalCode = signal ?? "SIGTERM";
    return true;
  }

  emitStderr(text: string): void {
    for (const cb of this.listeners) cb(text);
  }

  die(code: number): void {
    this.exitCode = code;
  }
}

function stubSpawnFactory(children: StubChild[], calls: { bin: string; args: string[] }[]) {
  return (bin: string, args: string[]): StreamChild => {
    calls.push({ bin, args });
    const child = new StubChild();
    children.push(child);
    return child;
  };
}

class FakeStreamer implements StreamOps {
  starts: string[] = [];
  stops: string[] = [];
  failStart = false;

  async startStream(udid: string): Promise<StreamInfo> {
    this.starts.push(udid);
    if (this.failStart) throw new Error("boom: no encoder");
    return { url: "http://127.0.0.1:3333/", port: 3333 };
  }

  async stopStream(udid: string): Promise<void> {
    this.stops.push(udid);
  }
}

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

class FakeRealFleet {
  constructor(private readonly devices: PoolDevice[]) {}
  async list(): Promise<PoolDevice[]> {
    return this.devices.map((d) => ({ ...d, trust: { ...d.trust } }));
  }
}

function dev(udid: string): PoolDevice {
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
  };
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realstream-")), "state.json");
}

// ---------- RealStreamer unit ----------

describe("RealStreamer (single-flight go-ios MJPEG)", () => {
  const UDID = "00008140-000555603453001C";

  function rig(opts: {
    portFree?: boolean;
    httpStatus?: number | Error;
    readyTimeoutMs?: number;
    killGraceMs?: number;
  } = {}) {
    const children: StubChild[] = [];
    const calls: { bin: string; args: string[] }[] = [];
    const streamer = new RealStreamer({
      spawn: stubSpawnFactory(children, calls),
      isPortFree: async () => opts.portFree ?? true,
      httpStatus: async () => {
        if (opts.httpStatus instanceof Error) throw opts.httpStatus;
        return opts.httpStatus ?? 200;
      },
      readyTimeoutMs: opts.readyTimeoutMs ?? 500,
      readyPollMs: 5,
      killGraceMs: opts.killGraceMs ?? 10,
      killForceMs: 10,
      sleep: async () => {},
    });
    return { streamer, children, calls };
  }

  it("spawns ios screenshot --stream --udid and returns the hardcoded :3333 URL", async () => {
    const { streamer, calls } = rig();
    const info = await streamer.startStream(UDID);
    expect(info).toEqual({ url: "http://127.0.0.1:3333/", port: REAL_STREAM_PORT });
    expect(REAL_STREAM_PORT).toBe(3333);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe("ios");
    expect(calls[0]?.args).toEqual(["screenshot", "--stream", `--udid=${UDID}`]);
  });

  it("reuses a live same-udid stream without spawning again", async () => {
    const { streamer, calls } = rig();
    const first = await streamer.startStream(UDID);
    const second = await streamer.startStream(UDID);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("rejects a second udid while streaming (single-flight busy names the holder)", async () => {
    const { streamer, calls } = rig();
    await streamer.startStream(UDID);
    await expect(streamer.startStream("R-OTHER")).rejects.toThrow(/single-flight/);
    await expect(streamer.startStream("R-OTHER")).rejects.toThrow(UDID);
    expect(calls).toHaveLength(1);
  });

  it("respawns when the tracked child died (stale state never blocks)", async () => {
    const { streamer, children, calls } = rig();
    await streamer.startStream(UDID);
    children[0]?.die(0);
    const info = await streamer.startStream(UDID);
    expect(info.port).toBe(3333);
    expect(calls).toHaveLength(2);
  });

  it("revalidates HTTP on reuse: a half-dead server triggers a fresh spawn", async () => {
    let failuresLeft = 0;
    const children: StubChild[] = [];
    const calls: { bin: string; args: string[] }[] = [];
    const streamer = new RealStreamer({
      spawn: stubSpawnFactory(children, calls),
      isPortFree: async () => true,
      httpStatus: async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("socket hang up");
        }
        return 200;
      },
      readyTimeoutMs: 500,
      readyPollMs: 5,
      sleep: async () => {},
    });
    await streamer.startStream(UDID);
    failuresLeft = 1; // reuse revalidation sees a dead server → respawn; the fresh one answers
    await streamer.startStream(UDID);
    expect(calls).toHaveLength(2);
  });

  it("reports a foreign :3333 occupant (no tracked child) with an lsof hint", async () => {
    const { streamer, calls } = rig({ portFree: false });
    await expect(streamer.startStream(UDID)).rejects.toThrow(/already in use/);
    await expect(streamer.startStream(UDID)).rejects.toThrow(/lsof -i :3333/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the helper's stderr when it exits during readiness (e.g. Device not found)", async () => {
    const children: StubChild[] = [];
    const calls: { bin: string; args: string[] }[] = [];
    const streamer = new RealStreamer({
      spawn: stubSpawnFactory(children, calls),
      isPortFree: async () => true,
      httpStatus: async () => {
        const latest = children[children.length - 1];
        latest?.emitStderr(`{"level":"ERROR","msg":"Device not found: R-BOGUS"}`);
        latest?.die(1);
        throw new Error("connect ECONNREFUSED");
      },
      readyTimeoutMs: 500,
      readyPollMs: 5,
      sleep: async () => {},
    });
    await expect(streamer.startStream("R-BOGUS")).rejects.toThrow(/Device not found: R-BOGUS/);
    // Failed start clears state: the next start retries instead of reporting busy.
    await expect(streamer.startStream("R-BOGUS")).rejects.toThrow(/Device not found: R-BOGUS/);
    expect(calls).toHaveLength(2);
  });

  it("kills the child and clears state when readiness times out", async () => {
    let live = false;
    const children: StubChild[] = [];
    const calls: { bin: string; args: string[] }[] = [];
    const streamer = new RealStreamer({
      spawn: stubSpawnFactory(children, calls),
      isPortFree: async () => true,
      httpStatus: async () => {
        if (!live) throw new Error("connect ECONNREFUSED");
        return 200;
      },
      readyTimeoutMs: 20,
      readyPollMs: 5,
      killGraceMs: 5,
      sleep: async () => {},
    });
    await expect(streamer.startStream(UDID)).rejects.toThrow(/did not answer/);
    expect(children[0]?.kills[0]).toBe("SIGTERM");
    // State cleared: a later start on the SAME instance spawns fresh (no busy).
    live = true;
    const retry = await streamer.startStream(UDID);
    expect(retry.port).toBe(3333);
    expect(calls).toHaveLength(2);
  });

  it("lets spawn ENOENT through (the tool layer adds the install hint)", async () => {
    const streamer = new RealStreamer({
      spawn: () => {
        throw new Error("spawn ios ENOENT");
      },
      isPortFree: async () => true,
      httpStatus: async () => 200,
      sleep: async () => {},
    });
    await expect(streamer.startStream(UDID)).rejects.toThrow(/spawn ios ENOENT/);
  });

  it("stop is idempotent and scoped: same-udid kills, other-udid is a no-op", async () => {
    const { streamer, children, calls } = rig();
    await streamer.stopStream(UDID); // idle stop: no-op, never throws
    await streamer.startStream(UDID);
    await streamer.stopStream("R-OTHER"); // not the holder: no-op
    expect(children[0]?.kills).toHaveLength(0);
    const again = await streamer.startStream(UDID); // holder survives the foreign stop
    expect(again.port).toBe(3333);
    expect(calls).toHaveLength(1);
    await streamer.stopStream(UDID);
    expect(children[0]?.kills[0]).toBe("SIGTERM");
    await streamer.stopStream(UDID); // second stop: no-op
    expect(children[0]?.kills).toHaveLength(1);
    // Signal-death recognized (exitCode null + signalCode set): a fresh start
    // respawns instead of reporting busy — the live SIGTERM case.
    expect(children[0]?.exitCode).toBeNull();
    expect(children[0]?.signalCode).toBe("SIGTERM");
    await streamer.startStream(UDID);
    expect(calls).toHaveLength(2);
  });

  it("stopAll never throws and always clears (shutdown path)", async () => {
    const { streamer, children, calls } = rig();
    await streamer.stopAll(); // idle: no-op
    await streamer.startStream(UDID);
    children[0]!.failKill = true;
    await streamer.stopAll();
    expect(calls).toHaveLength(1);
    // Cleared: a fresh start spawns again.
    children[0]!.failKill = false;
    await streamer.startStream(UDID);
    expect(calls).toHaveLength(2);
  });
});

// ---------- orchestrator routing ----------

describe("orchestrator real-stream routing", () => {
  function makeOrch(opts: { realStreamer?: StreamOps; streamer?: StreamOps } = {}) {
    const realStreamer = opts.realStreamer ?? new FakeStreamer();
    const streamer = opts.streamer ?? new FakeStreamer();
    const orch = new Orchestrator(
      new FakeFleet([
        { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
      ]),
      Store.load(tmpState()),
      {
        defaultTtlMs: 60_000,
        streamer,
        realStreamer,
        realFleet: new FakeRealFleet([dev("R1")]),
      },
    );
    return { orch, realStreamer: realStreamer as FakeStreamer, streamer: streamer as FakeStreamer };
  }

  it("startLeaseStream routes a real lease to the real streamer and persists the URL", async () => {
    const { orch, realStreamer, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    const { lease, url, port } = await orch.startLeaseStream(res.lease.leaseId);
    expect(url).toBe("http://127.0.0.1:3333/");
    expect(port).toBe(3333);
    expect(lease.streamUrl).toBe(url);
    expect(realStreamer.starts).toEqual(["R1"]);
    expect(streamer.starts).toHaveLength(0);
  });

  it("startLeaseStream on a real lease fails fast without a real streamer", async () => {
    const orch = new Orchestrator(
      new FakeFleet([]),
      Store.load(tmpState()),
      { defaultTtlMs: 60_000, realFleet: new FakeRealFleet([dev("R1")]) },
    );
    const res = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await expect(orch.startLeaseStream(res.lease.leaseId)).rejects.toThrow(/no real streamer/);
  });

  it("stopLeaseStream routes to the real streamer; without one it still clears the record", async () => {
    const { orch, realStreamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    const stopped = await orch.stopLeaseStream(res.lease.leaseId);
    expect(stopped.stopped).toBe(true);
    expect(stopped.lease.streamUrl).toBeUndefined();
    expect(realStreamer.stops).toEqual(["R1"]);

    const bare = new Orchestrator(
      new FakeFleet([]),
      Store.load(tmpState()),
      { defaultTtlMs: 60_000, realFleet: new FakeRealFleet([dev("R1")]) },
    );
    const res2 = await bare.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
    if (!res2.ok || res2.queued) throw new Error("expected lease");
    const cleared = await bare.stopLeaseStream(res2.lease.leaseId);
    expect(cleared.stopped).toBe(false);
  });

  it("sim leases keep routing to the sim streamer (real streamer untouched)", async () => {
    const { orch, realStreamer, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.streamUrl).toMatch(/127\.0\.0\.1/);
    expect(streamer.starts).toEqual(["U1"]);
    expect(realStreamer.starts).toHaveLength(0);
    await orch.release(res.lease.leaseId, "s1");
    expect(streamer.stops).toEqual(["U1"]);
    expect(realStreamer.stops).toHaveLength(0);
  });

  it("acquire real stream:true auto-starts via the real streamer (no P3 warning)", async () => {
    const { orch, realStreamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.streamUrl).toBe("http://127.0.0.1:3333/");
    expect(realStreamer.starts).toEqual(["R1"]);
    expect(res.warnings?.join(" ") ?? "").not.toContain("P3");
  });

  it("acquire real stream:true without a real streamer warns and the lease stands", async () => {
    const orch = new Orchestrator(
      new FakeFleet([]),
      Store.load(tmpState()),
      { defaultTtlMs: 60_000, realFleet: new FakeRealFleet([dev("R1")]) },
    );
    const res = await orch.acquire({ sessionId: "s1", stream: true, requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.streamUrl).toBeUndefined();
    expect(res.warnings?.join(" ")).toContain("no real streamer");
  });

  it("release stops a streaming real lease via the real streamer", async () => {
    const { orch, realStreamer, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, requirements: { deviceKind: "real" } });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await orch.release(res.lease.leaseId, "s1");
    expect(realStreamer.stops).toEqual(["R1"]);
    expect(streamer.stops).toHaveLength(0);
  });

  it("sweep stops an expired streaming real lease via the real streamer", async () => {
    const { orch, realStreamer } = makeOrch();
    const res = await orch.acquire({
      sessionId: "s1",
      stream: true,
      ttlMs: 5,
      requirements: { deviceKind: "real" },
    });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await new Promise((r) => setTimeout(r, 15));
    const { swept } = await orch.sweepStale();
    expect(swept).toContain(res.lease.leaseId);
    expect(realStreamer.stops).toEqual(["R1"]);
  });

  it("dispatch auto-starts the stream for a real stream ticket; failure lands on streamError", async () => {
    const { orch } = makeOrch();
    const first = await orch.acquire({ sessionId: "a", requirements: { deviceKind: "real" } });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const waiter = await orch.acquire({ sessionId: "b", stream: true, requirements: { deviceKind: "real" } });
    if (!waiter.ok || !waiter.queued) throw new Error("expected ticket");
    const rel = await orch.release(first.lease.leaseId, "a");
    expect(rel.dispatched).toHaveLength(1);
    expect(rel.dispatched[0]?.streamUrl).toBe("http://127.0.0.1:3333/");
    expect(rel.dispatched[0]?.streamError).toBeUndefined();
  });
});
