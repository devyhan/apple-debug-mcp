import fs from "node:fs";
import net from "node:net";
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
  NetProxyRule,
  NetProxyStatus,
  ProxyBusyError,
  ProxyOps,
  QUIC_BLOCK_ANCHOR,
  WaitReadyFn,
  buildAddon,
  buildQuicBlockRules,
  makeTcpWaitReady,
  normalizeRules,
  parseFlowLog,
  parsePfEnableToken,
  parsePfEnabled,
  parseProxyState,
  parseServicesList,
} from "../src/netproxy.js";
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
  private handlers = new Map<string, (...args: any[]) => void>();

  constructor(pid: number) {
    this.pid = pid;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.exitCode = signal === "SIGKILL" ? 137 : 0;
      this.emit("exit", this.exitCode);
    });
    return true;
  }

  once(event: string, cb: (...args: any[]) => void): void {
    this.handlers.set(event, cb);
  }

  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.(...args);
  }
}

/** Proven fixture: SvcA sits behind a corporate proxy (on), SvcB is off with a 9090 leftover. */
const LIST_SERVICES = "An asterisk (*) denotes that a network service is disabled.\nSvcA\nSvcB\n";
const GET_ON = "Enabled: Yes\nServer: 10.0.0.1\nPort: 8080\nAuthenticated Proxy Enabled: 0\n";
const GET_OFF = "Enabled: No\nServer: 127.0.0.1\nPort: 9090\nAuthenticated Proxy Enabled: 0\n";

function proxyHandler(cells: { sudoFails: boolean }) {
  return (bin: string, args: string[]): { stdout: string; stderr: string } => {
    if (bin === "networksetup" && args[0] === "-listallnetworkservices") return { stdout: LIST_SERVICES, stderr: "" };
    if (bin === "networksetup" && (args[0] === "-getwebproxy" || args[0] === "-getsecurewebproxy")) {
      return { stdout: args[1] === "SvcA" ? GET_ON : GET_OFF, stderr: "" };
    }
    if (bin === "xcrun") return { stdout: "", stderr: "" }; // keychain add-root-cert: empty, exit 0
    if (bin === "sudo") {
      if (cells.sudoFails) throw new ExecError("sudo", args, 1, "", "sudo: a password is required");
      return { stdout: "", stderr: "" };
    }
    if (bin === "mitmdump" && args[0] === "--version") return { stdout: "Mitmproxy: 12.1.1\n", stderr: "" };
    throw new Error(`unexpected ${bin} ${args.join(" ")}`);
  };
}

const immediateReady: WaitReadyFn = async () => {};

function makeProxy(cells: { sudoFails: boolean } = { sudoFails: false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-netproxy-"));
  const caPem = path.join(dir, "mitmproxy-ca-cert.pem");
  fs.writeFileSync(caPem, "fake-ca");
  const workDir = path.join(dir, "work");
  const run = stubRunner(proxyHandler(cells));
  const children: StubChild[] = [];
  const spawns: { bin: string; args: string[] }[] = [];
  const spawnFn = (bin: string, args: string[]): MitmChild => {
    const child = new StubChild(4242 + children.length);
    children.push(child);
    spawns.push({ bin, args });
    return child as unknown as MitmChild;
  };
  const proxy = new NetProxy({
    runner: run,
    spawnFn,
    caPemPath: caPem,
    workDir,
    portBase: 45500,
    waitReady: immediateReady,
  });
  return { proxy, run, children, spawns, dir, caPem, workDir };
}

const RULES: NetProxyRule[] = [
  {
    match: { url_regex: "example\\.com", method: "get" },
    action: { status: 200, headers: { "X-T": "v" }, body: "hi", delay_ms: 5 },
  },
];

describe("normalizeRules", () => {
  it("accepts an empty array and uppercases methods", () => {
    expect(normalizeRules([])).toEqual([]);
    expect(normalizeRules(RULES)).toEqual([
      {
        match: { url_regex: "example\\.com", method: "GET" },
        action: { status: 200, headers: { "X-T": "v" }, body: "hi", delay_ms: 5 },
      },
    ]);
  });

  it("accepts a rule without match (match-all) and single-field actions", () => {
    expect(normalizeRules([{ action: { delay_ms: 0 } }])).toEqual([{ action: { delay_ms: 0 } }]);
    expect(normalizeRules([{ match: {}, action: { body: "" } }])).toEqual([{ match: {}, action: { body: "" } }]);
  });

  it("rejects non-arrays and oversized arrays", () => {
    expect(() => normalizeRules({})).toThrow(/expected an array/);
    expect(() => normalizeRules("nope")).toThrow(/expected an array/);
    expect(() => normalizeRules(new Array(51).fill({ action: { delay_ms: 1 } }))).toThrow(/too many rules/i);
  });

  it("rejects malformed matches", () => {
    expect(() => normalizeRules([{ match: "(x", action: { delay_ms: 1 } }])).toThrow(/match.*expected \{url_regex/);
    expect(() => normalizeRules([{ match: { url_regex: "" }, action: { delay_ms: 1 } }])).toThrow(/url_regex/);
    expect(() => normalizeRules([{ match: { url_regex: "(unclosed" }, action: { delay_ms: 1 } }])).toThrow(
      /not a valid regular expression/,
    );
    expect(() => normalizeRules([{ match: { method: "" }, action: { delay_ms: 1 } }])).toThrow(/method/);
    expect(() => normalizeRules([{ match: { method: 7 }, action: { delay_ms: 1 } }])).toThrow(/method/);
  });

  it("rejects malformed actions", () => {
    expect(() => normalizeRules([{ action: {} }])).toThrow(/at least one of/);
    expect(() => normalizeRules([{ match: {}, action: undefined }])).toThrow(/action/);
    expect(() => normalizeRules([{ action: { status: 99 } }])).toThrow(/status.*100\.\.599/);
    expect(() => normalizeRules([{ action: { status: 600 } }])).toThrow(/status/);
    expect(() => normalizeRules([{ action: { status: 200.5 } }])).toThrow(/status/);
    expect(() => normalizeRules([{ action: { delay_ms: -1 } }])).toThrow(/delay_ms/);
    expect(() => normalizeRules([{ action: { delay_ms: 60001 } }])).toThrow(/delay_ms/);
    expect(() => normalizeRules([{ action: { headers: [] } }])).toThrow(/headers/);
    expect(() => normalizeRules([{ action: { headers: { "": "v" } } }])).toThrow(/non-empty/);
    expect(() => normalizeRules([{ action: { headers: { X: 7 } } }])).toThrow(/string value/);
    expect(() => normalizeRules([{ action: { body: 7 } }])).toThrow(/body/);
  });

  it("accepts request-direction rewrites and uppercases the method", () => {
    expect(
      normalizeRules([
        {
          match: { url_regex: "api\\.example\\.com" },
          action: { request: { method: "post", url: "https://api.example.com/v2", headers: { "X-A": "b" }, body: "{}" } },
        },
      ]),
    ).toEqual([
      {
        match: { url_regex: "api\\.example\\.com" },
        action: {
          request: { method: "POST", url: "https://api.example.com/v2", headers: { "X-A": "b" }, body: "{}" },
        },
      },
    ]);
  });

  it("rejects malformed request rewrites", () => {
    expect(() => normalizeRules([{ action: { request: {} } }])).toThrow(/request.*at least one of/);
    expect(() => normalizeRules([{ action: { request: [] } }])).toThrow(/request/);
    expect(() => normalizeRules([{ action: { request: { method: "" } } }])).toThrow(/request\.method/);
    expect(() => normalizeRules([{ action: { request: { url: "not-a-url" } } }])).toThrow(/request\.url/);
    expect(() => normalizeRules([{ action: { request: { url: "ftp://x/y" } } }])).toThrow(/http\(s\)/);
    expect(() => normalizeRules([{ action: { request: { headers: { "": "v" } } } }])).toThrow(/non-empty/);
    expect(() => normalizeRules([{ action: { request: { body: 7 } } }])).toThrow(/request\.body/);
  });

  it("accepts map_local for an existing regular file and rejects the rest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-map-"));
    const file = path.join(dir, "body.json");
    fs.writeFileSync(file, "{}");
    expect(normalizeRules([{ match: { url_regex: "x" }, action: { map_local: file } }])).toEqual([
      { match: { url_regex: "x" }, action: { map_local: file } },
    ]);
    expect(() => normalizeRules([{ action: { map_local: "" } }])).toThrow(/map_local/);
    expect(() => normalizeRules([{ action: { map_local: path.join(dir, "missing.json") } }])).toThrow(/not found or unreadable/);
    expect(() => normalizeRules([{ action: { map_local: dir } }])).toThrow(/not a regular file/);
  });

  it("accepts map_remote for absolute http(s) URLs and rejects the rest", () => {
    expect(normalizeRules([{ action: { map_remote: "https://staging.example.com/api" } }])).toEqual([
      { action: { map_remote: "https://staging.example.com/api" } },
    ]);
    expect(() => normalizeRules([{ action: { map_remote: "" } }])).toThrow(/map_remote/);
    expect(() => normalizeRules([{ action: { map_remote: "not-a-url" } }])).toThrow(/http\(s\)/);
    expect(() => normalizeRules([{ action: { map_remote: "ftp://x/y" } }])).toThrow(/http\(s\)/);
  });

  it("rejects map_local and map_remote on the same rule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-map-"));
    const file = path.join(dir, "body.json");
    fs.writeFileSync(file, "{}");
    expect(() =>
      normalizeRules([{ action: { map_local: file, map_remote: "https://example.com" } }]),
    ).toThrow(/mutually exclusive/);
  });
});

