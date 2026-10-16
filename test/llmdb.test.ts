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

  it("stops with optional session and lists sessions", async () => {
    const run = stubRunner(() => JSON.stringify({ stopped: true }));
    const lldmdb = new Llmdb({ runner: run });
    await lldmdb.stop("sess-1");
    await lldmdb.stop();
    expect(run.calls.map((c) => c.args)).toEqual([["stop", "--session", "sess-1"], ["stop"]]);
    const run2 = stubRunner(() => JSON.stringify([]));
    await new Llmdb({ runner: run2 }).sessions();
    expect(run2.calls[0]?.args).toEqual(["sessions"]);
  });

  it("checks availability via --version", async () => {
    const run = stubRunner(() => "0.2.0\n");
    await expect(new Llmdb({ runner: run }).checkAvailable()).resolves.toBe("0.2.0");
    expect(run.calls[0]?.args).toEqual(["--version"]);
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

async function makeDebugClient(llmdbrun: Runner & { calls: Call[] }) {
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
