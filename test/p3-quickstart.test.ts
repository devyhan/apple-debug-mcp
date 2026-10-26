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

/** P3 contract: server instructions + ONE quickstart resource + exactly 3 prompts; tools/list still 70. */

const QUICKSTART_URI = "apple-debug-mcp://quickstart";
const PROMPT_NAMES = ["ios-debug-session", "proxy-tamper", "log-triage"] as const;

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p3-")), "state.json");
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
    screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p3-shots-")),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client };
}

function promptText(res: { messages: { content: unknown }[] }): string {
  return res.messages
    .map((m) => {
      const c = m.content as { type?: string; text?: string };
      return c.type === "text" ? (c.text ?? "") : "";
    })
    .join("\n");
}

const SAVED_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("P3 quickstart contract", () => {
  it("publishes server instructions in initialize", async () => {
    const { client } = await makeClient();
    const instructions = client.getInstructions() ?? "";
    expect(instructions.length).toBeGreaterThan(0);
    for (const needle of ["lease_acquire", "lease_release", "NEVER start a per-session server", "debug_detach"]) {
      expect(instructions, `instructions mention ${needle}`).toContain(needle);
    }
  });

  it("lists exactly the ONE quickstart resource", async () => {
    const { client } = await makeClient();
    const listed = await client.listResources();
    expect(listed.resources.map((r) => r.uri)).toEqual([QUICKSTART_URI]);
  });

  it("reads the quickstart body with all 8 agent rules + 3 chains", async () => {
    const { client } = await makeClient();
    const res = await client.readResource({ uri: QUICKSTART_URI });
    const text = res.contents
      .map((c) => ((c as { text?: string }).text ?? ""))
      .join("\n");
    // 8 rules from docs/agents.md (condensed): one shared daemon, session_id, tickets, holder, heartbeat, release, proxy/stop, debug session.
    for (const needle of [
      "Never start a per-session server",
      "session_id",
      "queue_status",
      "holder-mismatch",
      "lease_heartbeat",
      "lease_release",
      "net_proxy_stop",
      "stream_stop",
      "One debug session per lease",
      "debug_detach",
    ]) {
      expect(text, `quickstart covers ${needle}`).toContain(needle);
    }
    // 3 grounded chains.
    for (const needle of [
      "Chain A",
      "Chain B",
      "Chain C",
      "ui_describe",
      "ui_tap",
      "net_proxy_start",
      "net_assert_flow",
      "debug_attach",
      "debug_break",
      "debug_continue",
      "debug_locals",
    ]) {
      expect(text, `quickstart covers ${needle}`).toContain(needle);
    }
  });

  it("lists exactly the 3 grounded prompts with grounded required args", async () => {
    const { client } = await makeClient();
    const listed = await client.listPrompts();
    expect(listed.prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
    const byName = new Map(listed.prompts.map((p) => [p.name, p]));
    const requiredOf = (name: string): string[] =>
      (byName.get(name)?.arguments ?? []).filter((a) => a.required === true).map((a) => a.name).sort();
    expect(requiredOf("ios-debug-session")).toEqual(["bundle_id", "file", "line"]);
    expect(requiredOf("proxy-tamper")).toEqual(["lease_id", "url_regex"]);
    expect(requiredOf("log-triage")).toEqual(["udid"]);
  });

  it("getPrompt ios-debug-session with and without optional args returns grounded tool names", async () => {
    const { client } = await makeClient();
    const full = promptText(
      await client.getPrompt({
        name: "ios-debug-session",
        arguments: { lease_id: "L1", bundle_id: "com.example.App", file: "a.swift", line: "42" },
      }),
    );
    const requiredOnly = promptText(
      await client.getPrompt({
        name: "ios-debug-session",
        arguments: { bundle_id: "com.example.App", file: "a.swift", line: "42" },
      }),
    );
    for (const text of [full, requiredOnly]) {
      for (const needle of ["com.example.App", "a.swift", "42", "debug_attach", "debug_break", "debug_continue", "debug_locals", "debug_detach", "lease_acquire"]) {
        expect(text, `ios-debug-session mentions ${needle}`).toContain(needle);
      }
    }
  });

  it("getPrompt proxy-tamper with and without optional args returns grounded tool names", async () => {
    const { client } = await makeClient();
    const full = promptText(
      await client.getPrompt({
        name: "proxy-tamper",
        arguments: { lease_id: "L1", url_regex: "api/v1", file: "/tmp/f.json" },
      }),
    );
    const requiredOnly = promptText(
      await client.getPrompt({
        name: "proxy-tamper",
        arguments: { lease_id: "L1", url_regex: "api/v1" },
      }),
    );
    for (const text of [full, requiredOnly]) {
      for (const needle of ["api/v1", "net_proxy_start", "net_assert_flow", "net_proxy_stop"]) {
        expect(text, `proxy-tamper mentions ${needle}`).toContain(needle);
      }
    }
  });

  it("getPrompt log-triage with and without optional args returns grounded tool names", async () => {
    const { client } = await makeClient();
    const full = promptText(
      await client.getPrompt({
        name: "log-triage",
        arguments: { udid: "U1", process: "MyApp", last: "10m", timeout_sec: "10" },
      }),
    );
    const requiredOnly = promptText(
      await client.getPrompt({ name: "log-triage", arguments: { udid: "U1" } }),
    );
    for (const text of [full, requiredOnly]) {
      for (const needle of ["U1", "sim_log_show", "sim_log_stream"]) {
        expect(text, `log-triage mentions ${needle}`).toContain(needle);
      }
    }
  });

  it("keeps tools/list at exactly 70 (additive-only guard)", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(70);
  });

  it("P3 measurement seam: resource+prompt reads append kind-tagged lines; tool lines stay exactly {t,tool,ok}", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p3-tc-"));
    process.env.SIM_MCP_TOOLCALLS = "1";
    process.env.SIM_MCP_TOOLCALLS_FILE = path.join(dir, "toolcalls.jsonl");
    const { client } = await makeClient();
    await client.callTool({ name: "pool_status", arguments: {} });
    await client.readResource({ uri: QUICKSTART_URI });
    await client.getPrompt({ name: "log-triage", arguments: { udid: "U1" } });
    const lines = fs
      .readFileSync(process.env.SIM_MCP_TOOLCALLS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    const toolLine = lines.find((l) => l.tool === "pool_status");
    expect(Object.keys(toolLine ?? {}).sort()).toEqual(["ok", "t", "tool"]);
    const kinds = new Set(lines.map((l) => l.kind).filter((k) => k !== undefined));
    expect(kinds).toEqual(new Set(["resource", "prompt"]));
  });
});