describe("buildAddon", () => {
  const tricky: NetProxyRule[] = [
    {
      match: { url_regex: "ex(ample)?\\.com/\"q\"\\?a='''x'''", method: "POST" },
      action: { status: 418, headers: { "X-Q": 'a"b\ncüd' }, body: 'line1\nline2 """triple""" ü', delay_ms: 250 },
    },
  ];

  it("embeds rules so they round-trip through the double encoding", () => {
    const addon = buildAddon(normalizeRules(tricky));
    const match = /RULES = json\.loads\((.*)\)\n/.exec(addon);
    expect(match?.[1]).toBeDefined();
    const decoded = JSON.parse(JSON.parse(match![1]!) as string) as NetProxyRule[];
    expect(decoded).toEqual(normalizeRules(tricky));
  });

  it("implements first-match-wins with upstream mutation semantics", () => {
    const addon = buildAddon(normalizeRules(RULES));
    expect(addon).toContain("re.search(pat, flow.request.pretty_url)");
    expect(addon).toContain("flow.request.method != method");
    expect(addon).toContain("time.sleep(delay / 1000.0)");
    expect(addon).toContain("resp.status_code = int(");
    expect(addon).toContain("resp.content = body");
    expect(addon).toContain('resp.headers.pop("content-encoding", None)');
    expect(addon).toContain('resp.headers["content-length"]');
    // First match wins: _find returns the first matching rule.
    expect(addon).toContain("return rule");
    expect(addon).toContain("example");
  });

  it("logs every request to the flow log and rewrites requests before forwarding", () => {
    const addon = buildAddon([], { flowLogPath: "/tmp/flow-1.jsonl" });
    expect(addon).toContain('FLOW_LOG = "/tmp/flow-1.jsonl"');
    expect(addon).toContain("_log(flow)");
    expect(addon).toContain('"method": flow.request.method');
    expect(addon).toContain("flow.request.method = req[");
    expect(addon).toContain("flow.request.url = req[");
    expect(addon).toContain("flow.request.headers[k] = v");
    expect(addon).toContain("flow.request.content = body");
    const bare = buildAddon([]);
    expect(bare).toContain("FLOW_LOG = None");
  });

  it("serves map_local files and rewrites map_remote URLs in the request hook", () => {
    const addon = buildAddon([]);
    expect(addon).toContain("from mitmproxy import http");
    expect(addon).toContain('flow.request.url = action["map_remote"]');
    expect(addon).toContain('open(action["map_local"], "rb")');
    expect(addon).toContain("http.Response.make(200, content)");
    expect(addon).toContain("http.Response.make(502,");
  });

  it("round-trips request/map rules through the double encoding", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-map-"));
    const file = path.join(dir, "body.json");
    fs.writeFileSync(file, "{}");
    const rules = normalizeRules([
      { match: { url_regex: "a" }, action: { request: { method: "put", body: "x" }, delay_ms: 1 } },
      { match: { url_regex: "b" }, action: { map_local: file } },
      { action: { map_remote: "https://staging.example.com/" } },
    ]);
    const addon = buildAddon(rules, { flowLogPath: "/tmp/f.jsonl" });
    const match = /RULES = json\.loads\((.*)\)\n/.exec(addon);
    const decoded = JSON.parse(JSON.parse(match![1]!) as string) as NetProxyRule[];
    expect(decoded).toEqual(rules);
  });
});

describe("parseFlowLog", () => {
  it("parses JSONL rows and skips torn or malformed lines", () => {
    const text = [
      '{"ts": 1.5, "method": "GET", "url": "https://example.com/a"}',
      '{"ts": 2.5, "method": "POST", "url": "https://example.com/b"}',
      "",
      '{"ts": 3.5, "method": "GET", "url": "https://example.com/c',
      "not json",
      '{"method": "GET"}',
    ].join("\n");
    expect(parseFlowLog(text)).toEqual([
      { ts: 1.5, method: "GET", url: "https://example.com/a" },
      { ts: 2.5, method: "POST", url: "https://example.com/b" },
    ]);
    expect(parseFlowLog("")).toEqual([]);
  });
});

describe("proxy state parsing", () => {
  it("parses the services list, skipping the header and disabled markers", () => {
    expect(parseServicesList("An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*USB LAN\n\n")).toEqual([
      "Wi-Fi",
      "USB LAN",
    ]);
  });

  it("parses getwebproxy output and tolerates missing fields", () => {
    expect(parseProxyState(GET_ON)).toEqual({ enabled: true, server: "10.0.0.1", port: 8080 });
    expect(parseProxyState(GET_OFF)).toEqual({ enabled: false, server: "127.0.0.1", port: 9090 });
    expect(parseProxyState("")).toEqual({ enabled: false, server: "", port: 0 });
  });
});

