import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, ExecOptions, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb, extractBreakpointIds, isDebugTimeoutError } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import {
  Symbolicator,
  findDsymDwarf,
  parseLipoArchs,
  parseLoadAddr,
  pickPreferredArch,
  resolveDwarfFile,
} from "../src/symbolicate.js";
import { XCTrace } from "../src/xctrace.js";

interface Call {
  bin: string;
  args: string[];
  opts?: ExecOptions;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class FakeFleet implements FleetOps {
  bootedUdids = new Set<string>(["U1"]);
  async list(): Promise<SimDevice[]> {
    return [
      { udid: "U1", name: "iPhone 17 Pro", state: this.bootedUdids.has("U1") ? "Booted" : "Shutdown", platform: "iOS", osVersion: "26.5", set: "default" },
    ];
  }
  async boot(udid: string): Promise<void> {
    this.bootedUdids.add(udid);
  }
  async slimStatus(): Promise<SlimStatus | null> {
    return { slim: false, managedDisabled: 0, managedTotal: 168, persistent: true, raw: {} };
  }
  async slimNoReboot(): Promise<void> {}
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-lifecycle-")), "state.json");
}

async function makeOrch(debuggerOps?: { stop: (id: string) => Promise<unknown> }) {
  const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), {
    defaultTtlMs: 60_000,
    ...(debuggerOps ? { debugger: debuggerOps } : {}),
  });
  const res = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
  if (!res.ok || res.queued) throw new Error("expected lease");
  return { orch, leaseId: res.lease.leaseId };
}

