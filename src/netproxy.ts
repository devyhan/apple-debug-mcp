import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Runner, defaultRunner } from "./exec.js";
import { findFreePort } from "./servesim.js";

/** Default first port scanned for the mitmdump listener. */
export const DEFAULT_NETPROXY_PORT_BASE = 3240;
export const DEFAULT_MITMDUMP_BIN = "mitmdump";
/** Host interface the proxy binds and the host proxy points at (proven on 127.0.0.1). */
export const NETPROXY_HOST = "127.0.0.1";
export const MAX_PROXY_RULES = 50;
export const MAX_DELAY_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;

export interface NetProxyMatch {
  /** Regex matched (search) against the full request URL. Omit to match all URLs. */
  url_regex?: string;
  /** HTTP method, compared uppercase. Omit to match all methods. */
  method?: string;
}

export interface NetProxyRequestRewrite {
  /** Replace the upstream request method (uppercased, e.g. "POST"). */
  method?: string;
  /** Replace the upstream request URL wholesale. */
  url?: string;
  /** Headers merged into the upstream request (replace per-name). */
  headers?: Record<string, string>;
  /** Replace the upstream request body (UTF-8). */
  body?: string;
}

export interface NetProxyAction {
  /** Override the upstream response status code. */
  status?: number;
  /** Headers merged into the upstream response (replace per-name). */
  headers?: Record<string, string>;
  /** Replace the upstream response body (UTF-8). Upstream content-encoding is dropped. */
  body?: string;
  /** Delay before forwarding the matched request, in milliseconds. */
  delay_ms?: number;
  /** Request-direction rewrite, applied in the mitm request() hook before forwarding. */
  request?: NetProxyRequestRewrite;
  /** Serve a local file as the response without contacting upstream (map_local). */
  map_local?: string;
  /** Rewrite the upstream URL to this fixed URL (map_remote). */
  map_remote?: string;
}

export interface NetProxyRule {
  /** What to match. Omit to match every request. */
  match?: NetProxyMatch;
  /** What to do with the match (at least one field required). */
  action: NetProxyAction;
}

export interface ProxyHolder {
  leaseId: string;
  sessionId: string;
}

export interface NetProxyStatus {
  running: boolean;
  port?: number;
  pid?: number;
  leaseId?: string;
  sessionId?: string;
  udid?: string;
  ruleCount?: number;
  addonPath?: string;
  flowLogPath?: string;
}

/** One JSONL row of the proxy flow log (written by the generated addon). */
export interface FlowRecord {
  ts: number;
  method: string;
  url: string;
}

export interface AssertFlowSpec {
  /** Regex matched (search) against the full request URL. */
  urlRegex: string;
  /** HTTP method, compared uppercase. Omit to match all methods. */
  method?: string;
  /** Succeed once this many matching flows are seen. Default 1. */
  minCount?: number;
  /** Poll the flow log up to this many seconds. Default 5. */
  timeoutSec?: number;
}

export interface AssertFlowResult {
  /** Matching flows seen (up to the poll deadline). */
  count: number;
  /** Total flows logged for this proxy run. */
  total: number;
  /** The most recent matching flows (at most 10, oldest first). */
  matched: FlowRecord[];
}

/** Minimal proxy surface the orchestrator needs (implemented by NetProxy, faked in tests). */
export interface ProxyOps {
  startProxy(udid: string, holder: ProxyHolder, rules: NetProxyRule[]): Promise<{ port: number; pid?: number }>;
  setProxyRules(leaseId: string, rules: NetProxyRule[]): Promise<void>;
  stopProxy(leaseId: string): Promise<{ stopped: boolean }>;
  proxyStatus(): NetProxyStatus;
  proxyRules(leaseId: string): NetProxyRule[];
  assertFlow(leaseId: string, spec: AssertFlowSpec): Promise<AssertFlowResult>;
  upsertMapRule(leaseId: string, rule: NetProxyRule): Promise<number>;
}

/** Thrown when a non-holder starts/sets/stops while another lease holds the global host proxy. */
export class ProxyBusyError extends Error {
  readonly holderLeaseId: string;
  readonly holderSessionId: string;
  readonly port: number;

