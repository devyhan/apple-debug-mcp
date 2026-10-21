import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError, Runner } from "../src/exec.js";
import { registerDeviceExtras } from "../src/extras.js";
import { Llmdb } from "../src/llmdb.js";
import {
  MitmChild,
  NetProxy,
  WaitReadyFn,
  buildAddon,
  parseFlowLog,
} from "../src/netproxy.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import { XCTrace } from "../src/xctrace.js";

const LIST_SERVICES = "An asterisk (*) denotes that a network service is disabled.\nSvcA\nSvcB\n";
const GET_ON = "Enabled: Yes\nServer: 10.0.0.1\nPort: 8080\nAuthenticated Proxy Enabled: 0\n";
const GET_OFF = "Enabled: No\nServer: 127.0.0.1\nPort: 9090\nAuthenticated Proxy Enabled: 0\n";

function stubRunner(): Runner {
  return (async (bin: string, args: string[]) => {
    if (bin === "networksetup" && args[0] === "-listallnetworkservices") return { stdout: LIST_SERVICES, stderr: "" };
    if (bin === "networksetup" && (args[0] === "-getwebproxy" || args[0] === "-getsecurewebproxy")) {
      return { stdout: args[1] === "SvcA" ? GET_ON : GET_OFF, stderr: "" };
    }
    if (bin === "xcrun") return { stdout: "", stderr: "" };
    if (bin === "sudo") return { stdout: "", stderr: "" };
    throw new ExecError(bin, args, 1, "", "unexpected");
  }) as Runner;
}

class StubChild {
  readonly pid: number;
  exitCode: number | null = null;
  private handlers = new Map<string, (...args: never[]) => void>();
  constructor(pid: number) {
    this.pid = pid;
  }
  kill(): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.handlers.get("exit")?.();
    });
    return true;
  }
  once(event: string, cb: (...args: never[]) => void): void {
    this.handlers.set(event, cb);
  }
}

const immediateReady: WaitReadyFn = async () => {};

function makeProxy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-assertflow-"));
  const caPem = path.join(dir, "mitmproxy-ca-cert.pem");
  fs.writeFileSync(caPem, "fake-ca");
  const workDir = path.join(dir, "work");
  let n = 0;
  const proxy = new NetProxy({
    runner: stubRunner(),
    spawnFn: () => new StubChild(7000 + n++) as unknown as MitmChild,
    caPemPath: caPem,
    workDir,
    portBase: 46700,
    waitReady: immediateReady,
  });
  return { proxy, workDir };
}

/** Seconds-epoch float safely after any assert start in this test (rows predate the call otherwise). */
function freshTs(): number {
  return Date.now() / 1000 + 30;
}

function writeRows(flowLogPath: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(flowLogPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("P2 ts watermark", () => {
  it("does not match pre-call (stale) flows under the default since:'call'", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    writeRows(flowLogPath, [
      { ts: 1, method: "GET", url: "https://example.com/a" },
      { ts: 2, method: "POST", url: "https://example.com/b" },
      { ts: 3, method: "GET", url: "https://other.test/c" },
    ]);
    await expect(
      proxy.assertFlow("l1", { urlRegex: "example\\.com", timeoutSec: 0 }),
    ).resolves.toMatchObject({ count: 0, total: 3, newSinceCall: 0, matched: [] });
    await proxy.stopProxy("l1");
  });

  it("matches new flows and reports new_since_call on timeout", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    writeRows(flowLogPath, [
      { ts: 1, method: "GET", url: "https://stale.test/old" },
      { ts: freshTs(), method: "GET", url: "https://fresh.test/new" },
    ]);
    await expect(proxy.assertFlow("l1", { urlRegex: "fresh\\.test", timeoutSec: 0 })).resolves.toMatchObject({
      count: 1,
      total: 2,
      newSinceCall: 1,
    });
    // Timeout with unrelated new traffic: nothing matched, but something new arrived.
    await expect(proxy.assertFlow("l1", { urlRegex: "missing\\.test", timeoutSec: 0 })).resolves.toMatchObject({
      count: 0,
      total: 2,
      newSinceCall: 1,
      matched: [],
    });
    await proxy.stopProxy("l1");
  });

  it("matches stale flows when since:'run' opts out of the watermark", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    writeRows(flowLogPath, [
      { ts: 1, method: "GET", url: "https://example.com/a" },
      { ts: 2, method: "POST", url: "https://example.com/b" },
    ]);
    await expect(
      proxy.assertFlow("l1", { urlRegex: "example\\.com", since: "run", timeoutSec: 0 }),
    ).resolves.toMatchObject({ count: 2, total: 2 });
    await proxy.stopProxy("l1");
  });
});