async function makeDebugClient(llmdbrun: Runner, atosrun?: Runner) {
  const lldmdb = new Llmdb({ runner: llmdbrun });
  const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), { defaultTtlMs: 60_000, debugger: lldmdb });
  const server = new McpServer({ name: "test", version: "0" });
  const noop = async () => ({ stdout: "", stderr: "" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb,
    ...(atosrun ? { symbolicator: new Symbolicator({ runner: atosrun }) } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const res = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
  if (!res.ok || res.queued) throw new Error("expected lease");
  return { client, orch, leaseId: res.lease.leaseId };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content.find((c) => c.type === "text")?.text ?? "") as string;
  return { isError: result.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

describe("per-session op mutex (cont/wait/interrupt)", () => {
  it("serializes one session's ops in arrival order", async () => {
    const started: string[] = [];
    const gate = deferred();
    let n = 0;
    const run = (async (_bin: string, args: string[]) => {
      started.push(args[0] ?? "?");
      if (n++ === 0) await gate.promise;
      return { stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
    }) as Runner;
    const db = new Llmdb({ runner: run });
    const p1 = db.cont("s1", 5);
    const p2 = db.wait("s1", 5);
    const p3 = db.interrupt("s1", 5);
    await tick();
    expect(started).toEqual(["continue"]);
    gate.resolve();
    await Promise.all([p1, p2, p3]);
    expect(started).toEqual(["continue", "wait", "interrupt"]);
  });

  it("runs different sessions concurrently", async () => {
    const started: string[] = [];
    const gate = deferred();
    let n = 0;
    const run = (async (_bin: string, args: string[]) => {
      started.push(args.join(" "));
      if (n++ === 0) await gate.promise;
      return { stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
    }) as Runner;
    const db = new Llmdb({ runner: run });
    const p1 = db.cont("s1", 5);
    const p2 = db.cont("s2", 5);
    await tick();
    expect(started).toHaveLength(2);
    gate.resolve();
    await Promise.all([p1, p2]);
  });

  it("releases the mutex when an op fails", async () => {
    let n = 0;
    const run = (async () => {
      if (n++ === 0) throw new ExecError("llmdb", ["continue"], 1, "", "Error: boom");
      return { stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
    }) as Runner;
    const db = new Llmdb({ runner: run });
    const p1 = db.cont("s1", 5);
    const p2 = db.wait("s1", 5);
    await expect(p1).rejects.toThrow(/boom/);
    await expect(p2).resolves.toMatchObject({ state: "stopped" });
  });

  it("rejects invalid ops without queueing behind the lock", async () => {
    const gate = deferred();
    let calls = 0;
    const run = (async () => {
      calls += 1;
      await gate.promise;
      return { stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
    }) as Runner;
    const db = new Llmdb({ runner: run });
    const p1 = db.cont("s1", 5);
    await expect(db.cont("s1", 0)).rejects.toThrow(/wait_sec/);
    expect(calls).toBe(1);
    gate.resolve();
    await p1;
  });
});

describe("isDebugTimeoutError", () => {
  it("detects timeout kills and timeout text", () => {
    expect(isDebugTimeoutError(new ExecError("llmdb", ["continue"], null, "", ""))).toBe(true);
    expect(isDebugTimeoutError(new ExecError("llmdb", ["wait"], 1, "", "command timed out"))).toBe(true);
    expect(isDebugTimeoutError(new Error("request timed out after 60s"))).toBe(true);
    expect(isDebugTimeoutError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("rejects daemon errors, ENOENT, and ordinary errors", () => {
    expect(isDebugTimeoutError(new ExecError("llmdb", ["continue"], 1, "", "Error: no session with id x"))).toBe(false);
    expect(isDebugTimeoutError(new ExecError("llmdb", ["attach"], "ENOENT", "", ""))).toBe(false);
    expect(isDebugTimeoutError(new Error("boom"))).toBe(false);
    expect(isDebugTimeoutError(null)).toBe(false);
  });

  it("ignores timeout words in the argv itself (e.g. wait --timeout)", () => {
    expect(isDebugTimeoutError(new ExecError("llmdb", ["wait", "--timeout", "5"], 1, "", "Error: no session with id x"))).toBe(
      false,
    );
  });
});

describe("orchestrator autoStopDebugSession", () => {
  it("stops the recorded session and clears bookkeeping", async () => {
    const stopped: string[] = [];
    const { orch, leaseId } = await makeOrch({ stop: async (id: string) => void stopped.push(id) });
    await orch.setDebugSession(leaseId, "dbg-1");
    await expect(orch.autoStopDebugSession(leaseId, "dbg-1")).resolves.toEqual({ stopped: true, sessionId: "dbg-1" });
    expect(stopped).toEqual(["dbg-1"]);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });

  it("reports stopped=false for unknown leases and missing sessions", async () => {
    const stopped: string[] = [];
    const { orch, leaseId } = await makeOrch({ stop: async (id: string) => void stopped.push(id) });
    await expect(orch.autoStopDebugSession("lease_nope")).resolves.toEqual({ stopped: false, sessionId: null });
    await expect(orch.autoStopDebugSession(leaseId)).resolves.toEqual({ stopped: false, sessionId: null });
    expect(stopped).toHaveLength(0);
  });

  it("refuses to stop a mismatched session id", async () => {
    const stopped: string[] = [];
    const { orch, leaseId } = await makeOrch({ stop: async (id: string) => void stopped.push(id) });
    await orch.setDebugSession(leaseId, "dbg-1");
    await expect(orch.autoStopDebugSession(leaseId, "dbg-other")).resolves.toEqual({ stopped: false, sessionId: "dbg-1" });
    expect(stopped).toHaveLength(0);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-1");
  });

  it("keeps the record when no debugger is configured", async () => {
    const { orch, leaseId } = await makeOrch();
    await orch.setDebugSession(leaseId, "dbg-1");
    await expect(orch.autoStopDebugSession(leaseId, "dbg-1")).resolves.toEqual({ stopped: false, sessionId: "dbg-1" });
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-1");
  });

  it("still clears bookkeeping when stop throws (quiet path)", async () => {
    const { orch, leaseId } = await makeOrch({
      stop: async () => {
        throw new Error("llmdbd gone");
      },
    });
    await orch.setDebugSession(leaseId, "dbg-1");
    await expect(orch.autoStopDebugSession(leaseId)).resolves.toEqual({ stopped: true, sessionId: "dbg-1" });
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });
});

describe("debug timeout auto-stop tools", () => {
  function timeoutRunner(calls: Call[]): Runner {
    return (async (bin: string, args: string[], opts?: ExecOptions) => {
      calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-9", state: "stopped" }), stderr: "" };
      if (args[0] === "stop") return { stdout: JSON.stringify({ stopped: true }), stderr: "" };
      throw new ExecError(bin, args, null, "", "");
    }) as Runner;
  }

  it("auto-stops and clears the session when continue times out", async () => {
    const calls: Call[] = [];
    const { client, orch, leaseId } = await makeDebugClient(timeoutRunner(calls));
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const res = await call(client, "debug_continue", { lease_id: leaseId, wait_sec: 5 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/auto-stopped/);
    expect(calls.map((c) => c.args[0])).toEqual(["attach", "continue", "stop"]);
    expect(calls[2]?.args).toEqual(["stop", "--session", "dbg-9"]);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });

  it("leaves the session alone for non-timeout failures", async () => {
    const calls: Call[] = [];
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-9", state: "stopped" }), stderr: "" };
      throw new ExecError(bin, args, 1, "", "Error: no session with id dbg-9");
    }) as Runner;
    const { client, orch, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const res = await call(client, "debug_wait", { lease_id: leaseId, timeout: 5 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).not.toMatch(/auto-stopped/);
    expect(calls.map((c) => c.args[0])).toEqual(["attach", "wait"]);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-9");
  });
});

describe("extractBreakpointIds", () => {
  it("reads ids from plausible break-list shapes", () => {
    expect(extractBreakpointIds({ breakpoints: [{ id: 1 }, { id: 7 }] })).toEqual([1, 7]);
    expect(extractBreakpointIds([{ id: 3 }])).toEqual([3]);
    expect(extractBreakpointIds([2, 5])).toEqual([2, 5]);
    expect(extractBreakpointIds({ breakpoint: { id: 9 } })).toEqual([9]);
    expect(extractBreakpointIds({ ids: [4, 4, 6] })).toEqual([4, 6]);
  });

  it("ignores garbage and non-positive ids", () => {
    expect(extractBreakpointIds({ breakpoints: [] })).toEqual([]);
    expect(extractBreakpointIds(null)).toEqual([]);
    expect(extractBreakpointIds("nope")).toEqual([]);
    expect(extractBreakpointIds({ breakpoints: [{ id: 0 }, { id: -2 }, { noid: 1 }] })).toEqual([]);
  });
});

describe("runUntil cleanup", () => {
  function cleanupRunner(calls: string[][], lists: string[], runUntil: string | Error) {
    let n = 0;
    return (async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "break" && args[1] === "list") return { stdout: lists[Math.min(n++, lists.length - 1)] ?? "[]", stderr: "" };
      if (args[0] === "run-until") {
        if (runUntil instanceof Error) throw runUntil;
        return { stdout: runUntil, stderr: "" };
      }
      if (args[0] === "break" && args[1] === "delete") return { stdout: JSON.stringify({ remaining: [] }), stderr: "" };
      throw new Error(`unexpected ${args.join(" ")}`);
    }) as Runner;
  }

  it("deletes the run-until breakpoint and reports removed ids", async () => {
    const calls: string[][] = [];
    const db = new Llmdb({
      runner: cleanupRunner(calls, [
        JSON.stringify({ breakpoints: [{ id: 1 }] }),
        JSON.stringify({ breakpoints: [{ id: 1 }, { id: 7 }] }),
      ], JSON.stringify({ state: "stopped" })),
    });
    const res = await db.runUntil("s1", "a.swift", 12, 30, { cleanup: true });
    expect(res).toMatchObject({ state: "stopped", cleanup: { removed: [7] } });
    expect(calls).toEqual([
      ["break", "list", "--session", "s1"],
      ["run-until", "a.swift:12", "--wait", "30", "--session", "s1"],
      ["break", "list", "--session", "s1"],
      ["break", "delete", "7", "--session", "s1"],
    ]);
  });

  it("leaves pre-existing breakpoints alone when nothing new appears", async () => {
    const calls: string[][] = [];
    const db = new Llmdb({
      runner: cleanupRunner(calls, [
        JSON.stringify({ breakpoints: [{ id: 1 }] }),
        JSON.stringify({ breakpoints: [{ id: 1 }] }),
      ], JSON.stringify({ state: "stopped" })),
    });
    const res = await db.runUntil("s1", "a.swift", 12, 30, { cleanup: true });
    expect(res).toMatchObject({ cleanup: { removed: [] } });
    expect(calls.filter((a) => a[1] === "delete")).toHaveLength(0);
  });

  it("keeps the legacy shape and argv when cleanup is off", async () => {
    const calls: string[][] = [];
    const db = new Llmdb({
      runner: cleanupRunner(calls, [], JSON.stringify({ state: "stopped" })),
    });
    const res = await db.runUntil("s1", "a.swift", 12, 30);
    expect(res).toEqual({ state: "stopped" });
    expect(calls).toEqual([["run-until", "a.swift:12", "--wait", "30", "--session", "s1"]]);
  });

  it("still cleans up when run-until fails, without masking the error", async () => {
    const calls: string[][] = [];
    const db = new Llmdb({
      runner: cleanupRunner(calls, [
        JSON.stringify([]),
        JSON.stringify([{ id: 4 }]),
      ], new ExecError("llmdb", ["run-until"], 1, "", "Error: target terminated")),
    });
    await expect(db.runUntil("s1", "a.swift", 12, 30, { cleanup: true })).rejects.toThrow(/target terminated/);
    expect(calls).toContainEqual(["break", "delete", "4", "--session", "s1"]);
  });

  it("threads cleanup through the debug_run_until tool", async () => {
    const calls: Call[] = [];
    let lists = 0;
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      calls.push({ bin, args, opts });
      if (args[0] === "attach") return { stdout: JSON.stringify({ sessionId: "dbg-9", state: "stopped" }), stderr: "" };
      if (args[0] === "break" && args[1] === "list") {
        lists += 1;
        return { stdout: lists === 1 ? "[]" : JSON.stringify([{ id: 7 }]), stderr: "" };
      }
      if (args[0] === "run-until") return { stdout: JSON.stringify({ state: "stopped" }), stderr: "" };
      if (args[0] === "break" && args[1] === "delete") return { stdout: JSON.stringify({}), stderr: "" };
      throw new Error(`unexpected ${args.join(" ")}`);
    }) as Runner;
    const { client, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const res = await call(client, "debug_run_until", { lease_id: leaseId, file: "a.swift", line: 12, cleanup: true });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, result: { cleanup: { removed: [7] } } });
  });
});

describe("symbolicate auto-detect", () => {
  it("parses lipo -info output and picks the host arch", () => {
    expect(parseLipoArchs("Architectures in the fat file: /bin/ls are: x86_64 arm64e \n")).toEqual(["x86_64", "arm64e"]);
    expect(parseLipoArchs("Non-fat file: Thin is architecture: arm64\n")).toBeNull();
    expect(parseLipoArchs("garbage\n")).toBeNull();
    expect(pickPreferredArch([])).toBeNull();
    expect(pickPreferredArch(["arm64"])).toBe("arm64");
    expect(["x86_64", "arm64"]).toContain(pickPreferredArch(["x86_64", "arm64"]));
  });

  it("detects arch for real files and skips missing ones without spawning", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-arch-"));
    const bin = path.join(dir, "App");
    fs.writeFileSync(bin, "placeholder");
    const calls: Call[] = [];
    const run = (async (b: string, a: string[], o?: ExecOptions) => {
      calls.push({ bin: b, args: a, opts: o });
      return { stdout: "Architectures in the fat file: App are: x86_64 arm64 \n", stderr: "" };
    }) as Runner;
    const sym = new Symbolicator({ runner: run });
    expect(["x86_64", "arm64"]).toContain(await sym.detectArch(bin));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bin: "lipo", args: ["-info", bin] });
    expect(await sym.detectArch(path.join(dir, "missing"))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when lipo fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-arch-"));
    const bin = path.join(dir, "App");
    fs.writeFileSync(bin, "placeholder");
    const failing = (async () => {
      throw new ExecError("lipo", ["-info", bin], 1, "", "not a mach-o file");
    }) as Runner;
    await expect(new Symbolicator({ runner: failing }).detectArch(bin)).resolves.toBeNull();
  });

  it("parses load addresses from Binary Images text", () => {
    const images = [
      "0x100000000 - 0x10003ffff  DebugApp  arm64  <uuid>  /tmp/DebugApp",
      "0x200000000 - 0x20001ffff  libSystem  arm64  <uuid>  /usr/lib/libSystem",
    ].join("\n");
    expect(parseLoadAddr(images, "DebugApp")).toBe("0x100000000");
    expect(parseLoadAddr(images, "libSystem")).toBe("0x200000000");
    expect(parseLoadAddr(images)).toBe("0x100000000");
    expect(parseLoadAddr(images, "Other")).toBeNull();
    expect(parseLoadAddr("no addresses here")).toBeNull();
  });

  function dsymFixture(root: string, name: string): { bin: string; dsym: string; dwarf: string } {
    const bin = path.join(root, name);
    fs.writeFileSync(bin, "mach-o placeholder");
    const dwarfDir = path.join(`${bin}.dSYM`, "Contents", "Resources", "DWARF");
    fs.mkdirSync(dwarfDir, { recursive: true });
    const dwarf = path.join(dwarfDir, name);
    fs.writeFileSync(dwarf, "dwarf placeholder");
    return { bin, dsym: `${bin}.dSYM`, dwarf };
  }

  it("finds sibling dSYMs and resolves their DWARF files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-dsym-"));
    const { bin, dsym, dwarf } = dsymFixture(dir, "DebugApp");
    expect(findDsymDwarf(bin)).toEqual({ dsym, dwarf });
    expect(resolveDwarfFile(dsym)).toBe(dwarf);
    expect(resolveDwarfFile(dwarf)).toBe(dwarf);
    expect(findDsymDwarf(path.join(dir, "Lonely"))).toBeNull();
  });

  it("finds Foo.app.dSYM for binaries inside Foo.app", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-app-"));
    const macos = path.join(dir, "Foo.app", "Contents", "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    const bin = path.join(macos, "Foo");
    fs.writeFileSync(bin, "mach-o placeholder");
    const dwarfDir = path.join(dir, "Foo.app.dSYM", "Contents", "Resources", "DWARF");
    fs.mkdirSync(dwarfDir, { recursive: true });
    const dwarf = path.join(dwarfDir, "Foo");
    fs.writeFileSync(dwarf, "dwarf placeholder");
    expect(findDsymDwarf(bin)).toEqual({ dsym: path.join(dir, "Foo.app.dSYM"), dwarf });
  });

  it("symbolicates via the auto-found dSYM with a detected arch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-sym-"));
    const { bin, dsym, dwarf } = dsymFixture(dir, "DebugApp");
    const calls: Call[] = [];
    const run = (async (b: string, a: string[], o?: ExecOptions) => {
      calls.push({ bin: b, args: a, opts: o });
      if (b === "lipo") return { stdout: "Architectures in the fat file: X are: x86_64 arm64 \n", stderr: "" };
      return { stdout: "main (in DebugApp) (main.swift:1)\n", stderr: "" };
    }) as Runner;
    const res = await new Symbolicator({ runner: run }).symbolicate(["0x1001"], { binary: bin });
    expect(res.binary).toBe(dwarf);
    expect(res.dsym).toBe(dsym);
    expect(["x86_64", "arm64"]).toContain(res.arch);
    const atos = calls.find((c) => c.bin === "atos");
    expect(atos?.args.slice(0, 2)).toEqual(["-o", dwarf]);
    expect(atos?.args).toContain("-arch");
  });

  it("derives load_addr from images text and lets explicit options win", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-img-"));
    const { bin } = dsymFixture(dir, "DebugApp");
    const calls: Call[] = [];
    const run = (async (b: string, a: string[], o?: ExecOptions) => {
      calls.push({ bin: b, args: a, opts: o });
      if (b === "lipo") return { stdout: "Non-fat file: X is architecture: arm64\n", stderr: "" };
      return { stdout: "main\n", stderr: "" };
    }) as Runner;
    const sym = new Symbolicator({ runner: run });
    const images = "0x10abc000 - 0x10abdfff  DebugApp  arm64  <uuid>  /tmp/DebugApp";
    const auto = await sym.symbolicate(["0x10abc123"], { binary: bin, images });
    expect(auto.loadAddr).toBe("0x10abc000");
    expect(auto.arch).toBeUndefined();
    const atos = calls.find((c) => c.bin === "atos");
    expect(atos?.args).toContain("-l");
    expect(atos?.args).not.toContain("-arch");

    calls.length = 0;
    const explicit = await sym.symbolicate(["0x10abc123"], {
      binary: bin,
      arch: "arm64",
      loadAddr: "0x200000000",
      images,
    });
    expect(explicit).toMatchObject({ arch: "arm64", loadAddr: "0x200000000" });
    expect(calls.map((c) => c.bin)).toEqual(["atos"]);
  });

  it("rejects explicit dSYMs without DWARF and skips detection for missing binaries", async () => {
    const calls: Call[] = [];
    const run = (async (b: string, a: string[], o?: ExecOptions) => {
      calls.push({ bin: b, args: a, opts: o });
      return { stdout: "main\n", stderr: "" };
    }) as Runner;
    const sym = new Symbolicator({ runner: run });
    await expect(sym.symbolicate(["0x1000"], { binary: "/tmp/App", dsym: "  " })).rejects.toThrow(/dsym/);
    await expect(sym.symbolicate(["0x1000"], { binary: "/tmp/App", dsym: "/tmp/nope.dSYM" })).rejects.toThrow(/DWARF/);
    const missing = path.join(os.tmpdir(), `sim-mcp-missing-${Date.now()}`, "App");
    const res = await sym.symbolicate(["0x1000"], { binary: missing });
    expect(res.binary).toBe(missing);
    expect(res.dsym).toBeUndefined();
    expect(res.arch).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe("atos");
  });

  it("threads images through the symbolicate tool", async () => {
    const calls: Call[] = [];
    const atosrun = (async (b: string, a: string[], o?: ExecOptions) => {
      calls.push({ bin: b, args: a, opts: o });
      return { stdout: "main\n", stderr: "" };
    }) as Runner;
    const noop = (async () => ({ stdout: "{}", stderr: "" })) as Runner;
    const { client } = await makeDebugClient(noop, atosrun);
    const missing = path.join(os.tmpdir(), `sim-mcp-missing-${Date.now()}`, "DebugApp");
    const res = await call(client, "symbolicate", {
      pcs: ["0x10abc123"],
      binary: missing,
      images: "0x10abc000 - 0x10abdfff  DebugApp  arm64  <uuid>  /x",
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, loadAddr: "0x10abc000" });
    expect(calls[0]?.args).toContain("-l");
  });
});
