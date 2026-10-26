import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Axe } from "../src/axe.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createMcpServer } from "../src/server.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, Simslim, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";
import { NEXT_ACTIONS, recoveryFor } from "../src/recovery.js";
import type { Runner } from "../src/exec.js";

/** P2 contract: additive next[] on success + recovery fields on failure; old keys byte-identical. */

const ALL_TOOLS = new Set([
  "pool_status", "sessions_list", "sim_boot", "sim_shutdown", "sim_slim",
  "lease_acquire", "lease_release", "lease_heartbeat", "lease_list",
  "queue_status", "queue_cancel",
  "ui_describe", "ui_tap", "ui_type", "ui_swipe", "ui_gesture", "ui_button",
  "ui_screenshot", "ui_batch", "ui_triage",
  "sim_rotate", "sim_ca_debug", "sim_memory_warning",
  "camera_start", "camera_switch", "camera_mirror", "camera_status", "camera_stop",
  "sim_log_stream", "sim_log_show",
  "stream_start", "stream_stop",
  "app_open_url", "app_install", "app_uninstall", "app_reinstall",
  "app_launch", "app_terminate", "app_cache_clear",
  "profile_trace",
  "debug_attach", "debug_break", "debug_continue", "debug_bt", "debug_locals",
  "debug_eval", "debug_step", "debug_detach", "debug_sessions", "debug_launch",
  "debug_doctor", "debug_threads", "debug_scopes", "debug_expand", "debug_set_var",
  "debug_output", "debug_run_until", "debug_wait", "debug_interrupt",
  "symbolicate", "lease_actions",
  "net_proxy_start", "net_proxy_set_rules", "net_proxy_stop", "net_proxy_status",
  "net_capture_start", "net_capture_stop", "net_capture_status", "net_assert_flow",
  "map_local", "map_remote",
]);

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
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

async function makeClient() {
  const noop: Runner = async () => ({ stdout: "", stderr: "" });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p2-")), "state.json");
  const store = Store.load(file);
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    store,
    { defaultTtlMs: 60_000 },
  );
  const server = createMcpServer({
    orchestrator: orch,
    simslim: new Simslim({ runner: noop }),
    axe: new Axe({ runner: noop }),
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog({ runner: async () => ({ stdout: "", truncated: false, timedOut: false }) }),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb: new Llmdb({ runner: noop }),
    screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p2-shots-")),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, orch, store };
}

function textOf(res: { content: unknown }): Record<string, unknown> {
  const content = res.content as { type: string; text?: string }[];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

function expectValidNext(body: Record<string, unknown>): void {
  expect(body["next"]).toBeDefined();
  expect(Array.isArray(body["next"])).toBe(true);
  const next = body["next"] as unknown[];
  expect(next.length).toBeGreaterThanOrEqual(2);
  for (const name of next) {
    expect(typeof name).toBe("string");
    expect(ALL_TOOLS.has(name as string), `unknown tool in next[]: ${String(name)}`).toBe(true);
  }
}

describe("P2 next[] on success", () => {
  it("pool_status carries next[] of valid tool names and keeps old keys", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "pool_status", arguments: {} });
    expect(res.isError).not.toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(true);
    expect(body["server"]).toBeDefined();
    expectValidNext(body);
  });

  it("lease_acquire success carries next[] and the lease payload", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "lease_acquire", arguments: { session_id: "s1" } });
    expect(res.isError).not.toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(true);
    expect(body["lease"]).toBeDefined();
    expectValidNext(body);
  });

  it("ui_describe success carries next[] including ui_tap", async () => {
    const { client, orch } = await makeClient();
    const acq = await orch.acquire({ sessionId: "s1", autoBoot: false, slim: false });
    if (!acq.ok || acq.queued) throw new Error("expected lease");
    const res = await client.callTool({ name: "ui_describe", arguments: { lease_id: acq.lease.leaseId } });
    expect(res.isError).not.toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(true);
    expectValidNext(body);
    expect(body["next"]).toContain("ui_tap");
  });

  it("extras success (sim_log_show) carries next[]", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "sim_log_show", arguments: { udid: "U1" } });
    expect(res.isError).not.toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(true);
    expectValidNext(body);
  });
});

