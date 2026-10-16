import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Runner } from "../src/exec.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  DEFAULT_STREAM_PORT_BASE,
  ServeSim,
  StreamInfo,
  StreamOps,
  findFreePort,
} from "../src/servesim.js";
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

function detachJson(udid: string, port: number): string {
  return JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:${port}/helper/${udid}/ws`,
    port,
    device: udid,
  });
}

/** Echoes the requested --port back in detach output, whatever the scan picked. */
function echoRunner(udid: string, listJson = `{"running":false}`): ReturnType<typeof stubRunner> {
  return stubRunner((_bin, args) => {
    if (args[0] === "--list") return { stdout: listJson, stderr: "" };
    if (args[0] === "--detach") {
      const port = Number(args[args.indexOf("--port") + 1]);
      return { stdout: detachJson(udid, port), stderr: "" };
    }
    if (args[0] === "--kill") {
      return { stdout: JSON.stringify({ disconnected: true, device: udid }), stderr: "" };
    }
    throw new Error(`unexpected args ${args.join(" ")}`);
  });
}

describe("ServeSim streaming", () => {
  it("uses port base 3220 by default", () => {
    expect(DEFAULT_STREAM_PORT_BASE).toBe(3220);
  });

  it("startStream spawns detach with a scanned --port and returns the stream URL", async () => {
    const run = echoRunner("U1");
    const info = await new ServeSim({ runner: run }).startStream("U1");
    const detach = run.calls.find((c) => c.args[0] === "--detach");
    expect(detach?.args.slice(0, 2)).toEqual(["--detach", "U1"]);
    expect(detach?.args[2]).toBe("--port");
    const port = Number(detach?.args[3]);
    expect(Number.isInteger(port) && port >= 3220).toBe(true);
    expect(info).toEqual({ url: `http://127.0.0.1:${port}/helper/U1/stream.mjpeg`, port });
    expect(run.calls[0]?.args).toEqual(["--list", "U1"]);
  });

  it("startStream reuses a running helper without spawning", async () => {
    const run = stubRunner((_bin, args) => {
      if (args[0] === "--list") {
        return {
          stdout: JSON.stringify({
            running: true,
            streamUrl: "http://127.0.0.1:3220/helper/U1/stream.mjpeg",
            port: 3220,
            pid: 111,
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected args ${args.join(" ")}`);
    });
    const info = await new ServeSim({ runner: run }).startStream("U1");
    expect(info).toEqual({ url: "http://127.0.0.1:3220/helper/U1/stream.mjpeg", port: 3220 });
    expect(run.calls).toHaveLength(1);
  });

  it("startStream tolerates non-JSON prefix lines in detach output", async () => {
    const run = stubRunner((_bin, args) => {
      if (args[0] === "--list") return { stdout: `{"running":false}`, stderr: "" };
      if (args[0] === "--detach") {
        const port = Number(args[args.indexOf("--port") + 1]);
        return {
          stdout: `\x1B[90mPort ${port} busy, killing listener pid(s): 999\x1B[0m\n${detachJson("U1", port)}\n`,
          stderr: "",
        };
      }
      throw new Error(`unexpected args ${args.join(" ")}`);
    });
    const info = await new ServeSim({ runner: run }).startStream("U1");
    expect(info.url).toMatch(/\/helper\/U1\/stream\.mjpeg$/);
  });

  it("startStream falls back to --list when detach output carries no URL", async () => {
    let lists = 0;
    const run = stubRunner((_bin, args) => {
      if (args[0] === "--list") {
        lists += 1;
        return {
          stdout: lists === 1
            ? `{"running":false}`
            : JSON.stringify({
              running: true,
              streamUrl: "http://127.0.0.1:3220/helper/U1/stream.mjpeg",
              port: 3220,
              pid: 222,
            }),
          stderr: "",
        };
      }
      if (args[0] === "--detach") return { stdout: `{}`, stderr: "" };
      throw new Error(`unexpected args ${args.join(" ")}`);
    });
    const info = await new ServeSim({ runner: run }).startStream("U1");
    expect(info).toEqual({ url: "http://127.0.0.1:3220/helper/U1/stream.mjpeg", port: 3220 });
    expect(run.calls.filter((c) => c.args[0] === "--list")).toHaveLength(2);
  });

  it("scans past an occupied base port", async () => {
    const busy = net.createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", () => resolve()));
    const base = (busy.address() as net.AddressInfo).port;
    try {
      await expect(findFreePort(base)).resolves.toBe(base + 1);
      const run = echoRunner("U1");
      const info = await new ServeSim({ runner: run }).startStream("U1", { portBase: base });
      expect(info.port).toBe(base + 1);
      const detach = run.calls.find((c) => c.args[0] === "--detach");
      expect(detach?.args).toEqual(["--detach", "U1", "--port", String(base + 1)]);
    } finally {
      await new Promise((resolve) => busy.close(() => resolve(undefined)));
    }
  });

  it("stopStream kills per-device and forgets the helper", async () => {
    const run = echoRunner("U1");
    const sim = new ServeSim({ runner: run });
    await sim.startStream("U1");
    expect(sim.helperPids().has("U1")).toBe(true);
    await sim.stopStream("U1");
    expect(run.calls.at(-1)?.args).toEqual(["--kill", "U1"]);
    expect(sim.helperPids().has("U1")).toBe(false);
  });

  it("streamStatus parses running and idle shapes", async () => {
    const running = stubRunner(() => ({
      stdout: JSON.stringify({
        running: true,
        streamUrl: "http://127.0.0.1:3220/helper/U1/stream.mjpeg",
        port: 3220,
        pid: 333,
      }),
      stderr: "",
    }));
    await expect(new ServeSim({ runner: running }).streamStatus("U1")).resolves.toEqual({
      running: true,
      url: "http://127.0.0.1:3220/helper/U1/stream.mjpeg",
      port: 3220,
      pid: 333,
    });
    const idle = stubRunner(() => ({ stdout: `{"running":false}`, stderr: "" }));
    await expect(new ServeSim({ runner: idle }).streamStatus("U1")).resolves.toEqual({ running: false });
  });
});

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

class FakeStreamer implements StreamOps {
  streams = new Map<string, StreamInfo>();
  starts: string[] = [];
  stops: string[] = [];
  failStart = false;
  nextPort = 3220;

  async startStream(udid: string): Promise<StreamInfo> {
    this.starts.push(udid);
    if (this.failStart) throw new Error("boom: no encoder");
    const existing = this.streams.get(udid);
    if (existing) return existing;
    const port = this.nextPort++;
    const info = { url: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`, port };
    this.streams.set(udid, info);
    return info;
  }

  async stopStream(udid: string): Promise<void> {
    this.stops.push(udid);
    this.streams.delete(udid);
  }
}

function makeOrch() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-stream-")), "state.json");
  const fleet = new FakeFleet([
    { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
  ]);
  const streamer = new FakeStreamer();
  const orch = new Orchestrator(fleet, Store.load(file), {
    defaultTtlMs: 60_000,
    streamer,
    streamPortBase: 3220,
  });
  return { orch, streamer };
}

describe("orchestrator streaming", () => {
  it("acquire with stream:true stores the URL on the lease and pool view", async () => {
    const { orch, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    expect(res.lease.streamUrl).toMatch(/\/helper\/U1\/stream\.mjpeg$/);
    expect(res.lease.streamPort).toBe(3220);
    expect(streamer.starts).toEqual(["U1"]);
    const pool = await orch.poolStatus();
    expect(pool.simulators[0]?.lease?.streamUrl).toBe(res.lease.streamUrl);
    const sessions = await orch.sessionsList();
    expect(sessions.sessions[0]?.leases[0]?.streamUrl).toBe(res.lease.streamUrl);
  });

  it("acquire keeps the lease valid with a warning when the stream fails", async () => {
    const { orch, streamer } = makeOrch();
    streamer.failStart = true;
    const res = await orch.acquire({ sessionId: "s1", stream: true, slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease despite stream failure");
    expect(res.lease.streamUrl).toBeUndefined();
    expect(res.warnings?.join("\n")).toMatch(/stream/i);
  });

  it("release stops the stream", async () => {
    const { orch, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await orch.release(res.lease.leaseId, "s1");
    expect(streamer.stops).toEqual(["U1"]);
  });

  it("dispatch auto-starts the stream for stream tickets", async () => {
    const { orch } = makeOrch();
    const first = await orch.acquire({ sessionId: "a", slim: false, autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const waiter = await orch.acquire({ sessionId: "b", stream: true, slim: false, autoBoot: false });
    if (!waiter.ok || !waiter.queued) throw new Error("expected ticket");
    expect(waiter.ticket.stream).toBe(true);
    const rel = await orch.release(first.lease.leaseId, "a");
    expect(rel.dispatched).toHaveLength(1);
    expect(rel.dispatched[0]?.streamUrl).toMatch(/\/helper\/U1\/stream\.mjpeg$/);
    expect(rel.dispatched[0]?.streamError).toBeUndefined();
    const { leases } = await orch.leasesList();
    expect(leases[0]?.streamUrl).toBe(rel.dispatched[0]?.streamUrl);
  });

  it("dispatch records streamError and keeps the lease when the stream fails", async () => {
    const { orch, streamer } = makeOrch();
    const first = await orch.acquire({ sessionId: "a", slim: false, autoBoot: false });
    if (!first.ok || first.queued) throw new Error("expected lease");
    const waiter = await orch.acquire({ sessionId: "b", stream: true, slim: false, autoBoot: false });
    if (!waiter.ok || !waiter.queued) throw new Error("expected ticket");
    streamer.failStart = true;
    const rel = await orch.release(first.lease.leaseId, "a");
    expect(rel.dispatched).toHaveLength(1);
    expect(rel.dispatched[0]?.streamUrl).toBeUndefined();
    expect(rel.dispatched[0]?.streamError).toMatch(/boom/);
    const { leases } = await orch.leasesList();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.streamUrl).toBeUndefined();
  });

  it("startLeaseStream/stopLeaseStream round-trip idempotently", async () => {
    const { orch, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    const started = await orch.startLeaseStream(res.lease.leaseId);
    expect(started.url).toMatch(/\/helper\/U1\/stream\.mjpeg$/);
    // Idempotent start reuses the running stream.
    const again = await orch.startLeaseStream(res.lease.leaseId);
    expect(again.url).toBe(started.url);
    const first = await orch.stopLeaseStream(res.lease.leaseId);
    expect(first.stopped).toBe(true);
    expect(first.lease.streamUrl).toBeUndefined();
    const second = await orch.stopLeaseStream(res.lease.leaseId);
    expect(second.stopped).toBe(false);
    expect(streamer.streams.has("U1")).toBe(false);
    await expect(orch.startLeaseStream("lease_nope")).rejects.toThrow(/unknown lease/i);
    await expect(orch.stopLeaseStream("lease_nope")).rejects.toThrow(/unknown lease/i);
  });

  it("sweep stops the expired lease's stream", async () => {
    const { orch, streamer } = makeOrch();
    const res = await orch.acquire({ sessionId: "s1", stream: true, slim: false, autoBoot: false, ttlMs: 5 });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await new Promise((r) => setTimeout(r, 15));
    const { swept } = await orch.sweepStale();
    expect(swept).toContain(res.lease.leaseId);
    expect(streamer.stops).toEqual(["U1"]);
  });
});