describe("NetProxy lifecycle (stubbed)", () => {
  it("reports the version from checkAvailable", async () => {
    const { proxy, run } = makeProxy();
    await expect(proxy.checkAvailable()).resolves.toContain("12.1.1");
    expect(run.calls[0]).toMatchObject({ bin: "mitmdump", args: ["--version"] });
  });

  it("rejects invalid rules before touching anything", async () => {
    const { proxy, run, spawns } = makeProxy();
    await expect(proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, [{ action: { status: 99 } }])).rejects.toThrow(
      /status.*100\.\.599/,
    );
    expect(run.calls).toHaveLength(0);
    expect(spawns).toHaveLength(0);
    expect(proxy.proxyStatus()).toEqual({ running: false });
  });

  it("refuses to start when the mitm CA is missing", async () => {
    const { run, spawns, workDir } = makeProxy();
    const proxy = new NetProxy({
      runner: run,
      spawnFn: () => {
        throw new Error("must not spawn");
      },
      caPemPath: path.join(workDir, "nope.pem"),
      workDir,
      portBase: 45500,
      waitReady: immediateReady,
    });
    await expect(proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, [])).rejects.toThrow(/mitm CA not found/);
    expect(run.calls).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("starts mitmdump, installs the CA, then toggles the host proxy last", async () => {
    const { proxy, run, spawns, caPem } = makeProxy();
    const { port, pid } = await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    expect(port).toBeGreaterThanOrEqual(45500);
    expect(pid).toBe(4242);

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.bin).toBe("mitmdump");
    const addonPath = spawns[0]!.args[3]!;
    expect(spawns[0]?.args.slice(0, 3)).toEqual(["-p", String(port), "-s"]);
    const addon = fs.readFileSync(addonPath, "utf8");
    expect(addon).toContain("example");
    expect(addon).toContain("GET"); // method normalized before embedding

    const keychain = run.calls.findIndex((c) => c.bin === "xcrun");
    expect(run.calls[keychain]).toMatchObject({
      bin: "xcrun",
      args: ["simctl", "keychain", "U1", "add-root-cert", caPem],
    });
    const sudoCalls = run.calls.filter((c) => c.bin === "sudo");
    expect(sudoCalls).toHaveLength(8); // 2 services x (web + secure) x (server + state)
    expect(sudoCalls[0]?.args).toEqual(["-n", "networksetup", "-setwebproxy", "SvcA", "127.0.0.1", String(port)]);
    expect(sudoCalls[1]?.args).toEqual(["-n", "networksetup", "-setsecurewebproxy", "SvcA", "127.0.0.1", String(port)]);
    expect(sudoCalls[2]?.args).toEqual(["-n", "networksetup", "-setwebproxystate", "SvcA", "on"]);
    expect(sudoCalls[3]?.args).toEqual(["-n", "networksetup", "-setsecurewebproxystate", "SvcA", "on"]);
    expect(run.calls.findIndex((c) => c.bin === "sudo")).toBeGreaterThan(keychain);

    expect(proxy.proxyStatus()).toMatchObject({
      running: true,
      port,
      pid: 4242,
      leaseId: "lease_1",
      sessionId: "sess-1",
      udid: "U1",
      ruleCount: 1,
      addonPath,
    });
  });

  it("is idempotent for the holding lease and busy for anyone else", async () => {
    const { proxy, run, spawns } = makeProxy();
    const first = await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    const sudoCount = run.calls.filter((c) => c.bin === "sudo").length;
    const again = await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    expect(again).toEqual(first);
    expect(spawns).toHaveLength(1);
    expect(run.calls.filter((c) => c.bin === "sudo")).toHaveLength(sudoCount);

    const err = await proxy
      .startProxy("U2", { leaseId: "lease_2", sessionId: "sess-2" }, [])
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(ProxyBusyError);
    expect(err?.message).toMatch(/sess-1/);
    expect(err?.message).toMatch(/lease_1/);
    expect(err?.message).toMatch(/global/);
  });

  it("restarts the child on set_rules without touching the host proxy", async () => {
    const { proxy, run, children, spawns } = makeProxy();
    const { port } = await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    const sudoCount = run.calls.filter((c) => c.bin === "sudo").length;
    const addonPath = proxy.proxyStatus().addonPath!;

    const next: NetProxyRule[] = [{ match: { method: "post" }, action: { body: "mock" } }];
    await proxy.setProxyRules("lease_1", next);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args).toEqual(["-p", String(port), "-s", addonPath]);
    expect(children[0]?.kills).toContain("SIGTERM");
    expect(run.calls.filter((c) => c.bin === "sudo")).toHaveLength(sudoCount);
    expect(fs.readFileSync(addonPath, "utf8")).toContain("POST");
    expect(proxy.proxyStatus()).toMatchObject({ running: true, port, ruleCount: 1 });
  });

  it("validates set_rules before rewriting anything", async () => {
    const { proxy, spawns } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    const addonPath = proxy.proxyStatus().addonPath!;
    const before = fs.readFileSync(addonPath, "utf8");
    await expect(proxy.setProxyRules("lease_1", [{ action: {} }])).rejects.toThrow(/at least one of/);
    expect(spawns).toHaveLength(1);
    expect(fs.readFileSync(addonPath, "utf8")).toBe(before);
  });

  it("requires a running holder-owned proxy for set_rules", async () => {
    const { proxy } = makeProxy();
    await expect(proxy.setProxyRules("lease_1", [])).rejects.toThrow(/no network proxy is running/i);
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    await expect(proxy.setProxyRules("lease_2", [])).rejects.toThrow(ProxyBusyError);
    await expect(proxy.setProxyRules("lease_2", [])).rejects.toThrow(/sess-1/);
  });

  it("creates an empty flow log on start and reports its path in status", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    const status = proxy.proxyStatus();
    expect(status.flowLogPath).toMatch(/flow-\d+\.jsonl$/);
    expect(fs.readFileSync(status.flowLogPath!, "utf8")).toBe("");
    expect(fs.readFileSync(status.addonPath!, "utf8")).toContain(`FLOW_LOG = ${JSON.stringify(status.flowLogPath)}`);
    await proxy.stopProxy("lease_1");
    expect(fs.existsSync(status.flowLogPath!)).toBe(false);
    expect(fs.existsSync(status.addonPath!)).toBe(false);
  });

  it("reads rules only for the holder and returns a copy", async () => {
    const { proxy } = makeProxy();
    expect(() => proxy.proxyRules("lease_1")).toThrow(/no network proxy is running/i);
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    expect(() => proxy.proxyRules("lease_2")).toThrow(ProxyBusyError);
    const rules = proxy.proxyRules("lease_1");
    expect(rules).toEqual([{ match: { url_regex: "example\\.com", method: "GET" }, action: RULES[0]!.action }]);
    rules.push({ action: { delay_ms: 1 } });
    expect(proxy.proxyRules("lease_1")).toHaveLength(1);
  });

  it("upserts map rules: prepend, replace-in-place, validation before holder check", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-map-"));
    const fileA = path.join(dir, "a.json");
    const fileB = path.join(dir, "b.json");
    fs.writeFileSync(fileA, "{}");
    fs.writeFileSync(fileB, "{}");
    const { proxy, spawns } = makeProxy();
    // Invalid rules fail even with no proxy running (validation runs first).
    await expect(
      proxy.upsertMapRule("lease_1", { match: { url_regex: "x" }, action: { map_local: path.join(dir, "nope.json") } }),
    ).rejects.toThrow(/not found or unreadable/);
    await expect(proxy.upsertMapRule("lease_1", { action: { delay_ms: 1 } })).rejects.toThrow(/map_local or map_remote/);
    await expect(
      proxy.upsertMapRule("lease_1", { match: { url_regex: "x" }, action: { map_local: fileA } }),
    ).rejects.toThrow(/no network proxy is running/i);

    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    await expect(
      proxy.upsertMapRule("lease_2", { match: { url_regex: "x" }, action: { map_local: fileA } }),
    ).rejects.toThrow(ProxyBusyError);

    await expect(
      proxy.upsertMapRule("lease_1", { match: { url_regex: "cdn\\.example\\.com" }, action: { map_local: fileA } }),
    ).resolves.toBe(2);
    expect(spawns).toHaveLength(2); // child restarted on the same port
    let rules = proxy.proxyRules("lease_1");
    expect(rules[0]).toEqual({ match: { url_regex: "cdn\\.example\\.com" }, action: { map_local: fileA } });
    expect(rules).toHaveLength(2);

    // Same pattern + same kind replaces in place (no growth); other kinds prepend.
    await expect(
      proxy.upsertMapRule("lease_1", { match: { url_regex: "cdn\\.example\\.com" }, action: { map_local: fileB } }),
    ).resolves.toBe(2);
    rules = proxy.proxyRules("lease_1");
    expect(rules[0]?.action).toEqual({ map_local: fileB });
    await expect(
      proxy.upsertMapRule("lease_1", {
        match: { url_regex: "cdn\\.example\\.com" },
        action: { map_remote: "https://staging.example.com/" },
      }),
    ).resolves.toBe(3);
    expect(proxy.proxyRules("lease_1")[0]?.action).toEqual({ map_remote: "https://staging.example.com/" });
  });

  it("refuses map upserts past the rule cap", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    await proxy.setProxyRules("lease_1", new Array(50).fill({ action: { delay_ms: 1 } }));
    await expect(
      proxy.upsertMapRule("lease_1", { match: { url_regex: "x" }, action: { map_remote: "https://example.com/" } }),
    ).rejects.toThrow(/too many rules/i);
  });

  it("asserts flows from the flow log with method filtering and min_count", async () => {
    const { proxy } = makeProxy();
    await expect(proxy.assertFlow("lease_1", { urlRegex: "x" })).rejects.toThrow(/no network proxy is running/i);
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    await expect(proxy.assertFlow("lease_2", { urlRegex: "x" })).rejects.toThrow(ProxyBusyError);
    await expect(proxy.assertFlow("lease_1", { urlRegex: "(unclosed" })).rejects.toThrow(/regular expression/);
    await expect(proxy.assertFlow("lease_1", { urlRegex: "x", minCount: 0 })).rejects.toThrow(/min_count/);
    await expect(proxy.assertFlow("lease_1", { urlRegex: "x", timeoutSec: 121 })).rejects.toThrow(/timeout_sec/);

    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    fs.writeFileSync(
      flowLogPath,
      [
        JSON.stringify({ ts: 1, method: "GET", url: "https://example.com/a" }),
        JSON.stringify({ ts: 2, method: "POST", url: "https://example.com/b" }),
        JSON.stringify({ ts: 3, method: "GET", url: "https://other.test/c" }),
      ].join("\n") + "\n",
    );
    await expect(proxy.assertFlow("lease_1", { urlRegex: "example\\.com", timeoutSec: 0 })).resolves.toMatchObject({
      count: 2,
      total: 3,
    });
    const post = await proxy.assertFlow("lease_1", { urlRegex: "example\\.com", method: "post", timeoutSec: 0 });
    expect(post.count).toBe(1);
    expect(post.matched).toEqual([{ ts: 2, method: "POST", url: "https://example.com/b" }]);
    await expect(
      proxy.assertFlow("lease_1", { urlRegex: "missing\\.test", minCount: 2, timeoutSec: 0 }),
    ).resolves.toMatchObject({ count: 0, total: 3 });
  });

  it("assertFlow polls until a late flow arrives", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    setTimeout(() => {
      fs.appendFileSync(flowLogPath, JSON.stringify({ ts: 1, method: "GET", url: "https://late.test/x" }) + "\n");
    }, 100);
    const res = await proxy.assertFlow("lease_1", { urlRegex: "late\\.test", timeoutSec: 5 });
    expect(res).toMatchObject({ count: 1, total: 1 });
  });

  it("restores the snapshot on stop, including an originally-on corporate proxy", async () => {
    const { proxy, run, children } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, RULES);
    const addonPath = proxy.proxyStatus().addonPath!;
    const before = run.calls.length;

    await expect(proxy.stopProxy("lease_1")).resolves.toEqual({ stopped: true });
    const restores = run.calls.slice(before).filter((c) => c.bin === "sudo");
    const args = restores.map((c) => c.args.slice(2));
    // SvcA: corporate server/port back, then state back on (http + https).
    expect(args).toContainEqual(["-setwebproxy", "SvcA", "10.0.0.1", "8080"]);
    expect(args).toContainEqual(["-setwebproxystate", "SvcA", "on"]);
    expect(args).toContainEqual(["-setsecurewebproxy", "SvcA", "10.0.0.1", "8080"]);
    expect(args).toContainEqual(["-setsecurewebproxystate", "SvcA", "on"]);
    // SvcB: leftovers restored, state stays off.
    expect(args).toContainEqual(["-setwebproxy", "SvcB", "127.0.0.1", "9090"]);
    expect(args).toContainEqual(["-setwebproxystate", "SvcB", "off"]);
    expect(args).toContainEqual(["-setsecurewebproxystate", "SvcB", "off"]);
    expect(children[0]?.kills).toContain("SIGTERM");
    expect(fs.existsSync(addonPath)).toBe(false);
    expect(proxy.proxyStatus()).toEqual({ running: false });

    await expect(proxy.stopProxy("lease_1")).resolves.toEqual({ stopped: false });
    expect(run.calls).toHaveLength(before + restores.length);
  });

  it("refuses stop by a non-holder without stopping", async () => {
    const { proxy } = makeProxy();
    await expect(proxy.stopProxy("lease_1")).resolves.toEqual({ stopped: false });
    await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    await expect(proxy.stopProxy("lease_2")).rejects.toThrow(ProxyBusyError);
    await expect(proxy.stopProxy("lease_2")).rejects.toThrow(/sess-1/);
    expect(proxy.proxyStatus().running).toBe(true);
    await expect(proxy.forceStop()).resolves.toEqual({ stopped: true });
    expect(proxy.proxyStatus().running).toBe(false);
  });

  it("rolls back (kill + restore) when the host toggle fails, with a sudoers hint", async () => {
    const cells = { sudoFails: true };
    const { proxy, run, children } = makeProxy(cells);
    const err = await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/failed to enable the host proxy/i);
    expect(err?.message).toMatch(/passwordless sudo/);
    expect(children[0]?.kills.length).toBeGreaterThan(0);
    // Restore was attempted (toggles back off) even though sudo fails throughout.
    expect(run.calls.filter((c) => c.bin === "sudo").length).toBeGreaterThan(1);
    expect(proxy.proxyStatus()).toEqual({ running: false });

    // The failure cleared all state: a later start works once sudo is provisioned.
    cells.sudoFails = false;
    const { port } = await proxy.startProxy("U1", { leaseId: "lease_1", sessionId: "sess-1" }, []);
    expect(port).toBeGreaterThanOrEqual(45500);
  });

  it("surfaces the install hint when mitmdump cannot spawn", async () => {
    const { dir, run, caPem, workDir } = makeProxy();
    const child = new StubChild(4242);
    const proxy = new NetProxy({
      runner: run,
      spawnFn: () => {
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn mitmdump ENOENT"), { code: "ENOENT" })));
        return child as unknown as MitmChild;
      },
      caPemPath: caPem,
      workDir: path.join(dir, "work2"),
      portBase: 45600,
      waitReady: async (_port, getSpawnError) => {
        await new Promise((r) => setTimeout(r, 10));
        const err = getSpawnError?.();
        if (err) throw err;
      },
    });
    await expect(proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, [])).rejects.toThrow(
      /mitmdump is not installed/,
    );
    expect(workDir).toBeDefined();
  });
});

