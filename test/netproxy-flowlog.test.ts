import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecError, Runner } from "../src/exec.js";
import {
  FLOW_BODY_CAP_BYTES,
  FLOW_LOG_KEEP_PER_PORT,
  FLOW_LOG_MAX_BYTES,
  MitmChild,
  NetProxy,
  PROXY_CAPTURE_BODIES_ENV,
  WaitReadyFn,
  buildAddon,
  flowLogFileName,
  normalizeRules,
  parseFlowLog,
  proxyCaptureBodiesEnabled,
  rotateFlowLogs,
} from "../src/netproxy.js";

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

function makeProxy(opts: { captureBodies?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-flowlog-"));
  const caPem = path.join(dir, "mitmproxy-ca-cert.pem");
  fs.writeFileSync(caPem, "fake-ca");
  const workDir = path.join(dir, "work");
  let n = 0;
  const proxy = new NetProxy({
    runner: stubRunner(),
    spawnFn: () => new StubChild(6000 + n++) as unknown as MitmChild,
    caPemPath: caPem,
    workDir,
    portBase: 46500,
    waitReady: immediateReady,
    ...(opts.captureBodies !== undefined ? { captureBodies: opts.captureBodies } : {}),
  });
  return { proxy, workDir };
}

describe("P1a addon template", () => {
  it("emits two-phase rows correlated by flow id with method/url/ts fallback", () => {
    const addon = buildAddon([], { flowLogPath: "/tmp/f.jsonl" });
    expect(addon).toContain("def request(flow):");
    expect(addon).toContain("def response(flow):");
    expect(addon).toContain("def error(flow):");
    expect(addon).toContain("flow.id");
    expect(addon).toContain('"phase": "request"');
    expect(addon).toContain('"phase": "response"');
    expect(addon).toContain('"phase": "error"');
    expect(addon).toContain('"method": flow.request.method');
    expect(addon).toContain("flow.request.pretty_url");
  });

  it("returns the matched rule index and logs response metadata", () => {
    const addon = buildAddon(normalizeRules([{ action: { status: 200 } }]));
    expect(addon).toContain("enumerate(RULES)");
    expect(addon).toContain("return i, rule");
    expect(addon).toContain("matched_rule");
    expect(addon).toContain("applied");
    expect(addon).toContain("rewritten");
    expect(addon).toContain("status_code");
    expect(addon).toContain("resp_bytes");
    expect(addon).toContain("content_type");
    expect(addon).toContain("req_bytes");
  });

  it("embeds the header allowlist and denylist", () => {
    const addon = buildAddon([]);
    for (const h of ["content-type", "content-length", "cache-control", "etag", "location"]) {
      expect(addon).toContain(h);
    }
    for (const h of ["authorization", "cookie", "set-cookie", "-token", "-secret"]) {
      expect(addon).toContain(h);
    }
    expect(addon).toContain("redacted");
  });

  it("keeps body capture OFF by default behind a template-embedded flag", () => {
    expect(proxyCaptureBodiesEnabled({})).toBe(false);
    expect(proxyCaptureBodiesEnabled({ [PROXY_CAPTURE_BODIES_ENV]: "1" })).toBe(true);
    expect(proxyCaptureBodiesEnabled({ [PROXY_CAPTURE_BODIES_ENV]: "0" })).toBe(false);
    expect(buildAddon([])).toContain("CAPTURE_BODIES = False");
    expect(buildAddon([], { captureBodies: true })).toContain("CAPTURE_BODIES = True");
    expect(buildAddon([], { captureBodies: false })).toContain("CAPTURE_BODIES = False");
  });

  it("serializes log rows as raw UTF-8 so body_regex matches non-ASCII", () => {
    const addon = buildAddon([]);
    expect(addon.match(/ensure_ascii=False/g)?.length).toBe(2);
  });

  it("caps bodies at 8KB and the flow log at 10MB addon-side", () => {
    expect(FLOW_BODY_CAP_BYTES).toBe(8192);
    expect(FLOW_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    const addon = buildAddon([]);
    expect(addon).toContain("8192");
    expect(addon).toContain("10485760");
    expect(addon).toContain("truncated");
  });
});

describe("P1a parseFlowLog", () => {
  it("still parses old 3-field rows", () => {
    expect(parseFlowLog('{"ts": 1.5, "method": "GET", "url": "https://example.com/a"}\n')).toEqual([
      { ts: 1.5, method: "GET", url: "https://example.com/a" },
    ]);
  });

  it("parses enriched rows and ignores mistyped optional fields", () => {
    const rows = parseFlowLog(
      [
        JSON.stringify({
          ts: 2, method: "GET", url: "https://example.com/a", phase: "response", flow_id: "abc",
          status_code: 418, req_bytes: 10, resp_bytes: 8, content_type: "text/plain",
          matched_rule: 0, applied: ["status", "body"], rewritten: true,
          headers: { "content-type": "text/plain" }, header_names: ["x-a"], redacted_headers: ["cookie"],
          resp_body: "tampered", resp_body_truncated: false, error: "nope",
        }),
        JSON.stringify({
          ts: 3, method: "POST", url: "https://example.com/b", phase: "bogus", flow_id: 7,
          status_code: "418", applied: "status", rewritten: "yes", headers: ["x"], matched_rule: null,
        }),
      ].join("\n") + "\n",
    );
    expect(rows[0]).toMatchObject({
      phase: "response", flowId: "abc", statusCode: 418, reqBytes: 10, respBytes: 8,
      contentType: "text/plain", matchedRule: 0, applied: ["status", "body"], rewritten: true,
      headers: { "content-type": "text/plain" }, headerNames: ["x-a"], redactedHeaders: ["cookie"],
      respBody: "tampered", respBodyTruncated: false, error: "nope",
    });
    expect(rows[1]).toEqual({ ts: 3, method: "POST", url: "https://example.com/b", matchedRule: null });
  });
});

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Drives the generated addon with a stubbed mitmproxy module: request/response/error
// hooks run against fake flows and the resulting JSONL is asserted in TS below.
const ADDON_DRIVER = `
import importlib.util, sys, types

mitmproxy = types.ModuleType("mitmproxy")
http = types.ModuleType("mitmproxy.http")

class Resp:
    def __init__(self, status_code, content, headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = dict(headers or {})
    @staticmethod
    def make(status, content, headers=None):
        if isinstance(content, str):
            content = content.encode("utf-8")
        return Resp(status, content, dict(headers or {}))

http.Response = Resp
mitmproxy.http = http
sys.modules["mitmproxy"] = mitmproxy
sys.modules["mitmproxy.http"] = http

spec = importlib.util.spec_from_file_location("addon", sys.argv[1])
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

class Headers(dict):
    # mitmproxy headers are case-insensitive; mirror that for content-type lookups.
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default

class Req:
    def __init__(self, method, url, headers, content):
        self.method = method
        self.pretty_url = url
        self.url = url
        self.headers = Headers(headers)
        self.content = content

class Flow:
    def __init__(self, fid, req):
        self.id = fid
        self.request = req
        self.response = None
        self.error = None

def run(fid, method, url, headers, content, upstream):
    flow = Flow(fid, Req(method, url, headers, content))
    addon.request(flow)
    if flow.response is None and upstream is not None:
        status, body, hdrs = upstream
        flow.response = Resp(status, body, hdrs)
    if flow.response is not None:
        addon.response(flow)
    return flow

MAP_URL = sys.argv[2]
# Matched response rewrite (rule index 2 in the generating test).
run("f1", "GET", "https://example.com/a",
    {"Authorization": "s3cret", "Content-Type": "text/html", "X-Custom": "1"}, None,
    (200, b"orig", {"content-type": "text/plain"}))
# Unmatched passthrough.
run("f2", "POST", "https://other.test/b", {"Content-Type": "application/octet-stream"}, b"\\x00\\x01",
    (200, b"ok", {"content-type": "text/plain"}))
# map_local serve (rule index 0).
run("f4", "GET", MAP_URL + "/f", {"Accept": "*/*"}, None, None)
# Request-direction rewrite (rule index 1).
run("f5", "GET", "https://example.com/rw", {}, b"{}",
    (200, b"done", {"content-type": "text/plain"}))
# Failed flow: request row + error row, no response row.
flow = Flow("f3", Req("GET", "https://err.test/", {}, None))
addon.request(flow)
flow.error = Exception("dns fail")
addon.error(flow)
print("driver-ok")
`;

function runAddonDriver(addonSource: string, mapUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-addon-"));
  const addonPath = path.join(dir, "addon.py");
  const flowLog = path.join(dir, "flow.jsonl");
  fs.writeFileSync(addonPath, addonSource.replace("__FLOW_LOG__", flowLog));
  const driverPath = path.join(dir, "driver.py");
  fs.writeFileSync(driverPath, ADDON_DRIVER);
  const out = execFileSync("python3", [driverPath, addonPath, mapUrl], { encoding: "utf8" });
  expect(out).toContain("driver-ok");
  return fs.readFileSync(flowLog, "utf8");
}

function observabilityRules(mapFile: string) {
  return normalizeRules([
    { match: { url_regex: "cdn\\.example\\.com" }, action: { map_local: mapFile } },
    { match: { url_regex: "example\\.com/rw" }, action: { request: { headers: { "X-Rw": "1" }, body: "{}" } } },
    { match: { url_regex: "example\\.com" }, action: { status: 418, body: "tampered" } },
  ]);
}

describe.runIf(hasPython3())("P1a live addon (stubbed mitmproxy)", () => {
  it("writes correlated two-phase rows with redaction and rule metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-map-"));
    const mapFile = path.join(dir, "body.json");
    fs.writeFileSync(mapFile, '{"cdn":true}');
    const addon = buildAddon(observabilityRules(mapFile), { flowLogPath: "__FLOW_LOG__" });
    const rows = parseFlowLog(runAddonDriver(addon, "https://cdn.example.com"));
    const byFlow = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byFlow.get(r.flowId ?? "") ?? [];
      list.push(r);
      byFlow.set(r.flowId ?? "", list);
    }

    // f1: request row redacts Authorization; response row carries rule metadata.
    const f1req = byFlow.get("f1")?.find((r) => r.phase === "request");
    expect(f1req).toMatchObject({ method: "GET", url: "https://example.com/a" });
    expect(f1req?.redactedHeaders).toContain("authorization");
    expect(JSON.stringify(f1req)).not.toContain("s3cret");
    expect(f1req?.headers).toMatchObject({ "content-type": "text/html" });
    expect(f1req?.headerNames).toContain("x-custom");
    expect(f1req?.reqBody).toBeUndefined();
    const f1resp = byFlow.get("f1")?.find((r) => r.phase === "response");
    expect(f1resp).toMatchObject({
      statusCode: 418, matchedRule: 2, rewritten: true, respBytes: 8, contentType: expect.any(String),
    });
    expect(f1resp?.applied).toEqual(expect.arrayContaining(["status", "body"]));

    // f2: unmatched passthrough still gets a metadata response row.
    const f2resp = byFlow.get("f2")?.find((r) => r.phase === "response");
    expect(f2resp).toMatchObject({ statusCode: 200, matchedRule: null, rewritten: false, applied: [] });
    expect(byFlow.get("f2")?.find((r) => r.phase === "request")).toMatchObject({ reqBytes: 2 });

    // f4: map_local served without upstream; f5: request rewrite tracked.
    const f4resp = byFlow.get("f4")?.find((r) => r.phase === "response");
    expect(f4resp).toMatchObject({ statusCode: 200, matchedRule: 0, rewritten: true });
    expect(f4resp?.applied).toContain("map_local");
    const f5resp = byFlow.get("f5")?.find((r) => r.phase === "response");
    expect(f5resp).toMatchObject({ matchedRule: 1, rewritten: true });
    expect(f5resp?.applied).toEqual(expect.arrayContaining(["request.headers", "request.body"]));

    // f3: failed flow is distinguishable from never-requested.
    const f3 = byFlow.get("f3") ?? [];
    expect(f3.map((r) => r.phase).sort()).toEqual(["error", "request"]);
    expect(f3.find((r) => r.phase === "error")?.error).toContain("dns fail");
  });

  it("captures bodies only when the embedded flag is on, with cap/sha/scrub", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-map-"));
    const mapFile = path.join(dir, "body.json");
    fs.writeFileSync(mapFile, "{}");
    const rules = observabilityRules(mapFile);

    const off = parseFlowLog(
      runAddonDriver(buildAddon(rules, { flowLogPath: "__FLOW_LOG__" }), "https://cdn.example.com"),
    );
    expect(off.some((r) => r.reqBody !== undefined || r.respBody !== undefined)).toBe(false);

    // Bodies on: drive a JSON flow with a secret plus an oversized text body.
    const big = "x".repeat(20000);
    const secret = JSON.stringify({ user: "ann", password: "hunter2", nested: { token: "abc" } });
    const customDriver = ADDON_DRIVER + `
run("b1", "POST", "https://example.com/big", {"Content-Type": "text/plain"}, ${JSON.stringify(big)}.encode(),
    (200, b"r", {"content-type": "text/plain"}))
run("b2", "POST", "https://example.com/secret", {"Content-Type": "application/json"}, ${JSON.stringify(secret)}.encode(),
    (200, b"r", {"content-type": "text/plain"}))
`;
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-addon-"));
    const addonPath = path.join(d2, "addon.py");
    const flowLog = path.join(d2, "flow.jsonl");
    fs.writeFileSync(addonPath, buildAddon(rules, { flowLogPath: flowLog, captureBodies: true }));
    const driverPath = path.join(d2, "driver.py");
    fs.writeFileSync(driverPath, customDriver);
    expect(execFileSync("python3", [driverPath, addonPath, "https://cdn.example.com"], { encoding: "utf8" })).toContain(
      "driver-ok",
    );
    const rows = parseFlowLog(fs.readFileSync(flowLog, "utf8"));
    const b1 = rows.find((r) => r.flowId === "b1" && r.phase === "request");
    expect(b1?.reqBytes).toBe(20000);
    expect(b1?.reqBodyTruncated).toBe(true);
    expect((b1?.reqBody ?? "").length).toBeLessThanOrEqual(8192);
    const b2 = rows.find((r) => r.flowId === "b2" && r.phase === "request");
    expect(b2?.reqBody).not.toContain("hunter2");
    expect(b2?.reqBody).toContain("***");
    expect(b2?.reqBody).toContain("ann");
    // Non-text content records sha + bytes only.
    const f2 = rows.find((r) => r.flowId === "f2" && r.phase === "request");
    expect(f2?.reqBody).toBeUndefined();
    expect(f2?.reqBodySha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("P1b flow-log lifecycle", () => {
  it("names per-run files and rotates to keep-last-5", () => {
    expect(FLOW_LOG_KEEP_PER_PORT).toBe(5);
    expect(flowLogFileName(3240, 123)).toBe("flow-3240-123.jsonl");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-rot-"));
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `flow-3240-${1000 + i}.jsonl`), "");
    fs.writeFileSync(path.join(dir, "flow-9999-1000.jsonl"), "");
    fs.writeFileSync(path.join(dir, "addon-3240.py"), "");
    rotateFlowLogs(dir, 3240);
    const left = fs.readdirSync(dir).sort();
    expect(left).toContain("flow-9999-1000.jsonl");
    expect(left).toContain("addon-3240.py");
    expect(left.filter((f) => f.startsWith("flow-3240-"))).toHaveLength(5);
    expect(left).not.toContain("flow-3240-1000.jsonl");
    expect(left).not.toContain("flow-3240-1001.jsonl");
    expect(() => rotateFlowLogs(path.join(dir, "missing"), 3240)).not.toThrow();
  });

  it("preserves the flow log on stop, returns its path, and exposes it in status", async () => {
    const { proxy, workDir } = makeProxy();
    expect(proxy.proxyStatus()).toEqual({ running: false });
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const status = proxy.proxyStatus();
    expect(status.flowLogPath).toMatch(/flow-\d+-\d+\.jsonl$/);
    fs.appendFileSync(status.flowLogPath!, '{"ts": 1, "method": "GET", "url": "https://example.com/"}\n');
    const stop = await proxy.stopProxy("l1");
    expect(stop).toMatchObject({ stopped: true, flowLogPath: status.flowLogPath });
    expect(fs.existsSync(status.flowLogPath!)).toBe(true);
    expect(fs.existsSync(status.addonPath!)).toBe(false);
    expect(proxy.proxyStatus()).toMatchObject({ running: false, lastFlowLogPath: status.flowLogPath });
    // A later run rotates but keeps prior logs on disk.
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const again = proxy.proxyStatus();
    expect(again.flowLogPath).not.toBe(status.flowLogPath);
    expect(fs.existsSync(status.flowLogPath!)).toBe(true);
    expect(fs.readdirSync(workDir).filter((f) => f.startsWith("flow-"))).toHaveLength(2);
    await proxy.stopProxy("l1");
  });

  it("embeds CAPTURE_BODIES from env by default with a constructor override", async () => {
    const prev = process.env[PROXY_CAPTURE_BODIES_ENV];
    try {
      process.env[PROXY_CAPTURE_BODIES_ENV] = "1";
      const envOn = makeProxy();
      await envOn.proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
      expect(fs.readFileSync(envOn.proxy.proxyStatus().addonPath!, "utf8")).toContain("CAPTURE_BODIES = True");
      await envOn.proxy.stopProxy("l1");

      delete process.env[PROXY_CAPTURE_BODIES_ENV];
      const envOff = makeProxy();
      await envOff.proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
      expect(fs.readFileSync(envOff.proxy.proxyStatus().addonPath!, "utf8")).toContain("CAPTURE_BODIES = False");
      await envOff.proxy.stopProxy("l1");

      process.env[PROXY_CAPTURE_BODIES_ENV] = "1";
      const forced = makeProxy({ captureBodies: false });
      await forced.proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
      expect(fs.readFileSync(forced.proxy.proxyStatus().addonPath!, "utf8")).toContain("CAPTURE_BODIES = False");
      await forced.proxy.stopProxy("l1");
    } finally {
      if (prev === undefined) delete process.env[PROXY_CAPTURE_BODIES_ENV];
      else process.env[PROXY_CAPTURE_BODIES_ENV] = prev;
    }
  });

  it("counts one flow per request row in assertFlow with two-phase logs", async () => {
    const { proxy } = makeProxy();
    await proxy.startProxy("U1", { leaseId: "l1", sessionId: "s1" }, []);
    const flowLogPath = proxy.proxyStatus().flowLogPath!;
    fs.writeFileSync(
      flowLogPath,
      [
        { ts: 1, method: "GET", url: "https://example.com/a", phase: "request", flow_id: "f1" },
        { ts: 1, method: "GET", url: "https://example.com/a", phase: "response", flow_id: "f1", status_code: 200 },
        { ts: 2, method: "GET", url: "https://example.com/b", phase: "request", flow_id: "f2" },
        { ts: 2, method: "GET", url: "https://example.com/b", phase: "response", flow_id: "f2", status_code: 200 },
        { ts: 3, method: "GET", url: "https://err.test/", phase: "error", flow_id: "f3", error: "dns fail" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await expect(proxy.assertFlow("l1", { urlRegex: "example\\.com", since: "run", timeoutSec: 0 })).resolves.toMatchObject({
      count: 2,
      total: 2,
    });
    await proxy.stopProxy("l1");
  });
});
