import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import type { Runner } from "../src/exec.js";

/** P1 contract: trigger-first descriptions + titles/annotations on all 70 tools, plus the toolcall choke point. */

const SERVER_TOOLS = [
  "pool_status", "sessions_list", "sim_boot", "sim_shutdown", "sim_slim",
  "lease_acquire", "lease_release", "lease_heartbeat", "lease_list",
  "queue_status", "queue_cancel",
  "ui_describe", "ui_tap", "ui_type", "ui_swipe", "ui_gesture", "ui_button",
  "ui_screenshot", "ui_batch",
];

const EXTRAS_TOOLS = [
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
];

const ALL_TOOLS = [...SERVER_TOOLS, ...EXTRAS_TOOLS];

// Research verdict: readOnlyHint=true x21, destructiveHint=true x4, openWorldHint=true x2.
const READONLY_TOOLS = new Set([
  "pool_status", "sessions_list", "lease_list", "queue_status", "ui_describe",
  "camera_status", "sim_log_stream", "sim_log_show",
  "debug_bt", "debug_locals", "debug_sessions", "debug_doctor",
  "debug_threads", "debug_scopes", "debug_expand", "debug_wait",
  "symbolicate", "lease_actions",
  "net_proxy_status", "net_capture_status", "net_assert_flow",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "app_uninstall", "app_reinstall", "app_cache_clear", "net_proxy_start",
]);

const OPEN_WORLD_TOOLS = new Set(["app_open_url", "net_proxy_start"]);

// Per-tool trigger keywords the WHEN prefix must contain (case-insensitive substring).
const TRIGGER_KEYWORDS: Record<string, string[]> = {
  pool_status: ["simulator", "lease"],
  sessions_list: ["session"],
  sim_boot: ["boot"],
  sim_shutdown: ["shut down", "shutdown"],
  sim_slim: ["slim"],
  lease_acquire: ["lease", "acquire"],
  lease_release: ["release"],
  lease_heartbeat: ["heartbeat", "renew", "ttl"],
  lease_list: ["lease"],
  queue_status: ["queue", "ticket"],
  queue_cancel: ["cancel", "ticket"],
  ui_describe: ["hierarchy", "describe"],
  ui_tap: ["tap"],
  ui_type: ["type"],
  ui_swipe: ["swipe"],
  ui_gesture: ["gesture", "scroll"],
  ui_button: ["button"],
  ui_screenshot: ["screenshot"],
  ui_batch: ["batch"],
  sim_rotate: ["rotat"],
  sim_ca_debug: ["coreanimation"],
  sim_memory_warning: ["memory"],
  camera_start: ["camera"],
  camera_switch: ["camera"],
  camera_mirror: ["mirror"],
  camera_status: ["camera"],
  camera_stop: ["camera"],
  sim_log_stream: ["log"],
  sim_log_show: ["log"],
  stream_start: ["stream"],
  stream_stop: ["stream"],
  app_open_url: ["url"],
  app_install: ["install"],
  app_uninstall: ["uninstall", "remove"],
  app_reinstall: ["reinstall"],
  app_launch: ["launch"],
  app_terminate: ["terminate"],
  app_cache_clear: ["cache"],
  profile_trace: ["profile", "trace"],
  debug_attach: ["attach"],
  debug_break: ["breakpoint"],
  debug_continue: ["continue", "resume"],
  debug_bt: ["backtrace"],
  debug_locals: ["locals"],
  debug_eval: ["eval"],
  debug_step: ["step"],
  debug_detach: ["detach"],
  debug_sessions: ["session"],
  debug_launch: ["launch"],
  debug_doctor: ["doctor", "diagnose"],
  debug_threads: ["thread"],
  debug_scopes: ["scope"],
  debug_expand: ["expand"],
  debug_set_var: ["variable", "assign"],
  debug_output: ["output"],
  debug_run_until: ["run-until", "run until"],
  debug_wait: ["wait"],
  debug_interrupt: ["interrupt", "pause"],
  symbolicate: ["symbolicat"],
  lease_actions: ["action", "history"],
  net_proxy_start: ["intercept", "proxy"],
  net_proxy_set_rules: ["rule"],
  net_proxy_stop: ["proxy"],
  net_proxy_status: ["proxy"],
  net_capture_start: ["capture"],
  net_capture_stop: ["capture"],
  net_capture_status: ["capture"],
  net_assert_flow: ["flow"],
  map_local: ["mock", "map"],
  map_remote: ["redirect", "map"],
};

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-meta-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
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
    screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-meta-shots-")),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, orch };
}