  constructor(active: { leaseId: string; sessionId: string; port: number }, action: string) {
    super(
      `Cannot ${action}: the network proxy (port ${active.port}) is held by session ${active.sessionId} ` +
        `(lease ${active.leaseId}). The host proxy is global — one holder at a time. ` +
        `That session must call net_proxy_stop first.`,
    );
    this.name = "ProxyBusyError";
    this.holderLeaseId = active.leaseId;
    this.holderSessionId = active.sessionId;
    this.port = active.port;
  }
}

export interface ProxyEndpointState {
  enabled: boolean;
  server: string;
  port: number;
}

export interface ServiceProxySnapshot {
  service: string;
  http: ProxyEndpointState;
  https: ProxyEndpointState;
}

/** First `networksetup -listallnetworkservices` line is a header; disabled services carry a `*` prefix. */
export function parseServicesList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("An asterisk")) continue;
    out.push(trimmed.startsWith("*") ? trimmed.slice(1) : trimmed);
  }
  return out;
}

/** Parse `networksetup -getwebproxy/-getsecurewebproxy` output (Enabled/Server/Port lines). */
export function parseProxyState(text: string): ProxyEndpointState {
  let enabled = false;
  let server = "";
  let port = 0;
  for (const line of text.split("\n")) {
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase();
    const value = match[2]!.trim();
    if (key === "enabled") enabled = /^yes$/i.test(value);
    else if (key === "server") server = value;
    else if (key === "port") port = Number(value) || 0;
  }
  return { enabled, server, port };
}

/** Validate rules and return a normalized copy (methods uppercased). Throws before any host change. */
export function normalizeRules(rules: unknown): NetProxyRule[] {
  if (!Array.isArray(rules)) throw new Error("Invalid rules (expected an array of {match?, action})");
  if (rules.length > MAX_PROXY_RULES) {
    throw new Error(`Too many rules (${rules.length}; max ${MAX_PROXY_RULES})`);
  }
  return rules.map((rule, i) => normalizeRule(rule, `rules[${i}]`));
}

function normalizeRule(rule: unknown, what: string): NetProxyRule {
  if (typeof rule !== "object" || rule === null) {
    throw new Error(`Invalid ${what} (expected {match?, action})`);
  }
  const { match, action } = rule as Record<string, unknown>;
  const out: NetProxyRule = { action: normalizeAction(action, what) };
  if (match !== undefined) out.match = normalizeMatch(match, what);
  return out;
}

function normalizeMatch(match: unknown, what: string): NetProxyMatch {
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    throw new Error(`Invalid ${what}.match (expected {url_regex?, method?})`);
  }
  const { url_regex, method } = match as Record<string, unknown>;
  const out: NetProxyMatch = {};
  if (url_regex !== undefined) {
    if (typeof url_regex !== "string" || url_regex.length === 0) {
      throw new Error(`Invalid ${what}.match.url_regex (expected a non-empty string)`);
    }
    try {
      void new RegExp(url_regex);
    } catch {
      throw new Error(`Invalid ${what}.match.url_regex ${JSON.stringify(url_regex)} (not a valid regular expression)`);
    }
    out.url_regex = url_regex;
  }
  if (method !== undefined) {
    if (typeof method !== "string" || method.trim().length === 0) {
      throw new Error(`Invalid ${what}.match.method (expected a non-empty string, e.g. "GET")`);
    }
    out.method = method.trim().toUpperCase();
  }
  return out;
}

function normalizeHeaders(headers: unknown, what: string): Record<string, string> {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new Error(`Invalid ${what} (expected an object of string->string)`);
  }
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.length === 0) throw new Error(`Invalid ${what} (header names must be non-empty)`);
    if (typeof value !== "string") {
      throw new Error(`Invalid ${what}[${JSON.stringify(name)}] (expected a string value)`);
    }
    clean[name] = value;
  }
  return clean;
}