describe("P2 generation watermark", () => {
  it("embeds the generation in the addon and stamps each row", () => {
    const addon = buildAddon([], { flowLogPath: "/tmp/f.jsonl", generation: 3 });
    expect(addon).toContain("GEN = 3");
    expect(parseFlowLog('{"ts": 1, "method": "GET", "url": "https://x/", "gen": 3}\n')).toEqual([
      { ts: 1, method: "GET", url: "https://x/", gen: 3 },
    ]);
    // Mistyped gen is ignored (tolerant parsing).
    expect(parseFlowLog('{"ts": 1, "method": "GET", "url": "https://x/", "gen": "3"}\n')).toEqual([
      { ts: 1, method: "GET", url: "https://x/" },
    ]);
  });

  it("does not match pre-set_rules flows even when their ts is fresh", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    // Logged under generation 0 with a fresh ts (ts watermark alone would pass).
    writeRows(flowLogPath, [{ ts: freshTs(), method: "GET", url: "https://example.com/a", gen: 0 }]);
    await proxy.setProxyRules("l1", [{ action: { delay_ms: 1 } }]);
    expect(fs.readFileSync(proxy.proxyStatus().addonPath!, "utf8")).toContain("GEN = 1");
    await expect(proxy.assertFlow("l1", { urlRegex: "example\\.com", timeoutSec: 0 })).resolves.toMatchObject({
      count: 0,
      total: 1,
      newSinceCall: 0,
    });
    // since:'run' opts out of the generation filter too.
    await expect(
      proxy.assertFlow("l1", { urlRegex: "example\\.com", since: "run", timeoutSec: 0 }),
    ).resolves.toMatchObject({ count: 1, total: 1 });
    await proxy.stopProxy("l1");
  });

  it("matches fresh rows stamped with the current generation (or no gen)", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    writeRows(flowLogPath, [
      { ts: freshTs(), method: "GET", url: "https://example.com/stamped", gen: 0 },
      { ts: freshTs(), method: "GET", url: "https://example.com/unstamped" },
    ]);
    await expect(proxy.assertFlow("l1", { urlRegex: "example\\.com", timeoutSec: 0 })).resolves.toMatchObject({
      count: 2,
      total: 2,
      newSinceCall: 2,
    });
    await proxy.stopProxy("l1");
  });
});