const SAVED_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("P1 tool metadata contract", () => {
  it("exposes exactly the 70 known tools via tools/list", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    expect(ALL_TOOLS).toHaveLength(70);
    expect(new Set(ALL_TOOLS).size).toBe(70);
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());
  });

  it("gives every tool a non-empty title", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(typeof tool.title === "string" && tool.title.length > 0, `${tool.name} title`).toBe(true);
    }
  });

  it("starts every description with a trigger-first WHEN prefix + raw-CLI grounding", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const desc = tool.description ?? "";
      expect(desc.startsWith("WHEN "), `${tool.name} WHEN prefix`).toBe(true);
      expect(
        desc.includes("INSTEAD OF") || desc.includes("no raw CLI"),
        `${tool.name} CLI grounding`,
      ).toBe(true);
    }
  });

  it("contains each tool's trigger keywords in its description", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    expect(Object.keys(TRIGGER_KEYWORDS).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of listed.tools) {
      const desc = (tool.description ?? "").toLowerCase();
      const keywords = TRIGGER_KEYWORDS[tool.name] ?? [];
      expect(
        keywords.some((k) => desc.includes(k.toLowerCase())),
        `${tool.name} trigger keywords ${JSON.stringify(keywords)}`,
      ).toBe(true);
    }
  });

  it("marks exactly the 21 read-only tools with readOnlyHint=true", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    expect(READONLY_TOOLS.size).toBe(21);
    for (const tool of listed.tools) {
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe("boolean");
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(READONLY_TOOLS.has(tool.name));
      expect(typeof tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe("boolean");
    }
  });

  it("marks destructive + open-world tools per the research verdict", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(
        DESTRUCTIVE_TOOLS.has(tool.name),
      );
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(
        OPEN_WORLD_TOOLS.has(tool.name),
      );
    }
  });

  it("keeps input schemas untouched (spot-check required params)", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((t) => [t.name, t]));
    expect(byName.get("ui_tap")?.inputSchema).toMatchObject({ type: "object" });
    expect(JSON.stringify(byName.get("ui_tap")?.inputSchema)).toContain("lease_id");
    expect(JSON.stringify(byName.get("lease_acquire")?.inputSchema)).toContain("session_id");
    expect(JSON.stringify(byName.get("debug_break")?.inputSchema)).toContain("breakpoints");
    expect(JSON.stringify(byName.get("net_proxy_start")?.inputSchema)).toContain("url_regex");
    expect(JSON.stringify(byName.get("map_remote")?.inputSchema)).toContain("url_regex");
  });
});

describe("P1 toolcall telemetry choke point", () => {
  it("appends one JSONL line per tools/call with tool name + timestamp + ok only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-toolcalls-"));
    const file = path.join(dir, "toolcalls.jsonl");
    process.env["SIM_MCP_TOOLCALLS_FILE"] = file;
    delete process.env["SIM_MCP_TOOLCALLS"];
    const { client } = await makeClient();
    const before = Date.now();
    await client.callTool({ name: "pool_status", arguments: {} });
    const res = await client.callTool({
      name: "lease_release",
      arguments: { lease_id: "bogus-lease-z9", session_id: "s1" },
    });
    expect(res.isError).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["ok", "t", "tool"]);
    expect(first).toMatchObject({ tool: "pool_status", ok: true });
    expect(typeof first["t"]).toBe("number");
    expect(first["t"] as number).toBeGreaterThanOrEqual(before);
    expect(Object.keys(second).sort()).toEqual(["ok", "t", "tool"]);
    expect(second).toMatchObject({ tool: "lease_release", ok: false });
    // Never logs arg values: the bogus lease id must not appear anywhere.
    expect(fs.readFileSync(file, "utf8")).not.toContain("bogus-lease-z9");
  });

  it("writes nothing when SIM_MCP_TOOLCALLS=0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-toolcalls-off-"));
    const file = path.join(dir, "toolcalls.jsonl");
    process.env["SIM_MCP_TOOLCALLS_FILE"] = file;
    process.env["SIM_MCP_TOOLCALLS"] = "0";
    const { client } = await makeClient();
    await client.callTool({ name: "pool_status", arguments: {} });
    expect(fs.existsSync(file)).toBe(false);
  });
});