describe("makeTcpWaitReady", () => {
  it("resolves once the port accepts connections", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await makeTcpWaitReady(2000)(port);
    } finally {
      server.close();
    }
  });

  it("rejects after the timeout when nothing listens", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(makeTcpWaitReady(300)(port)).rejects.toThrow(/did not accept connections/);
  });

  it("fails fast on a spawn error without waiting for the timeout", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const boom = new Error("spawn mitmdump ENOENT");
    await expect(makeTcpWaitReady(10_000)(port, () => boom)).rejects.toBe(boom);
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
  async slimStatus(udid: string): Promise<SlimStatus | null> {
    if (!this.booted.has(udid)) return null;
    return { slim: false, managedDisabled: 0, managedTotal: 168, persistent: true, raw: {} };
  }
  async slimNoReboot(_udid: string): Promise<void> {}
}

function sim(udid: string): SimDevice {
  return { udid, name: "iPhone 17", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" };
}

class FakeProxy implements ProxyOps {
  holder: { leaseId: string; sessionId: string; udid: string } | null = null;
  rules: NetProxyRule[] = [];
  stops: string[] = [];
  blockQuicSeen: (boolean | undefined)[] = [];
  quicBlocked = false;
  failStop = false;

  async startProxy(
    udid: string,
    holder: { leaseId: string; sessionId: string },
    rules: NetProxyRule[],
    opts?: { blockQuic?: boolean },
  ): Promise<{ port: number; pid?: number }> {
    if (this.holder && this.holder.leaseId !== holder.leaseId) {
      throw new ProxyBusyError({ ...this.holder, port: 3240 }, "start");
    }
    this.blockQuicSeen.push(opts?.blockQuic);
    if (!this.holder) {
      this.holder = { ...holder, udid };
      this.quicBlocked = opts?.blockQuic === true;
    }
    this.rules = rules;
    return { port: 3240, pid: 99 };
  }

  async setProxyRules(leaseId: string, rules: NetProxyRule[]): Promise<void> {
    if (!this.holder) throw new Error("No network proxy is running; call net_proxy_start first.");
    if (this.holder.leaseId !== leaseId) throw new ProxyBusyError({ ...this.holder, port: 3240 }, "set rules");
    this.rules = rules;
  }

  async stopProxy(leaseId: string): Promise<{ stopped: boolean }> {
    if (!this.holder) return { stopped: false };
    if (this.holder.leaseId !== leaseId) throw new ProxyBusyError({ ...this.holder, port: 3240 }, "stop");
    this.stops.push(leaseId);
    this.holder = null;
    this.quicBlocked = false;
    if (this.failStop) throw new Error("stop exploded");
    return { stopped: true };
  }

  proxyStatus(): NetProxyStatus {
    if (!this.holder) return { running: false };
    return {
      running: true,
      port: 3240,
      pid: 99,
      leaseId: this.holder.leaseId,
      sessionId: this.holder.sessionId,
      udid: this.holder.udid,
      ruleCount: this.rules.length,
      quicBlocked: this.quicBlocked,
    };
  }

  proxyRules(leaseId: string): NetProxyRule[] {
    if (!this.holder) throw new Error("No network proxy is running; call net_proxy_start first.");
    if (this.holder.leaseId !== leaseId) throw new ProxyBusyError({ ...this.holder, port: 3240 }, "read rules");
    return structuredClone(this.rules);
  }

  async assertFlow(
    leaseId: string,
    spec: { urlRegex: string; method?: string; minCount?: number; timeoutSec?: number },
  ): Promise<{ count: number; total: number; matched: { ts: number; method: string; url: string }[] }> {
    if (!this.holder) throw new Error("No network proxy is running; call net_proxy_start first.");
    if (this.holder.leaseId !== leaseId) throw new ProxyBusyError({ ...this.holder, port: 3240 }, "assert flow");
    void spec;
    return { count: 0, total: 0, matched: [] };
  }

  async upsertMapRule(leaseId: string, rule: NetProxyRule): Promise<number> {
    if (!this.holder) throw new Error("No network proxy is running; call net_proxy_start first.");
    if (this.holder.leaseId !== leaseId) throw new ProxyBusyError({ ...this.holder, port: 3240 }, "set map rule");
    this.rules.unshift(rule);
    return this.rules.length;
  }
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-netproxy-test-")), "state.json");
}

async function twoLeases(proxy?: ProxyOps) {
  const orch = new Orchestrator(new FakeFleet([sim("U1"), sim("U2")]), Store.load(tmpState()), {
    defaultTtlMs: 60_000,
    ...(proxy ? { proxy } : {}),
  });
  const a = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
  const b = await orch.acquire({ sessionId: "sess-b", client: "t", autoBoot: false });
  if (!a.ok || a.queued || !b.ok || b.queued) throw new Error("expected two leases");
  return { orch, a: a.lease, b: b.lease };
}

describe("orchestrator proxy binding", () => {
  it("round-trips start -> status (with holder) -> set_rules -> stop", async () => {
    const fake = new FakeProxy();
    const { orch, a } = await twoLeases(fake);
    const started = await orch.startLeaseProxy(a.leaseId, RULES);
    expect(started.port).toBe(3240);
    const status = await orch.leaseProxyStatus(a.leaseId);
    expect(status).toMatchObject({ running: true, leaseId: a.leaseId, sessionId: "sess-a", ruleCount: 1 });
    await orch.setLeaseProxyRules(a.leaseId, []);
    expect(fake.rules).toEqual([]);
    await expect(orch.stopLeaseProxy(a.leaseId)).resolves.toMatchObject({ stopped: true });
    await expect(orch.stopLeaseProxy(a.leaseId)).resolves.toMatchObject({ stopped: false });
    await expect(orch.leaseProxyStatus(a.leaseId)).resolves.toMatchObject({ running: false });
  });

  it("rejects a second concurrent holder with the holding session named", async () => {
    const { orch, a, b } = await twoLeases(new FakeProxy());
    await orch.startLeaseProxy(a.leaseId, []);
    await expect(orch.startLeaseProxy(b.leaseId, [])).rejects.toThrow(/sess-a/);
    await expect(orch.startLeaseProxy(b.leaseId, [])).rejects.toThrow(new RegExp(a.leaseId));
    await expect(orch.setLeaseProxyRules(b.leaseId, [])).rejects.toThrow(/sess-a/);
    await expect(orch.stopLeaseProxy(b.leaseId)).rejects.toThrow(/sess-a/);
    // The other lease may still view the global status.
    await expect(orch.leaseProxyStatus(b.leaseId)).resolves.toMatchObject({ running: true, sessionId: "sess-a" });
  });

  it("rejects unknown leases and an unconfigured proxy", async () => {
    const { orch } = await twoLeases(new FakeProxy());
    await expect(orch.startLeaseProxy("lease_nope", [])).rejects.toThrow(/unknown lease/i);
    await expect(orch.setLeaseProxyRules("lease_nope", [])).rejects.toThrow(/unknown lease/i);
    await expect(orch.stopLeaseProxy("lease_nope")).rejects.toThrow(/unknown lease/i);
    await expect(orch.leaseProxyStatus("lease_nope")).rejects.toThrow(/unknown lease/i);

    const bare = await twoLeases();
    await expect(bare.orch.startLeaseProxy(bare.a.leaseId, [])).rejects.toThrow(/no proxy is configured/);
    await expect(bare.orch.setLeaseProxyRules(bare.a.leaseId, [])).rejects.toThrow(/no proxy is configured/);
    await expect(bare.orch.stopLeaseProxy(bare.a.leaseId)).resolves.toMatchObject({ stopped: false });
    await expect(bare.orch.leaseProxyStatus(bare.a.leaseId)).resolves.toMatchObject({ running: false });
  });

  it("binds assertFlow and upsertMapRule with lease + holder gating", async () => {
    const fake = new FakeProxy();
    const { orch, a, b } = await twoLeases(fake);
    await expect(orch.assertLeaseFlow("lease_nope", { urlRegex: "x" })).rejects.toThrow(/unknown lease/i);
    await expect(orch.upsertLeaseMapRule("lease_nope", { action: { delay_ms: 1 } })).rejects.toThrow(/unknown lease/i);
    const bare = await twoLeases();
    await expect(bare.orch.assertLeaseFlow(bare.a.leaseId, { urlRegex: "x" })).rejects.toThrow(/no proxy is configured/);
    await expect(bare.orch.upsertLeaseMapRule(bare.a.leaseId, { action: { delay_ms: 1 } })).rejects.toThrow(
      /no proxy is configured/,
    );

    await orch.startLeaseProxy(a.leaseId, []);
    await expect(orch.assertLeaseFlow(b.leaseId, { urlRegex: "x" })).rejects.toThrow(/sess-a/);
    await expect(orch.upsertLeaseMapRule(b.leaseId, { action: { delay_ms: 1 } })).rejects.toThrow(/sess-a/);
    await expect(orch.assertLeaseFlow(a.leaseId, { urlRegex: "x" })).resolves.toMatchObject({ count: 0, total: 0 });
    const rule = { match: { url_regex: "x" }, action: { map_remote: "https://example.com/" } };
    await expect(orch.upsertLeaseMapRule(a.leaseId, rule)).resolves.toMatchObject({ ruleCount: 1 });
    expect(fake.rules[0]).toEqual(rule);
  });

  it("stops the holder's proxy on release but leaves other holders running", async () => {
    const fake = new FakeProxy();
    const { orch, a, b } = await twoLeases(fake);
    await orch.startLeaseProxy(a.leaseId, []);
    // Releasing a non-holder lease leaves the proxy running.
    await orch.release(b.leaseId, "sess-b");
    expect(fake.holder?.leaseId).toBe(a.leaseId);
    // Releasing the holder stops it (and never fails the release).
    const res = await orch.release(a.leaseId, "sess-a");
    expect(res.released).toBe(a.leaseId);
    expect(fake.stops).toEqual([a.leaseId]);
    expect(fake.holder).toBeNull();
  });

  it("never fails release when the proxy stop explodes", async () => {
    const fake = new FakeProxy();
    fake.failStop = true;
    const { orch, a } = await twoLeases(fake);
    await orch.startLeaseProxy(a.leaseId, []);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => {
      errors.push(msg);
    };
    try {
      await expect(orch.release(a.leaseId, "sess-a")).resolves.toMatchObject({ released: a.leaseId });
    } finally {
      console.error = orig;
    }
    expect(errors.some((m) => /failed to stop network proxy/i.test(m))).toBe(true);
  });

  it("stops the expired holder's proxy on sweep", async () => {
    const fake = new FakeProxy();
    const fleet = new FakeFleet([sim("U1")]);
    const store = Store.load(tmpState());
    const orch = new Orchestrator(fleet, store, { defaultTtlMs: 60_000, proxy: fake });
    const res = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await orch.startLeaseProxy(res.lease.leaseId, []);
    await store.mutate((s) => {
      const rec = s.leases.find((l) => l.leaseId === res.lease.leaseId);
      if (rec) rec.lastHeartbeat = Date.now() - 120_000;
      return { value: undefined, dirty: true };
    });
    const swept = await orch.sweepStale();
    expect(swept.swept).toEqual([res.lease.leaseId]);
    expect(fake.holder).toBeNull();
    expect(fake.stops).toEqual([res.lease.leaseId]);
  });

  it("releases the proxy when resolveLease drops an expired lease", async () => {
    const fake = new FakeProxy();
    const store = Store.load(tmpState());
    const orch = new Orchestrator(new FakeFleet([sim("U1")]), store, { defaultTtlMs: 60_000, proxy: fake });
    const res = await orch.acquire({ sessionId: "sess-a", client: "t", autoBoot: false });
    if (!res.ok || res.queued) throw new Error("expected lease");
    await orch.startLeaseProxy(res.lease.leaseId, []);
    await store.mutate((s) => {
      const rec = s.leases.find((l) => l.leaseId === res.lease.leaseId);
      if (rec) rec.lastHeartbeat = Date.now() - 120_000;
      return { value: undefined, dirty: true };
    });
    await expect(orch.resolveLease(res.lease.leaseId)).rejects.toThrow(/expired/);
    expect(fake.holder).toBeNull();
  });
});

async function makeToolClient() {
  const fake = new FakeProxy();
  const orch = new Orchestrator(new FakeFleet([sim("U1"), sim("U2")]), Store.load(tmpState()), {
    defaultTtlMs: 60_000,
    proxy: fake,
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
  const b = await orch.acquire({ sessionId: "sess-b", client: "t", autoBoot: false });
  if (!a.ok || a.queued || !b.ok || b.queued) throw new Error("expected two leases");
  return { client, orch, fake, a: a.lease, b: b.lease };
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text as string) as Record<string, unknown> };
}

async function callRaw(client: Client, tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args });
  return { isError: result.isError === true, text: (result.content.find((c) => c.type === "text")?.text ?? "") as string };
}