function normalizeRequestRewrite(request: unknown, what: string): NetProxyRequestRewrite {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new Error(`Invalid ${what}.action.request (expected {method?, url?, headers?, body?})`);
  }
  const { method, url, headers, body } = request as Record<string, unknown>;
  if (method === undefined && url === undefined && headers === undefined && body === undefined) {
    throw new Error(`Invalid ${what}.action.request (needs at least one of method|url|headers|body)`);
  }
  const out: NetProxyRequestRewrite = {};
  if (method !== undefined) {
    if (typeof method !== "string" || method.trim().length === 0) {
      throw new Error(`Invalid ${what}.action.request.method (expected a non-empty string, e.g. "POST")`);
    }
    out.method = method.trim().toUpperCase();
  }
  if (url !== undefined) {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error(`Invalid ${what}.action.request.url (expected a non-empty string)`);
    }
    assertHttpUrl(url, `${what}.action.request.url`);
    out.url = url;
  }
  if (headers !== undefined) out.headers = normalizeHeaders(headers, `${what}.action.request.headers`);
  if (body !== undefined) {
    if (typeof body !== "string") throw new Error(`Invalid ${what}.action.request.body (expected a string)`);
    out.body = body;
  }
  return out;
}

function assertHttpUrl(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${what} ${JSON.stringify(url)} (expected an absolute http(s) URL)`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${what} ${JSON.stringify(url)} (expected an absolute http(s) URL)`);
  }
}

