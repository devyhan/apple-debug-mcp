import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createMcpServer } from "../src/server.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, Simslim, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import type { UiDriver } from "../src/uidriver.js";
import { XCTrace } from "../src/xctrace.js";
import type { Runner } from "../src/exec.js";

/** P4 contract: pool_status router copy, lease_acquire minimal path, ui_triage composite; tools/list 71. */

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const STUB_AX = JSON.stringify({ type: "Application", label: "StubApp", children: [] });

class StubUi implements UiDriver {
  async checkAvailable(): Promise<string> {
    return "stub";
  }
  async describeUi(_udid: string, _point?: { x: number; y: number }): Promise<string> {
    return STUB_AX;
  }
  async tap(): Promise<string> {
    throw new Error("unused");
  }
  async typeText(): Promise<string> {
    throw new Error("unused");
  }
  async swipe(): Promise<string> {
    throw new Error("unused");
  }
  async gesture(): Promise<string> {
    throw new Error("unused");
  }
  async button(): Promise<string> {
    throw new Error("unused");
  }
  async screenshot(_udid: string, output: string): Promise<string> {
    fs.writeFileSync(output, Buffer.from(PNG_1X1, "base64"));
    return output;
  }
  async batch(): Promise<string> {
    throw new Error("unused");
  }
}

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p4-")), "state.json");
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
    axe: new StubUi(),
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog({ runner: async () => ({ stdout: "", truncated: false, timedOut: false }) }),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop }),
    lldmdb: new Llmdb({ runner: noop }),
    screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-p4-shots-")),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, orch };
}

function textOf(res: { content: unknown }): Record<string, unknown> {
  const content = res.content as { type: string; text?: string }[];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("P4 pool_status router description", () => {
  it("keeps the original sentence and routes to lease/queue/session tools", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    const pool = listed.tools.find((t) => t.name === "pool_status");
    const desc = pool?.description ?? "";
    expect(desc).toContain(
      "WHEN you want to list, show, or check the status of simulators and devices, see who holds what lease, or check the wait-queue depth.",
    );
    for (const needle of ["Route from here", "lease_acquire", "queue_status", "sessions_list", "lease_list"]) {
      expect(desc, `pool_status routes via ${needle}`).toContain(needle);
    }
  });
});

describe("P4 lease_acquire minimal path", () => {
  it("acquires with session_id omitted (anonymous fallback on transports without a session)", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "lease_acquire", arguments: {} });
    expect(res.isError, JSON.stringify(textOf(res))).not.toBe(true);
    const body = textOf(res);
    expect(body["ok"]).toBe(true);
    const lease = body["lease"] as Record<string, unknown>;
    expect(lease["leaseId"]).toEqual(expect.any(String));
    expect(lease["udid"]).toBe("U1");
    // InMemoryTransport carries no transport session id, so the documented anon- fallback fires.
    expect(lease["sessionId"]).toMatch(/^anon-/);
    expect(body["next"]).toContain("queue_status");
  });

  it("explicit session_id always wins, byte-identical", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: "lease_acquire", arguments: { session_id: "s-explicit" } });
    expect(res.isError).not.toBe(true);
    const body = textOf(res);
    expect((body["lease"] as Record<string, unknown>)["sessionId"]).toBe("s-explicit");
  });

  it("documents the transport default + fallback in the description", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    const acq = listed.tools.find((t) => t.name === "lease_acquire");
    const desc = acq?.description ?? "";
    for (const needle of ["transport session", "explicit", "anon-"]) {
      expect(desc, `lease_acquire documents ${needle}`).toContain(needle);
    }
    // session_id is optional in the schema now (old callers passing it are unaffected).
    const required = (acq?.inputSchema as { required?: string[] })?.required ?? [];
    expect(required).not.toContain("session_id");
    expect(JSON.stringify(acq?.inputSchema)).toContain("session_id");
  });
});

describe("P4 ui_triage composite", () => {
  it("returns describe payload + screenshot path + image block in one call", async () => {
    const { client, orch } = await makeClient();
    const acq = await orch.acquire({ sessionId: "s1", autoBoot: false, slim: false });
    if (!acq.ok || acq.queued) throw new Error("expected lease");
    const res = await client.callTool({ name: "ui_triage", arguments: { lease_id: acq.lease.leaseId } });
    expect(res.isError, JSON.stringify(textOf(res))).not.toBe(true);
    const body = textOf(res);
    // Describe keys byte-identical to ui_describe, plus ui_screenshot's path.
    expect(body["ok"]).toBe(true);
    expect(body["udid"]).toBe("U1");
    expect(body["ui"]).toContain("StubApp");
    expect(body["truncated"]).toBe(false);
    expect(body["format"]).toBe("full");
    expect(body["path"]).toEqual(expect.stringMatching(/\.png$/));
    expect(fs.existsSync(body["path"] as string)).toBe(true);
    const content = res.content as { type: string; mimeType?: string }[];
    expect(content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    // P2 next[] contract holds for the new tool.
    expect(body["next"]).toContain("ui_tap");
  });

  it("meets the P1 description contract (WHEN prefix + grounding + title + annotations)", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    const triage = listed.tools.find((t) => t.name === "ui_triage");
    expect(triage?.title).toBe("Triage screen");
    expect(triage?.description ?? "").toMatch(/^WHEN /);
    expect(triage?.description ?? "").toContain("INSTEAD OF");
    expect((triage?.description ?? "").toLowerCase()).toContain("triage");
    expect(triage?.annotations?.readOnlyHint).toBe(false);
    expect(typeof triage?.annotations?.destructiveHint).toBe("boolean");
    expect(typeof triage?.annotations?.idempotentHint).toBe("boolean");
    expect(typeof triage?.annotations?.openWorldHint).toBe("boolean");
  });
});

describe("P4 tool count + old keys intact", () => {
  it("exposes 71 tools via tools/list", async () => {
    const { client } = await makeClient();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(71);
    expect(listed.tools.map((t) => t.name)).toContain("ui_triage");
  });

  it("keeps old response keys byte-identical", async () => {
    const { client, orch } = await makeClient();
    const pool = textOf(await client.callTool({ name: "pool_status", arguments: {} }));
    expect(pool["ok"]).toBe(true);
    expect(pool["server"]).toBeDefined();
    const acq = await orch.acquire({ sessionId: "s1", autoBoot: false, slim: false });
    if (!acq.ok || acq.queued) throw new Error("expected lease");
    const desc = textOf(await client.callTool({ name: "ui_describe", arguments: { lease_id: acq.lease.leaseId } }));
    expect(Object.keys(desc).sort()).toEqual(["format", "next", "ok", "truncated", "udid", "ui"]);
    const shot = textOf(await client.callTool({ name: "ui_screenshot", arguments: { lease_id: acq.lease.leaseId } }));
    expect(Object.keys(shot).sort()).toEqual(["next", "ok", "path", "udid"]);
    // Explicit-session release still works (ownership path unchanged).
    const rel = textOf(
      await client.callTool({ name: "lease_release", arguments: { lease_id: acq.lease.leaseId, session_id: "s1" } }),
    );
    expect(rel["ok"]).toBe(true);
  });
});