describe("net_proxy_* tools", () => {
  it("registers all four tools with object input schemas", async () => {
    const { client } = await makeToolClient();
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const name of ["net_proxy_start", "net_proxy_set_rules", "net_proxy_stop", "net_proxy_status"]) {
      expect(names).toContain(name);
    }
    const start = listed.tools.find((t) => t.name === "net_proxy_start");
    expect(start?.inputSchema).toMatchObject({ type: "object" });
    expect(JSON.stringify(start?.inputSchema)).toContain("url_regex");
  });

  it("round-trips start -> status -> set_rules -> stop and logs actions", async () => {
    const { client, orch, a } = await makeToolClient();
    const stopped = await call(client, "net_proxy_status", { lease_id: a.leaseId });
    expect(stopped.json).toMatchObject({ ok: true, running: false });

    const start = await call(client, "net_proxy_start", {
      lease_id: a.leaseId,
      rules: [{ match: { url_regex: "example\\.com", method: "get" }, action: { delay_ms: 10 } }],
    });
    expect(start.json).toMatchObject({ ok: true, port: 3240, rule_count: 1 });

    const running = await call(client, "net_proxy_status", { lease_id: a.leaseId });
    expect(running.json).toMatchObject({
      ok: true,
      running: true,
      port: 3240,
      holder_lease_id: a.leaseId,
      holder_session_id: "sess-a",
      rule_count: 1,
    });

    const set = await call(client, "net_proxy_set_rules", { lease_id: a.leaseId, rules: [] });
    expect(set.json).toMatchObject({ ok: true, rule_count: 0 });

    const stop = await call(client, "net_proxy_stop", { lease_id: a.leaseId });
    expect(stop.json).toMatchObject({ ok: true, stopped: true });
    const stop2 = await call(client, "net_proxy_stop", { lease_id: a.leaseId });
    expect(stop2.json).toMatchObject({ ok: true, stopped: false });

    const tools = orch.leaseActions(a.leaseId).map((e) => e.tool);
    expect(tools).toEqual(["net_proxy_start", "net_proxy_set_rules", "net_proxy_stop", "net_proxy_stop"]);
  });

  it("gates every tool on a valid lease and names the holder on conflict", async () => {
    const { client, a, b } = await makeToolClient();
    for (const [tool, args] of [
      ["net_proxy_start", {}],
      ["net_proxy_set_rules", { rules: [] }],
      ["net_proxy_stop", {}],
      ["net_proxy_status", {}],
    ] as const) {
      const res = await call(client, tool, { lease_id: "lease_nope", ...args });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.json)).toMatch(/unknown lease/i);
    }

    await call(client, "net_proxy_start", { lease_id: a.leaseId });
    const conflict = await call(client, "net_proxy_start", { lease_id: b.leaseId });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.json)).toMatch(/sess-a/);
    const conflictStop = await call(client, "net_proxy_stop", { lease_id: b.leaseId });
    expect(conflictStop.isError).toBe(true);
    expect(JSON.stringify(conflictStop.json)).toMatch(/sess-a/);
  });

  it("rejects invalid rules with validation errors (before any proxy work)", async () => {
    const { client, fake, a } = await makeToolClient();
    const badStatus = await callRaw(client, "net_proxy_start", {
      lease_id: a.leaseId,
      rules: [{ action: { status: 99 } }],
    });
    expect(badStatus.isError).toBe(true);
    expect(badStatus.text).toMatch(/status|599/i);

    const badRegex = await callRaw(client, "net_proxy_set_rules", {
      lease_id: a.leaseId,
      rules: [{ match: { url_regex: "(unclosed" }, action: { delay_ms: 1 } }],
    });
    expect(badRegex.isError).toBe(true);
    expect(badRegex.text).toMatch(/regular expression/);

    const emptyAction = await callRaw(client, "net_proxy_start", {
      lease_id: a.leaseId,
      rules: [{ action: {} }],
    });
    expect(emptyAction.isError).toBe(true);
    expect(emptyAction.text).toMatch(/at least one/);

    expect(fake.holder).toBeNull();
  });
});

