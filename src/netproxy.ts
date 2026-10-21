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
  quicBlocked?: boolean;
  addonPath?: string;
  flowLogPath?: string;
  /** Most recent preserved flow log, reported after the proxy stops (P1b). */
  lastFlowLogPath?: string;
}

/** Which hook wrote a flow-log row: request(), response(), or error(). Old rows predate phases. */
export type FlowPhase = "request" | "response" | "error";

/**
 * One JSONL row of the proxy flow log (written by the generated addon).
 * Only ts/method/url are guaranteed (old 3-field rows); every enriched
 * field is optional and parsed tolerantly (P1a).
 */
export interface FlowRecord {
  ts: number;
  method: string;
  url: string;
  phase?: FlowPhase;
  /** Correlates a request row with its response/error row (flow.id). */
  flowId?: string;
  /** Rule generation that wrote the row (bumped on every set_rules/map restart; P2). */
  gen?: number;
  statusCode?: number;
  reqBytes?: number;
  respBytes?: number;
  contentType?: string;
  /** Index into the active rules of the rule that fired (null = passthrough). */
  matchedRule?: number | null;
  /** Which action fields fired (status/headers/body/map_local/map_remote/request.*). */
  applied?: string[];
  rewritten?: boolean;
  /** Allowlisted header values (content-type, content-length, cache-control, etag, location). */
  headers?: Record<string, string>;
  /** Names of the remaining non-sensitive headers (values withheld). */
  headerNames?: string[];
  /** Denylisted header names present on the message (values always redacted). */
  redactedHeaders?: string[];
  reqBody?: string;
  reqBodyTruncated?: boolean;
  reqBodySha?: string;
  respBody?: string;
  respBodyTruncated?: boolean;
  respBodySha?: string;
  error?: string;
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
  /**
   * Watermark scope. 'call' (default) matches only flows that started after
   * this call began and under the current rule generation; 'run' matches
   * every flow logged by this proxy run (pre-call opt-out).
   */
  since?: "call" | "run";
  /** Only flows whose response status equals this. Requires a response row. */
  status?: number;
  /** Only flows with at least this many response bytes. Requires a response row. */
  minBytes?: number;
  /** Regex matched (search) against the response body. Requires a response row with a captured body. */
  bodyRegex?: string;
  /** Only flows the proxy rewrote (true) or passed through untouched (false). Requires a response row. */
  rewritten?: boolean;
  /** Only flows handled by this rule index. Requires a response row. */
  rule?: number;
}

export interface AssertFlowResult {
  /** Matching flows seen (up to the poll deadline). */
  count: number;
  /** Total flows logged for this proxy run. */
  total: number;
  /** Request rows that started after this call began (match or not). */
  newSinceCall: number;
  /** The most recent matching flows (at most 10, oldest first). */
  matched: FlowRecord[];
}

/** Minimal proxy surface the orchestrator needs (implemented by NetProxy, faked in tests). */
export interface ProxyOps {
  startProxy(
    udid: string,
    holder: ProxyHolder,
    rules: NetProxyRule[],
    opts?: { blockQuic?: boolean },
  ): Promise<{ port: number; pid?: number }>;
  setProxyRules(leaseId: string, rules: NetProxyRule[]): Promise<void>;
  stopProxy(leaseId: string): Promise<{ stopped: boolean; flowLogPath?: string }>;
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

/**
 * PF anchor carrying the QUIC block. Anchors attach via `/`-separated paths
 * (dots do NOT create hierarchy): stock macOS pf.conf evaluates only
 * `anchor "com.apple/*"`, so the block must live directly under `com.apple/`
 * to take effect without editing any system file. Removal flushes only this
 * anchor.
 */
export const QUIC_BLOCK_ANCHOR = "com.apple/apple-debug-mcp.quicblock";

/** PF rules blocking QUIC (UDP/443) so apps fall back to TCP/TLS through the proxy. */
export function buildQuicBlockRules(): string {
  return "block drop quick proto udp to any port 443\n";
}

/** Parse `pfctl -s info` output; true on a `Status: Enabled...` line (real output appends uptime). */
export function parsePfEnabled(text: string): boolean {
  return text.split("\n").some((line) => /^status:\s*enabled(\s|$)/i.test(line.trim()));
}

/** Parse the enable-reference token printed by `pfctl -E` (`Token : <n>`). */
export function parsePfEnableToken(text: string): string {
  const match = text.match(/Token\s*:\s*(\S+)/);
  if (!match?.[1]) {
    throw new Error(`Could not parse the pfctl -E enable token from: ${JSON.stringify(text.slice(0, 120))}`);
  }
  return match[1];
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

/** Env gate for proxy body capture (P1a). Default OFF (PII risk); metadata rows are always on. */
export const PROXY_CAPTURE_BODIES_ENV = "SIM_MCP_PROXY_CAPTURE_BODIES";
/** Per-body capture cap embedded in the addon (larger bodies set truncated). */
export const FLOW_BODY_CAP_BYTES = 8192;
/** Addon-side flow-log size cap: past this, bodies stop but metadata rows continue. */
export const FLOW_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Per-run flow logs retained per port (P1b rotation). */
export const FLOW_LOG_KEEP_PER_PORT = 5;

/** True only when the body-capture gate is explicitly enabled. Never throws. */
export function proxyCaptureBodiesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return env[PROXY_CAPTURE_BODIES_ENV] === "1";
  } catch {
    return false;
  }
}

