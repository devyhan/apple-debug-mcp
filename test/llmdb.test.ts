import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, ExecOptions, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { Symbolicator } from "../src/symbolicate.js";
import { XCTrace } from "../src/xctrace.js";

interface Call {
  bin: string;
  args: string[];
  opts?: ExecOptions;
}

function stubRunner(handler: (bin: string, args: string[]) => string = () => "{}"): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
    calls.push({ bin, args, opts });
    return { stdout: handler(bin, args), stderr: "" };
  }) as Runner & { calls: Call[] };
  run.calls = calls;
  return run;
}

describe("Llmdb wrapper", () => {
  it("attaches by bundle id and extracts the session id", async () => {
    const run = stubRunner(() => JSON.stringify({ sessionId: "abc12", state: "stopped" }));
    const lldmdb = new Llmdb({ runner: run });
    const res = await lldmdb.attach({ bundleId: "com.example.App" });
    expect(res.sessionId).toBe("abc12");
    expect(res.response).toMatchObject({ sessionId: "abc12", state: "stopped" });
    expect(run.calls[0]).toMatchObject({ bin: "llmdb", args: ["attach", "--app", "com.example.App"] });
  });

  it("attaches by pid", async () => {
    const run = stubRunner(() => JSON.stringify({ sessionId: "s1" }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.attach({ pid: 1234 });
    expect(run.calls[0]?.args).toEqual(["attach", "--pid", "1234"]);
  });

  it("rejects attach targets that are not exactly one of bundle/pid", async () => {
    const lldmdb = new Llmdb({ runner: stubRunner() });
    await expect(lldmdb.attach({})).rejects.toThrow(/exactly one/);
    await expect(lldmdb.attach({ bundleId: "a", pid: 1 })).rejects.toThrow(/exactly one/);
    await expect(lldmdb.attach({ bundleId: "  " })).rejects.toThrow(/bundle_id/);
    await expect(lldmdb.attach({ pid: 0 })).rejects.toThrow(/pid/);
    await expect(lldmdb.attach({ pid: 1.5 })).rejects.toThrow(/pid/);
  });

  it("rejects attach responses without a sessionId", async () => {
    const lldmdb = new Llmdb({ runner: stubRunner(() => JSON.stringify({ state: "stopped" })) });
    await expect(lldmdb.attach({ pid: 1 })).rejects.toThrow(/no sessionId/);
  });

  it("sets breakpoints as file:line with session threading", async () => {
    const run = stubRunner(() => JSON.stringify({ breakpoint: { id: 1 } }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.breakSet("sess-1", "./Sources/App/main.swift", 34);
    expect(run.calls[0]?.args).toEqual([
      "break", "set", "./Sources/App/main.swift:34", "--session", "sess-1",
    ]);
    await expect(lldmdb.breakSet("sess-1", "  ", 1)).rejects.toThrow(/file/);
    await expect(lldmdb.breakSet("sess-1", "f.swift", 0)).rejects.toThrow(/line/);
    await expect(lldmdb.breakSet("  ", "f.swift", 1)).rejects.toThrow(/session_id/);
  });

  it("continues with an explicit wait and an outliving exec timeout", async () => {
    const run = stubRunner(() => JSON.stringify({ state: "stopped" }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.cont("sess-1", 45);
    expect(run.calls[0]?.args).toEqual(["continue", "--wait", "45", "--session", "sess-1"]);
    expect(run.calls[0]?.opts?.timeoutMs).toBe((45 + 30) * 1000);
    await lldmdb.cont("sess-1");
    expect(run.calls[1]?.args).toEqual(["continue", "--wait", "60", "--session", "sess-1"]);
    await expect(lldmdb.cont("sess-1", 0)).rejects.toThrow(/wait_sec/);
    await expect(lldmdb.cont("sess-1", 601)).rejects.toThrow(/wait_sec/);
  });

  it("reads backtraces with optional depth", async () => {
    const run = stubRunner(() => JSON.stringify({ frames: [] }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.backtrace("sess-1");
    expect(run.calls[0]?.args).toEqual(["bt", "--session", "sess-1"]);
    await lldmdb.backtrace("sess-1", 3);
    expect(run.calls[1]?.args).toEqual(["bt", "--depth", "3", "--session", "sess-1"]);
    await expect(lldmdb.backtrace("sess-1", 0)).rejects.toThrow(/depth/);
  });

  it("reads locals and evals expressions with frame threading", async () => {
    const run = stubRunner(() => JSON.stringify({ locals: [] }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.locals("sess-1");
    expect(run.calls[0]?.args).toEqual(["locals", "--frame", "0", "--session", "sess-1"]);
    await lldmdb.locals("sess-1", 2);
    expect(run.calls[1]?.args).toEqual(["locals", "--frame", "2", "--session", "sess-1"]);
    await expect(lldmdb.locals("sess-1", -1)).rejects.toThrow(/frame/);
    await lldmdb.eval("sess-1", "self.count", 1);
    expect(run.calls[2]?.args).toEqual(["expr", "self.count", "--frame", "1", "--session", "sess-1"]);
    await expect(lldmdb.eval("sess-1", "  ")).rejects.toThrow(/expr/);
  });

  it("maps step modes to llmdb flags and rejects unknown modes", async () => {
    const run = stubRunner(() => JSON.stringify({ state: "stopped" }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.step("sess-1");
    await lldmdb.step("sess-1", "in");
    await lldmdb.step("sess-1", "out");
    expect(run.calls.map((c) => c.args)).toEqual([
      ["step", "--over", "--session", "sess-1"],
      ["step", "--in", "--session", "sess-1"],
      ["step", "--out", "--session", "sess-1"],
    ]);
    await expect(lldmdb.step("sess-1", "sideways")).rejects.toThrow(/Invalid mode/);
  });

  it("stops with a required session and lists sessions", async () => {
    const run = stubRunner(() => JSON.stringify({ stopped: true }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.stop("sess-1");
    expect(run.calls.map((c) => c.args)).toEqual([["stop", "--session", "sess-1"]]);
    await expect(lldmdb.stop("  ")).rejects.toThrow(/session_id/);
    expect(run.calls).toHaveLength(1);
    const run2 = stubRunner(() => JSON.stringify([]));
    await new Llmdb({ runner: run2 }).sessions();
    expect(run2.calls[0]?.args).toEqual(["sessions"]);
  });

  it("checks availability via --version", async () => {
    const run = stubRunner(() => "0.2.0\n");
    await expect(new Llmdb({ runner: run }).checkAvailable()).resolves.toBe("0.2.0");
    expect(run.calls[0]?.args).toEqual(["--version"]);
  });

  it("launches a binary path with forwarded args and extracts the session id", async () => {
    const run = stubRunner(() => JSON.stringify({ sessionId: "launch-1", state: "running" }));
    const lldmdb = new Llmdb({ runner: run });
    const res = await lldmdb.launch("/tmp/app/DebugApp", ["--flag", "x"]);
    expect(res.sessionId).toBe("launch-1");
    expect(run.calls[0]?.args).toEqual(["launch", "/tmp/app/DebugApp", "--flag", "x"]);
    await lldmdb.launch("/tmp/app/DebugApp");
    expect(run.calls[1]?.args).toEqual(["launch", "/tmp/app/DebugApp"]);
    await expect(lldmdb.launch("  ")).rejects.toThrow(/path/);
  });

  it("rejects launch responses without a sessionId", async () => {
    const lldmdb = new Llmdb({ runner: stubRunner(() => JSON.stringify({ state: "running" })) });
    await expect(lldmdb.launch("/bin/true")).rejects.toThrow(/no sessionId/);
  });

  it("runs doctor and threads with session threading", async () => {
    const run = stubRunner(() => JSON.stringify({ ok: true }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.doctor();
    expect(run.calls[0]?.args).toEqual(["doctor"]);
    await lldmdb.threads("sess-1");
    expect(run.calls[1]?.args).toEqual(["threads", "--session", "sess-1"]);
    await expect(lldmdb.threads("  ")).rejects.toThrow(/session_id/);
  });

  it("sets conditional breakpoints and manages break list/delete/exception", async () => {
    const run = stubRunner(() => JSON.stringify({ ok: true }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.breakSet("sess-1", "a.swift", 10, { condition: "n > 100", hitCondition: ">5" });
    expect(run.calls[0]?.args).toEqual([
      "break", "set", "a.swift:10", "--condition", "n > 100", "--hit-condition", ">5", "--session", "sess-1",
    ]);
    await lldmdb.breakSet("sess-1", "a.swift", 10, { condition: "x" });
    expect(run.calls[1]?.args).toEqual(["break", "set", "a.swift:10", "--condition", "x", "--session", "sess-1"]);
    await expect(lldmdb.breakSet("sess-1", "a.swift", 10, { condition: "  " })).rejects.toThrow(/condition/);
    await expect(lldmdb.breakSet("sess-1", "a.swift", 10, { hitCondition: "" })).rejects.toThrow(/hit_condition/);

    await lldmdb.breakList("sess-1");
    expect(run.calls[2]?.args).toEqual(["break", "list", "--session", "sess-1"]);
    await lldmdb.breakDelete("sess-1", 3);
    expect(run.calls[3]?.args).toEqual(["break", "delete", "3", "--session", "sess-1"]);
    await expect(lldmdb.breakDelete("sess-1", 0)).rejects.toThrow(/breakpoint id/);
    await lldmdb.breakException("sess-1", ["swift_throw"]);
    expect(run.calls[4]?.args).toEqual(["break", "exception", "swift_throw", "--session", "sess-1"]);
    await lldmdb.breakException("sess-1");
    expect(run.calls[5]?.args).toEqual(["break", "exception", "--session", "sess-1"]);
    await expect(lldmdb.breakException("sess-1", ["  "])).rejects.toThrow(/filter/);
  });

  it("reads backtraces for an explicit thread", async () => {
    const run = stubRunner(() => JSON.stringify({ frames: [] }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.backtrace("sess-1", undefined, 7);
    expect(run.calls[0]?.args).toEqual(["bt", "--thread", "7", "--session", "sess-1"]);
    await lldmdb.backtrace("sess-1", 4, 2);
    expect(run.calls[1]?.args).toEqual(["bt", "--thread", "2", "--depth", "4", "--session", "sess-1"]);
    await expect(lldmdb.backtrace("sess-1", undefined, 0)).rejects.toThrow(/thread/);
  });

  it("reads scopes, expands refs, sets vars, and drains output", async () => {
    const run = stubRunner(() => JSON.stringify({ ok: true }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.scopes("sess-1");
    expect(run.calls[0]?.args).toEqual(["scopes", "--frame", "0", "--session", "sess-1"]);
    await lldmdb.scopes("sess-1", 3);
    expect(run.calls[1]?.args).toEqual(["scopes", "--frame", "3", "--session", "sess-1"]);
    await expect(lldmdb.scopes("sess-1", -1)).rejects.toThrow(/frame/);

    await lldmdb.expand("sess-1", 42);
    expect(run.calls[2]?.args).toEqual(["expand", "42", "--session", "sess-1"]);
    await expect(lldmdb.expand("sess-1", 0)).rejects.toThrow(/ref/);

    await lldmdb.setVar("sess-1", "self.count", "42", 1);
    expect(run.calls[3]?.args).toEqual(["set-var", "self.count", "42", "--frame", "1", "--session", "sess-1"]);
    await expect(lldmdb.setVar("sess-1", "  ", "1")).rejects.toThrow(/target/);
    await expect(lldmdb.setVar("sess-1", "x", "")).rejects.toThrow(/value/);

    await lldmdb.output("sess-1");
    expect(run.calls[4]?.args).toEqual(["output", "--session", "sess-1"]);
    await lldmdb.output("sess-1", true);
    expect(run.calls[5]?.args).toEqual(["output", "--clear", "--session", "sess-1"]);
  });

  it("runs until a location with an outliving exec timeout", async () => {
    const run = stubRunner(() => JSON.stringify({ state: "stopped" }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.runUntil("sess-1", "a.swift", 12, 45);
    expect(run.calls[0]?.args).toEqual(["run-until", "a.swift:12", "--wait", "45", "--session", "sess-1"]);
    expect(run.calls[0]?.opts?.timeoutMs).toBe((45 + 30) * 1000);
    await expect(lldmdb.runUntil("sess-1", "a.swift", 0)).rejects.toThrow(/line/);
    await expect(lldmdb.runUntil("sess-1", "a.swift", 1, 601)).rejects.toThrow(/wait_sec/);
  });

  it("waits for stops and interrupts with outliving exec timeouts", async () => {
    const run = stubRunner(() => JSON.stringify({ state: "stopped" }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.wait("sess-1");
    expect(run.calls[0]?.args).toEqual(["wait", "--timeout", "60", "--session", "sess-1"]);
    expect(run.calls[0]?.opts?.timeoutMs).toBe((60 + 30) * 1000);
    await lldmdb.wait("sess-1", 5);
    expect(run.calls[1]?.args).toEqual(["wait", "--timeout", "5", "--session", "sess-1"]);
    await expect(lldmdb.wait("sess-1", 0)).rejects.toThrow(/timeout/);
    await lldmdb.interrupt("sess-1");
    expect(run.calls[2]?.args).toEqual(["interrupt", "--wait", "10", "--session", "sess-1"]);
    expect(run.calls[2]?.opts?.timeoutMs).toBe((10 + 30) * 1000);
    await expect(lldmdb.interrupt("sess-1", 601)).rejects.toThrow(/wait_sec/);
  });
});

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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-llmdb-")), "state.json");
}

describe("orchestrator debug bookkeeping", () => {
  async function makeOrch(debugOps?: { stop: (id?: string) => Promise<unknown> }) {
    const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), {
      defaultTtlMs: 60_000,
      ...(debugOps ? { debugger: debugOps } : {}),
    });
    const res = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    return { orch, leaseId: res.lease.leaseId };
  }

  it("records, replaces, and clears the debug session id", async () => {
    const { orch, leaseId } = await makeOrch();
    await expect(orch.setDebugSession(leaseId, "dbg-1")).resolves.toBeNull();
    await expect(orch.setDebugSession(leaseId, "dbg-2")).resolves.toBe("dbg-1");
    const lease = await orch.resolveLease(leaseId);
    expect(lease.debugSessionId).toBe("dbg-2");
    await expect(orch.clearDebugSession(leaseId)).resolves.toBe("dbg-2");
    await expect(orch.clearDebugSession(leaseId)).resolves.toBeNull();
  });

  it("rejects bookkeeping on unknown leases", async () => {
    const { orch } = await makeOrch();
    await expect(orch.setDebugSession("lease_nope", "x")).rejects.toThrow(/unknown lease/i);
    await expect(orch.clearDebugSession("lease_nope")).rejects.toThrow(/unknown lease/i);
  });

  it("auto-detaches on release and never fails the release when stop throws", async () => {
    const stopped: (string | undefined)[] = [];
    const { orch, leaseId } = await makeOrch({
      stop: async (id?: string) => {
        stopped.push(id);
        throw new Error("llmdbd gone");
      },
    });
    await orch.setDebugSession(leaseId, "dbg-1");
    const res = await orch.release(leaseId, "s");
    expect(res.released).toBe(leaseId);
    expect(stopped).toEqual(["dbg-1"]);
  });

  it("auto-detaches swept leases", async () => {
    const stopped: (string | undefined)[] = [];
    const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), {
      defaultTtlMs: 20,
      debugger: { stop: async (id?: string) => void stopped.push(id) },
    });
    const res = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await orch.setDebugSession(res.lease.leaseId, "dbg-sweep");
    await new Promise((r) => setTimeout(r, 40));
    const swept = await orch.sweepStale();
    expect(swept.swept).toContain(res.lease.leaseId);
    expect(stopped).toEqual(["dbg-sweep"]);
  });

  it("auto-detaches when resolveLease expires the lease", async () => {
    const stopped: (string | undefined)[] = [];
    const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), {
      defaultTtlMs: 20,
      debugger: { stop: async (id?: string) => void stopped.push(id) },
    });
    const res = await orch.acquire({ sessionId: "s", autoBoot: false, slim: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await orch.setDebugSession(res.lease.leaseId, "dbg-expire");
    await new Promise((r) => setTimeout(r, 40));
    await expect(orch.resolveLease(res.lease.leaseId)).rejects.toThrow(/expired/);
    expect(stopped).toEqual(["dbg-expire"]);
  });
});

async function makeDebugClient(llmdbrun: Runner & { calls: Call[] }, atosrun?: Runner) {
  const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), { defaultTtlMs: 60_000 });
  const server = new McpServer({ name: "test", version: "0" });
  const noop = async () => ({ stdout: "", stderr: "" });
  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog(),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb: new Llmdb({ runner: llmdbrun }),
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
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text }; // zod input failures arrive as plain text, not {ok:false}
  }
  return { isError: result.isError === true, json };
}

function debugHandler(_bin: string, args: string[]): string {
  if (args[0] === "attach") return JSON.stringify({ sessionId: "dbg-9", state: "stopped" });
  if (args[0] === "bt") return JSON.stringify({ frames: [{ name: "main" }] });
  if (args[0] === "stop") return JSON.stringify({ stopped: true });
  return JSON.stringify({ ok: true });
}

describe("debug_* tools", () => {
  it("rejects unknown leases", async () => {
    const { client } = await makeDebugClient(stubRunner(debugHandler));
    const res = await call(client, "debug_bt", { lease_id: "lease_nope" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/unknown lease/i);
  });

  it("requires an attached session for break/continue/bt/locals/eval/step", async () => {
    const { client, leaseId } = await makeDebugClient(stubRunner(debugHandler));
    for (const [tool, args] of [
      ["debug_break", { file: "a.swift", line: 1 }],
      ["debug_continue", {}],
      ["debug_bt", {}],
      ["debug_locals", {}],
      ["debug_eval", { expr: "x" }],
      ["debug_step", {}],
    ] as const) {
      const res = await call(client, tool, { lease_id: leaseId, ...args });
      expect(res.isError, tool).toBe(true);
      expect(String(res.json.error), tool).toMatch(/no debug session/i);
    }
  });

  it("rejects invalid step modes without spawning llmdb", async () => {
    const run = stubRunner(debugHandler);
    const { client, leaseId } = await makeDebugClient(run);
    const attach = await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    expect(attach.json).toMatchObject({ ok: true, session_id: "dbg-9" });
    const res = await call(client, "debug_step", { lease_id: leaseId, mode: "sideways" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.json)).toMatch(/mode/i);
    expect(run.calls.filter((c) => c.args[0] === "step")).toHaveLength(0);
  });

  it("threads the lease session id through every verb and logs actions", async () => {
    const run = stubRunner(debugHandler);
    const { client, orch, leaseId } = await makeDebugClient(run);
    const attach = await call(client, "debug_attach", { lease_id: leaseId, bundle_id: "com.example.App" });
    expect(attach.json).toMatchObject({ ok: true, session_id: "dbg-9" });
    expect(run.calls[0]?.args).toEqual(["attach", "--app", "com.example.App"]);

    const bt = await call(client, "debug_bt", { lease_id: leaseId, depth: 5 });
    expect(bt.json).toMatchObject({ ok: true, session_id: "dbg-9" });
    expect(run.calls[1]?.args).toEqual(["bt", "--depth", "5", "--session", "dbg-9"]);

    const step = await call(client, "debug_step", { lease_id: leaseId, mode: "in" });
    expect(step.isError).toBe(false);
    expect(run.calls[2]?.args).toEqual(["step", "--in", "--session", "dbg-9"]);

    const tools = orch.leaseActions(leaseId).map((a) => a.tool);
    expect(tools).toEqual(["debug_attach", "debug_bt", "debug_step"]);
  });

  it("re-attach replaces the previous session and stops it", async () => {
    const run = stubRunner(debugHandler);
    const { client, orch, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 111 });
    await orch.setDebugSession(leaseId, "dbg-old"); // simulate a diverged record
    await call(client, "debug_attach", { lease_id: leaseId, pid: 222 });
    expect(run.calls.map((c) => c.args[0])).toEqual(["attach", "attach", "stop"]);
    expect(run.calls[2]?.args).toEqual(["stop", "--session", "dbg-old"]);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBe("dbg-9");
  });

  it("detach is idempotent and clears bookkeeping", async () => {
    const run = stubRunner(debugHandler);
    const { client, orch, leaseId } = await makeDebugClient(run);
    const empty = await call(client, "debug_detach", { lease_id: leaseId });
    expect(empty.json).toMatchObject({ ok: true, stopped: false });

    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const detach = await call(client, "debug_detach", { lease_id: leaseId });
    expect(detach.json).toMatchObject({ ok: true, stopped: true, session_id: "dbg-9" });
    expect(run.calls.at(-1)?.args).toEqual(["stop", "--session", "dbg-9"]);
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();

    const again = await call(client, "debug_detach", { lease_id: leaseId });
    expect(again.json).toMatchObject({ ok: true, stopped: false });
  });

  it("detach treats an already-gone session as stopped=false", async () => {
    const calls: Call[] = [];
    const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
      calls.push({ bin, args, opts });
      if (args[0] === "stop") {
        throw new ExecError("llmdb", args, 1, "", "Error: no session with id dbg-9");
      }
      return { stdout: debugHandler(bin, args), stderr: "" };
    }) as Runner & { calls: Call[] };
    run.calls = calls;
    const { client, orch, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const detach = await call(client, "debug_detach", { lease_id: leaseId });
    expect(detach.json).toMatchObject({ ok: true, stopped: false, session_id: "dbg-9" });
    expect((await orch.resolveLease(leaseId)).debugSessionId).toBeUndefined();
  });

  it("attach failures surface cleanly with the llmdb error", async () => {
    const failingRun = (async (bin: string, args: string[], opts?: ExecOptions) => {
      failingRun.calls.push({ bin, args, opts });
      throw new ExecError("llmdb", args, 1, "", "Error: DAP attach failed: no process found with process ID 99999999");
    }) as Runner & { calls: Call[] };
    failingRun.calls = [];
    const { client, leaseId } = await makeDebugClient(failingRun);
    const res = await call(client, "debug_attach", { lease_id: leaseId, pid: 99999999 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/no process found/);
  });

  it("missing llmdb binary fails with an install hint", async () => {
    const missing = (async () => {
      throw new ExecError("llmdb", ["attach"], "ENOENT", "", "spawn llmdb ENOENT");
    }) as Runner & { calls: Call[] };
    missing.calls = [];
    const { client, leaseId } = await makeDebugClient(missing);
    const res = await call(client, "debug_attach", { lease_id: leaseId, pid: 1 });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/brew install alexmx\/tools\/llmdb/);
  });
});

function round2Handler(_bin: string, args: string[]): string {
  if (args[0] === "launch") return JSON.stringify({ sessionId: "dbg-launch", state: "running" });
  if (args[0] === "attach") return JSON.stringify({ sessionId: "dbg-9", state: "stopped" });
  if (args[0] === "sessions") return JSON.stringify([{ sessionId: "dbg-9" }]);
  if (args[0] === "doctor") return JSON.stringify({ lldbDap: "ok" });
  if (args[0] === "threads") return JSON.stringify({ threads: [{ id: 1 }] });
  if (args[0] === "break") return JSON.stringify({ ok: true });
  return JSON.stringify({ ok: true });
}

describe("round-2 debug_* tools", () => {
  it("registers every round-2 tool", async () => {
    const { client } = await makeDebugClient(stubRunner(round2Handler));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "debug_sessions", "debug_launch", "debug_doctor", "debug_threads", "debug_scopes",
      "debug_expand", "debug_set_var", "debug_output", "debug_run_until", "debug_wait",
      "debug_interrupt", "symbolicate", "net_assert_flow", "map_local", "map_remote",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("requires an attached session for the session-bound round-2 verbs", async () => {
    const { client, leaseId } = await makeDebugClient(stubRunner(round2Handler));
    for (const [tool, args] of [
      ["debug_threads", {}],
      ["debug_scopes", {}],
      ["debug_expand", { ref: 3 }],
      ["debug_set_var", { target: "x", value: "1" }],
      ["debug_output", {}],
      ["debug_run_until", { file: "a.swift", line: 1 }],
      ["debug_wait", {}],
      ["debug_interrupt", {}],
      ["debug_break", { list: true }],
      ["debug_break", { delete: 1 }],
      ["debug_break", { exception: [] }],
    ] as const) {
      const res = await call(client, tool, { lease_id: leaseId, ...args });
      expect(res.isError, tool).toBe(true);
      expect(String(res.json.error), tool).toMatch(/no debug session/i);
    }
  });

  it("dispatches debug_break ops and rejects combos before touching a session", async () => {
    const run = stubRunner(round2Handler);
    const { client, leaseId } = await makeDebugClient(run);
    const combo = await call(client, "debug_break", { lease_id: leaseId, file: "a.swift", line: 1, list: true });
    expect(combo.isError).toBe(true);
    expect(String(combo.json.error)).toMatch(/exactly one op/);
    const none = await call(client, "debug_break", { lease_id: leaseId });
    expect(none.isError).toBe(true);
    expect(String(none.json.error)).toMatch(/exactly one op/);
    expect(run.calls).toHaveLength(0);

    await call(client, "debug_attach", { lease_id: leaseId, pid: 4242 });
    const list = await call(client, "debug_break", { lease_id: leaseId, list: true });
    expect(list.json).toMatchObject({ ok: true, op: "list", session_id: "dbg-9" });
    const del = await call(client, "debug_break", { lease_id: leaseId, delete: 2 });
    expect(del.json).toMatchObject({ ok: true, op: "delete" });
    const exc = await call(client, "debug_break", { lease_id: leaseId, exception: ["swift_throw"] });
    expect(exc.json).toMatchObject({ ok: true, op: "exception" });
    const clear = await call(client, "debug_break", { lease_id: leaseId, exception: [] });
    expect(clear.json).toMatchObject({ ok: true, op: "exception" });
    const set = await call(client, "debug_break", {
      lease_id: leaseId, file: "a.swift", line: 9, condition: "n > 1", hit_condition: ">2",
    });
    expect(set.json).toMatchObject({ ok: true, op: "set" });
    const half = await call(client, "debug_break", { lease_id: leaseId, file: "a.swift" });
    expect(half.isError).toBe(true);
    expect(String(half.json.error)).toMatch(/both file and line/);
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "list", "--session", "dbg-9"]);
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "delete", "2", "--session", "dbg-9"]);
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "exception", "swift_throw", "--session", "dbg-9"]);
    expect(run.calls.map((c) => c.args)).toContainEqual(["break", "exception", "--session", "dbg-9"]);
    expect(run.calls.map((c) => c.args)).toContainEqual([
      "break", "set", "a.swift:9", "--condition", "n > 1", "--hit-condition", ">2", "--session", "dbg-9",
    ]);
  });

  it("threads the session through the round-2 verbs and logs actions", async () => {
    const run = stubRunner(round2Handler);
    const { client, orch, leaseId } = await makeDebugClient(run);
    const sessions = await call(client, "debug_sessions", { lease_id: leaseId });
    expect(sessions.json).toMatchObject({ ok: true });
    const doctor = await call(client, "debug_doctor", { lease_id: leaseId });
    expect(doctor.json).toMatchObject({ ok: true });
    const launch = await call(client, "debug_launch", { lease_id: leaseId, path: "/tmp/DebugApp", args: ["--x"] });
    expect(launch.json).toMatchObject({ ok: true, session_id: "dbg-launch" });
    expect(run.calls[2]?.args).toEqual(["launch", "/tmp/DebugApp", "--x"]);

    for (const [tool, args, argv] of [
      ["debug_threads", {}, ["threads", "--session", "dbg-launch"]],
      ["debug_scopes", { frame: 2 }, ["scopes", "--frame", "2", "--session", "dbg-launch"]],
      ["debug_expand", { ref: 5 }, ["expand", "5", "--session", "dbg-launch"]],
      ["debug_set_var", { target: "x", value: "1" }, ["set-var", "x", "1", "--frame", "0", "--session", "dbg-launch"]],
      ["debug_output", { clear: true }, ["output", "--clear", "--session", "dbg-launch"]],
      ["debug_run_until", { file: "a.swift", line: 3 }, ["run-until", "a.swift:3", "--wait", "60", "--session", "dbg-launch"]],
      ["debug_wait", { timeout: 7 }, ["wait", "--timeout", "7", "--session", "dbg-launch"]],
      ["debug_interrupt", {}, ["interrupt", "--wait", "10", "--session", "dbg-launch"]],
      ["debug_bt", { thread: 4, depth: 3 }, ["bt", "--thread", "4", "--depth", "3", "--session", "dbg-launch"]],
    ] as const) {
      const res = await call(client, tool, { lease_id: leaseId, ...args });
      expect(res.isError, tool).toBe(false);
      expect(res.json).toMatchObject({ ok: true, session_id: "dbg-launch" });
      expect(run.calls.map((c) => c.args), tool).toContainEqual(argv);
    }
    const tools = orch.leaseActions(leaseId).map((a) => a.tool);
    expect(tools).toContain("debug_launch");
    expect(tools).toContain("debug_threads");
    expect(tools).toContain("debug_wait");
  });

  it("rejects invalid round-2 inputs without spawning llmdb", async () => {
    const run = stubRunner(round2Handler);
    const { client, leaseId } = await makeDebugClient(run);
    const badRef = await call(client, "debug_expand", { lease_id: leaseId, ref: 0 });
    expect(badRef.isError).toBe(true);
    const badTimeout = await call(client, "debug_wait", { lease_id: leaseId, timeout: 601 });
    expect(badTimeout.isError).toBe(true);
    const badThread = await call(client, "debug_bt", { lease_id: leaseId, thread: -1 });
    expect(badThread.isError).toBe(true);
    expect(run.calls).toHaveLength(0);
  });

describe("debug-ux", () => {
  it("wait_sec, truncation, stopReason", async () => {
    const run = stubRunner((_b, args) => {
      const v = args[0];
      if (v === "attach") return '{"sessionId":"dbg-9"}';
      if (v === "output") return '{"output":"abcdef"}';
      return `{"state":"stopped","stop${v === "step" ? "_reason" : "Reason"}":"bp"}`;
    });
    const { client, leaseId } = await makeDebugClient(run);
    await call(client, "debug_attach", { lease_id: leaseId, pid: 1 });
    await call(client, "debug_interrupt", { lease_id: leaseId });
    await call(client, "debug_interrupt", { lease_id: leaseId, wait_sec: 3 });
    expect(run.calls.slice(1, 3).map((c) => c.args)).toEqual([
      ["interrupt", "--wait", "10", "--session", "dbg-9"],
      ["interrupt", "--wait", "3", "--session", "dbg-9"],
    ]);
    const full = await call(client, "debug_output", { lease_id: leaseId });
    expect(full.json).toMatchObject({ output: "abcdef", truncated: false, result: { output: "abcdef" } });
    const cut = await call(client, "debug_output", { lease_id: leaseId, max_chars: 4 });
    expect(cut.json).toMatchObject({ output: "…[truncated 2 chars]\ncdef", truncated: true });
    for (const tool of ["debug_continue", "debug_step", "debug_wait"] as const) {
      const res = await call(client, tool, { lease_id: leaseId });
      expect(res.json, tool).toMatchObject({ ok: true, state: "stopped", stopReason: "bp" });
    }
  });
});

  it("symbolicate validates the lease, pcs, and binary without spawning", async () => {
    const { client, leaseId } = await makeDebugClient(stubRunner(round2Handler));
    const gated = await call(client, "symbolicate", { pcs: "0x1000", binary: "/bin/ls", lease_id: "lease_nope" });
    expect(gated.isError).toBe(true);
    expect(String(gated.json.error)).toMatch(/unknown lease/i);
    const noBinary = await call(client, "symbolicate", { pcs: "0x1000", lease_id: leaseId });
    expect(noBinary.isError).toBe(true);
    expect(String(noBinary.json.error)).toMatch(/binary/);
    const badPc = await call(client, "symbolicate", { pcs: "not-an-address", binary: "/bin/ls" });
    expect(badPc.isError).toBe(true);
    expect(String(badPc.json.error)).toMatch(/pc/);
    const empty = await call(client, "symbolicate", { pcs: [], binary: "/bin/ls" });
    expect(empty.isError).toBe(true);
  });
});

describe("failure-tests", () => {
  type A=Record<string,unknown>;
  const ATTACH='{"sessionId":"d1"}';
  const cx=async(run:Runner & {calls:Call[]},atos?:Runner) => {
    const {client:c,leaseId:id}=await makeDebugClient(run,atos);
    return (t:string,a:A={}) => call(c,t,{lease_id:id,...a});
  };
  const E=(r:{json:A}) => String(r.json.error);
  it("bad stdout is a parse error", async () => {
    const C=await cx(stubRunner((_b,a) => (a[0]==="attach" ? ATTACH : "???")));
    await C("debug_attach",{pid:1});
    const r=await C("debug_bt");
    expect(r.isError).toBe(true);
    expect(E(r)).toMatch(/parse.*JSON/i);
  });
  it("exit-1/verb; timeout continue/wait", async () => {
    const C=await cx((async(b:string,a:string[]) => {
      if(a[0]==="attach") return {stdout:ATTACH,stderr:""};
      if(a[0]==="continue"||a[0]==="wait") throw new ExecError(b,a,"ETIMEDOUT","","t/o");
      throw new ExecError(b,a,1,"",`boom-${a[0]}`);
    }) as Runner & {calls:Call[]});
    await C("debug_attach",{pid:1});
    const verbs:[string,A][]=[["debug_threads",{}],["debug_bt",{}],["debug_locals",{}],["debug_eval",{expr:"x"}],["debug_step",{}],["debug_scopes",{}],["debug_expand",{ref:1}],["debug_set_var",{target:"x",value:"1"}],["debug_output",{}],["debug_run_until",{file:"a",line:1}],["debug_interrupt",{}],["debug_break",{list:true}],["debug_doctor",{}],["debug_sessions",{}]];
    for(const [t,a] of verbs) {
      const r=await C(t,a);
      expect(r.isError,t).toBe(true);
      expect(E(r),t).toMatch(/boom-/);
    }
    for(const [t,a] of [["debug_continue",{wait_sec:60}],["debug_wait",{timeout:60}]]) {
      const r=await C(t,a);
      expect(r.isError,t).toBe(true);
      expect(E(r),t).toMatch(/ETIMEDOUT|timed out/i);
    }
  });
  it("debug_launch bad input; no spawn", async () => {
    const run=stubRunner(() => ATTACH);
    const C=await cx(run);
    const p=await C("debug_launch",{path:"   "});
    expect(p.isError).toBe(true);
    expect(E(p)).toMatch(/path/);
    expect((await C("debug_launch",{path:"/A",args:["ok",123]})).isError).toBe(true);
    expect(run.calls).toHaveLength(0);
  });
  it("atos ENOENT; binary required", async () => {
    const atos=(() => { throw Object.assign(new Error("ENOENT"),{code:"ENOENT"}); }) as Runner;
    const C=await cx(stubRunner(() => ATTACH),atos);
    const m=await C("symbolicate",{pcs:"0x1",binary:"/b"});
    expect(m.isError).toBe(true);
    expect(E(m)).toMatch(/xcode-select --install/);
    const n=await C("symbolicate",{pcs:"0x1"});
    expect(n.isError).toBe(true);
    expect(E(n)).toMatch(/binary/);
  });
});