function normalizeAction(action: unknown, what: string): NetProxyAction {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    throw new Error(
      `Invalid ${what}.action (expected {status?, headers?, body?, delay_ms?, request?, map_local?, map_remote?})`,
    );
  }
  const { status, headers, body, delay_ms, request, map_local, map_remote } = action as Record<string, unknown>;
  if (
    status === undefined &&
    headers === undefined &&
    body === undefined &&
    delay_ms === undefined &&
    request === undefined &&
    map_local === undefined &&
    map_remote === undefined
  ) {
    throw new Error(`Invalid ${what}.action (needs at least one of status|headers|body|delay_ms|request|map_local|map_remote)`);
  }
  if (map_local !== undefined && map_remote !== undefined) {
    throw new Error(`Invalid ${what}.action (map_local and map_remote are mutually exclusive)`);
  }
  const out: NetProxyAction = {};
  if (status !== undefined) {
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
      throw new Error(`Invalid ${what}.action.status ${String(status)} (expected an integer in 100..599)`);
    }
    out.status = status as number;
  }
  if (headers !== undefined) out.headers = normalizeHeaders(headers, `${what}.action.headers`);
  if (body !== undefined) {
    if (typeof body !== "string") throw new Error(`Invalid ${what}.action.body (expected a string)`);
    out.body = body;
  }
  if (delay_ms !== undefined) {
    if (!Number.isInteger(delay_ms) || (delay_ms as number) < 0 || (delay_ms as number) > MAX_DELAY_MS) {
      throw new Error(`Invalid ${what}.action.delay_ms ${String(delay_ms)} (expected an integer in 0..${MAX_DELAY_MS})`);
    }
    out.delay_ms = delay_ms as number;
  }
  if (request !== undefined) out.request = normalizeRequestRewrite(request, what);
  if (map_local !== undefined) {
    if (typeof map_local !== "string" || map_local.length === 0) {
      throw new Error(`Invalid ${what}.action.map_local (expected a non-empty file path)`);
    }
    try {
      if (!fs.statSync(map_local).isFile()) {
        throw new Error(`Invalid ${what}.action.map_local ${JSON.stringify(map_local)} (not a regular file)`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Invalid ${what}.action.map_local`)) throw err;
      throw new Error(`Invalid ${what}.action.map_local ${JSON.stringify(map_local)} (file not found or unreadable)`);
    }
    out.map_local = map_local;
  }
  if (map_remote !== undefined) {
    if (typeof map_remote !== "string" || map_remote.length === 0) {
      throw new Error(`Invalid ${what}.action.map_remote (expected a non-empty string)`);
    }
    assertHttpUrl(map_remote, `${what}.action.map_remote`);
    out.map_remote = map_remote;
  }
  return out;
}

/**
 * Generate the mitmdump addon for normalized rules. The rules are embedded as
 * a doubly-encoded JSON string literal (valid Python: JSON escapes are a
 * subset of Python string escapes), so rule bodies need no Python escaping.
 * Semantics: every request is appended to the flow log; the first matching
 * rule may rewrite the request (method/url/headers/body, map_remote), serve a
 * local file instead of upstream (map_local), delay the request, and mutate
 * the response (status/headers/body).
 */
export function buildAddon(rules: NetProxyRule[], opts: { flowLogPath?: string } = {}): string {
  const embedded = JSON.stringify(JSON.stringify(rules));
  const flowLog = opts.flowLogPath !== undefined ? JSON.stringify(opts.flowLogPath) : "None";
  return `# Generated by sim-orchestration-mcp NetProxy - do not edit.
"""Per-lease rewrite rules (first match wins per request).

Every request is appended to the flow log; the matched rule may rewrite the
request, serve a local file (map_local), delay, and mutate the response.
Regenerated on every net_proxy_start / net_proxy_set_rules / map_*.
"""
import json
import re
import time

from mitmproxy import http

RULES = json.loads(${embedded})
FLOW_LOG = ${flowLog}


def _log(flow):
    if not FLOW_LOG:
        return
    try:
        with open(FLOW_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.time(),
                "method": flow.request.method,
                "url": flow.request.pretty_url,
            }) + "\\n")
    except OSError:
        pass


def _match(rule, flow):
    m = rule.get("match") or {}
    pat = m.get("url_regex")
    if pat:
        try:
            if not re.search(pat, flow.request.pretty_url):
                return False
        except re.error:
            return False
    method = m.get("method")
    if method and flow.request.method != method:
        return False
    return True


def _find(flow):
    for rule in RULES:
        if _match(rule, flow):
            return rule
    return None


def request(flow):
    _log(flow)
    rule = _find(flow)
    if rule is None:
        return
    action = rule.get("action") or {}
    delay = action.get("delay_ms")
    if delay:
        time.sleep(delay / 1000.0)
    req = action.get("request") or {}
    if req.get("method"):
        flow.request.method = req["method"]
    if req.get("url"):
        flow.request.url = req["url"]
    for k, v in (req.get("headers") or {}).items():
        flow.request.headers[k] = v
    if req.get("body") is not None:
        body = req["body"].encode("utf-8")
        flow.request.content = body
        flow.request.headers.pop("content-encoding", None)
        flow.request.headers["content-length"] = str(len(body))
    if action.get("map_remote"):
        flow.request.url = action["map_remote"]
    if action.get("map_local"):
        try:
            with open(action["map_local"], "rb") as f:
                content = f.read()
            flow.response = http.Response.make(200, content)
        except OSError as e:
            flow.response = http.Response.make(502, ("map_local failed: %s" % e).encode("utf-8"))


def response(flow):
    rule = _find(flow)
    if rule is None:
        return
    action = rule.get("action") or {}
    resp = flow.response
    if action.get("status") is not None:
        resp.status_code = int(action["status"])
    for k, v in (action.get("headers") or {}).items():
        resp.headers[k] = v
    if action.get("body") is not None:
        body = action["body"].encode("utf-8")
        resp.content = body
        resp.headers.pop("content-encoding", None)
        resp.headers["content-length"] = str(len(body))
`;
}

/** Parse flow-log JSONL, skipping malformed rows (a partial last line while mitmdump writes). */
export function parseFlowLog(text: string): FlowRecord[] {
  const out: FlowRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof row["method"] === "string" && typeof row["url"] === "string") {
        out.push({ ts: typeof row["ts"] === "number" ? row["ts"] : 0, method: row["method"], url: row["url"] });
      }
    } catch {
      // Skip torn writes.
    }
  }
  return out;
}

/** Identity of a map rule for replace-in-place: url_regex + map kind (or null for non-map rules). */
function mapKey(rule: NetProxyRule): string | null {
  const kind = rule.action.map_local !== undefined ? "local" : rule.action.map_remote !== undefined ? "remote" : null;
  if (kind === null) return null;
  return `${kind}:${rule.match?.url_regex ?? ""}:${rule.match?.method ?? ""}`;
}

/** Read + parse the flow log; a missing file (proxy just started) reads as empty. */
function readFlowLog(flowLogPath: string): FlowRecord[] {
  try {
    return parseFlowLog(fs.readFileSync(flowLogPath, "utf8"));
  } catch {
    return [];
  }
}

/** Injectable mitmdump child handle (node:child_process ChildProcess satisfies this). */
export interface MitmChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (err: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
}

export type SpawnFn = (bin: string, args: string[], opts: Record<string, never>) => MitmChild;

const defaultSpawn: SpawnFn = (bin, args) => spawn(bin, args, { stdio: "ignore" });

/** Wait until mitmdump accepts connections; getSpawnError fails fast on spawn/exit errors. */
export type WaitReadyFn = (port: number, getSpawnError?: () => Error | null) => Promise<void>;

export function makeTcpWaitReady(timeoutMs: number): WaitReadyFn {
  return async (port, getSpawnError) => {
    const start = Date.now();
    for (;;) {
      const spawnError = getSpawnError?.() ?? null;
      if (spawnError) throw spawnError;
      if (await canConnect(port)) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`mitmdump did not accept connections on 127.0.0.1:${port} within ${timeoutMs}ms`);
      }
      await sleep(250);
    }
  };
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, NETPROXY_HOST);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SIGTERM with a grace window, then SIGKILL. Never throws. */
async function stopChildQuiet(child: MitmChild, graceMs = 2000): Promise<void> {
  try {
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    let done = false;
    child.once("exit", () => {
      done = true;
    });
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + graceMs;
    while (!done && Date.now() < deadline) await sleep(50);
    if (!done) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Never throws.
  }
}

function mitmError(err: unknown): string {
  const msg = (err as Error).message;
  if ((err as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|spawn .*mitmdump|mitmdump.*not found/i.test(msg)) {
    return `${msg}. mitmdump is not installed; run: brew install mitmproxy (or set MITMDUMP_BIN)`;
  }
  return msg;
}

function sudoHint(err: unknown): string {
  const msg = (err as Error).message;
  if (/password is required|\bsudo\b/i.test(msg)) {
    return (
      `${msg}. Host proxy control needs passwordless sudo for: ` +
      `networksetup -setwebproxy/-setsecurewebproxy/-setwebproxystate/-setsecurewebproxystate ` +
      `(ask an admin to provision a sudoers rule, then retry)`
    );
  }
  return msg;
}

export function defaultCaPemPath(): string {
  return path.join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
}

interface ActiveProxy {
  leaseId: string;
  sessionId: string;
  udid: string;
  port: number;
  pid?: number;
  rules: NetProxyRule[];
  snapshot: ServiceProxySnapshot[];
  addonPath: string;
  flowLogPath: string;
  child: MitmChild;
}

/** Upper bound for net_assert_flow polling (keeps the tool call bounded). */
export const MAX_ASSERT_FLOW_SEC = 120;

/**
 * Lease-scoped HTTPS interception for one simulator, on the proven mechanism:
 * mitmdump (scanned port, generated rewrite addon) + the mitm CA trusted in
 * the sim keychain + the HOST web proxy pointed at mitmdump.
 *
 * The host proxy is global to macOS, so at most one lease holds the proxy:
 * a second holder gets a ProxyBusyError naming the holding session. The host
 * toggle runs LAST on start (after CA install + mitmdump readiness) and is
 * restored FIRST on stop; every teardown path is best-effort and never throws.
 *
 * Proven commands (sim-traffic MITM verified end-to-end):
 * - `xcrun simctl keychain <udid> add-root-cert ~/.mitmproxy/mitmproxy-ca-cert.pem`
 * - `mitmdump -p <port> -s <addon.py>`
 * - `sudo -n networksetup -setwebproxy/-setsecurewebproxy <svc> 127.0.0.1 <port>`
 * - `sudo -n networksetup -setwebproxystate/-setsecurewebproxystate <svc> on|off`
 * Reads (`-listallnetworkservices`, `-getwebproxy/-getsecurewebproxy`) need no sudo.
 */
export class NetProxy implements ProxyOps {
  private readonly bin: string;
  private readonly run: Runner;
  private readonly spawnFn: SpawnFn;
  private readonly execTimeoutMs: number;
  private readonly portBase: number;
  private readonly caPemPath: string;
  private readonly workDir: string;
  private readonly waitReady: WaitReadyFn;
  private active: ActiveProxy | null = null;

  constructor(
    opts: {
      bin?: string;
      runner?: Runner;
      spawnFn?: SpawnFn;
      execTimeoutMs?: number;
      portBase?: number;
      caPemPath?: string;
      workDir?: string;
      readyTimeoutMs?: number;
      waitReady?: WaitReadyFn;
    } = {},
  ) {
    this.bin = opts.bin ?? DEFAULT_MITMDUMP_BIN;
    this.run = opts.runner ?? defaultRunner;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
    this.portBase = opts.portBase ?? DEFAULT_NETPROXY_PORT_BASE;
    this.caPemPath = opts.caPemPath ?? defaultCaPemPath();
    this.workDir = opts.workDir ?? path.join(os.tmpdir(), "sim-mcp-netproxy");
    this.waitReady = opts.waitReady ?? makeTcpWaitReady(opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.bin, ["--version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  proxyStatus(): NetProxyStatus {
    const active = this.active;
    if (!active) return { running: false };
    return {
      running: true,
      port: active.port,
      pid: active.pid,
      leaseId: active.leaseId,
      sessionId: active.sessionId,
      udid: active.udid,
      ruleCount: active.rules.length,
      addonPath: active.addonPath,
      flowLogPath: active.flowLogPath,
    };
  }

  /**
   * Start interception for a lease. Idempotent for the holding lease (returns
   * the running port without touching rules — use setProxyRules for those);
   * a different lease gets a ProxyBusyError naming the holding session.
   * Validation (rules, CA file) runs before any host change.
   */
  async startProxy(udid: string, holder: ProxyHolder, rules: NetProxyRule[]): Promise<{ port: number; pid?: number }> {
    const active = this.active;
    if (active) {
      if (active.leaseId === holder.leaseId) return { port: active.port, pid: active.pid };
      throw new ProxyBusyError(active, "start");
    }
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    const normalized = normalizeRules(rules);
    if (!fs.existsSync(this.caPemPath)) {
      throw new Error(`mitm CA not found at ${this.caPemPath}; run "mitmdump" once on this host to generate it, then retry.`);
    }
    const port = await findFreePort(this.portBase);
    const snapshot = await this.snapshotHost();
    await this.run("xcrun", ["simctl", "keychain", udid, "add-root-cert", this.caPemPath], {
      timeoutMs: this.execTimeoutMs,
    });
    fs.mkdirSync(this.workDir, { recursive: true });
    const addonPath = path.join(this.workDir, `addon-${port}.py`);
    const flowLogPath = path.join(this.workDir, `flow-${port}.jsonl`);
    fs.writeFileSync(addonPath, buildAddon(normalized, { flowLogPath }));
    fs.writeFileSync(flowLogPath, "");
    const child = this.spawnFn(this.bin, ["-p", String(port), "-s", addonPath], {});
    let spawnError: Error | null = null;
    child.once("error", (err) => {
      spawnError ??= new Error(mitmError(err));
    });
    child.once("exit", (code) => {
      spawnError ??= new Error(
        `mitmdump exited before becoming ready (code ${String(code)}); ` +
          `try "${this.bin} -p ${port} -s ${addonPath}" manually to see why.`,
      );
    });
    try {
      await this.waitReady(port, () => spawnError);
    } catch (err) {
      await stopChildQuiet(child);
      throw new Error(mitmError(err));
    }
    try {
      await this.setHostProxy(
        snapshot.map((s) => s.service),
        port,
      );
    } catch (err) {
      await stopChildQuiet(child);
      await this.restoreSnapshot(snapshot);
      throw new Error(`Failed to enable the host proxy (previous state restored): ${sudoHint(err)}`);
    }
    this.active = {
      leaseId: holder.leaseId,
      sessionId: holder.sessionId,
      udid,
      port,
      pid: child.pid,
      rules: normalized,
      snapshot,
      addonPath,
      flowLogPath,
      child,
    };
    return { port, pid: child.pid };
  }

  /**
   * Replace the rewrite rules. mitmdump does not reload addon code, so the
   * child is restarted on the same port while the host proxy stays on. When
   * the restart fails, the proxy is stopped and the host proxy restored
   * rather than stranding it against a dead port.
   */
  async setProxyRules(leaseId: string, rules: NetProxyRule[]): Promise<void> {
    const active = this.requireHolder(leaseId, "set rules");
    const normalized = normalizeRules(rules);
    await this.applyRules(active, normalized, "Proxy rules update failed");
  }

  /** Current rules of the running proxy (a copy). Only the holding lease may read them. */
  proxyRules(leaseId: string): NetProxyRule[] {
    const active = this.requireHolder(leaseId, "read rules");
    return structuredClone(active.rules);
  }

  /**
   * Insert or replace one map rule (map_local/map_remote action). The rule is
   * validated before the holder check so a bad file/URL/regex fails without
   * needing a running proxy. A prior map rule with the same url_regex and the
   * same map kind is replaced in place; otherwise the rule is prepended (first
   * match wins, so maps take precedence). Returns the new rule count.
   */
  async upsertMapRule(leaseId: string, rule: NetProxyRule): Promise<number> {
    const [normalized] = normalizeRules([rule]);
    const action = normalized!.action;
    if (action.map_local === undefined && action.map_remote === undefined) {
      throw new Error("Invalid map rule (action needs map_local or map_remote)");
    }
    const active = this.requireHolder(leaseId, "set map rule");
    const key = mapKey(normalized!);
    const next = active.rules.filter((r) => mapKey(r) !== key);
    next.unshift(normalized!);
    if (next.length > MAX_PROXY_RULES) {
      throw new Error(`Too many rules (${next.length}; max ${MAX_PROXY_RULES})`);
    }
    await this.applyRules(active, next, "Proxy map update failed");
    return next.length;
  }

  /**
   * Poll the proxy flow log for requests matching urlRegex (+method). Fails
   * cleanly when the lease holds no running proxy. Returns the counts; the
   * caller decides pass/fail against minCount.
   */
  async assertFlow(leaseId: string, spec: AssertFlowSpec): Promise<AssertFlowResult> {
    const active = this.requireHolder(leaseId, "assert flow");
    if (typeof spec.urlRegex !== "string" || spec.urlRegex.length === 0) {
      throw new Error("Invalid url_regex (expected a non-empty string)");
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(spec.urlRegex);
    } catch {
      throw new Error(`Invalid url_regex ${JSON.stringify(spec.urlRegex)} (not a valid regular expression)`);
    }
    const method = spec.method !== undefined ? spec.method.trim().toUpperCase() : undefined;
    if (method !== undefined && method.length === 0) {
      throw new Error('Invalid method (expected a non-empty string, e.g. "GET")');
    }
    const minCount = spec.minCount ?? 1;
    if (!Number.isInteger(minCount) || minCount < 1) {
      throw new Error(`Invalid min_count ${String(spec.minCount)} (expected a positive integer)`);
    }
    const timeoutSec = spec.timeoutSec ?? 5;
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0 || timeoutSec > MAX_ASSERT_FLOW_SEC) {
      throw new Error(`Invalid timeout_sec ${String(spec.timeoutSec)} (expected a number in 0..${MAX_ASSERT_FLOW_SEC})`);
    }
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const flows = readFlowLog(active.flowLogPath);
      const matched = flows.filter(
        (f) => (method === undefined || f.method === method) && pattern.test(f.url),
      );
      if (matched.length >= minCount || Date.now() >= deadline) {
        return { count: matched.length, total: flows.length, matched: matched.slice(-10) };
      }
      await sleep(250);
    }
  }

  private requireHolder(leaseId: string, action: string): ActiveProxy {
    const active = this.active;
    if (!active) throw new Error("No network proxy is running; call net_proxy_start first.");
    if (active.leaseId !== leaseId) throw new ProxyBusyError(active, action);
    return active;
  }

  /**
   * Regenerate the addon and restart mitmdump on the same port (the host
   * proxy stays on, the flow log keeps appending). When the restart fails,
   * the proxy is stopped and the host proxy restored rather than stranding
   * it against a dead port.
   */
  private async applyRules(active: ActiveProxy, normalized: NetProxyRule[], failurePrefix: string): Promise<void> {
    fs.writeFileSync(active.addonPath, buildAddon(normalized, { flowLogPath: active.flowLogPath }));
    await stopChildQuiet(active.child);
    const child = this.spawnFn(this.bin, ["-p", String(active.port), "-s", active.addonPath], {});
    let spawnError: Error | null = null;
    child.once("error", (err) => {
      spawnError ??= new Error(mitmError(err));
    });
    child.once("exit", (code) => {
      spawnError ??= new Error(
        `mitmdump exited before becoming ready (code ${String(code)}); ` +
          `try "${this.bin} -p ${active.port} -s ${active.addonPath}" manually to see why.`,
      );
    });
    try {
      await this.waitReady(active.port, () => spawnError);
    } catch (err) {
      await this.restoreSnapshot(active.snapshot);
      this.active = null;
      throw new Error(
        `${failurePrefix} and the proxy was stopped (host proxy restored): ${mitmError(err)}. ` +
          `Call net_proxy_start to resume.`,
      );
    }
    active.child = child;
    active.pid = child.pid;
    active.rules = normalized;
  }

  /**
   * Stop the proxy and restore the host proxy snapshot. Idempotent (unknown
   * or already-stopped reports stopped=false); only the holding lease may
   * stop — anything else gets a ProxyBusyError naming the holder. The
   * teardown itself never throws.
   */
  async stopProxy(leaseId: string): Promise<{ stopped: boolean }> {
    const active = this.active;
    if (!active) return { stopped: false };
    if (active.leaseId !== leaseId) throw new ProxyBusyError(active, "stop");
    await this.teardown(active);
    return { stopped: true };
  }

  /** Unconditional best-effort stop for daemon shutdown (never throws, never rejects holders). */
  async forceStop(): Promise<{ stopped: boolean }> {
    const active = this.active;
    if (!active) return { stopped: false };
    await this.teardown(active);
    return { stopped: true };
  }

  private async teardown(active: ActiveProxy): Promise<void> {
    this.active = null;
    await this.restoreSnapshot(active.snapshot);
    await stopChildQuiet(active.child);
    for (const generated of [active.addonPath, active.flowLogPath]) {
      try {
        fs.unlinkSync(generated);
      } catch {
        // Best-effort.
      }
    }
  }

  /** Snapshot every network service (reads need no sudo). Unreadable endpoints restore to off. */
  private async snapshotHost(): Promise<ServiceProxySnapshot[]> {
    const { stdout } = await this.run("networksetup", ["-listallnetworkservices"], {
      timeoutMs: this.execTimeoutMs,
    });
    const services = parseServicesList(stdout);
    const snapshot: ServiceProxySnapshot[] = [];
    for (const service of services) {
      snapshot.push({
        service,
        http: await this.readEndpoint(service, false),
        https: await this.readEndpoint(service, true),
      });
    }
    return snapshot;
  }

  private async readEndpoint(service: string, secure: boolean): Promise<ProxyEndpointState> {
    const flag = secure ? "-getsecurewebproxy" : "-getwebproxy";
    try {
      const { stdout } = await this.run("networksetup", [flag, service], { timeoutMs: this.execTimeoutMs });
      return parseProxyState(stdout);
    } catch (err) {
      console.error(
        `[netproxy] Failed to snapshot ${flag} for ${JSON.stringify(service)}; restore will turn it off: ${(err as Error).message}`,
      );
      return { enabled: false, server: "", port: 0 };
    }
  }

  private async sudo(networkArgs: string[]): Promise<void> {
    await this.run("sudo", ["-n", "networksetup", ...networkArgs], { timeoutMs: this.execTimeoutMs });
  }

  /** Point every service at mitmdump and turn the proxy on (the only host-network change). */
  private async setHostProxy(services: string[], port: number): Promise<void> {
    for (const service of services) {
      await this.sudo(["-setwebproxy", service, NETPROXY_HOST, String(port)]);
      await this.sudo(["-setsecurewebproxy", service, NETPROXY_HOST, String(port)]);
      await this.sudo(["-setwebproxystate", service, "on"]);
      await this.sudo(["-setsecurewebproxystate", service, "on"]);
    }
  }

  /** Best-effort restore: original server/port first, then the original on/off state. Never throws. */
  private async restoreSnapshot(snapshot: ServiceProxySnapshot[]): Promise<void> {
    for (const entry of snapshot) {
      const endpoints = [
        { state: entry.http, set: "-setwebproxy", toggle: "-setwebproxystate" },
        { state: entry.https, set: "-setsecurewebproxy", toggle: "-setsecurewebproxystate" },
      ] as const;
      for (const { state, set, toggle } of endpoints) {
        if (state.server !== "" && state.port > 0) {
          try {
            await this.sudo([set, entry.service, state.server, String(state.port)]);
          } catch (err) {
            console.error(`[netproxy] Failed to restore ${set} for ${JSON.stringify(entry.service)}: ${(err as Error).message}`);
          }
        }
        try {
          await this.sudo([toggle, entry.service, state.enabled ? "on" : "off"]);
        } catch (err) {
          console.error(`[netproxy] Failed to restore ${toggle} for ${JSON.stringify(entry.service)}: ${(err as Error).message}`);
        }
      }
    }
  }
}
