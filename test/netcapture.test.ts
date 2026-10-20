import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb } from "../src/llmdb.js";
import {
  CaptureBusyError,
  CaptureOps,
  CaptureStartSpec,
  CaptureStatus,
  CaptureStopResult,
  MAX_CAPTURE_FLOWS,
  NetCapture,
  escapeRegExp,
  parseDefaultRouteInterface,
  parseTcpdumpFlows,
  validateCaptureFilter,
  validateCaptureInterface,
  validateCaptureSnaplen,
} from "../src/netcapture.js";
import { MitmChild } from "../src/netproxy.js";
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

class StubChild {
  readonly pid: number;
  exitCode: number | null = null;
  kills: (string | undefined)[] = [];
  private handlers = new Map<string, (...args: unknown[]) => void>();

  constructor(pid: number) {
    this.pid = pid;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.exitCode = signal === "SIGKILL" ? 137 : 0;
      this.handlers.get("exit")?.(this.exitCode);
    });
    return true;
  }

  once(event: string, cb: (...args: unknown[]) => void): void {
    this.handlers.set(event, cb);
  }
}

const DUMP = [
  "12:00:00.000000 IP 192.168.1.5.51234 > 121.254.184.65.6555: Flags [S], seq 0, win 65535, length 0",
  "12:00:00.010000 IP 121.254.184.65.6555 > 192.168.1.5.51234: Flags [S.], seq 0, ack 1, win 65535, length 0",
  "12:00:00.020000 IP 192.168.1.5.51234 > 121.254.184.65.6555: Flags [P.], seq 1:43, ack 1, win 65535, length 42",
  "12:00:01.000000 IP 192.168.1.5.5353 > 224.0.0.251.5353: UDP, length 32",
  "12:00:02.000000 ARP, Request who-has 192.168.1.1 tell 192.168.1.5, length 28",
  "12:00:03.000000 IP6 2001:db8::1.443 > 2001:db8::2.51234: Flags [P.], seq 1:101, ack 1, win 65535, length 100",
  "12:00:04.000000 IP 10.0.0.9.80 > 10.0.0.10.1234: Flags [F.], seq 9, ack 9, win 100",
].join("\n");

describe("parseTcpdumpFlows", () => {
  it("counts packets/bytes per flow and skips non-IP lines", () => {
    const summary = parseTcpdumpFlows(DUMP);
    expect(summary.packets).toBe(6); // ARP skipped
    expect(summary.bytes).toBe(0 + 0 + 42 + 32 + 100 + 0); // missing length = 0
    expect(summary.truncatedFlows).toBe(0);
    expect(summary.flows).toHaveLength(4);
    // Sorted by bytes desc: ip6 (100), tcp 6555 (42), udp mdns (32), tcp FIN (0).
    expect(summary.flows.map((f) => f.fromBytes + f.toBytes)).toEqual([100, 42, 32, 0]);
    expect(summary.flows[0]).toMatchObject({
      proto: "tcp",
      from: "2001:db8::1.443",
      to: "2001:db8::2.51234",
      fromPackets: 1,
      fromBytes: 100,
    });
    const game = summary.flows.find((f) => f.to === "121.254.184.65.6555")!;
    expect(game).toMatchObject({
      proto: "tcp",
      from: "192.168.1.5.51234",
      fromPackets: 2,
      fromBytes: 42,
      toPackets: 1,
      toBytes: 0,
    });
  });

  it("caps the flow list but keeps full totals", () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_CAPTURE_FLOWS + 10; i += 1) {
      lines.push(`IP 10.1.0.${i % 250}.${1000 + i} > 10.2.0.1.80: Flags [P.], seq 1:11, ack 1, win 1, length 10`);
    }
    const summary = parseTcpdumpFlows(lines.join("\n"));
    expect(summary.packets).toBe(MAX_CAPTURE_FLOWS + 10);
    expect(summary.bytes).toBe((MAX_CAPTURE_FLOWS + 10) * 10);
    expect(summary.flows).toHaveLength(MAX_CAPTURE_FLOWS);
    expect(summary.truncatedFlows).toBe(10);
  });

  it("handles empty input", () => {
    expect(parseTcpdumpFlows("")).toEqual({ packets: 0, bytes: 0, flows: [], truncatedFlows: 0 });
  });
});