/** Per-run flow-log name: `flow-{port}-{runId}.jsonl` where runId is the start timestamp (P1b). */
export function flowLogFileName(port: number, runId: number): string {
  return `flow-${port}-${runId}.jsonl`;
}

/** Delete all but the newest `keep` per-run flow logs for a port. Never throws. */
export function rotateFlowLogs(workDir: string, port: number, keep: number = FLOW_LOG_KEEP_PER_PORT): void {
  try {
    const prefix = `flow-${port}-`;
    const names = fs.readdirSync(workDir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"));
    if (names.length <= keep) return;
    const runIdOf = (name: string): number => {
      const n = Number(name.slice(prefix.length, -".jsonl".length));
      return Number.isFinite(n) ? n : 0;
    };
    names.sort((a, b) => runIdOf(a) - runIdOf(b));
    for (const stale of names.slice(0, names.length - keep)) {
      try {
        fs.unlinkSync(path.join(workDir, stale));
      } catch {
        // Best-effort.
      }
    }
  } catch {
    // Rotation must never break proxy start.
  }
}

/**
 * Generate the mitmdump addon for normalized rules. The rules are embedded as
 * a doubly-encoded JSON string literal (valid Python: JSON escapes are a
 * subset of Python string escapes), so rule bodies need no Python escaping.
 * Semantics: every request is appended to the flow log as a {"phase":
 * "request"} row and every response as a {"phase": "response"} row, correlated
 * by "flow_id" (flow.id, with a method+url fallback); failed flows get a
 * {"phase": "error"} row. The first matching rule may rewrite the request
 * (method/url/headers/body, map_remote), serve a local file instead of
 * upstream (map_local), delay the request, and mutate the response
 * (status/headers/body).
 *
 * Body capture is OFF by default and, when enabled, is embedded as a
 * CAPTURE_BODIES literal (RULES/FLOW_LOG precedent): defaultSpawn inherits
 * process.env into mitmdump, but the SpawnFn seam cannot carry env, so a
 * template literal is the deterministic plumbing. The rule generation rides
 * the same precedent (GEN literal, stamped on every row for the P2
 * generation watermark).
 */
export function buildAddon(
  rules: NetProxyRule[],
  opts: { flowLogPath?: string; captureBodies?: boolean; generation?: number } = {},
): string {
  const embedded = JSON.stringify(JSON.stringify(rules));
  const flowLog = opts.flowLogPath !== undefined ? JSON.stringify(opts.flowLogPath) : "None";
  const captureBodies = opts.captureBodies === true ? "True" : "False";
  const generation = opts.generation !== undefined && Number.isInteger(opts.generation) && opts.generation >= 0
    ? opts.generation
    : 0;
  return `# Generated by apple-debug-mcp NetProxy - do not edit.
"""Per-lease rewrite rules (first match wins per request).

Every request is appended to the flow log as a {"phase": "request"} row and
every response as a {"phase": "response"} row, correlated by "flow_id"
(flow.id, with a method+url fallback); failed flows get a {"phase": "error"}
row. The matched rule may rewrite the request, serve a local file
(map_local), delay, and mutate the response.
Regenerated on every net_proxy_start / net_proxy_set_rules / map_*.
"""
import hashlib
import json
import os
import re
import time

from mitmproxy import http

RULES = json.loads(${embedded})
FLOW_LOG = ${flowLog}
CAPTURE_BODIES = ${captureBodies}
GEN = ${generation}
BODY_CAP = 8192
FLOW_LOG_MAX_BYTES = 10485760
HEADER_VALUE_ALLOW = {"content-type", "content-length", "cache-control", "etag", "location"}
HEADER_REDACT_EXACT = {"authorization", "cookie", "set-cookie"}
HEADER_REDACT_SUFFIX = ("-token", "-secret")
JSON_SCRUB_SUBSTR = ("password", "passwd", "secret", "token", "authorization", "cookie", "session", "ssn")
TEXT_CONTENT_TYPES = {"application/json", "application/xml", "application/javascript",
                      "application/ecmascript", "application/x-www-form-urlencoded"}

_PENDING = {}
_PENDING_MAX = 4096


def _flow_key(flow):
    try:
        fid = getattr(flow, "id", "")
        if fid:
            return str(fid)
    except Exception:
        pass
    # Degenerate fallback (flow.id is standard on HTTPFlow): stable across
    # the request/response hooks so rows still correlate; concurrent
    # identical requests may share it. TS-side joins on (method,url,ts).
    try:
        return "%s %s" % (flow.request.method, flow.request.pretty_url)
    except Exception:
        return ""


def _bodies_ok():
    if not CAPTURE_BODIES or not FLOW_LOG:
        return False
    try:
        return os.path.getsize(FLOW_LOG) <= FLOW_LOG_MAX_BYTES
    except OSError:
        return True


def _content_type(headers):
    try:
        return str(headers.get("content-type", ""))
    except Exception:
        return ""


def _headers_split(headers):
    values = {}
    names = []
    redacted = []
    try:
        items = list(headers.items())
    except Exception:
        return values, names, redacted
    for k, v in items:
        try:
            name = str(k).lower()
        except Exception:
            continue
        if name in HEADER_REDACT_EXACT or name.endswith(HEADER_REDACT_SUFFIX):
            redacted.append(name)
        elif name in HEADER_VALUE_ALLOW:
            try:
                values[name] = str(v)
            except Exception:
                pass
        else:
            names.append(name)
    return values, names, redacted


def _is_text(content_type):
    ct = content_type.split(";")[0].strip().lower()
    if ct.startswith("text/") or ct in TEXT_CONTENT_TYPES:
        return True
    return ct.endswith("+json") or ct.endswith("+xml")


def _scrub_json(text):
    try:
        obj = json.loads(text)
    except Exception:
        return text

    def scrub(value):
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                if any(s in str(k).lower() for s in JSON_SCRUB_SUBSTR):
                    out[k] = "***"
                else:
                    out[k] = scrub(v)
            return out
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value

    try:
        return json.dumps(scrub(obj), ensure_ascii=False)
    except Exception:
        return text


def _body_fields(content, content_type, bodies_ok):
    size = len(content) if content else 0
    fields = {}
    if not bodies_ok or not content:
        return size, fields
    try:
        raw = bytes(content)
    except Exception:
        return size, fields
    if not _is_text(content_type):
        fields["sha"] = hashlib.sha256(raw).hexdigest()
        return size, fields
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        return size, fields
    ct = content_type.split(";")[0].strip().lower()
    if ct == "application/json" or ct.endswith("+json"):
        text = _scrub_json(text)
    encoded = text.encode("utf-8")
    if len(encoded) > BODY_CAP:
        text = encoded[:BODY_CAP].decode("utf-8", errors="replace")
        fields["truncated"] = True
    fields["text"] = text
    return size, fields


def _write(row):
    if not FLOW_LOG:
        return
    try:
        with open(FLOW_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\\n")
    except OSError:
        pass


def _remember(flow, rule_index, applied):
    try:
        if len(_PENDING) >= _PENDING_MAX:
            _PENDING.pop(next(iter(_PENDING)), None)
        _PENDING[_flow_key(flow)] = {"rule": rule_index, "applied": applied}
    except Exception:
        pass


def _take_pending(flow):
    try:
        found = _PENDING.pop(_flow_key(flow), None)
    except Exception:
        return None
    if isinstance(found, dict) and isinstance(found.get("applied"), list):
        return found
    return None


def _log(flow):
    try:
        bodies_ok = _bodies_ok()
        try:
            content = flow.request.content
        except Exception:
            content = None
        size, bf = _body_fields(content, _content_type(flow.request.headers), bodies_ok)
        values, names, redacted = _headers_split(flow.request.headers)
        row = {
            "phase": "request",
            "flow_id": _flow_key(flow),
            "ts": time.time(),
            "gen": GEN,
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "req_bytes": size,
            "headers": values,
            "header_names": names,
            "redacted_headers": redacted,
        }
        if "text" in bf:
            row["req_body"] = bf["text"]
            row["req_body_truncated"] = bool(bf.get("truncated"))
        elif "sha" in bf:
            row["req_body_sha"] = bf["sha"]
        _write(row)
    except Exception:
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
    for i, rule in enumerate(RULES):
        if _match(rule, flow):
            return i, rule
    return None, None


def request(flow):
    _log(flow)
    try:
        _request_inner(flow)
    except Exception:
        pass


def _request_inner(flow):
    index, rule = _find(flow)
    applied = []
    if rule is not None:
        action = rule.get("action") or {}
        delay = action.get("delay_ms")
        if delay:
            time.sleep(delay / 1000.0)
        req = action.get("request") or {}
        if req.get("method"):
            flow.request.method = req["method"]
            applied.append("request.method")
        if req.get("url"):
            flow.request.url = req["url"]
            applied.append("request.url")
        req_headers = req.get("headers") or {}
        if req_headers:
            for k, v in req_headers.items():
                flow.request.headers[k] = v
            applied.append("request.headers")
        if req.get("body") is not None:
            body = req["body"].encode("utf-8")
            flow.request.content = body
            flow.request.headers.pop("content-encoding", None)
            flow.request.headers["content-length"] = str(len(body))
            applied.append("request.body")
        if action.get("map_remote"):
            flow.request.url = action["map_remote"]
            applied.append("map_remote")
        if action.get("map_local"):
            try:
                with open(action["map_local"], "rb") as f:
                    content = f.read()
                flow.response = http.Response.make(200, content)
            except OSError as e:
                flow.response = http.Response.make(502, ("map_local failed: %s" % e).encode("utf-8"))
            applied.append("map_local")
    _remember(flow, index, applied)


def response(flow):
    try:
        _response_inner(flow)
    except Exception:
        pass


def _response_inner(flow):
    index, rule = _find(flow)
    applied = []
    pend = _take_pending(flow)
    if pend is not None:
        applied.extend([a for a in pend["applied"] if isinstance(a, str)])
        if index is None and isinstance(pend.get("rule"), int):
            index = pend["rule"]
    if rule is not None:
        try:
            action = rule.get("action") or {}
            resp = flow.response
            if action.get("status") is not None:
                resp.status_code = int(action["status"])
                applied.append("status")
            resp_headers = action.get("headers") or {}
            if resp_headers:
                for k, v in resp_headers.items():
                    resp.headers[k] = v
                applied.append("headers")
            if action.get("body") is not None:
                body = action["body"].encode("utf-8")
                resp.content = body
                resp.headers.pop("content-encoding", None)
                resp.headers["content-length"] = str(len(body))
                applied.append("body")
        except Exception:
            pass
    try:
        resp = flow.response
    except Exception:
        resp = None
    try:
        status_code = resp.status_code if resp is not None else None
    except Exception:
        status_code = None
    bodies_ok = _bodies_ok()
    try:
        content = resp.content if resp is not None else None
    except Exception:
        content = None
    ctype = _content_type(resp.headers) if resp is not None else ""
    size, bf = _body_fields(content, ctype, bodies_ok)
    try:
        req_content = flow.request.content
    except Exception:
        req_content = None
    if resp is not None:
        values, names, redacted = _headers_split(resp.headers)
    else:
        values, names, redacted = {}, [], []
    row = {
        "phase": "response",
        "flow_id": _flow_key(flow),
        "ts": time.time(),
        "gen": GEN,
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "status_code": status_code,
        "content_type": ctype,
        "req_bytes": len(req_content) if req_content else 0,
        "resp_bytes": size,
        "matched_rule": index,
        "applied": applied,
        "rewritten": len(applied) > 0,
        "headers": values,
        "header_names": names,
        "redacted_headers": redacted,
    }
    if "text" in bf:
        row["resp_body"] = bf["text"]
        row["resp_body_truncated"] = bool(bf.get("truncated"))
    elif "sha" in bf:
        row["resp_body_sha"] = bf["sha"]
    _write(row)


def error(flow):
    try:
        _take_pending(flow)
        try:
            method = flow.request.method
        except Exception:
            method = ""
        try:
            url = flow.request.pretty_url
        except Exception:
            url = ""
        try:
            message = str(flow.error)
        except Exception:
            message = ""
        _write({
            "phase": "error",
            "flow_id": _flow_key(flow),
            "ts": time.time(),
            "gen": GEN,
            "method": method,
            "url": url,
            "error": message,
        })
    except Exception:
        pass
`;
}

function asFlowString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFlowNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asFlowBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asFlowStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asFlowStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * Parse flow-log JSONL, skipping malformed rows (a partial last line while
 * mitmdump writes). Old 3-field rows still parse; enriched optional fields
 * are picked up only when correctly typed (tolerant parsing, P1a).
 */
export function parseFlowLog(text: string): FlowRecord[] {
  const out: FlowRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof row["method"] !== "string" || typeof row["url"] !== "string") continue;
      const record: FlowRecord = {
        ts: typeof row["ts"] === "number" ? row["ts"] : 0,
        method: row["method"],
        url: row["url"],
      };
      const phase = asFlowString(row["phase"]);
      if (phase === "request" || phase === "response" || phase === "error") record.phase = phase;
      const flowId = asFlowString(row["flow_id"]);
      if (flowId !== undefined) record.flowId = flowId;
      const gen = asFlowNumber(row["gen"]);
      if (gen !== undefined) record.gen = gen;
      const statusCode = asFlowNumber(row["status_code"]);
      if (statusCode !== undefined) record.statusCode = statusCode;
      const reqBytes = asFlowNumber(row["req_bytes"]);
      if (reqBytes !== undefined) record.reqBytes = reqBytes;
      const respBytes = asFlowNumber(row["resp_bytes"]);
      if (respBytes !== undefined) record.respBytes = respBytes;
      const contentType = asFlowString(row["content_type"]);
      if (contentType !== undefined) record.contentType = contentType;
      const matchedRule = row["matched_rule"];
      if (typeof matchedRule === "number" && Number.isFinite(matchedRule)) record.matchedRule = matchedRule;
      else if (matchedRule === null) record.matchedRule = null;
      const applied = asFlowStringArray(row["applied"]);
      if (applied !== undefined) record.applied = applied;
      const rewritten = asFlowBoolean(row["rewritten"]);
      if (rewritten !== undefined) record.rewritten = rewritten;
      const headers = asFlowStringMap(row["headers"]);
      if (headers !== undefined) record.headers = headers;
      const headerNames = asFlowStringArray(row["header_names"]);
      if (headerNames !== undefined) record.headerNames = headerNames;
      const redactedHeaders = asFlowStringArray(row["redacted_headers"]);
      if (redactedHeaders !== undefined) record.redactedHeaders = redactedHeaders;
      const reqBody = asFlowString(row["req_body"]);
      if (reqBody !== undefined) record.reqBody = reqBody;
      const reqBodyTruncated = asFlowBoolean(row["req_body_truncated"]);
      if (reqBodyTruncated !== undefined) record.reqBodyTruncated = reqBodyTruncated;
      const reqBodySha = asFlowString(row["req_body_sha"]);
      if (reqBodySha !== undefined) record.reqBodySha = reqBodySha;
      const respBody = asFlowString(row["resp_body"]);
      if (respBody !== undefined) record.respBody = respBody;
      const respBodyTruncated = asFlowBoolean(row["resp_body_truncated"]);
      if (respBodyTruncated !== undefined) record.respBodyTruncated = respBodyTruncated;
      const respBodySha = asFlowString(row["resp_body_sha"]);
      if (respBodySha !== undefined) record.respBodySha = respBodySha;
      const error = asFlowString(row["error"]);
      if (error !== undefined) record.error = error;
      out.push(record);
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

/**
 * Overlay a request row with its correlated response row (same flow_id), so
 * response-side assert filters see completed-flow state. Request-identity
 * fields (method/url/ts/headers/reqBytes) always stay the request row's;
 * only response-specific fields are overlaid, and only when defined (a null
 * matched_rule is meaningful: passthrough). Rows without a correlated
 * response row pass through unchanged.
 */
function mergeFlowResponse(request: FlowRecord, responseById: Map<string, FlowRecord>): FlowRecord {
  if (request.flowId === undefined) return request;
  const response = responseById.get(request.flowId);
  if (!response) return request;
  const merged: FlowRecord = { ...request };
  if (response.statusCode !== undefined) merged.statusCode = response.statusCode;
  if (response.respBytes !== undefined) merged.respBytes = response.respBytes;
  if (response.contentType !== undefined) merged.contentType = response.contentType;
  if (response.matchedRule !== undefined) merged.matchedRule = response.matchedRule;
  if (response.applied !== undefined) merged.applied = response.applied;
  if (response.rewritten !== undefined) merged.rewritten = response.rewritten;
  if (response.respBody !== undefined) merged.respBody = response.respBody;
  if (response.respBodyTruncated !== undefined) merged.respBodyTruncated = response.respBodyTruncated;
  if (response.respBodySha !== undefined) merged.respBodySha = response.respBodySha;
  return merged;
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

function sudoHintPf(err: unknown): string {
  const msg = (err as Error).message;
  if (/passwordless sudo/.test(msg)) return msg; // Already hinted; never double-wrap.
  if (/password is required|\bsudo\b/i.test(msg)) {
    return (
      `${msg}. QUIC blocking needs passwordless sudo for: ` +
      `pfctl -s info/-E/-X and pfctl -a ${QUIC_BLOCK_ANCHOR} -f/-F ` +
      `(ask an admin to provision a sudoers rule, then retry)`
    );
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
  quicBlocked: boolean;
  /** Resolved once per run at start; reused across rule restarts so the flag cannot flip mid-run. */
  captureBodies: boolean;
  /** Rule generation for the P2 watermark: 0 at start, ++ on every applyRules restart. */
  ruleGeneration: number;
  /** Enable-reference token from `pfctl -E`; present only when WE enabled PF. */
  pfEnableToken?: string;
  pfRulesPath?: string;
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
  private readonly captureBodiesOverride: boolean | undefined;
  private active: ActiveProxy | null = null;
  private lastRun: { flowLogPath: string } | null = null;

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
      captureBodies?: boolean;
    } = {},
  ) {
    this.bin = opts.bin ?? DEFAULT_MITMDUMP_BIN;
    this.run = opts.runner ?? defaultRunner;
    this.captureBodiesOverride = opts.captureBodies;
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
    if (!active) {
      return this.lastRun ? { running: false, lastFlowLogPath: this.lastRun.flowLogPath } : { running: false };
    }
    return {
      running: true,
      port: active.port,
      pid: active.pid,
      leaseId: active.leaseId,
      sessionId: active.sessionId,
      udid: active.udid,
      ruleCount: active.rules.length,
      quicBlocked: active.quicBlocked,
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
  async startProxy(
    udid: string,
    holder: ProxyHolder,
    rules: NetProxyRule[],
    opts?: { blockQuic?: boolean },
  ): Promise<{ port: number; pid?: number }> {
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
    const blockQuic = opts?.blockQuic === true;
    const port = await findFreePort(this.portBase);
    const snapshot = await this.snapshotHost();
    const pfWasEnabled = blockQuic ? await this.readPfEnabled() : false;
    await this.run("xcrun", ["simctl", "keychain", udid, "add-root-cert", this.caPemPath], {
      timeoutMs: this.execTimeoutMs,
    });
    fs.mkdirSync(this.workDir, { recursive: true });
    rotateFlowLogs(this.workDir, port);
    const addonPath = path.join(this.workDir, `addon-${port}.py`);
    const flowLogPath = path.join(this.workDir, flowLogFileName(port, Date.now()));
    const captureBodies = this.captureBodiesOverride ?? proxyCaptureBodiesEnabled();
    fs.writeFileSync(addonPath, buildAddon(normalized, { flowLogPath, captureBodies, generation: 0 }));
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
      this.unlinkGenerated([addonPath, flowLogPath]);
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
      this.unlinkGenerated([addonPath, flowLogPath]);
      throw new Error(`Failed to enable the host proxy (previous state restored): ${sudoHint(err)}`);
    }
    let pfRulesPath: string | undefined;
    let pfEnableToken: string | undefined;
    if (blockQuic) {
      try {
        fs.mkdirSync(this.workDir, { recursive: true });
        pfRulesPath = path.join(this.workDir, `pf-quicblock-${port}.conf`);
        fs.writeFileSync(pfRulesPath, buildQuicBlockRules());
        // Token assigned BEFORE the anchor load: if the load fails, rollback
        // still releases our enable reference instead of leaking it.
        if (!pfWasEnabled) pfEnableToken = await this.acquirePfEnable();
        await this.loadQuicAnchor(pfRulesPath);
      } catch (err) {
        let cleanupErr: unknown = null;
        try {
          await this.removeQuicBlock(pfRulesPath, pfEnableToken);
        } catch (err2) {
          cleanupErr = err2;
        }
        await stopChildQuiet(child);
        await this.restoreSnapshot(snapshot);
        this.unlinkGenerated([addonPath, flowLogPath]);
        const cleanupNote =
          cleanupErr !== null ? ` (QUIC cleanup also failed: ${(cleanupErr as Error).message})` : "";
        throw new Error(`Failed to block QUIC (previous state restored${cleanupNote}): ${sudoHintPf(err)}`);
      }
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
      quicBlocked: blockQuic,
      captureBodies,
      ruleGeneration: 0,
      pfEnableToken,
      pfRulesPath,
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
   * Poll the proxy flow log for requests matching urlRegex (+method and the
   * response-side filters). Fails cleanly when the lease holds no running
   * proxy. Returns the counts; the caller decides pass/fail against minCount.
   *
   * Watermarks (P2): under the default since:'call', only rows that started
   * after this call began (ts) and under the current rule generation match,
   * so stale flows from before the call or before a set_rules restart never
   * match; since:'run' matches every flow of this proxy run. Both watermarks
   * anchor at call start. Rows without a gen stamp (pre-P2 logs) pass the
   * generation check; the ts check still excludes them when stale.
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
    const since = spec.since ?? "call";
    if (since !== "call" && since !== "run") {
      throw new Error(`Invalid since ${JSON.stringify(since)} (expected "call" or "run")`);
    }
    const status = spec.status;
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw new Error(`Invalid status ${String(spec.status)} (expected an integer in 100..599)`);
    }
    const minBytes = spec.minBytes;
    if (minBytes !== undefined && (!Number.isInteger(minBytes) || minBytes < 0)) {
      throw new Error(`Invalid min_bytes ${String(spec.minBytes)} (expected an integer >= 0)`);
    }
    let bodyPattern: RegExp | undefined;
    if (spec.bodyRegex !== undefined) {
      if (typeof spec.bodyRegex !== "string" || spec.bodyRegex.length === 0) {
        throw new Error("Invalid body_regex (expected a non-empty string)");
      }
      try {
        bodyPattern = new RegExp(spec.bodyRegex);
      } catch {
        throw new Error(`Invalid body_regex ${JSON.stringify(spec.bodyRegex)} (not a valid regular expression)`);
      }
    }
    const rewritten = spec.rewritten;
    if (rewritten !== undefined && typeof rewritten !== "boolean") {
      throw new Error(`Invalid rewritten ${String(spec.rewritten)} (expected a boolean)`);
    }
    const rule = spec.rule;
    if (rule !== undefined && (!Number.isInteger(rule) || rule < 0)) {
      throw new Error(`Invalid rule ${String(spec.rule)} (expected an integer >= 0)`);
    }
    const sinceRun = since === "run";
    const startTs = Date.now();
    const startGen = active.ruleGeneration;
    const isNew = (f: FlowRecord): boolean =>
      f.ts * 1000 >= startTs && (sinceRun || f.gen === undefined || f.gen === startGen);
    const deadline = startTs + timeoutSec * 1000;
    for (;;) {
      const rows = readFlowLog(active.flowLogPath);
      const responseById = new Map<string, FlowRecord>();
      for (const row of rows) {
        if (row.phase === "response" && row.flowId !== undefined) responseById.set(row.flowId, row);
      }
      // Two-phase logs carry one request row plus one response/error row per
      // flow: count request rows only (phaseless old rows count as requests)
      // so one flow still counts once.
      const flows = rows.filter((f) => f.phase === undefined || f.phase === "request");
      const newSinceCall = flows.filter(isNew).length;
      const candidates = sinceRun ? flows : flows.filter(isNew);
      const matched = candidates
        .filter((f) => (method === undefined || f.method === method) && pattern.test(f.url))
        .map((f) => mergeFlowResponse(f, responseById))
        .filter(
          (f) =>
            (status === undefined || f.statusCode === status) &&
            (minBytes === undefined || (f.respBytes !== undefined && f.respBytes >= minBytes)) &&
            (bodyPattern === undefined || (f.respBody !== undefined && bodyPattern.test(f.respBody))) &&
            (rewritten === undefined || f.rewritten === rewritten) &&
            (rule === undefined || f.matchedRule === rule),
        );
      if (matched.length >= minCount || Date.now() >= deadline) {
        return { count: matched.length, total: flows.length, newSinceCall, matched: matched.slice(-10) };
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
    active.ruleGeneration += 1;
    fs.writeFileSync(
      active.addonPath,
      buildAddon(normalized, {
        flowLogPath: active.flowLogPath,
        captureBodies: active.captureBodies,
        generation: active.ruleGeneration,
      }),
    );
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
      // The replacement child may still be alive (readiness timeout, not
      // exit): stop it, or it strands with no reference holding the port.
      await stopChildQuiet(child);
      await this.restoreSnapshot(active.snapshot);
      // The proxy is gone but our PF state is not: flush the anchor and
      // release our enable reference, or the block strands host-wide with
      // no later stop able to reach it (status already reports not-running).
      if (active.quicBlocked) {
        await this.removeQuicBlock(active.pfRulesPath, active.pfEnableToken).catch((quicErr) => {
          console.error(`[netproxy] Failed to remove the QUIC block: ${(quicErr as Error).message}`);
        });
      }
      this.active = null;
      this.unlinkGenerated([active.addonPath, active.flowLogPath]);
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
  async stopProxy(leaseId: string): Promise<{ stopped: boolean; flowLogPath?: string }> {
    const active = this.active;
    if (!active) return { stopped: false };
    if (active.leaseId !== leaseId) throw new ProxyBusyError(active, "stop");
    const flowLogPath = await this.teardown(active);
    return { stopped: true, flowLogPath };
  }

  /** Unconditional best-effort stop for daemon shutdown (never throws, never rejects holders). */
  async forceStop(): Promise<{ stopped: boolean; flowLogPath?: string }> {
    const active = this.active;
    if (!active) return { stopped: false };
    const flowLogPath = await this.teardown(active);
    return { stopped: true, flowLogPath };
  }

  /**
   * Restore the host, stop the child, and archive the run: the addon is
   * deleted but the per-run flow log stays on disk (like the pcap pattern)
   * and its path is recorded for status. Returns the archived path.
   */
  private async teardown(active: ActiveProxy): Promise<string> {
    this.active = null;
    await this.restoreSnapshot(active.snapshot);
    if (active.quicBlocked) {
      await this.removeQuicBlock(active.pfRulesPath, active.pfEnableToken).catch((err) => {
        console.error(`[netproxy] Failed to remove the QUIC block: ${(err as Error).message}`);
      });
    }
    await stopChildQuiet(active.child);
    try {
      fs.unlinkSync(active.addonPath);
    } catch {
      // Best-effort.
    }
    this.lastRun = { flowLogPath: active.flowLogPath };
    return active.flowLogPath;
  }

  /** Read PF enabled-state (needs sudo; pfctl refuses /dev/pf for mortals). */
  private async readPfEnabled(): Promise<boolean> {
    try {
      const { stdout } = await this.run("sudo", ["-n", "pfctl", "-s", "info"], {
        timeoutMs: this.execTimeoutMs,
      });
      return parsePfEnabled(stdout);
    } catch (err) {
      // Nothing is mutated yet (the snapshot is read-only), so fail here
      // with the provisioning hint instead of a raw sudo error.
      throw new Error(sudoHintPf(err));
    }
  }

  /**
   * Enable PF via `pfctl -E` (not `-e`) per the contract in stock
   * /etc/pf.conf. Returns the enable-reference token, which releases only OUR
   * reference via `pfctl -X`, so a `-d`-style global disable can never kill
   * another component's filtering. The token arrives on stderr
   * (`pf enabled\nToken : <n>`), so both streams are parsed.
   */
  private async acquirePfEnable(): Promise<string> {
    const { stdout, stderr } = await this.run("sudo", ["-n", "pfctl", "-E"], { timeoutMs: this.execTimeoutMs });
    return parsePfEnableToken(`${stdout}\n${stderr}`);
  }

  /** Best-effort removal of generated work files on failure paths (never throws). */
  private unlinkGenerated(paths: (string | undefined)[]): void {
    for (const p of paths) {
      if (!p) continue;
      try {
        fs.unlinkSync(p);
      } catch {
        // Best-effort.
      }
    }
  }

  /** Load the QUIC block rules into our (evaluated) anchor. */
  private async loadQuicAnchor(rulesPath: string): Promise<void> {
    await this.run("sudo", ["-n", "pfctl", "-a", QUIC_BLOCK_ANCHOR, "-f", rulesPath], {
      timeoutMs: this.execTimeoutMs,
    });
  }

  /**
   * Flush only our anchor (never the user's ruleset) and release our PF
   * enable reference when we hold one. The flush and the release are
   * independent: either failing must not skip the other, and the rules file
   * is always unlinked. Best-effort at teardown (callers catch).
   */
  private async removeQuicBlock(rulesPath: string | undefined, pfEnableToken?: string): Promise<void> {
    let firstError: unknown;
    try {
      await this.run("sudo", ["-n", "pfctl", "-a", QUIC_BLOCK_ANCHOR, "-F", "all"], {
        timeoutMs: this.execTimeoutMs,
      });
    } catch (err) {
      firstError = err;
    }
    if (pfEnableToken !== undefined) {
      try {
        await this.run("sudo", ["-n", "pfctl", "-X", pfEnableToken], { timeoutMs: this.execTimeoutMs });
      } catch (err) {
        firstError ??= err;
      }
    }
    if (rulesPath) {
      try {
        fs.unlinkSync(rulesPath);
      } catch {
        // Best-effort.
      }
    }
    if (firstError) throw firstError;
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
