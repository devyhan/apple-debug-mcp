import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

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

describe("ServeSim camera", () => {
  it("starts with a placeholder feed by default (no source flags)", async () => {
    const run = stubRunner(() => ({ stdout: "📷 Injected camera into com.acme.App (pid 1) on U1\n", stderr: "" }));
    await new ServeSim({ runner: run }).start("U1", "com.acme.App");
    expect(run.calls[0]).toMatchObject({ bin: "serve-sim", args: ["camera", "com.acme.App", "-d", "U1"] });
  });

  it("starts with an explicit placeholder source", async () => {
    const run = stubRunner(() => ({ stdout: "📷 ok\n", stderr: "" }));
    await new ServeSim({ runner: run }).start("U1", "com.acme.App", { source: "placeholder" });
    expect(run.calls[0]?.args).toEqual(["camera", "com.acme.App", "-d", "U1"]);
  });

  it("starts with a file source", async () => {
    const run = stubRunner(() => ({ stdout: "📷 ok\n", stderr: "" }));
    await new ServeSim({ runner: run }).start("U1", "com.acme.App", { source: "file", file: "/tmp/face.png" });
    expect(run.calls[0]?.args).toEqual(["camera", "com.acme.App", "-d", "U1", "--file", "/tmp/face.png"]);
  });

  it("starts with the default or a named webcam", async () => {
    const def = stubRunner(() => ({ stdout: "📷 ok\n", stderr: "" }));
    await new ServeSim({ runner: def }).start("U1", "com.acme.App", { source: "webcam" });
    expect(def.calls[0]?.args).toEqual(["camera", "com.acme.App", "-d", "U1", "--webcam"]);

    const named = stubRunner(() => ({ stdout: "📷 ok\n", stderr: "" }));
    await new ServeSim({ runner: named }).start("U1", "com.acme.App", { source: "webcam", webcam: "FaceTime HD 카메라" });
    expect(named.calls[0]?.args).toEqual(["camera", "com.acme.App", "-d", "U1", "--webcam", "FaceTime HD 카메라"]);
  });

  it("rejects invalid start combos without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const sim = new ServeSim({ runner: run });
    await expect(sim.start("U1", "com.acme.App", { source: "image" })).rejects.toThrow(/invalid camera source/i);
    await expect(sim.start("U1", "com.acme.App", { source: "file" })).rejects.toThrow(/requires a file path/i);
    await expect(sim.start("U1", "com.acme.App", { file: "/tmp/x.png" })).rejects.toThrow(/only valid with source "file"/i);
    await expect(sim.start("U1", "com.acme.App", { source: "file", file: "/tmp/x.png", webcam: "C" })).rejects.toThrow(
      /not both/i,
    );
    await expect(sim.start("U1", "com.acme.App", { source: "placeholder", webcam: "C" })).rejects.toThrow(
      /only valid with source "webcam"/i,
    );
    expect(run.calls).toHaveLength(0);
  });

  it("switches placeholder/webcam feeds", async () => {
    const run = stubRunner(() => ({ stdout: "📷 Switched U1 → placeholder\n", stderr: "" }));
    const sim = new ServeSim({ runner: run });
    await sim.switchSource("U1", "placeholder");
    await sim.switchSource("U1", "webcam");
    expect(run.calls.map((c) => c.args)).toEqual([
      ["camera", "switch", "placeholder", "-d", "U1"],
      ["camera", "switch", "webcam", "-d", "U1"],
    ]);
  });

  it("switches to a file feed", async () => {
    const run = stubRunner(() => ({ stdout: "📷 Switched U1 → image (/tmp/loop.mp4)\n", stderr: "" }));
    await new ServeSim({ runner: run }).switchSource("U1", "file", "/tmp/loop.mp4");
    expect(run.calls[0]?.args).toEqual(["camera", "switch", "file", "/tmp/loop.mp4", "-d", "U1"]);
  });

  it("rejects invalid switch combos without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const sim = new ServeSim({ runner: run });
    await expect(sim.switchSource("U1", "video")).rejects.toThrow(/invalid camera source/i);
    await expect(sim.switchSource("U1", "file")).rejects.toThrow(/requires a file path/i);
    await expect(sim.switchSource("U1", "webcam", "/tmp/x.png")).rejects.toThrow(/only valid with source "file"/i);
    expect(run.calls).toHaveLength(0);
  });

  it("sets mirror modes and rejects the rest", async () => {
    const run = stubRunner(() => ({ stdout: "📷 Mirror → on on U1\n", stderr: "" }));
    const sim = new ServeSim({ runner: run });
    await sim.mirror("U1", "on");
    expect(run.calls[0]?.args).toEqual(["camera", "mirror", "on", "-d", "U1"]);
    await expect(sim.mirror("U1", "sideways")).rejects.toThrow(/invalid camera mirror mode/i);
    expect(run.calls).toHaveLength(1);
  });

  it("parses the alive status shape", async () => {
    const run = stubRunner(() => ({
      stdout: JSON.stringify({
        source: "placeholder",
        mirror: "unset",
        ok: true,
        udid: "U1",
        alive: true,
        helperPid: 93049,
        bundleIds: [],
      }),
      stderr: "",
    }));
    await expect(new ServeSim({ runner: run }).status("U1")).resolves.toEqual({
      udid: "U1",
      alive: true,
      source: "placeholder",
      mirror: "unset",
      helperPid: 93049,
      bundleIds: [],
    });
    expect(run.calls[0]?.args).toEqual(["camera", "status", "-d", "U1"]);
  });

  it("tolerates the no-helper status as a normal idle result", async () => {
    const idle = stubRunner(() => ({ stdout: `{"udid":"U1","alive":false}`, stderr: "" }));
    await expect(new ServeSim({ runner: idle }).status("U1")).resolves.toEqual({ udid: "U1", alive: false });

    const noDevice = stubRunner(() => ({ stdout: `{"alive":false,"error":"no booted simulator"}`, stderr: "" }));
    await expect(new ServeSim({ runner: noDevice }).status("U1")).resolves.toEqual({
      alive: false,
      error: "no booted simulator",
    });
  });

  it("rejects status output without a boolean alive", async () => {
    const run = stubRunner(() => ({ stdout: `{"running":true}`, stderr: "" }));
    await expect(new ServeSim({ runner: run }).status("U1")).rejects.toThrow(/missing boolean "alive"/i);
  });

  it("stops via --stop-webcam and ignores the human-readable output", async () => {
    const run = stubRunner(() => ({ stdout: "Stopped camera helper for U1\n", stderr: "" }));
    await new ServeSim({ runner: run }).stop("U1");
    expect(run.calls[0]?.args).toEqual(["camera", "--stop-webcam", "-d", "U1"]);
  });

  it("parses --list-webcams TSV", async () => {
    const run = stubRunner(() => ({
      stdout: "1FD4B3A2-236E-492B-8CE5-255DD288CE50\tFaceTime HD 카메라\nAAAA\tUSB Cam\n\n",
      stderr: "",
    }));
    await expect(new ServeSim({ runner: run }).listWebcams()).resolves.toEqual([
      { id: "1FD4B3A2-236E-492B-8CE5-255DD288CE50", name: "FaceTime HD 카메라" },
      { id: "AAAA", name: "USB Cam" },
    ]);
    expect(run.calls[0]?.args).toEqual(["camera", "--list-webcams"]);
  });

  it("tolerates empty and malformed webcam listings", async () => {
    const empty = stubRunner(() => ({ stdout: "\n", stderr: "" }));
    await expect(new ServeSim({ runner: empty }).listWebcams()).resolves.toEqual([]);
    const bare = stubRunner(() => ({ stdout: "lonely-line\n", stderr: "" }));
    await expect(new ServeSim({ runner: bare }).listWebcams()).resolves.toEqual([{ id: "lonely-line", name: "" }]);
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

async function makeClient(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }) {
  const run = stubRunner(handler);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-camera-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    { defaultTtlMs: 60_000 },
  );
  const server = new McpServer({ name: "test", version: "0" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: run }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: run }),
    xctrace: new XCTrace({ runner: run }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, orch, run };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