describe("capture validators", () => {
  it("accepts ordinary BPF and normalizes empties", () => {
    expect(validateCaptureFilter("tcp port 6555")).toBe("tcp port 6555");
    expect(validateCaptureFilter("  udp port 443  ")).toBe("udp port 443");
    expect(validateCaptureFilter("host 10.0.0.1 and (tcp[13] & 2 != 0)")).toBe("host 10.0.0.1 and (tcp[13] & 2 != 0)");
    expect(validateCaptureFilter(undefined)).toBeUndefined();
    expect(validateCaptureFilter("")).toBeUndefined();
    expect(validateCaptureFilter("   ")).toBeUndefined();
  });

  it("rejects shell metacharacters and overlong filters", () => {
    for (const bad of ["tcp; rm -rf /", "port 80`id`", "host $HOME", 'tcp and "x"', "a'b", "a\\b", "a#b"]) {
      expect(() => validateCaptureFilter(bad)).toThrow(/allowlist/);
    }
    expect(() => validateCaptureFilter("x".repeat(257))).toThrow(/too long/);
  });

  it("rejects a leading dash that getopt would parse as flags", () => {
    expect(() => validateCaptureFilter("-d")).toThrow(/must not start with/);
    expect(() => validateCaptureFilter("  -Us0")).toThrow(/must not start with/);
    // Dashes elsewhere are fine (e.g. inside bracket offsets).
    expect(validateCaptureFilter("tcp[13-16]")).toBe("tcp[13-16]");
  });

  it("validates interfaces and snaplens", () => {
    expect(validateCaptureInterface(undefined)).toBeUndefined();
    expect(validateCaptureInterface("en0")).toBe("en0");
    expect(() => validateCaptureInterface("en0;id")).toThrow(/alphanumeric/);
    expect(() => validateCaptureInterface("")).toThrow(/alphanumeric/);
    expect(validateCaptureSnaplen(undefined)).toBe(256);
    expect(validateCaptureSnaplen(1500)).toBe(1500);
    for (const bad of [0, 63, 65536, 1.5, Number.NaN]) {
      expect(() => validateCaptureSnaplen(bad)).toThrow(/snaplen/);
    }
  });
});

describe("parseDefaultRouteInterface", () => {
  it("reads the interface from route output", () => {
    expect(
      parseDefaultRouteInterface("route to: default\ngateway: 192.168.1.1\ninterface: en0\nflags: <UP,GATEWAY>\n"),
    ).toBe("en0");
    expect(parseDefaultRouteInterface("interface: utun4\n")).toBe("utun4");
    expect(parseDefaultRouteInterface("no route here\n")).toBeUndefined();
    expect(parseDefaultRouteInterface("")).toBeUndefined();
  });
});

