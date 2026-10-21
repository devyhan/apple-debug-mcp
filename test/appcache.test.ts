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

class FakeFleet implements FleetOps {
  constructor(private readonly devs: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devs.map((d) => ({ ...d }));
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

/** Real temp data-container fixture: Caches + must-survive siblings. */
function makeContainer(): { container: string; caches: string } {
  const container = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-appcache-")), "data");
  const caches = path.join(container, "Library", "Caches");
  fs.mkdirSync(path.join(caches, "sub"), { recursive: true });
  fs.writeFileSync(path.join(caches, "a.txt"), "cached");
  fs.writeFileSync(path.join(caches, "sub", "b.txt"), "cached");
  fs.mkdirSync(path.join(container, "Library", "Preferences"), { recursive: true });
  fs.writeFileSync(path.join(container, "Library", "Preferences", "com.example.plist"), "prefs");
  fs.mkdirSync(path.join(container, "Documents"), { recursive: true });
  fs.writeFileSync(path.join(container, "Documents", "keep.txt"), "login-state");
  return { container, caches };
}

function handlerFor(container: string, opts: { terminateFails?: boolean } = {}) {
  return (bin: string, args: string[]) => {
    if (bin === "xcrun" && args[0] === "simctl" && args[1] === "terminate") {
      if (opts.terminateFails) throw new ExecError(bin, args, 1, "", "The app is not running");
      return { stdout: "", stderr: "" };
    }
    if (bin === "xcrun" && args[0] === "simctl" && args[1] === "get_app_container") {
      const bundle = args[3];
      if (bundle === "com.unknown.App") throw new ExecError(bin, args, 1, "", "No such app installed");
      return { stdout: `${container}\n`, stderr: "" };
    }
    if (bin === "plutil") return { stdout: "", stderr: "" };
    throw new Error(`unexpected spawn ${bin} ${args.join(" ")}`);
  };
}

async function makeClient(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }) {
  const run = stubRunner(handler);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-appcache-")), "state.json");
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
  const acquired = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
  if (!acquired.ok || acquired.queued) throw new Error("expected a lease");
  return { client, orch, run, leaseId: acquired.lease.leaseId };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

describe("app_cache_clear", () => {
  it("refuses an empty bundle id without spawning", async () => {
    const { container } = makeContainer();
    const run = stubRunner(handlerFor(container));
    const apps = new SimApps({ runner: run });
    await expect(apps.clearCache("U1", "  ")).rejects.toThrow(/bundle_id/i);
    await expect(apps.clearCache("", "com.example.App")).rejects.toThrow(/udid/i);
    expect(run.calls).toHaveLength(0);
  });

  it("is lease-gated: unknown lease fails without spawning", async () => {
    const { container } = makeContainer();
    const { client, run } = await makeClient(handlerFor(container));
    const res = await call(client, "app_cache_clear", { lease_id: "lease_nope", bundle_id: "com.example.App" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/unknown lease/i);
    expect(run.calls).toHaveLength(0);
  });

  it("refuses an unknown app container and deletes nothing", async () => {
    const { container } = makeContainer();
    const { client, run, leaseId } = await makeClient(handlerFor(container));
    const res = await call(client, "app_cache_clear", { lease_id: leaseId, bundle_id: "com.unknown.App" });
    expect(res.isError).toBe(true);
    expect(String(res.json.error)).toMatch(/no such app|unknown app container/i);
    expect(fs.existsSync(path.join(container, "Library", "Caches", "a.txt"))).toBe(true);
    expect(run.calls.map((c) => c.args[1])).not.toContain("plutil");
  });

  it("terminates first, clears Caches, reports paths/count, spares Documents/Preferences", async () => {
    const { container } = makeContainer();
    const { client, orch, run, leaseId } = await makeClient(handlerFor(container));
    const res = await call(client, "app_cache_clear", { lease_id: leaseId, bundle_id: "com.example.App" });
    expect(res.json).toMatchObject({ ok: true, udid: "U1", bundle_id: "com.example.App", deleted_count: 2 });
    // terminate runs before get_app_container.
    expect(run.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["simctl", "terminate"],
      ["simctl", "get_app_container"],
    ]);
    const deleted = res.json.deleted as string[];
    expect(deleted).toHaveLength(2);
    for (const p of deleted) {
      expect(path.relative(path.join(container, "Library", "Caches"), p).startsWith("..")).toBe(false);
      expect(fs.existsSync(p)).toBe(false);
    }
    // Login-adjacent state survives.
    expect(fs.readFileSync(path.join(container, "Documents", "keep.txt"), "utf8")).toBe("login-state");
    expect(fs.existsSync(path.join(container, "Library", "Preferences", "com.example.plist"))).toBe(true);
    expect(orch.leaseActions(leaseId).map((a) => a.tool)).toContain("app_cache_clear");
  });

  it("proceeds fail-soft when terminate fails (app not running)", async () => {
    const { container } = makeContainer();
    const { client, leaseId } = await makeClient(handlerFor(container, { terminateFails: true }));
    const res = await call(client, "app_cache_clear", { lease_id: leaseId, bundle_id: "com.example.App" });
    expect(res.json).toMatchObject({ ok: true, terminated: false, deleted_count: 2 });
  });

  it("removes only named plist keys via plutil, confined to the container", async () => {
    const { container } = makeContainer();
    const { client, run, leaseId } = await makeClient(handlerFor(container));
    const res = await call(client, "app_cache_clear", {
      lease_id: leaseId,
      bundle_id: "com.example.App",
      plist_keys: [{ plist: "Library/Preferences/com.example.plist", keys: ["ThrottleDate", "Backoff"] }],
    });
    expect(res.json).toMatchObject({ ok: true, deleted_count: 2 });
    expect(res.json.plist_keys_removed).toEqual([
      { plist: path.join(container, "Library", "Preferences", "com.example.plist"), key: "ThrottleDate" },
      { plist: path.join(container, "Library", "Preferences", "com.example.plist"), key: "Backoff" },
    ]);
    const plutils = run.calls.filter((c) => c.bin === "plutil");
    expect(plutils).toHaveLength(2);
    for (const c of plutils) {
      expect(path.relative(container, c.args[2] ?? "").startsWith("..")).toBe(false);
    }
  });

  it("refuses plist targets outside the container, in Documents, or near Keychain", async () => {
    const { container } = makeContainer();
    const run = stubRunner(handlerFor(container));
    const apps = new SimApps({ runner: run });
    for (const plist of [
      "../Documents/evil.plist",
      "/abs/path.plist",
      "Documents/evil.plist",
      "Library/Keychain/x.plist",
      "Library/keychain-backup.plist",
      "Library/Preferences/noext",
    ]) {
      await expect(apps.clearCache("U1", "com.example.App", { plistKeys: [{ plist, keys: ["k"] }] })).rejects.toThrow(
        /plist/i,
      );
    }
    expect(run.calls).toHaveLength(0);
    // Refusal happens before any deletion.
    expect(fs.existsSync(path.join(container, "Library", "Caches", "a.txt"))).toBe(true);
  });

  it("missing Caches dir is ok with count 0 (fail-soft)", async () => {
    const container = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-appcache-")), "data");
    fs.mkdirSync(path.join(container, "Documents"), { recursive: true });
    const { client, leaseId } = await makeClient(handlerFor(container));
    const res = await call(client, "app_cache_clear", { lease_id: leaseId, bundle_id: "com.example.App" });
    expect(res.json).toMatchObject({ ok: true, deleted_count: 0, deleted: [] });
  });
});