describe("extras camera tools", () => {
  it("camera_start refuses a leased sim unless force, naming the holder", async () => {
    const { client, orch, run } = await makeClient(() => ({ stdout: "📷 ok\n", stderr: "" }));
    const res = await orch.acquire({ sessionId: "s-holder", slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected a lease");
    const leaseId = res.lease.leaseId;

    const refused = await call(client, "camera_start", { udid: "U1", bundle_id: "com.acme.App" });
    expect(refused.isError).toBe(true);
    expect(String(refused.json.error)).toMatch(/s-holder/);
    expect(String(refused.json.error)).toMatch(new RegExp(leaseId));
    expect(run.calls).toHaveLength(0);

    const forced = await call(client, "camera_start", { udid: "U1", bundle_id: "com.acme.App", force: true });
    expect(forced.json).toMatchObject({ ok: true, udid: "U1", bundle_id: "com.acme.App", source: "placeholder" });
    expect(run.calls[0]?.args).toEqual(["camera", "com.acme.App", "-d", "U1"]);
    expect(orch.leaseActions(leaseId).map((a) => a.tool)).toContain("camera_start");
  });

  it("camera_start proceeds on an unleased sim", async () => {
    const { client, run } = await makeClient(() => ({ stdout: "📷 ok\n", stderr: "" }));
    const res = await call(client, "camera_start", {
      udid: "U1",
      bundle_id: "com.acme.App",
      source: "file",
      file: "/tmp/face.png",
    });
    expect(res.json).toMatchObject({ ok: true, source: "file" });
    expect(run.calls[0]?.args).toEqual(["camera", "com.acme.App", "-d", "U1", "--file", "/tmp/face.png"]);
  });

  it("camera_switch refuses a leased sim unless force", async () => {
    const { client, orch, run } = await makeClient(() => ({ stdout: "📷 Switched U1 → webcam\n", stderr: "" }));
    const res = await orch.acquire({ sessionId: "s-holder", slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected a lease");

    const refused = await call(client, "camera_switch", { udid: "U1", source: "webcam" });
    expect(refused.isError).toBe(true);
    expect(String(refused.json.error)).toMatch(/s-holder/);
    expect(run.calls).toHaveLength(0);

    const forced = await call(client, "camera_switch", { udid: "U1", source: "webcam", force: true });
    expect(forced.json).toMatchObject({ ok: true, udid: "U1", source: "webcam" });
    expect(run.calls[0]?.args).toEqual(["camera", "switch", "webcam", "-d", "U1"]);
  });

  it("camera_mirror/camera_status/camera_stop are ungated on a leased sim", async () => {
    const { client, orch, run } = await makeClient((_bin, args) => {
      if (args[0] === "camera" && args[1] === "status") return { stdout: `{"udid":"U1","alive":false}`, stderr: "" };
      return { stdout: "ok\n", stderr: "" };
    });
    const res = await orch.acquire({ sessionId: "s-holder", slim: false, autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected a lease");

    const mirror = await call(client, "camera_mirror", { udid: "U1", mode: "off" });
    expect(mirror.json).toMatchObject({ ok: true, udid: "U1", mode: "off" });
    const status = await call(client, "camera_status", { udid: "U1" });
    expect(status.json).toMatchObject({ ok: true, udid: "U1", alive: false });
    const stop = await call(client, "camera_stop", { udid: "U1" });
    expect(stop.json).toMatchObject({ ok: true, udid: "U1", stopped: true });
    expect(run.calls.map((c) => c.args)).toEqual([
      ["camera", "mirror", "off", "-d", "U1"],
      ["camera", "status", "-d", "U1"],
      ["camera", "--stop-webcam", "-d", "U1"],
    ]);
  });

  it("camera tools fail with an install hint when serve-sim is missing", async () => {
    const missing: Runner = async (bin, args) => {
      throw new ExecError(bin, args, "ENOENT", "", "spawn serve-sim ENOENT");
    };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-camera-")), "state.json");
    const orch = new Orchestrator(
      new FakeFleet([
        { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
      ]),
      Store.load(file),
      { defaultTtlMs: 60_000 },
    );
    const server = new McpServer({ name: "test", version: "0" });
    registerDeviceExtras(server, {
      orchestrator: orch,
      serveSim: new ServeSim({ runner: missing }),
      simLog: new SimLog(),
      simApps: new SimApps({ runner: missing }),
      xctrace: new XCTrace({ runner: missing }),
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);

    const status = await call(client, "camera_status", { udid: "U1" });
    expect(status.isError).toBe(true);
    expect(String(status.json.error)).toMatch(/npm install -g serve-sim/);
  });
});