/** MCP client wired to a REAL NetProxy with every side effect stubbed (runner/spawn/ready). */
async function makeStubbedProxyClient() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-netproxy-mcp-"));
  const caPem = path.join(dir, "mitmproxy-ca-cert.pem");
  fs.writeFileSync(caPem, "fake-ca");
  const bodyFile = path.join(dir, "body.json");
  fs.writeFileSync(bodyFile, '{"mock":true}');
  const workDir = path.join(dir, "work");
  const run = stubRunner(proxyHandler({ sudoFails: false }));
  const children: StubChild[] = [];
  const spawns: { bin: string; args: string[] }[] = [];
  const spawnFn = (bin: string, args: string[]): MitmChild => {
    const child = new StubChild(4242 + children.length);
    children.push(child);
    spawns.push({ bin, args });
    return child as unknown as MitmChild;
  };
  const proxy = new NetProxy({ runner: run, spawnFn, caPemPath: caPem, workDir, portBase: 46700, waitReady: immediateReady });
  const orch = new Orchestrator(new FakeFleet([sim("U1"), sim("U2")]), Store.load(tmpState()), {
    defaultTtlMs: 60_000,
    proxy,
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
  const b = await orch.acquire({ sessionId: "sess-b", client: "t", autoBoot: false });
  if (!a.ok || a.queued || !b.ok || b.queued) throw new Error("expected two leases");
  return { client, orch, proxy, spawns, dir, bodyFile, a: a.lease, b: b.lease };
}

describe("net_assert_flow / map_* tools (stubbed real proxy)", () => {
  it("gates on a valid lease and fails cleanly with no running proxy", async () => {
    const { client, a } = await makeStubbedProxyClient();
    for (const [tool, args] of [
      ["net_assert_flow", { url_regex: "x" }],
      ["map_local", { url_regex: "x", file: "/tmp/x" }],
      ["map_remote", { url_regex: "x", url: "https://example.com/" }],
    ] as const) {
      const gated = await call(client, tool, { lease_id: "lease_nope", ...args });
      expect(gated.isError, tool).toBe(true);
      expect(JSON.stringify(gated.json), tool).toMatch(/unknown lease/i);
    }
    const idle = await call(client, "net_assert_flow", { lease_id: a.leaseId, url_regex: "x", timeout_sec: 0 });
    expect(idle.isError).toBe(true);
    expect(JSON.stringify(idle.json)).toMatch(/no network proxy is running/i);
  });

  it("validates map inputs at the schema layer", async () => {
    const { client, a } = await makeStubbedProxyClient();
    const badRegex = await callRaw(client, "map_local", { lease_id: a.leaseId, url_regex: "(unclosed", file: "/tmp/x" });
    expect(badRegex.isError).toBe(true);
    expect(badRegex.text).toMatch(/regular expression/);
    const badUrl = await callRaw(client, "map_remote", { lease_id: a.leaseId, url_regex: "x", url: "ftp://x/y" });
    expect(badUrl.isError).toBe(true);
    expect(badUrl.text).toMatch(/absolute http/);
    const badAssert = await callRaw(client, "net_assert_flow", { lease_id: a.leaseId, url_regex: "(unclosed" });
    expect(badAssert.isError).toBe(true);
    expect(badAssert.text).toMatch(/regular expression/);
  });

  it("validates the map file before the holder check (no proxy needed)", async () => {
    const { client, a } = await makeStubbedProxyClient();
    const missing = await call(client, "map_local", {
      lease_id: a.leaseId,
      url_regex: "cdn\\.example\\.com",
      file: "/nonexistent/mcp-map-body.json",
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.json)).toMatch(/map_local.*not found or unreadable/);
  });

  it("round-trips start -> map -> assert -> stop and logs actions", async () => {
    const { client, orch, proxy, spawns, bodyFile, a, b } = await makeStubbedProxyClient();
    const start = await call(client, "net_proxy_start", { lease_id: a.leaseId, rules: [] });
    expect(start.json).toMatchObject({ ok: true, rule_count: 0 });

    const status = await call(client, "net_proxy_status", { lease_id: a.leaseId });
    const flowLogPath = status.json.flow_log_path as string;
    expect(typeof flowLogPath).toBe("string");

    // A non-holder can view status but cannot map or assert.
    const conflictMap = await call(client, "map_local", { lease_id: b.leaseId, url_regex: "x", file: bodyFile });
    expect(conflictMap.isError).toBe(true);
    expect(JSON.stringify(conflictMap.json)).toMatch(/sess-a/);
    const conflictAssert = await call(client, "net_assert_flow", { lease_id: b.leaseId, url_regex: "x", timeout_sec: 0 });
    expect(conflictAssert.isError).toBe(true);
    expect(JSON.stringify(conflictAssert.json)).toMatch(/sess-a/);

    const map = await call(client, "map_local", { lease_id: a.leaseId, url_regex: "cdn\\.example\\.com", file: bodyFile });
    expect(map.json).toMatchObject({ ok: true, rule_count: 1 });
    expect(spawns).toHaveLength(2); // map upsert restarts the child on the same port
    const remote = await call(client, "map_remote", {
      lease_id: a.leaseId,
      url_regex: "api\\.example\\.com",
      url: "https://staging.example.com/api",
    });
    expect(remote.json).toMatchObject({ ok: true, rule_count: 2 });
    expect(proxy.proxyRules(a.leaseId)[0]?.action).toEqual({ map_remote: "https://staging.example.com/api" });

    fs.appendFileSync(
      flowLogPath,
      [
        JSON.stringify({ ts: 1, method: "GET", url: "https://cdn.example.com/app.js" }),
        JSON.stringify({ ts: 2, method: "GET", url: "https://cdn.example.com/style.css" }),
        JSON.stringify({ ts: 3, method: "POST", url: "https://api.example.com/submit" }),
      ].join("\n") + "\n",
    );
    const hit = await call(client, "net_assert_flow", { lease_id: a.leaseId, url_regex: "cdn\\.example\\.com" });
    expect(hit.json).toMatchObject({ ok: true, count: 2, total: 3 });
    const miss = await call(client, "net_assert_flow", {
      lease_id: a.leaseId,
      url_regex: "cdn\\.example\\.com",
      min_count: 5,
      timeout_sec: 0,
    });
    expect(miss.isError).toBe(true);
    expect(JSON.stringify(miss.json)).toMatch(/saw 2 matching flow\(s\).*needed 5/);

    const stop = await call(client, "net_proxy_stop", { lease_id: a.leaseId });
    expect(stop.json).toMatchObject({ ok: true, stopped: true });
    expect(fs.existsSync(flowLogPath)).toBe(false);

    const tools = orch.leaseActions(a.leaseId).map((e) => e.tool);
    expect(tools).toEqual(["net_proxy_start", "map_local", "map_remote", "net_assert_flow", "net_proxy_stop"]);
  });
});

describe("net_proxy block_quic wiring", () => {
  it("passes block_quic through tools and reports actual QUIC state", async () => {
    const { client, fake, a } = await makeToolClient();
    const start = await call(client, "net_proxy_start", { lease_id: a.leaseId, block_quic: true });
    expect(start.json).toMatchObject({ ok: true, quic_blocked: true });
    expect(fake.blockQuicSeen).toEqual([true]);

    const status = await call(client, "net_proxy_status", { lease_id: a.leaseId });
    expect(status.json).toMatchObject({ ok: true, running: true, quic_blocked: true });

    // Idempotent re-start ignores new opts: the response must echo ACTUAL
    // state (still blocked), not the new request (block_quic false).
    const again = await call(client, "net_proxy_start", { lease_id: a.leaseId, block_quic: false });
    expect(again.json).toMatchObject({ ok: true, quic_blocked: true });
    expect(fake.blockQuicSeen).toEqual([true, false]);

    await call(client, "net_proxy_stop", { lease_id: a.leaseId });
    const plain = await call(client, "net_proxy_start", { lease_id: a.leaseId });
    expect(plain.json).toMatchObject({ ok: true, quic_blocked: false });
    expect(fake.blockQuicSeen).toEqual([true, false, false]);
    const status2 = await call(client, "net_proxy_status", { lease_id: a.leaseId });
    expect(status2.json).toMatchObject({ ok: true, running: true, quic_blocked: false });
  });
});

describe("quic block helpers", () => {
  it("builds a family-agnostic UDP/443 drop (covers v4 + v6)", () => {
    // Loaded via `pfctl -a <anchor> -f`, so the file holds only the rule.
    expect(buildQuicBlockRules()).toBe("block drop quick proto udp to any port 443\n");
  });

  it("keeps the anchor directly under com.apple/ so stock pf.conf evaluates it", () => {
    // Dots do NOT create PF anchor hierarchy (see man pf.conf): a dotted
    // top-level anchor would load fine yet never be evaluated — a silent
    // no-op no call-sequence stub can catch. Pin the slash form instead.
    expect(QUIC_BLOCK_ANCHOR).toMatch(/^com\.apple\/[A-Za-z0-9_.-]+$/);
  });

  it("parses pfctl -s info status, including real uptime suffixes", () => {
    expect(parsePfEnabled("Status: Enabled for 3 days 01:02:03           Debug: Urgent\n")).toBe(true);
    expect(parsePfEnabled("Status:Enabled\n")).toBe(true);
    expect(parsePfEnabled("  status: enabled  \n")).toBe(true);
    expect(parsePfEnabled("Status: Disabled\n")).toBe(false);
    expect(parsePfEnabled("")).toBe(false);
    expect(parsePfEnabled("no status here")).toBe(false);
  });

  it("parses the pfctl -E enable token", () => {
    expect(parsePfEnableToken("Token : 4242\n")).toBe("4242");
    expect(parsePfEnableToken("Token: 99")).toBe("99");
    expect(() => parsePfEnableToken("")).toThrow(/enable token/);
    expect(() => parsePfEnableToken("Status: Enabled\n")).toThrow(/enable token/);
  });
});

describe("startProxy with blockQuic", () => {
  const anchorPattern = QUIC_BLOCK_ANCHOR.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

  function makeQuicProxy(opts: { pfInfo: string; pfFailOn?: string; failReadyOnCall?: number }) {
    const base = makeProxy();
    const handler = (bin: string, args: string[]) => {
      if (bin === "sudo" && args[1] === "pfctl") {
        const sub = args.slice(2).join(" ");
        if (opts.pfFailOn && sub.startsWith(opts.pfFailOn)) {
          throw new ExecError("sudo", args, 1, "", "pfctl: permission denied");
        }
        if (sub === "-s info") return { stdout: opts.pfInfo, stderr: "" };
        // Mirrors real macOS: the token arrives on stderr, stdout is empty.
        if (sub === "-E") return { stdout: "", stderr: "pf enabled\nToken : 4242\n" };
        return { stdout: "", stderr: "" };
      }
      return proxyHandler({ sudoFails: false })(bin, args);
    };
    const run = stubRunner(handler);
    let readyCalls = 0;
    const waitReady: WaitReadyFn = async () => {
      readyCalls += 1;
      if (opts.failReadyOnCall === readyCalls) throw new Error("mitmdump never became ready");
    };
    const children: StubChild[] = [];
    const proxy = new NetProxy({
      runner: run,
      spawnFn: () => {
        const child = new StubChild(5000 + children.length);
        children.push(child);
        return child as unknown as MitmChild;
      },
      caPemPath: base.caPem,
      workDir: base.workDir,
      portBase: 45600,
      waitReady,
    });
    const pfctlCalls = () =>
      run.calls.filter((c) => c.bin === "sudo" && c.args[1] === "pfctl").map((c) => c.args.slice(2).join(" "));
    const workLeftovers = () => {
      try {
        return fs.readdirSync(base.workDir).filter((f) => f.startsWith("addon-") || f.startsWith("flow-") || f.startsWith("pf-"));
      } catch {
        return []; // Work dir never created: nothing could strand.
      }
    };
    return { proxy, run, pfctlCalls, children, workLeftovers };
  }

  it("enables PF via -E, loads the anchor, and releases the token on stop when PF was off", async () => {
    const { proxy, pfctlCalls } = makeQuicProxy({ pfInfo: "Status: Disabled\n" });
    await proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true });
    expect(proxy.proxyStatus()).toMatchObject({ running: true, quicBlocked: true });

    const pfctl = pfctlCalls();
    expect(pfctl[0]).toBe("-s info");
    expect(pfctl[1]).toBe("-E");
    expect(pfctl[2]).toMatch(new RegExp(`^-a ${anchorPattern} -f \\S+$`));
    // Rules file on disk while running, holding the drop rule.
    const rulesPath = pfctl[2]!.split(" ").pop()!;
    expect(fs.readFileSync(rulesPath, "utf8")).toBe(buildQuicBlockRules());

    await proxy.stopProxy("l1");
    expect(pfctlCalls().slice(3)).toEqual([`-a ${QUIC_BLOCK_ANCHOR} -F all`, "-X 4242"]);
    expect(fs.existsSync(rulesPath)).toBe(false);
    expect(proxy.proxyStatus()).toEqual({ running: false });
  });

  it("flushes only the anchor on stop when PF was already on", async () => {
    const { proxy, pfctlCalls } = makeQuicProxy({ pfInfo: "Status: Enabled for 1 day\n" });
    await proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true });
    const pfctl = pfctlCalls();
    expect(pfctl).toHaveLength(2); // -s info + anchor load, no -E
    expect(pfctl[1]).toMatch(/^-a .* -f \S+$/);
    await proxy.stopProxy("l1");
    expect(pfctlCalls().slice(2)).toEqual([`-a ${QUIC_BLOCK_ANCHOR} -F all`]); // flush only, no -X
  });

  it("rolls everything back when the anchor load fails", async () => {
    const { proxy, run, pfctlCalls, workLeftovers } = makeQuicProxy({ pfInfo: "Status: Disabled\n", pfFailOn: "-a " });
    await expect(proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true })).rejects.toThrow(
      /Failed to block QUIC.*previous state restored/,
    );
    // sudo-flavored failures carry the passwordless-sudo provisioning hint.
    await expect(proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true })).rejects.toThrow(/passwordless sudo/);
    // The anchor flush also fails here, so the message must hedge the restore claim.
    await expect(proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true })).rejects.toThrow(/QUIC cleanup also failed/);
    expect(proxy.proxyStatus()).toEqual({ running: false });
    // Host proxy snapshot restored (services pointed back at 127.0.0.1:port were reverted).
    const sets = run.calls.filter((c) => c.bin === "sudo" && c.args[1] === "networksetup" && c.args[2] === "-setwebproxy");
    expect(sets.length).toBeGreaterThan(0);
    // Our enable reference is released even though the anchor flush also fails.
    const pfctl = pfctlCalls();
    expect(pfctl).toContain("-E");
    expect(pfctl).toContain("-X 4242");
    // No generated files strand in the work dir.
    expect(workLeftovers()).toEqual([]);
  });

  it("fails with a sudoers hint before mutating anything when the PF read is refused", async () => {
    const { proxy, run, pfctlCalls, workLeftovers } = makeQuicProxy({ pfInfo: "Status: Disabled\n", pfFailOn: "-s info" });
    await expect(proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true })).rejects.toThrow(/passwordless sudo/);
    expect(proxy.proxyStatus()).toEqual({ running: false });
    expect(pfctlCalls()).toEqual(["-s info"]);
    // Snapshot reads happened, but no host mutation: no -set* calls at all,
    // and not even the sim keychain write.
    expect(run.calls.some((c) => c.args.some((a) => a.startsWith("-set")))).toBe(false);
    expect(run.calls.some((c) => c.bin === "xcrun")).toBe(false);
    expect(workLeftovers()).toEqual([]);
  });

  it("removes the QUIC block when a rules update kills the proxy", async () => {
    const { proxy, pfctlCalls, children, workLeftovers } = makeQuicProxy({ pfInfo: "Status: Disabled\n", failReadyOnCall: 2 });
    await proxy.startProxy("U1", { leaseId: "l1" }, [], { blockQuic: true });
    await expect(proxy.setProxyRules("l1", [])).rejects.toThrow(/Proxy rules update failed.*proxy was stopped/);
    expect(proxy.proxyStatus()).toEqual({ running: false });
    // Anchor flushed + our enable reference released despite the dead proxy.
    expect(pfctlCalls().slice(3)).toEqual([`-a ${QUIC_BLOCK_ANCHOR} -F all`, "-X 4242"]);
    // The replacement child is stopped (not stranded) and no files strand.
    expect(children).toHaveLength(2);
    expect(children[1]!.kills).toContain("SIGTERM");
    expect(workLeftovers()).toEqual([]);
  });

  it("does not touch pfctl when blockQuic is off", async () => {
    const { proxy, run } = makeQuicProxy({ pfInfo: "Status: Disabled\n" });
    await proxy.startProxy("U1", { leaseId: "l1" }, []);
    expect(proxy.proxyStatus()).toMatchObject({ running: true, quicBlocked: false });
    expect(run.calls.some((c) => c.args.includes("pfctl"))).toBe(false);
    await proxy.stopProxy("l1");
  });
});