describe("P2 response-side assertions", () => {
  async function correlatedFixture() {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    const ts = freshTs();
    writeRows(flowLogPath, [
      { ts, method: "GET", url: "https://example.com/a", phase: "request", flow_id: "f1", gen: 0 },
      {
        ts, method: "GET", url: "https://example.com/a", phase: "response", flow_id: "f1", gen: 0,
        status_code: 418, resp_bytes: 100, content_type: "text/plain",
        matched_rule: 2, applied: ["status", "body"], rewritten: true, resp_body: "tampered payload",
      },
      { ts, method: "POST", url: "https://example.com/b", phase: "request", flow_id: "f2", gen: 0 },
      {
        ts, method: "POST", url: "https://example.com/b", phase: "response", flow_id: "f2", gen: 0,
        status_code: 200, resp_bytes: 8, content_type: "text/plain",
        matched_rule: null, applied: [], rewritten: false,
      },
      // In-flight: request row with no response row yet.
      { ts, method: "GET", url: "https://example.com/pending", phase: "request", flow_id: "f3", gen: 0 },
    ]);
    return { proxy, flowLogPath };
  }

  it("filters on status, min_bytes, body_regex, rewritten, and rule", async () => {
    const { proxy } = await correlatedFixture();
    const base = { urlRegex: "example\\.com", timeoutSec: 0 } as const;
    await expect(proxy.assertFlow("l1", { ...base, status: 418 })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, status: 200 })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, minBytes: 50 })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, minBytes: 8 })).resolves.toMatchObject({ count: 2 });
    await expect(proxy.assertFlow("l1", { ...base, bodyRegex: "tampered pay" })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, bodyRegex: "absent-body" })).resolves.toMatchObject({ count: 0 });
    await expect(proxy.assertFlow("l1", { ...base, rewritten: true })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, rewritten: false })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, rule: 2 })).resolves.toMatchObject({ count: 1 });
    await expect(proxy.assertFlow("l1", { ...base, rule: 0 })).resolves.toMatchObject({ count: 0 });
    // Combined filters AND.
    await expect(proxy.assertFlow("l1", { ...base, status: 418, rule: 0 })).resolves.toMatchObject({ count: 0 });
    await expect(proxy.assertFlow("l1", { ...base, status: 418, rewritten: true })).resolves.toMatchObject({
      count: 1,
    });
    // Without response-side filters the in-flight flow still counts once (behavior preserved).
    await expect(proxy.assertFlow("l1", base)).resolves.toMatchObject({ count: 3, total: 3 });
    await proxy.stopProxy("l1");
  });

  it("returns merged request/response views in matched", async () => {
    const { proxy } = await correlatedFixture();
    const res = await proxy.assertFlow("l1", { urlRegex: "example\\.com/a", status: 418, timeoutSec: 0 });
    expect(res.count).toBe(1);
    expect(res.matched).toMatchObject([
      { method: "GET", url: "https://example.com/a", statusCode: 418, respBytes: 100, rewritten: true, matchedRule: 2 },
    ]);
    await proxy.stopProxy("l1");
  });

  it("requires a correlated response row when response-side filters are present", async () => {
    const { proxy } = await correlatedFixture();
    // f3 has no response row: response assertions must not match it, even rewritten:false.
    await expect(
      proxy.assertFlow("l1", { urlRegex: "pending", rewritten: false, timeoutSec: 0 }),
    ).resolves.toMatchObject({ count: 0 });
    await expect(proxy.assertFlow("l1", { urlRegex: "pending", timeoutSec: 0 })).resolves.toMatchObject({ count: 1 });
    await proxy.stopProxy("l1");
  });

  it("exposes the P2 params at the tool layer with new_since_call in and out", async () => {
    const { proxy } = makeProxy();
    const orch = new Orchestrator(new FakeFleet(), Store.load(tmpState()), { defaultTtlMs: 60_000, proxy });
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
    const acquired = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
    if (!acquired.ok || acquired.queued) throw new Error("expected a lease");
    const leaseId = acquired.lease.leaseId;
    await client.callTool({ name: "net_proxy_start", arguments: { lease_id: leaseId, rules: [] } });
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    const ts = freshTs();
    writeRows(flowLogPath, [
      { ts, method: "GET", url: "https://example.com/a", phase: "request", flow_id: "f1", gen: 0 },
      {
        ts, method: "GET", url: "https://example.com/a", phase: "response", flow_id: "f1", gen: 0,
        status_code: 418, resp_bytes: 100, matched_rule: 0, applied: ["status"], rewritten: true,
      },
    ]);
    const hit = await toolCall(client, "net_assert_flow", {
      lease_id: leaseId, url_regex: "example\\.com", status: 418, rewritten: true, rule: 0, timeout_sec: 0,
    });
    expect(hit.json).toMatchObject({ ok: true, count: 1, total: 1, new_since_call: 1 });
    const miss = await toolCall(client, "net_assert_flow", {
      lease_id: leaseId, url_regex: "example\\.com", status: 200, timeout_sec: 0,
    });
    expect(miss.isError).toBe(true);
    expect(JSON.stringify(miss.json)).toMatch(/saw 0 matching flow\(s\).*1 new since call/);
    const badBody = await toolCallRaw(client, "net_assert_flow", {
      lease_id: leaseId, url_regex: "x", body_regex: "(unclosed",
    });
    expect(badBody.isError).toBe(true);
    expect(badBody.text).toMatch(/regular expression/);
    await client.callTool({ name: "net_proxy_stop", arguments: { lease_id: leaseId } });
  });

  it("validates the new spec fields without throwing on the tool path shape", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    await expect(proxy.assertFlow("l1", { urlRegex: "x", since: "bogus" as never })).rejects.toThrow(/since/);
    await expect(proxy.assertFlow("l1", { urlRegex: "x", status: 99 })).rejects.toThrow(/status/);
    await expect(proxy.assertFlow("l1", { urlRegex: "x", minBytes: -1 })).rejects.toThrow(/min_bytes/);
    await expect(proxy.assertFlow("l1", { urlRegex: "x", bodyRegex: "(unclosed" })).rejects.toThrow(/regular expression/);
    await expect(proxy.assertFlow("l1", { urlRegex: "x", rewritten: "yes" as never })).rejects.toThrow(/rewritten/);
    await expect(proxy.assertFlow("l1", { urlRegex: "x", rule: -1 })).rejects.toThrow(/rule/);
    await proxy.stopProxy("l1");
  });
});

class FakeFleet implements FleetOps {
  private readonly dev: SimDevice = {
    udid: "U1", name: "iPhone 17", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default",
  };
  async list(): Promise<SimDevice[]> {
    return [{ ...this.dev }];
  }
  async boot(): Promise<void> {}
  async slimStatus(udid: string): Promise<SlimStatus | null> {
    if (udid !== this.dev.udid) return null;
    return { slim: false, managedDisabled: 0, managedTotal: 168, persistent: true, raw: {} };
  }
  async slimNoReboot(): Promise<void> {}
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-assertflow-test-")), "state.json");
}

async function toolCall(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

async function toolCallRaw(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  return { isError: result.isError === true, text: (result.content.find((c) => c.type === "text")?.text ?? "") as string };
}