describe("NetCapture start/stop", () => {
  function makeCapture(opts: { exitImmediately?: boolean; dump?: string; ignoreTerm?: boolean; failReadback?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-netcapture-"));
    const run = stubRunner((bin, args) => {
      if (bin === "route") return { stdout: "route to: default\ninterface: en0\n", stderr: "" };
      if (bin === "tcpdump" && args[0] === "--version") return { stdout: "tcpdump version 4.99.1\n", stderr: "" };
      if (bin === "tcpdump" && args[0] === "-n") {
        if (opts.failReadback) throw new Error("tcpdump: pcap: Permission denied");
        return { stdout: opts.dump ?? DUMP, stderr: "" };
      }
      if (bin === "sudo" && args[1] === "pkill") return { stdout: "", stderr: "" };
      throw new Error(`unexpected ${bin} ${args.join(" ")}`);
    });
    const children: StubChild[] = [];
    const spawns: { bin: string; args: string[] }[] = [];
    const capture = new NetCapture({
      runner: run,
      spawnFn: (bin, args) => {
        const child = new StubChild(6100 + children.length);
        if (opts.exitImmediately) child.exitCode = 1;
        if (opts.ignoreTerm) {
          const realKill = child.kill.bind(child);
          child.kill = (signal?: string) => {
            if (signal === "SIGTERM") {
              child.kills.push(signal);
              return true; // Swallow SIGTERM: never exits, never emits.
            }
            return realKill(signal);
          };
        }
        children.push(child);
        spawns.push({ bin, args });
        return child as unknown as MitmChild;
      },
      stateDir: dir,
    });
    return { capture, run, children, spawns, dir };
  }

  it("spawns sudo tcpdump on the default interface and stops with SIGINT + summary", async () => {
    const { capture, run, children, spawns, dir } = makeCapture();
    const { pid, pcapPath } = await capture.startCapture("l1", { sessionId: "s1", udid: "U1", filter: "tcp port 6555" });
    expect(pid).toBe(6100);
    expect(pcapPath).toBe(path.join(dir, "capture-l1.pcap"));
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual({
      bin: "sudo",
      args: ["-n", "tcpdump", "-i", "en0", "-s", "256", "-w", pcapPath, "tcp port 6555"],
    });
    expect(run.calls[0]).toEqual({ bin: "route", args: ["-n", "get", "default"] });
    expect(capture.captureStatus()).toMatchObject({
      running: true,
      pid: 6100,
      leaseId: "l1",
      interface: "en0",
      filter: "tcp port 6555",
      pcapPath,
    });

    fs.writeFileSync(pcapPath, "fake-pcap");
    const stopped = await capture.stopCapture("l1");
    expect(children[0]!.kills[0]).toBe("SIGINT");
    expect(stopped.stopped).toBe(true);
    expect(stopped.pcapPath).toBe(pcapPath);
    expect(stopped.summary).toMatchObject({ packets: 6, bytes: 174, truncatedFlows: 0 });
    // Full readback, never -q (the quiet short form has no Flags/length to parse).
    const readback = run.calls.find((c) => c.bin === "tcpdump" && c.args.includes("-r"));
    expect(readback?.args).toEqual(["-n", "-r", pcapPath]);
    expect(capture.captureStatus()).toEqual({ running: false });
    // Second stop is idempotent.
    expect(await capture.stopCapture("l1")).toEqual({ stopped: false });
  });

  it("honors explicit interface/snaplen and stops without a pcap", async () => {
    const { capture, spawns } = makeCapture();
    const { pcapPath } = await capture.startCapture("l1", { interface: "utun4", snaplen: 1500 });
    expect(spawns[0]!.args).toContain("utun4");
    expect(spawns[0]!.args).toContain("1500");
    expect(spawns[0]!.args).not.toContain("tcp");
    const stopped = await capture.stopCapture("l1");
    expect(stopped).toEqual({ stopped: true, pcapPath });
  });

  it("rejects a second lease and allows the holder to re-start", async () => {
    const { capture } = makeCapture();
    const first = await capture.startCapture("l1", {});
    await expect(capture.startCapture("l2", {})).rejects.toThrow(CaptureBusyError);
    await expect(capture.startCapture("l2", {})).rejects.toThrow(/already running for lease l1/);
    await expect(capture.stopCapture("l2")).rejects.toThrow(/not l2/);
    expect(await capture.startCapture("l1", {})).toEqual(first);
    expect(await capture.stopCapture("l1")).toMatchObject({ stopped: true });
  });

  it("surfaces an immediate tcpdump exit with a sudoers hint", async () => {
    const { capture } = makeCapture({ exitImmediately: true });
    await expect(capture.startCapture("l1", { filter: "tcp port (" })).rejects.toThrow(/exited immediately.*code 1/);
    await expect(capture.startCapture("l1", { filter: "tcp port (" })).rejects.toThrow(/NOPASSWD/);
    expect(capture.captureStatus()).toEqual({ running: false });
  });

  it("rejects invalid filters before spawning", async () => {
    const { capture, spawns } = makeCapture();
    await expect(capture.startCapture("l1", { filter: "x; id" })).rejects.toThrow(/allowlist/);
    expect(spawns).toHaveLength(0);
    expect(capture.captureStatus()).toEqual({ running: false });
  });

  it("reports checkAvailable from --version", async () => {
    const { capture } = makeCapture();
    expect(await capture.checkAvailable()).toBe("tcpdump version 4.99.1");
  });

  it("skips the readback when summarize is false", async () => {
    const { capture, run } = makeCapture();
    const { pcapPath } = await capture.startCapture("l1", {});
    fs.writeFileSync(pcapPath, "fake-pcap");
    const stopped = await capture.stopCapture("l1", { summarize: false });
    expect(stopped).toEqual({ stopped: true, pcapPath });
    expect(run.calls.some((c) => c.args.includes("-r"))).toBe(false);
  });

  it("forceStop kills the child without readback and never throws", async () => {
    const { capture, run, children } = makeCapture();
    expect(await capture.forceStop()).toEqual({ stopped: false });
    await capture.startCapture("l1", {});
    expect(await capture.forceStop()).toEqual({ stopped: true });
    expect(capture.captureStatus()).toEqual({ running: false });
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
    expect(run.calls.some((c) => c.args.includes("-r"))).toBe(false);
    expect(run.calls.some((c) => c.args.includes("pkill"))).toBe(false);
    expect(await capture.forceStop()).toEqual({ stopped: false });
  });

  it("forceStop escalates to SIGKILL + scoped pkill when SIGTERM is ignored", async () => {
    const { capture, run, children } = makeCapture({ ignoreTerm: true });
    const { pcapPath } = await capture.startCapture("l1", {});
    expect(await capture.forceStop()).toEqual({ stopped: true });
    expect(capture.captureStatus()).toEqual({ running: false });
    expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    const pkill = run.calls.find((c) => c.args.includes("pkill"));
    expect(pkill?.bin).toBe("sudo");
    expect(pkill?.args.slice(0, 3)).toEqual(["-n", "pkill", "-f"]);
    // Scoped to our exact pcap path (regex-escaped), never a bare pattern.
    expect(pkill?.args[3]).toBe(`tcpdump.*-w ${escapeRegExp(pcapPath)}`);
    expect(pkill?.args[3]).toContain("capture-l1\\.pcap");
  }, 15000);

  it("returns pcap-only when the readback fails", async () => {
    const { capture } = makeCapture({ failReadback: true });
    const { pcapPath } = await capture.startCapture("l1", {});
    fs.writeFileSync(pcapPath, "fake-pcap");
    const stopped = await capture.stopCapture("l1");
    expect(stopped).toEqual({ stopped: true, pcapPath });
  });
});

describe("escapeRegExp", () => {
  it("escapes ERE metacharacters in pcap paths", () => {
    expect(escapeRegExp("/tmp/x-y/capture-l1.pcap")).toBe("/tmp/x-y/capture-l1\\.pcap");
    expect(new RegExp(`tcpdump.*-w ${escapeRegExp("/tmp/a/capture-l1.pcap")}`).test(
      "sudo -n tcpdump -i en0 -w /tmp/a/capture-l1.pcap",
    )).toBe(true);
  });
});

class FakeFleet implements FleetOps {
  booted = new Set<string>();
  constructor(private readonly devs: SimDevice[]) {
    for (const d of devs) if (d.state === "Booted") this.booted.add(d.udid);
  }
  async list(): Promise<SimDevice[]> {
    return this.devs.map((d) => ({ ...d, state: this.booted.has(d.udid) ? "Booted" : "Shutdown" }));
  }
  async boot(udid: string): Promise<void> {
    this.booted.add(udid);
  }
  async slimStatus(_udid: string): Promise<SlimStatus | null> {
    return { slim: false, managedDisabled: 0, managedTotal: 168, persistent: true, raw: {} };
  }
  async slimNoReboot(_udid: string): Promise<void> {}
}

function sim(udid: string): SimDevice {
  return { udid, name: "iPhone 17", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" };
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-netcapture-test-")), "state.json");
}

class FakeCapture implements CaptureOps {
  holder: { leaseId: string; sessionId?: string; udid?: string } | null = null;
  stops: string[] = [];
  summarizeSeen: (boolean | undefined)[] = [];
  forceStops = 0;
  spec: CaptureStartSpec | null = null;

  async checkAvailable(): Promise<string> {
    return "tcpdump version 9.9.9-test";
  }

  async startCapture(leaseId: string, spec: CaptureStartSpec): Promise<{ pid: number; pcapPath: string }> {
    if (this.holder && this.holder.leaseId !== leaseId) {
      throw new CaptureBusyError(`Packet capture is already running for lease ${this.holder.leaseId}; stop it first`);
    }
    if (!this.holder) {
      this.holder = { leaseId, sessionId: spec.sessionId, udid: spec.udid };
      this.spec = spec;
    }
    return { pid: 77, pcapPath: "/tmp/capture-test.pcap" };
  }

  async stopCapture(leaseId: string, opts?: { summarize?: boolean }): Promise<CaptureStopResult> {
    if (!this.holder) return { stopped: false };
    if (this.holder.leaseId !== leaseId) {
      throw new CaptureBusyError(`Packet capture is running for lease ${this.holder.leaseId}, not ${leaseId}`);
    }
    this.stops.push(leaseId);
    this.summarizeSeen.push(opts?.summarize);
    this.holder = null;
    return { stopped: true, pcapPath: "/tmp/capture-test.pcap", summary: { packets: 3, bytes: 30, flows: [], truncatedFlows: 0 } };
  }

  async forceStop(): Promise<{ stopped: boolean }> {
    this.forceStops += 1;
    const stopped = this.holder !== null;
    this.holder = null;
    return { stopped };
  }

  captureStatus(): CaptureStatus {
    if (!this.holder) return { running: false };
    return { running: true, pid: 77, leaseId: this.holder.leaseId, sessionId: this.holder.sessionId, udid: this.holder.udid };
  }
}

describe("orchestrator capture plumbing", () => {
  it("starts/stops capture through leases and stops on release", async () => {
    const fake = new FakeCapture();
    const orch = new Orchestrator(new FakeFleet([sim("U1"), sim("U2")]), Store.load(tmpState()), {
      defaultTtlMs: 60_000,
      capture: fake,
    });
    const a = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
    const b = await orch.acquire({ sessionId: "sess-b", client: "t", autoBoot: false });
    if (!a.ok || a.queued || !b.ok || b.queued) throw new Error("expected two leases");

    const started = await orch.startLeaseCapture(a.lease.leaseId, { filter: "tcp port 6555" });
    expect(started.pid).toBe(77);
    expect(fake.spec).toMatchObject({ filter: "tcp port 6555", sessionId: "sess-a", udid: "U1" });
    await expect(orch.startLeaseCapture(b.lease.leaseId, {})).rejects.toThrow(CaptureBusyError);

    const status = await orch.leaseCaptureStatus(b.lease.leaseId);
    expect(status).toMatchObject({ running: true, leaseId: a.lease.leaseId });

    // Releasing the non-holder leaves the capture running; releasing the
    // holder stops it quietly.
    await orch.release(b.lease.leaseId, "sess-b");
    expect(fake.stops).toEqual([]);
    await orch.release(a.lease.leaseId, "sess-a");
    expect(fake.stops).toEqual([a.lease.leaseId]);
    // Quiet teardown skips the readback summary (would stall the mutex).
    expect(fake.summarizeSeen).toEqual([false]);
  });

  it("reports not-running when no capture is configured", async () => {
    const orch = new Orchestrator(new FakeFleet([sim("U1")]), Store.load(tmpState()), { defaultTtlMs: 60_000 });
    const a = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
    if (!a.ok || a.queued) throw new Error("expected a lease");
    await expect(orch.startLeaseCapture(a.lease.leaseId, {})).rejects.toThrow(/unavailable/);
    expect(await orch.stopLeaseCapture(a.lease.leaseId)).toMatchObject({ stopped: false });
    expect(await orch.leaseCaptureStatus(a.lease.leaseId)).toMatchObject({ running: false });
    await orch.release(a.lease.leaseId, "sess-a");
  });
});

async function makeCaptureClient() {
  const fake = new FakeCapture();
  const orch = new Orchestrator(new FakeFleet([sim("U1"), sim("U2")]), Store.load(tmpState()), {
    defaultTtlMs: 60_000,
    capture: fake,
  });
  const noop: Runner = async () => ({ stdout: "", stderr: "" });
  const server = new McpServer({ name: "test", version: "0" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog({ runner: async () => ({ stdout: "", truncated: false, timedOut: false }) }),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb: new Llmdb({ runner: noop }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const a = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
  if (!a.ok || a.queued) throw new Error("expected a lease");
  return { client, orch, fake, a: a.lease };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

describe("net_capture_* tools", () => {
  it("registers the three tools with object input schemas", async () => {
    const { client } = await makeCaptureClient();
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const name of ["net_capture_start", "net_capture_stop", "net_capture_status"]) {
      expect(names).toContain(name);
    }
    const start = listed.tools.find((t) => t.name === "net_capture_start");
    expect(start?.inputSchema).toMatchObject({ type: "object" });
    expect(JSON.stringify(start?.inputSchema)).toContain("snaplen");
  });

  it("runs a full start/status/stop round trip", async () => {
    const { client, orch, a } = await makeCaptureClient();
    const start = await call(client, "net_capture_start", { lease_id: a.leaseId, filter: "udp port 443" });
    expect(start.json).toMatchObject({ ok: true, pid: 77, pcap_path: "/tmp/capture-test.pcap" });

    const status = await call(client, "net_capture_status", { lease_id: a.leaseId });
    expect(status.json).toMatchObject({ ok: true, running: true, holder_lease_id: a.leaseId });

    const stop = await call(client, "net_capture_stop", { lease_id: a.leaseId });
    expect(stop.json).toMatchObject({ ok: true, stopped: true, pcap_path: "/tmp/capture-test.pcap" });
    expect(stop.json).toHaveProperty("summary");

    const stopped = await call(client, "net_capture_status", { lease_id: a.leaseId });
    expect(stopped.json).toMatchObject({ ok: true, running: false });

    const tools = orch.leaseActions(a.leaseId).map((e) => e.tool);
    expect(tools).toEqual(["net_capture_start", "net_capture_stop"]);
  });

  it("rejects an out-of-range snaplen at the schema layer", async () => {
    const { client, fake, a } = await makeCaptureClient();
    const result = await client.callTool({ name: "net_capture_start", arguments: { lease_id: a.leaseId, snaplen: 10 } });
    expect(result.isError).toBe(true);
    expect((result.content.find((c) => c.type === "text")?.text ?? "") as string).toMatch(/greater than or equal to 64/);
    expect(fake.holder).toBeNull();
  });
});