describe("P2 recovery on failure", () => {
  it("unknown lease: recoverable + lease_acquire, error text intact", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "ui_describe", arguments: { lease_id: "lease-nope" } });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toBe("Unknown lease lease-nope");
    expect(body["recoverable"]).toBe(true);
    expect(body["recover_with_tool"]).toBe("lease_acquire");
    expect(body["recover_args_hint"]).toMatchObject({ session_id: expect.any(String) });
  });

  it("expired lease: recoverable + lease_acquire", async () => {
    const { client, orch, store } = await makeClient();
    const acq = await orch.acquire({ sessionId: "s1", autoBoot: false, slim: false });
    if (!acq.ok || acq.queued) throw new Error("expected lease");
    const id = acq.lease.leaseId;
    await store.mutate((s) => {
      const rec = s.leases.find((l) => l.leaseId === id);
      if (rec) rec.lastHeartbeat = Date.now() - rec.ttlMs - 1000;
      return { value: undefined, dirty: true };
    });
    const res = await client.callTool({ name: "ui_describe", arguments: { lease_id: id } });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toBe(`Lease ${id} expired and was released`);
    expect(body["recoverable"]).toBe(true);
    expect(body["recover_with_tool"]).toBe("lease_acquire");
  });

  it("holder mismatch: recoverable + status tool, holder named", async () => {
    const { client, orch } = await makeClient();
    const acq = await orch.acquire({ sessionId: "alice", autoBoot: false, slim: false });
    if (!acq.ok || acq.queued) throw new Error("expected lease");
    const res = await client.callTool({
      name: "lease_heartbeat",
      arguments: { lease_id: acq.lease.leaseId, session_id: "mallory" },
    });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toMatch(/held by session alice/);
    expect(body["recoverable"]).toBe(true);
    expect(String(body["recover_with_tool"])).toMatch(/lease_list|sessions_list|pool_status/);
  });

  it("next[] map covers exactly the 71 tools with valid names", async () => {
    const keys = Object.keys(NEXT_ACTIONS).sort();
    expect(keys).toEqual([...ALL_TOOLS].sort());
    // Golden path lease→drive→release must be next[]-followable with no detour.
    expect(NEXT_ACTIONS["ui_screenshot"]).toContain("lease_release");
    expect(NEXT_ACTIONS["ui_batch"]).toContain("lease_release");
    for (const [tool, next] of Object.entries(NEXT_ACTIONS)) {
      expect(next.length, tool).toBeGreaterThanOrEqual(2);
      expect(next.length, tool).toBeLessThanOrEqual(5);
      for (const name of next) {
        expect(ALL_TOOLS.has(name), `${tool} -> ${name}`).toBe(true);
      }
    }
  });

  it("recovery classifier covers the grounded error classes", () => {
    expect(recoveryFor("Lease l1 is held by session a, not b")).toMatchObject({ recoverable: true, recover_with_tool: "lease_list" });
    expect(recoveryFor("Lease l1 expired and was released")).toMatchObject({ recoverable: true, recover_with_tool: "lease_acquire" });
    expect(recoveryFor("Lease l1 has no debug session attached; call debug_attach first.")).toMatchObject({
      recoverable: true,
      recover_with_tool: "debug_attach",
    });
    expect(
      recoveryFor("Cannot set_rules: the network proxy (port 8080) is held by session a (lease l1). That session must call net_proxy_stop first."),
    ).toMatchObject({ recoverable: true, recover_with_tool: "net_proxy_status" });
    expect(recoveryFor("No network proxy is running; call net_proxy_start first.")).toMatchObject({
      recoverable: true,
      recover_with_tool: "net_proxy_start",
    });
    expect(recoveryFor("Packet capture is already running for lease l1; stop it first")).toMatchObject({
      recoverable: true,
      recover_with_tool: "net_capture_status",
    });
    expect(recoveryFor("debug_attach does not support real-device leases yet: real-device support lands in P3 (x).")).toMatchObject({
      recoverable: true,
      recover_with_tool: "lease_acquire",
    });
    expect(recoveryFor("spawn serve-sim ENOENT. serve-sim is not installed; run: npm install -g serve-sim (or set SERVE_SIM_BIN)")).toMatchObject({
      recoverable: false,
    });
    expect(recoveryFor("xcrun failed. Xcode's devicectl is not installed; install Xcode + accept the license (xcode-select --install)")).toMatchObject({
      recoverable: false,
      recover_args_hint: { install: expect.stringContaining("xcode-select --install") },
    });
    expect(recoveryFor("Simulator U1 is leased to session a (lease l1). Pass force=true to preempt.", "sim_shutdown")).toMatchObject({
      recoverable: true,
      recover_with_tool: "sim_shutdown",
    });
    expect(recoveryFor("something totally novel")).toEqual({ recoverable: false });
    expect(recoveryFor("Invalid udid (expected a non-empty string)", "ui_screenshot")).toMatchObject({
      recoverable: true,
      recover_with_tool: "ui_screenshot",
    });
  });

  it("unknown ticket: recoverable + lease_acquire (re-queue)", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "queue_cancel", arguments: { ticket_id: "tick-nope", session_id: "s1" } });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toBe("Unknown ticket tick-nope");
    expect(body["recoverable"]).toBe(true);
    expect(body["recover_with_tool"]).toBe("lease_acquire");
  });
});
