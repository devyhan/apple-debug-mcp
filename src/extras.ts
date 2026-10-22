import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_BOUND_MAX_CHARS, ExecError, tailTruncationMarker } from "./exec.js";
import { isRealLease, requireSimLease } from "./devicekind.js";
import { Llmdb, MAX_CONTINUE_WAIT_SEC, STEP_MODES, hintForDebugError, isDebugTimeoutError } from "./llmdb.js";
import { DebugStateTracker, alreadyStoppedResult, debugRobustnessEnabled, isAlreadyStoppedError, isAlreadyStoppedResponse, isWaitElapsedError, isWaitElapsedResponse, waitElapsedResult } from "./debug-robustness.js";
import { MAX_ASSERT_FLOW_SEC, MAX_PROXY_RULES } from "./netproxy.js";
import { Orchestrator } from "./orchestrator.js";
import type { AppOps } from "./appops.js";
import type { LogOps } from "./logops.js";
import { GO_IOS_INSTALL_HINT } from "./realdevices.js";
import { Lease } from "./store.js";
import { failureExtra, successExtra } from "./recovery.js";
import { Symbolicator } from "./symbolicate.js";
import { CA_DEBUG_OPTIONS, CAMERA_MIRROR_MODES, CAMERA_SOURCES, ORIENTATIONS, ServeSim } from "./servesim.js";
import { MAX_STREAM_SEC } from "./simlog.js";
import { instrumentToolcalls } from "./toolcalls.js";
import { MAX_TRACE_SEC, XCTrace } from "./xctrace.js";

export interface ExtrasDeps {
  orchestrator: Orchestrator;
  serveSim: ServeSim;
  simLog: LogOps;
  simApps: AppOps;
  xctrace: XCTrace;
  lldmdb: Llmdb;
  symbolicator?: Symbolicator;
  /** Real-device app backend (go-ios). Absent ⇒ real app verbs fail with a missing-transport error. */
  realApps?: AppOps;
  /** Real-device log backend (syslog relay). Absent ⇒ real log verbs fail with a missing-transport error. */
  realLog?: LogOps;
}

const DEBUG_REAL_DETAIL = "remote debug sessions";
const NET_REAL_DETAIL = "real-device network interception (see docs/real-device-p4.md §1): blocked on on-device manual steps with no programmatic API — (1) iPhone Wi-Fi proxy → host LAN IP:port (mitmdump binds 127.0.0.1, unreachable from the phone; `simctl keychain add-root-cert` src/netproxy.ts:1274 is sim-only), (2) manual CA-profile install + Settings > General > About > Certificate Trust Settings enablement; RVI alternative also blocked (`sudo -n true` FAILS, no rvi* in `ifconfig -l`, device Wi-Fi-only)";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown, tool?: string): ToolResult {
  // P2: additive `next` only — every key from data keeps its value.
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...(data as object), ...successExtra(tool) }, null, 2) }] };
}

function fail(message: string, tool?: string): ToolResult {
  // P2: additive recovery fields only — `error` keeps its text verbatim.
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...failureExtra(message, tool) }, null, 2) }],
    isError: true,
  };
}

/** Top-level state/stopReason (cont/step/wait). */
function stopSummary(r: unknown): Record<string, string> {
  const o = (r ?? {}) as Record<string, unknown>;
  const s: Record<string, string> = {};
  if (typeof o["state"] === "string") s["state"] = o["state"];
  const q = o["stopReason"] ?? o["stop_reason"];
  if (typeof q === "string") s["stopReason"] = q;
  return s;
}

/** Tail-truncated output text (mirrors sim_log). */
function truncateOutput(result: unknown, maxChars: number): { output: string; truncated: boolean } {
  const f = (result as { output?: unknown })?.output;
  const t = typeof result === "string" ? result : typeof f === "string" ? f : JSON.stringify(result);
  return t.length <= maxChars ? { output: t, truncated: false }
    : { output: tailTruncationMarker(t.length - maxChars) + t.slice(-maxChars), truncated: true };
}

/** Missing-binary errors get an install hint; everything else passes through. */
function serveSimError(err: unknown): string {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return `${msg}. serve-sim is not installed; run: npm install -g serve-sim (or set SERVE_SIM_BIN)`;
  }
  if (/serve-sim.*(not found|ENOENT)|spawn serve-sim/i.test(msg)) {
    return `${msg}. serve-sim is not installed; run: npm install -g serve-sim (or set SERVE_SIM_BIN)`;
  }
  return msg;
}

/** Missing-binary errors get a go-ios install hint; everything else passes through. */
function realStreamError(err: unknown): string {
  const msg = (err as Error).message;
  if (/spawn ios ENOENT|\bios\b.*ENOENT/i.test(msg)) {
    return `${msg}. go-ios (\`ios\`) is not installed; install with: ${GO_IOS_INSTALL_HINT} (or set IOS_BIN).`;
  }
  return msg;
}

/** Missing-binary errors get an install hint; everything else passes through. */
function lldmdbError(err: unknown): string {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return `${msg}. llmdb is not installed; run: brew install alexmx/tools/llmdb (or set LLMDB_BIN)`;
  }
  if (/llmdb.*(not found|ENOENT)|spawn llmdb/i.test(msg)) {
    return `${msg}. llmdb is not installed; run: brew install alexmx/tools/llmdb (or set LLMDB_BIN)`;
  }
  const hint = hintForDebugError(msg);
  return hint ? `${msg}. Hint: ${hint}` : msg;
}

/** Missing-binary errors get an install hint; everything else passes through. */
function netCaptureError(err: unknown): string {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return `${msg}. tcpdump is not installed or not on PATH (macOS ships it; or set TCPDUMP_BIN)`;
  }
  if (/tcpdump.*(not found|ENOENT)|spawn tcpdump/i.test(msg)) {
    return `${msg}. tcpdump is not installed or not on PATH (macOS ships it; or set TCPDUMP_BIN)`;
  }
  return msg;
}

function netProxyError(err: unknown): string {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return `${msg}. mitmdump is not installed; run: brew install mitmproxy (or set MITMDUMP_BIN)`;
  }
  if (/mitmdump.*(not found|ENOENT)|spawn mitmdump/i.test(msg)) {
    return `${msg}. mitmdump is not installed; run: brew install mitmproxy (or set MITMDUMP_BIN)`;
  }
  return msg;
}

const netProxyMatchSchema = z.object({
  url_regex: z
    .string()
    .min(1)
    .refine(
      (s) => {
        try {
          void new RegExp(s);
          return true;
        } catch {
          return false;
        }
      },
      "url_regex must be a valid regular expression",
    )
    .optional()
    .describe("Regex matched (search) against the full request URL. Omit to match all URLs."),
  method: z.string().min(1).optional().describe('HTTP method, e.g. "GET". Compared uppercase; omit to match all methods.'),
});

const netProxyRequestSchema = z
  .object({
    method: z.string().min(1).optional().describe("Replace the upstream request method. Compared uppercase."),
    url: z.string().min(1).optional().describe("Replace the upstream request URL wholesale (absolute http(s) URL)."),
    headers: z.record(z.string()).optional().describe("Headers merged into the upstream request (replace per-name)."),
    body: z.string().optional().describe("Replace the upstream request body (UTF-8)."),
  })
  .refine(
    (r) => r.method !== undefined || r.url !== undefined || r.headers !== undefined || r.body !== undefined,
    "request needs at least one of method|url|headers|body",
  );

const netProxyActionSchema = z.object({
  status: z.number().int().min(100).max(599).optional().describe("Override the upstream response status code."),
  headers: z.record(z.string()).optional().describe("Headers merged into the upstream response (replace per-name)."),
  body: z.string().optional().describe("Replace the upstream response body (UTF-8). Upstream content-encoding is dropped."),
  delay_ms: z.number().int().min(0).max(60000).optional().describe("Delay before forwarding the matched request, in milliseconds."),
  request: netProxyRequestSchema.optional().describe("Request-direction rewrite, applied before forwarding upstream."),
  map_local: z.string().min(1).optional().describe("Serve this local file as the response without contacting upstream."),
  map_remote: z
    .string()
    .min(1)
    .refine(
      (s) => {
        try {
          const u = new URL(s);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      },
      "map_remote must be an absolute http(s) URL",
    )
    .optional()
    .describe("Rewrite the upstream URL to this fixed URL."),
});

const netProxyRuleSchema = z
  .object({
    match: netProxyMatchSchema.optional().describe("What to match. Omit to match every request."),
    action: netProxyActionSchema.describe("What to do with the match (at least one field required)."),
  })
  .refine(
    (r) =>
      r.action.status !== undefined ||
      r.action.headers !== undefined ||
      r.action.body !== undefined ||
      r.action.delay_ms !== undefined ||
      r.action.request !== undefined ||
      r.action.map_local !== undefined ||
      r.action.map_remote !== undefined,
    "action needs at least one of status|headers|body|delay_ms|request|map_local|map_remote",
  )
  .refine(
    (r) => r.action.map_local === undefined || r.action.map_remote === undefined,
    "map_local and map_remote are mutually exclusive",
  );

const netProxyRulesSchema = z
  .array(netProxyRuleSchema)
  .max(MAX_PROXY_RULES)
  .describe("Response-rewrite rules, first match wins. Empty = transparent interception (no rewrites).");

/**
 * Phase-1 device extras: serve-sim one-shots (rotate, CoreAnimation debug
 * flags, memory warnings), synthetic camera (start/switch/mirror/status/stop),
 * unified-log capture, app lifecycle (openurl/install/uninstall/reinstall/launch/
 * terminate/cache-clear), xctrace profiling, llmdb debugging (attach/launch/break/
 * continue/run-until/wait/interrupt/bt/threads/locals/scopes/expand/eval/
 * set-var/output/step/detach/sessions/doctor, all lease-gated), atos crash
 * symbolication (optional lease), mitm network proxying (net_proxy_start/
 * set_rules/stop/status/assert_flow/map_local/map_remote, all lease-gated),
 * and the per-lease action log.
 */
export function registerDeviceExtras(server: McpServer, deps: ExtrasDeps): void {
  instrumentToolcalls(server); // P1 single choke point (idempotent; no-op when createMcpServer already wrapped this server).
  const { orchestrator: orch, serveSim, simLog, simApps, xctrace, lldmdb } = deps;
  const symbolicator = deps.symbolicator ?? new Symbolicator();
  const debugStates = new DebugStateTracker();

  /** App backend for a resolved lease: simctl for sims, go-ios + devicectl for real devices. */
  function appsFor(lease: Lease, verb: string): AppOps {
    if (!isRealLease(lease)) return simApps;
    if (!deps.realApps) {
      throw new Error(`${verb} on real-device lease ${lease.leaseId} needs the go-ios transport, which is unavailable in this embedding.`);
    }
    return deps.realApps;
  }

  /** Log backend for a udid holder: syslog relay for real leases, simctl log otherwise. */
  function logFor(holder: Lease | null, verb: string): LogOps {
    if (holder && isRealLease(holder)) {
      if (!deps.realLog) {
        throw new Error(`${verb} on real-device lease ${holder.leaseId} needs the syslog-relay transport, which is unavailable in this embedding.`);
      }
      return deps.realLog;
    }
    return simLog;
  }

  /** Leases carry at most one llmdb session; every debug verb except attach/detach needs it. */
  function requireDebugSession(lease: Lease): string {
    if (!lease.debugSessionId) {
      throw new Error(`Lease ${lease.leaseId} has no debug session attached; call debug_attach first.`);
    }
    return lease.debugSessionId;
  }

  /**
   * Run a long-blocking debug op; on client timeout best-effort auto-stop the
   * lease's session (via the orchestrator's shared stop path, never duplicated
   * here) and rethrow with a re-attach hint. Non-timeout errors pass through.
   */
  async function withDebugTimeoutGuard<T>(leaseId: string, sessionId: string, op: () => Promise<T>, opName = "debug"): Promise<T> {
    try {
      return await op();
    } catch (err) {
      // D1.1 (gated): wait-elapsed / already-stopped are structured ok, never auto-stop.
      try {
        if (debugRobustnessEnabled()) {
          if (isAlreadyStoppedError(err)) {
            const skipped = alreadyStoppedResult();
            debugStates.updateFromResult(sessionId, skipped);
            return skipped as unknown as T;
          }
          if (isWaitElapsedError(err)) {
            const synth = waitElapsedResult(opName, (err as Error)?.message);
            debugStates.updateFromResult(sessionId, synth);
            return synth as unknown as T;
          }
        }
      } catch {
        // fall through to legacy handling.
      }
      if (!isDebugTimeoutError(err)) throw err;
      let stopped = false;
      let autoId: string | null = null;
      try {
        ({ stopped, sessionId: autoId } = await orch.autoStopDebugSession(leaseId, sessionId));
      } catch {
        // autoStopDebugSession never throws; the timeout error below is what matters.
      }
      try {
        debugStates.clear(sessionId);
      } catch {
        // tracking must never break the tool path.
      }
      const what = stopped
        ? `debug session ${autoId} auto-stopped`
        : autoId !== null
          ? `debug session ${autoId} left attached`
          : "no debug session remained to auto-stop";
      throw new Error(`${(err as Error).message}. Hint: client timeout (${what}); call debug_attach to open a new session`);
    }
  }

  /** Mirrors sim_shutdown: leased sims need force=true. Returns the holder (if any). */
  async function leaseGate(
    udid: string,
    force: boolean | undefined,
    real?: { verb: string; detail: string },
  ): Promise<{ holder: Lease | null; refusal: ToolResult | null }> {
    const holder = await orch.leaseForUdid(udid);
    if (holder && real) {
      try {
        requireSimLease(holder, { verb: real.verb, phase: "sim-only", detail: real.detail });
      } catch (err) {
        return { holder, refusal: fail((err as Error).message, real.verb) };
      }
    }
    if (holder && !force) {
      return {
        holder,
        refusal: fail(
          `Simulator ${udid} is leased to session ${holder.sessionId} (lease ${holder.leaseId}). Pass force=true to proceed anyway.`,
          real?.verb,
        ),
      };
    }
    return { holder, refusal: null };
  }

  server.registerTool(
    "sim_rotate",
    {
      title: "Rotate display",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to rotate a simulator display. INSTEAD OF `serve-sim rotate -d UDID <orientation>`. Rotate a simulator display via serve-sim. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        orientation: z.enum(ORIENTATIONS).describe("Target orientation."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, orientation, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force, { verb: "sim_rotate", detail: "serve-sim display rotation" });
        if (refusal) return refusal;
        await serveSim.rotate(udid, orientation);
        if (holder) await orch.logAction(holder.leaseId, "sim_rotate", `rotate ${orientation}${force ? " (force)" : ""}`);
        return ok({ udid, orientation }, "sim_rotate");
      } catch (err) {
        return fail(serveSimError(err), "sim_rotate");
      }
    },
  );

  server.registerTool(
    "sim_ca_debug",
    {
      title: "Toggle CA debug",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to toggle a CoreAnimation debug visualization. INSTEAD OF `serve-sim ca-debug -d UDID <option> <on|off>`. Toggle a CoreAnimation debug visualization via serve-sim. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        option: z.enum(CA_DEBUG_OPTIONS).describe("Debug visualization to toggle."),
        enabled: z.boolean().describe("true = on, false = off."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, option, enabled, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force, { verb: "sim_ca_debug", detail: "serve-sim CoreAnimation debug flags" });
        if (refusal) return refusal;
        const state = enabled ? "on" : "off";
        await serveSim.caDebug(udid, option, state);
        if (holder) await orch.logAction(holder.leaseId, "sim_ca_debug", `ca-debug ${option} ${state}${force ? " (force)" : ""}`);
        return ok({ udid, option, enabled }, "sim_ca_debug");
      } catch (err) {
        return fail(serveSimError(err), "sim_ca_debug");
      }
    },
  );

  server.registerTool(
    "sim_memory_warning",
    {
      title: "Memory warning",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to simulate a memory warning. INSTEAD OF `serve-sim memory-warning -d UDID`. Simulate a memory warning on a simulator via serve-sim. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force, { verb: "sim_memory_warning", detail: "serve-sim memory warnings" });
        if (refusal) return refusal;
        await serveSim.memoryWarning(udid);
        if (holder) await orch.logAction(holder.leaseId, "sim_memory_warning", `memory-warning${force ? " (force)" : ""}`);
        return ok({ udid, memoryWarning: true }, "sim_memory_warning");
      } catch (err) {
        return fail(serveSimError(err), "sim_memory_warning");
      }
    },
  );

  server.registerTool(
    "camera_start",
    {
      title: "Start camera feed",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to launch an app with a fake or synthetic camera feed (placeholder, webcam, or file). INSTEAD OF `serve-sim camera <bundle-id> -d UDID [--file PATH | --webcam [name]]`. Launch an app with a synthetic serve-sim camera feed (placeholder, host webcam, or image/video file). Relaunches the app; needs a debuggable (get-task-allow) build. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        bundle_id: z.string().describe("App bundle id to launch with the injected feed."),
        source: z.enum(CAMERA_SOURCES).optional().describe("Feed source. Default placeholder."),
        file: z.string().optional().describe("Image/video path. Required when source is file."),
        webcam: z
          .string()
          .optional()
          .describe("Webcam name (see `serve-sim camera --list-webcams`). Only with source webcam; default camera when omitted."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, bundle_id, source, file, webcam, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force, { verb: "camera_start", detail: "serve-sim synthetic camera feed injection" });
        if (refusal) return refusal;
        await serveSim.start(udid, bundle_id, { source, file, webcam });
        if (holder) {
          await orch.logAction(holder.leaseId, "camera_start", `camera ${bundle_id} ${source ?? "placeholder"}${force ? " (force)" : ""}`);
        }
        return ok({ udid, bundle_id, source: source ?? "placeholder" }, "camera_start");
      } catch (err) {
        return fail(serveSimError(err), "camera_start");
      }
    },
  );

  server.registerTool(
    "camera_switch",
    {
      title: "Switch camera feed",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to hot-swap a running camera feed without relaunching. INSTEAD OF `serve-sim camera switch <source> [file] -d UDID`. Hot-swap a running serve-sim camera feed without relaunching the app. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        source: z.enum(CAMERA_SOURCES).describe("Feed source to switch to."),
        file: z.string().optional().describe("Image/video path. Required when source is file."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, source, file, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force, { verb: "camera_switch", detail: "serve-sim synthetic camera feed injection" });
        if (refusal) return refusal;
        await serveSim.switchSource(udid, source, file);
        if (holder) await orch.logAction(holder.leaseId, "camera_switch", `switch ${source}${force ? " (force)" : ""}`);
        return ok({ udid, source }, "camera_switch");
      } catch (err) {
        return fail(serveSimError(err), "camera_switch");
      }
    },
  );

  server.registerTool(
    "camera_mirror",
    {
      title: "Mirror camera preview",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to set camera preview mirroring. INSTEAD OF `serve-sim camera mirror <mode> -d UDID`. Set preview mirroring (auto|on|off) for a running serve-sim camera feed. Read-only vs leases.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        mode: z.enum(CAMERA_MIRROR_MODES).describe("Preview mirroring mode."),
      },
    },
    async ({ udid, mode }) => {
      try {
        const holder = await orch.leaseForUdid(udid);
        if (holder) requireSimLease(holder, { verb: "camera_mirror", phase: "sim-only", detail: "serve-sim camera preview mirroring" });
        await serveSim.mirror(udid, mode);
        return ok({ udid, mode }, "camera_mirror");
      } catch (err) {
        return fail(serveSimError(err), "camera_mirror");
      }
    },
  );

  server.registerTool(
    "camera_status",
    {
      title: "Camera status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to check camera helper state. INSTEAD OF `serve-sim camera status -d UDID`. Show a simulator's serve-sim camera helper state ({alive:false} when idle).",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
      },
    },
    async ({ udid }) => {
      try {
        const s = await serveSim.status(udid);
        return ok({ udid, ...s }, "camera_status");
      } catch (err) {
        return fail(serveSimError(err), "camera_status");
      }
    },
  );

  server.registerTool(
    "camera_stop",
    {
      title: "Stop camera",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to stop the camera helper. INSTEAD OF `serve-sim camera --stop-webcam -d UDID`. Stop a simulator's serve-sim camera helper (terminates injected apps). Idempotent.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
      },
    },
    async ({ udid }) => {
      try {
        await serveSim.stop(udid);
        return ok({ udid, stopped: true }, "camera_stop");
      } catch (err) {
        return fail(serveSimError(err), "camera_stop");
      }
    },
  );

  server.registerTool(
    "sim_log_stream",
    {
      title: "Stream logs",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to watch live logs, tail, stream, or follow console output. INSTEAD OF `xcrun simctl spawn UDID log stream --style compact --level LEVEL [--predicate ...]` on sims, or `ios syslog --udid=UDID` on real devices. Capture live log output for a bounded window: unified log on a simulator (xcrun simctl spawn log stream), syslog relay on a real-device lease (go-ios; predicate/process are client-side substring/regex filters there, level is rejected).",
      inputSchema: {
        udid: z.string().describe("Simulator or device UDID."),
        predicate: z.string().optional().describe("Log predicate filter, e.g. 'process == \"MyApp\"'."),
        process: z.string().optional().describe("Process-name shorthand, e.g. \"Preferences\". ANDed with predicate."),
        level: z.enum(["default", "info", "debug"]).optional().describe("Log level filter. Default default."),
        timeout_sec: z.number().positive().max(MAX_STREAM_SEC).optional().describe("Capture window in seconds. Default 5, max 60."),
        max_chars: z.number().int().positive().optional().describe("Truncate output (tail kept). Default 20000."),
      },
    },
    async ({ udid, predicate, process, level, timeout_sec, max_chars }) => {
      try {
        const holder = await orch.leaseForUdid(udid);
        const r = await logFor(holder, "sim_log_stream").stream(udid, {
          predicate,
          process,
          level,
          timeoutSec: timeout_sec ?? 5,
          maxChars: max_chars,
        });
        return ok({ udid, log: r.stdout, truncated: r.truncated, timedOut: r.timedOut }, "sim_log_stream");
      } catch (err) {
        return fail((err as Error).message, "sim_log_stream");
      }
    },
  );

  server.registerTool(
    "sim_log_show",
    {
      title: "Show log history",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to read past log history. INSTEAD OF `xcrun simctl spawn UDID log show --style compact --last WINDOW [--info/--debug/--signpost]` (sims only; real devices have no history). Show recent historical unified-log output from a simulator (xcrun simctl spawn log show --last). Real-device leases have no history (live-only relay): use sim_log_stream.",
      inputSchema: {
        udid: z.string().describe("Simulator or device UDID."),
        last: z.string().optional().describe('Historical window, e.g. "30s", "5m", "2h". Default "5m".'),
        predicate: z.string().optional().describe("Log predicate filter, e.g. 'process == \"MyApp\"'."),
        process: z.string().optional().describe("Process-name shorthand, e.g. \"Preferences\". ANDed with predicate."),
        info: z.boolean().optional().describe("Include info-level messages (--info)."),
        debug: z.boolean().optional().describe("Include debug messages (--debug)."),
        signpost: z.boolean().optional().describe("Include signposts (--signpost)."),
        max_chars: z.number().int().positive().optional().describe("Truncate output (tail kept). Default 20000."),
      },
    },
    async ({ udid, last, predicate, process, info, debug, signpost, max_chars }) => {
      try {
        const holder = await orch.leaseForUdid(udid);
        const r = await logFor(holder, "sim_log_show").show(udid, {
          last: last ?? "5m",
          predicate,
          process,
          info,
          debug,
          signpost,
          maxChars: max_chars,
        });
        return ok({ udid, log: r.stdout, truncated: r.truncated, timedOut: r.timedOut }, "sim_log_show");
      } catch (err) {
        return fail((err as Error).message, "sim_log_show");
      }
    },
  );

  server.registerTool(
    "stream_start",
    {
      title: "Start screen stream",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to watch the live screen as an MJPEG stream. INSTEAD OF `serve-sim --detach UDID --port PORT` on sims, or `ios screenshot --stream --udid=UDID` on real devices. Start (or reuse) a live MJPEG stream for your lease: a serve-sim helper on a scanned port for simulators (idempotent); the single go-ios :3333 feed for real-device leases (single-flight across the host — one real stream at a time, ~2fps).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      let mapError = serveSimError;
      try {
        const held = await orch.leaseById(lease_id);
        if (held && isRealLease(held)) mapError = realStreamError;
        const { lease, url, port } = await orch.startLeaseStream(lease_id);
        await orch.logAction(lease_id, "stream_start", `stream ${url}`);
        return ok({ lease_id, udid: lease.udid, url, port }, "stream_start");
      } catch (err) {
        return fail(mapError(err), "stream_start");
      }
    },
  );

  server.registerTool(
    "stream_stop",
    {
      title: "Stop screen stream",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to stop the live screen stream. INSTEAD OF `serve-sim --kill UDID`. Stop the live stream for your lease. Idempotent: stopping twice succeeds.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      let mapError = serveSimError;
      try {
        const held = await orch.leaseById(lease_id);
        if (held && isRealLease(held)) mapError = realStreamError;
        const { lease, stopped } = await orch.stopLeaseStream(lease_id);
        await orch.logAction(lease_id, "stream_stop", stopped ? "stream stopped" : "stream already stopped");
        return ok({ lease_id, udid: lease.udid, stopped }, "stream_stop");
      } catch (err) {
        return fail(mapError(err), "stream_stop");
      }
    },
  );

  server.registerTool(
    "app_open_url",
    {
      title: "Open URL",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: "WHEN you want to open a URL or deep link in the stock handler. INSTEAD OF `xcrun simctl openurl UDID URL` on sims, or `xcrun devicectl device process launch --device UDID --payload-url URL com.apple.mobilesafari` on real devices. Open a URL on your lease (xcrun simctl openurl stock handler on a simulator; http(s) via Safari on a real-device lease, other schemes stay P2).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        url: z.string().min(1).describe("URL to open, e.g. https://www.apple.com."),
      },
    },
    async ({ lease_id, url }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await appsFor(lease, "app_open_url").openUrl(lease.udid, url);
        await orch.logAction(lease_id, "app_open_url", `open ${url.slice(0, 120)}`);
        return ok({ lease_id, udid: lease.udid, url }, "app_open_url");
      } catch (err) {
        return fail((err as Error).message, "app_open_url");
      }
    },
  );

  server.registerTool(
    "app_install",
    {
      title: "Install app",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to install an .app bundle. INSTEAD OF `xcrun simctl install UDID <app-path>` on sims, or `ios install --path=<app-path> --udid=UDID` on real devices. Install an .app bundle onto your lease (xcrun simctl install on a simulator, go-ios install on a real-device lease).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        app_path: z.string().min(1).describe("Host path to the .app bundle to install."),
      },
    },
    async ({ lease_id, app_path }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await appsFor(lease, "app_install").install(lease.udid, app_path);
        await orch.logAction(lease_id, "app_install", `install ${path.basename(app_path).slice(0, 120)}`);
        return ok({ lease_id, udid: lease.udid, app_path }, "app_install");
      } catch (err) {
        return fail((err as Error).message, "app_install");
      }
    },
  );

  server.registerTool(
    "app_uninstall",
    {
      title: "Uninstall app",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to remove or uninstall an app. INSTEAD OF `xcrun simctl uninstall UDID <bundle-id>` on sims, or `ios uninstall <bundle-id> --udid=UDID` on real devices. Remove an app from your lease (xcrun simctl uninstall on a simulator, go-ios uninstall on a real-device lease).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to remove, e.g. com.example.App."),
      },
    },
    async ({ lease_id, bundle_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await appsFor(lease, "app_uninstall").uninstall(lease.udid, bundle_id);
        await orch.logAction(lease_id, "app_uninstall", `uninstall ${bundle_id}`);
        return ok({ lease_id, udid: lease.udid, bundle_id }, "app_uninstall");
      } catch (err) {
        return fail((err as Error).message, "app_uninstall");
      }
    },
  );

  server.registerTool(
    "app_reinstall",
    {
      title: "Reinstall app",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to reinstall an app wiped fresh (logout expected). INSTEAD OF the `xcrun simctl uninstall` + `xcrun simctl install` pair (or the `ios uninstall` + `ios install` pair on real devices) in one call. Reinstall an app on your lease: uninstall then install from app_path in one call (xcrun simctl on a simulator, go-ios on a real-device lease). WIPES Documents/Keychain and logs out — the opposite of app_cache_clear. Requires confirm_data_loss: true.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to remove and reinstall, e.g. com.example.App."),
        app_path: z.string().min(1).describe("Host path to the .app bundle to install after removal."),
        confirm_data_loss: z
          .literal(true, {
            errorMap: () => ({
              message:
                "app_reinstall refused: pass confirm_data_loss: true — reinstall wipes Documents/Keychain and logs out",
            }),
          })
          .describe("Must be true: reinstall wipes Documents/Keychain (logs out). Refused otherwise, before any spawn."),
      },
    },
    async ({ lease_id, bundle_id, app_path }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        // Same backend path each verb uses today: simctl via SimApps for sim
        // leases, go-ios via RealDeviceApps for real leases (appsFor dispatch).
        // No terminate-first: uninstall removes a running app on both backends,
        // while terminate would fail on a non-running app for zero benefit.
        const apps = appsFor(lease, "app_reinstall");
        await apps.uninstall(lease.udid, bundle_id);
        try {
          await apps.install(lease.udid, app_path);
        } catch (err) {
          // Non-atomic by nature: the app is already gone. Name the half-state
          // and keep the backend's own text verbatim (device errors are never
          // reframed as a missing binary). The app is not running, so the
          // lease-launched claim is dropped exactly like terminate.
          orch.markAppTerminated(lease_id, bundle_id);
          await orch.logAction(lease_id, "app_reinstall", `reinstall ${bundle_id} HALF-STATE (removed, install failed)`);
          return fail(`app_reinstall half-state: app ${bundle_id} was removed but install failed: ${(err as Error).message}`, "app_reinstall");
        }
        orch.markAppTerminated(lease_id, bundle_id);
        await orch.logAction(lease_id, "app_reinstall", `reinstall ${bundle_id} from ${path.basename(app_path).slice(0, 120)}`);
        return ok({ lease_id, udid: lease.udid, bundle_id, uninstalled: true, installed: true, logged_out: true }, "app_reinstall");
      } catch (err) {
        return fail((err as Error).message, "app_reinstall");
      }
    },
  );

  server.registerTool(
    "app_launch",
    {
      title: "Launch app",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to launch an app by bundle id. INSTEAD OF `xcrun simctl launch UDID <bundle-id> [args]` on sims, or `ios launch <bundle-id> --arg=... --udid=UDID` on real devices. Launch an app by bundle id on your lease (xcrun simctl launch on a simulator, go-ios launch on a real-device lease). Returns its pid.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to launch, e.g. com.apple.Preferences."),
        args: z.array(z.string()).optional().describe("Argv passed to the app."),
      },
    },
    async ({ lease_id, bundle_id, args }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { pid, output } = await appsFor(lease, "app_launch").launch(lease.udid, bundle_id, args ?? []);
        orch.markAppLaunched(lease_id, bundle_id);
        await orch.logAction(lease_id, "app_launch", `launch ${bundle_id} (pid ${pid})`);
        return ok({ lease_id, udid: lease.udid, bundle_id, pid, output }, "app_launch");
      } catch (err) {
        return fail((err as Error).message, "app_launch");
      }
    },
  );

  server.registerTool(
    "app_terminate",
    {
      title: "Terminate app",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to terminate or kill a running app. INSTEAD OF `xcrun simctl terminate UDID <bundle-id>` on sims, or `ios kill <bundle-id> --udid=UDID` on real devices. Terminate an app by bundle id on your lease (xcrun simctl terminate on a simulator, go-ios kill on a real-device lease).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to terminate, e.g. com.apple.Preferences."),
      },
    },
    async ({ lease_id, bundle_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await appsFor(lease, "app_terminate").terminate(lease.udid, bundle_id);
        orch.markAppTerminated(lease_id, bundle_id);
        await orch.logAction(lease_id, "app_terminate", `terminate ${bundle_id}`);
        return ok({ lease_id, udid: lease.udid, bundle_id }, "app_terminate");
      } catch (err) {
        return fail((err as Error).message, "app_terminate");
      }
    },
  );

  server.registerTool(
    "app_cache_clear",
    {
      title: "Clear app cache",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to clear an app's caches without logging out. INSTEAD OF `xcrun simctl terminate` + `xcrun simctl get_app_container` + removing Library/Caches on sims, or `ios fsync tree/rm --app=<bid> --udid=UDID --path=...` on real devices. Clear an app's Library/Caches on your lease without logging out (terminates the app first; never touches Documents/Keychain; relaunch left to caller). Real-device leases clear via ios fsync on developer-profile installs (device-side ios-fsync:// paths; plist_keys refused); container-denied apps fail fast with a precise P2.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id whose caches to clear, e.g. com.example.App."),
        plist_keys: z
          .array(
            z.object({
              plist: z.string().min(1).describe("Plist path relative to the app data container, e.g. Library/Preferences/com.example.plist."),
              keys: z.array(z.string().min(1)).min(1).describe("Keys to remove from the plist."),
            }),
          )
          .optional()
          .describe("Optional targeted plist keys (e.g. throttle state). Documents/Keychain targets are refused."),
      },
    },
    async ({ lease_id, bundle_id, plist_keys }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const r = await appsFor(lease, "app_cache_clear").clearCache(lease.udid, bundle_id, { plistKeys: plist_keys });
        orch.markAppTerminated(lease_id, bundle_id);
        await orch.logAction(lease_id, "app_cache_clear", `cache-clear ${bundle_id} (${r.deletedCount} removed)`);
        return ok({
          lease_id,
          udid: lease.udid,
          bundle_id,
          container: r.container,
          caches_dir: r.cachesDir,
          deleted: r.deleted,
          deleted_count: r.deletedCount,
          plist_keys_removed: r.plistKeysRemoved,
          terminated: r.terminated,
          errors: r.errors,
        }, "app_cache_clear");
      } catch (err) {
        return fail((err as Error).message, "app_cache_clear");
      }
    },
  );

  server.registerTool(
    "profile_trace",
    {
      title: "Record trace",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to profile CPU or record a trace. INSTEAD OF `xcrun xctrace record --template NAME --device UDID [--attach PID | --all-processes] --time-limit Ns --no-prompt --output PATH`. Record a bounded xctrace profile (Time Profiler by default) on your leased simulator or real device and save the .trace file. Real devices must be paired/trusted with Developer Mode on; prefer attach there (--attach resolves on hardware, unlike sims).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        duration_sec: z.number().positive().max(MAX_TRACE_SEC).optional().describe("Recording length in seconds. Default 5, max 60."),
        template: z.string().optional().describe("xctrace template name or path. Default \"Time Profiler\"."),
        attach: z.union([z.string(), z.number()]).optional().describe("PID or process name for xctrace --attach. Omit for all-processes (recommended: simulator app processes usually fail attach lookup)."),
        output_dir: z.string().optional().describe("Directory for the .trace file. Default the OS temp dir."),
      },
    },
    async ({ lease_id, duration_sec, template, attach, output_dir }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const dir = output_dir ?? path.join(os.tmpdir(), "sim-mcp-traces");
        const output = path.join(dir, `${lease.udid}-${Date.now()}.trace`);
        const { template: used } = await xctrace.record(lease.udid, output, {
          template,
          attach,
          timeLimitSec: duration_sec ?? 5,
        });
        await orch.logAction(lease_id, "profile_trace", `trace ${used} ${duration_sec ?? 5}s -> ${path.basename(output)}`);
        return ok({ lease_id, udid: lease.udid, path: output, template: used, duration_sec: duration_sec ?? 5 }, "profile_trace");
      } catch (err) {
        return fail((err as Error).message, "profile_trace");
      }
    },
  );

  server.registerTool(
    "debug_attach",
    {
      title: "Attach debugger",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to attach the debugger to a running app or pid. INSTEAD OF `llmdb attach --app <bundle-id>` or `llmdb attach --pid <pid>`. Attach the llmdb debugger to a running target for your lease (one session per lease; re-attaching replaces it). Needs a debuggable (get-task-allow) build; stock Apple apps refuse attach.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().optional().describe("App bundle id running in the booted Simulator (exactly one of bundle_id or pid)."),
        pid: z.number().int().positive().optional().describe("Host pid to attach to (exactly one of bundle_id or pid)."),
      },
    },
    async ({ lease_id, bundle_id, pid }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_attach", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const { sessionId, response } = await lldmdb.attach({ bundleId: bundle_id, pid });
        try {
          if (debugRobustnessEnabled()) debugStates.markAttached(sessionId, response);
        } catch {
          // tracking must never break the tool path.
        }
        const replaced = await orch.setDebugSession(lease_id, sessionId);
        if (replaced && replaced !== sessionId) {
          try {
            debugStates.clear(replaced);
          } catch {
            // tracking must never break the tool path.
          }
          try {
            await lldmdb.stop(replaced);
          } catch {
            // The replaced session is already gone; the new attach wins regardless.
          }
        }
        const target = bundle_id !== undefined ? bundle_id : `pid ${pid}`;
        await orch.logAction(lease_id, "debug_attach", `attach ${target} (session ${sessionId})`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result: response }, "debug_attach");
      } catch (err) {
        return fail(lldmdbError(err), "debug_attach");
      }
    },
  );

  server.registerTool(
    "debug_break",
    {
      title: "Manage breakpoints",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to set, list, delete, or clear breakpoints or exception filters. INSTEAD OF `llmdb break set <file:line> [--condition ...] [--hit-condition ...] --session S`, `llmdb break list|delete --session S`, or `llmdb break exception --session S`. Manage breakpoints in your lease's debug session. Exactly one op per call: set (file+line for one, or breakpoints=[...] for several, with optional condition/hit_condition), list (list=true), delete (delete=<id> or [<ids>]), or exception filters (exception=[...], [] clears).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        file: z.string().min(1).optional().describe("Source file path for set, e.g. ./Sources/App/main.swift."),
        line: z.number().int().positive().optional().describe("1-based line number for set."),
        breakpoints: z
          .array(
            z.object({
              file: z.string().min(1).describe("Source file path, e.g. ./Sources/App/main.swift."),
              line: z.number().int().positive().describe("1-based line number."),
              condition: z.string().min(1).optional().describe("Fire only when this expression is true."),
              hit_condition: z.string().min(1).optional().describe("Fire on a hit-count match, e.g. >5 or 3."),
            }),
          )
          .min(1)
          .optional()
          .describe("Set only: set several breakpoints with one call (alternative to file+line)."),
        list: z.boolean().optional().describe("List breakpoints in the session."),
        delete: z
          .union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)])
          .optional()
          .describe("Delete the breakpoint with this id, or several with an array of ids."),
        exception: z
          .array(z.string().min(1))
          .optional()
          .describe("Stop on thrown exceptions: filter ids to enable (e.g. [\"swift_throw\"]), [] to clear."),
        condition: z.string().min(1).optional().describe("Set only: fire only when this expression is true, e.g. n > 100."),
        hit_condition: z.string().min(1).optional().describe("Set only: fire on a hit-count match, e.g. >5 or 3."),
      },
    },
    async ({ lease_id, file, line, breakpoints, list, delete: del, exception, condition, hit_condition }) => {
      try {
        const ops = [
          list === true ? "list" : null,
          del !== undefined ? "delete" : null,
          exception !== undefined ? "exception" : null,
          file !== undefined || line !== undefined || breakpoints !== undefined ||
            condition !== undefined || hit_condition !== undefined
            ? "set"
            : null,
        ].filter((op): op is string => op !== null);
        if (ops.length === 0) {
          return fail("debug_break needs exactly one op: set (file+line), list=true, delete=<id>, or exception=[...].", "debug_break");
        }
        if (ops.length > 1) {
          return fail(`debug_break takes exactly one op per call (got ${ops.join("+")}).`, "debug_break");
        }
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_break", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const op = ops[0]!;
        if (op === "list") {
          const result = await lldmdb.breakList(sessionId);
          await orch.logAction(lease_id, "debug_break", "break list");
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result }, "debug_break");
        }
        if (op === "delete") {
          const ids = del as number | number[];
          const result = Array.isArray(ids)
            ? await lldmdb.breakDeleteMany(sessionId, ids)
            : await lldmdb.breakDelete(sessionId, ids);
          await orch.logAction(lease_id, "debug_break", `break delete ${Array.isArray(ids) ? ids.join(",") : ids}`);
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result }, "debug_break");
        }
        if (op === "exception") {
          const result = await lldmdb.breakException(sessionId, exception as string[]);
          const summary = (exception as string[]).length === 0 ? "break exception (clear)" : `break exception ${(exception as string[]).join(",")}`;
          await orch.logAction(lease_id, "debug_break", summary.slice(0, 160));
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result }, "debug_break");
        }
        if (breakpoints !== undefined) {
          if (file !== undefined || line !== undefined || condition !== undefined || hit_condition !== undefined) {
            return fail("debug_break set takes either file+line or breakpoints=[...], not both.", "debug_break");
          }
          const result = await lldmdb.breakSetMany(
            sessionId,
            breakpoints.map((b) => ({
              file: b.file,
              line: b.line,
              ...(b.condition !== undefined ? { condition: b.condition } : {}),
              ...(b.hit_condition !== undefined ? { hitCondition: b.hit_condition } : {}),
            })),
          );
          await orch.logAction(lease_id, "debug_break", `break set x${breakpoints.length}`.slice(0, 160));
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result }, "debug_break");
        }
        if (file === undefined || line === undefined) {
          return fail("debug_break set needs both file and line.", "debug_break");
        }
        const result = await lldmdb.breakSet(sessionId, file, line, {
          ...(condition !== undefined ? { condition } : {}),
          ...(hit_condition !== undefined ? { hitCondition: hit_condition } : {}),
        });
        const extras = [
          condition !== undefined ? ` if ${condition}` : "",
          hit_condition !== undefined ? ` hit ${hit_condition}` : "",
        ].join("");
        await orch.logAction(lease_id, "debug_break", `break ${file}:${line}${extras}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result }, "debug_break");
      } catch (err) {
        return fail(lldmdbError(err), "debug_break");
      }
    },
  );

  server.registerTool(
    "debug_continue",
    {
      title: "Continue execution",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to resume or continue execution until the next stop. INSTEAD OF `llmdb continue --wait N --session S`. Resume execution until the next stop (or the wait elapses). A client timeout auto-stops the session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        wait_sec: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Block up to this many seconds for the next stop. Default 60, max 600."),
      },
    },
    async ({ lease_id, wait_sec }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_continue", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await withDebugTimeoutGuard(lease_id, sessionId, () => lldmdb.cont(sessionId, wait_sec ?? 60), "continue");
        let waitElapsed = false;
        try {
          if (debugRobustnessEnabled()) {
            debugStates.updateFromResult(sessionId, result);
            waitElapsed = isWaitElapsedResponse(result);
          }
        } catch {
          // tracking must never break the tool path.
        }
        await orch.logAction(lease_id, "debug_continue", `continue (wait ${wait_sec ?? 60}s)`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, ...stopSummary(result), ...(waitElapsed ? { wait_elapsed: true } : {}), result }, "debug_continue");
      } catch (err) {
        return fail(lldmdbError(err), "debug_continue");
      }
    },
  );

  server.registerTool(
    "debug_bt",
    {
      title: "Backtrace",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want a backtrace of the stopped thread. INSTEAD OF `llmdb bt [--thread T] [--depth N] --session S`. Structured backtrace for the stopped thread (or an explicit thread id) in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        depth: z.number().int().positive().optional().describe("Maximum stack depth. Default full stack."),
        thread: z.number().int().positive().optional().describe("Thread id (see debug_threads). Default the stopped thread."),
      },
    },
    async ({ lease_id, depth, thread }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_bt", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.backtrace(sessionId, depth, thread);
        const qualifiers = [
          thread !== undefined ? `thread ${thread}` : "",
          depth !== undefined ? `depth ${depth}` : "",
        ].filter((s) => s.length > 0);
        await orch.logAction(lease_id, "debug_bt", qualifiers.length > 0 ? `bt (${qualifiers.join(", ")})` : "bt");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_bt");
      } catch (err) {
        return fail(lldmdbError(err), "debug_bt");
      }
    },
  );

  server.registerTool(
    "debug_locals",
    {
      title: "List locals",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want typed locals for a stack frame. INSTEAD OF `llmdb locals --frame N --session S`. Typed locals for a stack frame in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_locals", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.locals(sessionId, frame ?? 0);
        await orch.logAction(lease_id, "debug_locals", `locals (frame ${frame ?? 0})`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_locals");
      } catch (err) {
        return fail(lldmdbError(err), "debug_locals");
      }
    },
  );

  server.registerTool(
    "debug_eval",
    {
      title: "Evaluate expression",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to eval or evaluate an expression in a frame. INSTEAD OF `llmdb expr <expression> --frame N --session S`. Evaluate an expression in the context of a frame in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        expr: z.string().min(1).describe("Expression to evaluate, e.g. self.state.count."),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, expr, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_eval", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.eval(sessionId, expr, frame ?? 0);
        await orch.logAction(lease_id, "debug_eval", `eval ${JSON.stringify(expr.slice(0, 80))}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_eval");
      } catch (err) {
        return fail(lldmdbError(err), "debug_eval");
      }
    },
  );

  server.registerTool(
    "debug_step",
    {
      title: "Step line",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to step one source line (over, in, or out). INSTEAD OF `llmdb step --over|--in|--out --session S`. Step one source line in your lease's debug session: over (default) | in | out.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        mode: z.enum(STEP_MODES).optional().describe("Step mode. Default over."),
      },
    },
    async ({ lease_id, mode }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_step", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.step(sessionId, mode ?? "over");
        try {
          if (debugRobustnessEnabled()) debugStates.updateFromResult(sessionId, result);
        } catch {
          // tracking must never break the tool path.
        }
        await orch.logAction(lease_id, "debug_step", `step ${mode ?? "over"}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, ...stopSummary(result), result }, "debug_step");
      } catch (err) {
        return fail(lldmdbError(err), "debug_step");
      }
    },
  );

  server.registerTool(
    "debug_detach",
    {
      title: "Detach debugger",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to detach the debug session. INSTEAD OF `llmdb stop --session S`. Detach your lease's debug session. Idempotent: detaching twice succeeds with stopped=false.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = lease.debugSessionId ?? null;
        if (!sessionId) return ok({ lease_id, udid: lease.udid, stopped: false }, "debug_detach");
        try {
          const result = await lldmdb.stop(sessionId);
          await orch.clearDebugSession(lease_id);
          try {
            debugStates.clear(sessionId);
          } catch {
            // tracking must never break the tool path.
          }
          await orch.logAction(lease_id, "debug_detach", `detach session ${sessionId}`);
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, stopped: true, result }, "debug_detach");
        } catch (err) {
          if (/no session with id/i.test((err as Error).message)) {
            await orch.clearDebugSession(lease_id);
            try {
              debugStates.clear(sessionId);
            } catch {
              // tracking must never break the tool path.
            }
            await orch.logAction(lease_id, "debug_detach", `detach session ${sessionId} (already gone)`);
            return ok({ lease_id, udid: lease.udid, session_id: sessionId, stopped: false }, "debug_detach");
          }
          throw err;
        }
      } catch (err) {
        return fail(lldmdbError(err), "debug_detach");
      }
    },
  );

  server.registerTool(
    "debug_sessions",
    {
      title: "List debug sessions",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to list active debug sessions across agents. INSTEAD OF `llmdb sessions`. List active llmdb debug sessions across all agents on this host's daemon. lease_id is optional — when given, the lease is validated and the call is logged against it.",
      inputSchema: {
        lease_id: z.string().optional().describe("Your active lease id (validates + logs when given)."),
      },
    },
    async ({ lease_id }) => {
      try {
        let udid: string | undefined;
        if (lease_id !== undefined) {
          udid = (await orch.resolveLease(lease_id)).udid;
        }
        const result = await lldmdb.sessions();
        if (lease_id !== undefined) {
          await orch.logAction(lease_id, "debug_sessions", "sessions");
        }
        return ok({ ...(lease_id !== undefined ? { lease_id } : {}), ...(udid !== undefined ? { udid } : {}), result }, "debug_sessions");
      } catch (err) {
        return fail(lldmdbError(err), "debug_sessions");
      }
    },
  );

  server.registerTool(
    "debug_launch",
    {
      title: "Launch under debugger",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to launch a target under the debugger. INSTEAD OF `llmdb launch <path> [args]` (or `xcrun simctl launch` + `llmdb attach --app` composed for bundle_id). Launch a target under the debugger for your lease (one session per lease; re-launching replaces it). Exactly one of path or bundle_id: path launches a binary (or .app bundle) via `llmdb launch`; bundle_id launches a sim app via `xcrun simctl launch` then attaches via `llmdb attach --app` (llmdb 0.2.0 launch takes a filesystem path only — verified `llmdb launch --help` — so the bundle form is composed from existing primitives, never a new flag).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        path: z.string().min(1).optional().describe("Path to the binary (or .app bundle) to debug (exactly one of path or bundle_id)."),
        bundle_id: z.string().min(1).optional().describe("Sim app bundle id to launch then attach to (exactly one of path or bundle_id)."),
        args: z.array(z.string()).optional().describe("Argv forwarded to the binary/app."),
      },
    },
    async ({ lease_id, path: target, bundle_id, args }) => {
      try {
        if ((target === undefined) === (bundle_id === undefined)) {
          return fail("debug_launch needs exactly one of path or bundle_id.", "debug_launch");
        }
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_launch", phase: "P3", detail: DEBUG_REAL_DETAIL });
        if (bundle_id !== undefined) {
          let pid: number;
          try {
            ({ pid } = await simApps.launch(lease.udid, bundle_id, args ?? []));
          } catch (err) {
            return fail((err as Error).message, "debug_launch");
          }
          const { sessionId, response } = await lldmdb.attach({ bundleId: bundle_id });
          try {
            if (debugRobustnessEnabled()) debugStates.markAttached(sessionId, response);
          } catch {
            // tracking must never break the tool path.
          }
          const replaced = await orch.setDebugSession(lease_id, sessionId);
          if (replaced && replaced !== sessionId) {
            try {
              debugStates.clear(replaced);
            } catch {
              // tracking must never break the tool path.
            }
            try {
              await lldmdb.stop(replaced);
            } catch {
              // The replaced session is already gone; the new launch wins regardless.
            }
          }
          await orch.logAction(lease_id, "debug_launch", `launch ${bundle_id} (pid ${pid}, session ${sessionId})`.slice(0, 160));
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, bundle_id, pid, result: response }, "debug_launch");
        }
        const fsPath = target as string; // exactly-one check above guarantees this
        const { sessionId, response } = await lldmdb.launch(fsPath, args ?? []);
        try {
          if (debugRobustnessEnabled()) debugStates.markLaunched(sessionId, response);
        } catch {
          // tracking must never break the tool path.
        }
        const replaced = await orch.setDebugSession(lease_id, sessionId);
        if (replaced && replaced !== sessionId) {
          try {
            debugStates.clear(replaced);
          } catch {
            // tracking must never break the tool path.
          }
          try {
            await lldmdb.stop(replaced);
          } catch {
            // The replaced session is already gone; the new launch wins regardless.
          }
        }
        await orch.logAction(lease_id, "debug_launch", `launch ${path.basename(fsPath)} (session ${sessionId})`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result: response }, "debug_launch");
      } catch (err) {
        return fail(lldmdbError(err), "debug_launch");
      }
    },
  );

  server.registerTool(
    "debug_doctor",
    {
      title: "Diagnose debugger",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to diagnose the debugger environment. INSTEAD OF `llmdb doctor`. Diagnose the local llmdb environment (lldb-dap, socket dir, daemon reachability). lease_id is optional — when given, the lease is validated and the call is logged against it.",
      inputSchema: {
        lease_id: z.string().optional().describe("Your active lease id (validates + logs when given)."),
      },
    },
    async ({ lease_id }) => {
      try {
        let udid: string | undefined;
        if (lease_id !== undefined) {
          udid = (await orch.resolveLease(lease_id)).udid;
        }
        const result = await lldmdb.doctor();
        if (lease_id !== undefined) {
          await orch.logAction(lease_id, "debug_doctor", "doctor");
        }
        return ok({ ...(lease_id !== undefined ? { lease_id } : {}), ...(udid !== undefined ? { udid } : {}), result }, "debug_doctor");
      } catch (err) {
        return fail(lldmdbError(err), "debug_doctor");
      }
    },
  );

  server.registerTool(
    "debug_threads",
    {
      title: "List threads",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to list threads in the stopped session. INSTEAD OF `llmdb threads --session S`. List threads in your lease's stopped debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_threads", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.threads(sessionId);
        await orch.logAction(lease_id, "debug_threads", "threads");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_threads");
      } catch (err) {
        return fail(lldmdbError(err), "debug_threads");
      }
    },
  );

  server.registerTool(
    "debug_scopes",
    {
      title: "List scopes",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want a frame's variable scopes. INSTEAD OF `llmdb scopes --frame N --session S`. List a frame's variable scopes (Locals, Globals, Registers) in your lease's debug session; expand a ref to read it.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_scopes", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.scopes(sessionId, frame ?? 0);
        await orch.logAction(lease_id, "debug_scopes", `scopes (frame ${frame ?? 0})`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_scopes");
      } catch (err) {
        return fail(lldmdbError(err), "debug_scopes");
      }
    },
  );

  server.registerTool(
    "debug_expand",
    {
      title: "Expand value",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to expand a structured value into its children. INSTEAD OF `llmdb expand <ref> --session S`. Expand a structured value into its children by variablesReference (the non-zero ref from a debug_locals/debug_scopes entry). Takes a ref, not an expression — use debug_eval for expressions.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        ref: z.number().int().positive().describe("variablesReference to expand (must be non-zero)."),
      },
    },
    async ({ lease_id, ref }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_expand", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.expand(sessionId, ref);
        await orch.logAction(lease_id, "debug_expand", `expand ref ${ref}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_expand");
      } catch (err) {
        return fail(lldmdbError(err), "debug_expand");
      }
    },
  );

  server.registerTool(
    "debug_set_var",
    {
      title: "Set variable",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to assign a new value to a variable. INSTEAD OF `llmdb set-var <target> <value> --frame N --session S`. Assign a new value to a variable during a stop in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        target: z.string().min(1).describe("Assignable target: a local name, or an expression like self.count or arr[0]."),
        value: z.string().min(1).describe('New value, in the target\'s language (e.g. 42, true, "hi").'),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, target, value, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_set_var", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.setVar(sessionId, target, value, frame ?? 0);
        await orch.logAction(lease_id, "debug_set_var", `set ${target} = ${value.slice(0, 60)}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_set_var");
      } catch (err) {
        return fail(lldmdbError(err), "debug_set_var");
      }
    },
  );

  server.registerTool(
    "debug_output",
    {
      title: "Read target output",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to print the target's captured output. INSTEAD OF `llmdb output [--clear] --session S`. Print the debug target's captured stdout/stderr/console output.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        clear: z.boolean().optional().describe("Drain the buffer so the next call returns only newer output. Default false."),
        max_chars: z.number().int().positive().optional().describe("Tail-truncate output text. Default 20000."),
      },
    },
    async ({ lease_id, clear, max_chars }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_output", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.output(sessionId, clear ?? false);
        await orch.logAction(lease_id, "debug_output", clear === true ? "output (clear)" : "output");
        const { output, truncated } = truncateOutput(result, max_chars ?? DEFAULT_BOUND_MAX_CHARS);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result, output, truncated }, "debug_output");
      } catch (err) {
        return fail(lldmdbError(err), "debug_output");
      }
    },
  );

  server.registerTool(
    "debug_run_until",
    {
      title: "Run until line",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to run until a file:line breakpoint hits. INSTEAD OF `llmdb run-until <file:line> --wait N --session S`. Set a breakpoint at file:line and continue; returns when it hits (or the target terminates). A client timeout auto-stops the session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        file: z.string().min(1).describe("Source file path, e.g. ./Sources/App/main.swift."),
        line: z.number().int().positive().describe("1-based line number."),
        wait_sec: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Block up to this many seconds. Default 60, max 600."),
        cleanup: z.boolean().optional().describe("Delete the run-until breakpoint afterwards (best-effort). Default false."),
      },
    },
    async ({ lease_id, file, line, wait_sec, cleanup }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_run_until", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await withDebugTimeoutGuard(lease_id, sessionId, () =>
          lldmdb.runUntil(sessionId, file, line, wait_sec ?? 60, { cleanup: cleanup ?? false }),
        "run-until");
        try {
          if (debugRobustnessEnabled()) debugStates.updateFromResult(sessionId, result);
        } catch {
          // tracking must never break the tool path.
        }
        await orch.logAction(lease_id, "debug_run_until", `run-until ${file}:${line}${cleanup === true ? " (cleanup)" : ""}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result }, "debug_run_until");
      } catch (err) {
        return fail(lldmdbError(err), "debug_run_until");
      }
    },
  );

  server.registerTool(
    "debug_wait",
    {
      title: "Wait for stop",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to wait until the session stops. INSTEAD OF `llmdb wait --timeout N --session S`. Block until your lease's debug session leaves `running` (stops or terminates). A client timeout auto-stops the session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        timeout: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Timeout in seconds. Default 60, max 600."),
      },
    },
    async ({ lease_id, timeout }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_wait", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        const result = await withDebugTimeoutGuard(lease_id, sessionId, () => lldmdb.wait(sessionId, timeout ?? 60), "wait");
        let waitElapsed = false;
        try {
          if (debugRobustnessEnabled()) {
            debugStates.updateFromResult(sessionId, result);
            waitElapsed = isWaitElapsedResponse(result);
          }
        } catch {
          // tracking must never break the tool path.
        }
        await orch.logAction(lease_id, "debug_wait", `wait (timeout ${timeout ?? 60}s)`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, ...stopSummary(result), ...(waitElapsed ? { wait_elapsed: true } : {}), result }, "debug_wait");
      } catch (err) {
        return fail(lldmdbError(err), "debug_wait");
      }
    },
  );

  server.registerTool(
    "debug_interrupt",
    {
      title: "Interrupt execution",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to pause or interrupt the running session. INSTEAD OF `llmdb interrupt --wait N --session S`. Pause your lease's running debug session; returns once stopped. A client timeout auto-stops the session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        wait_sec: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Block up to this many seconds. Default 10, max 600."),
      },
    },
    async ({ lease_id, wait_sec }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "debug_interrupt", phase: "P3", detail: DEBUG_REAL_DETAIL });
        const sessionId = requireDebugSession(lease);
        // D1.1 (gated): skip llmdb when the session is already stopped.
        try {
          if (debugRobustnessEnabled() && debugStates.get(sessionId) === "stopped") {
            await orch.logAction(lease_id, "debug_interrupt", "interrupt (already stopped, skipped)");
            return ok({ lease_id, udid: lease.udid, session_id: sessionId, state: "stopped", already_stopped: true, result: alreadyStoppedResult() }, "debug_interrupt");
          }
        } catch {
          // fall through to llmdb.
        }
        const result = await withDebugTimeoutGuard(lease_id, sessionId, () => lldmdb.interrupt(sessionId, wait_sec ?? 10), "interrupt");
        let waitElapsed = false;
        let alreadyStopped = false;
        try {
          if (debugRobustnessEnabled()) {
            debugStates.updateFromResult(sessionId, result);
            waitElapsed = isWaitElapsedResponse(result);
            alreadyStopped = isAlreadyStoppedResponse(result);
          }
        } catch {
          // tracking must never break the tool path.
        }
        await orch.logAction(lease_id, "debug_interrupt", "interrupt");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, ...(waitElapsed ? { wait_elapsed: true } : {}), ...(alreadyStopped ? { already_stopped: true } : {}), result }, "debug_interrupt");
      } catch (err) {
        return fail(lldmdbError(err), "debug_interrupt");
      }
    },
  );

  server.registerTool(
    "symbolicate",
    {
      title: "Symbolicate addresses",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to symbolicate crash addresses. INSTEAD OF `atos -o <binary> [-arch A] [-l addr] <pcs>` (+ `lipo -info` for arch detection). Symbolicate hex addresses against a Mach-O binary via atos (host-local, read-only; touches no simulator). Auto-detects -arch via lipo, a sibling dSYM, and load_addr from images text. lease_id is optional — when given, the lease is validated and the call is logged against it.",
      inputSchema: {
        pcs: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)])
          .describe('Program counters to symbolicate: one hex address or an array (max 100), e.g. "0x100234567".'),
        binary: z.string().min(1).optional().describe("Mach-O binary (or dSYM) the addresses belong to. Required for atos."),
        arch: z.string().min(1).optional().describe('Slice for universal binaries, e.g. "arm64". Omit to auto-detect via lipo.'),
        load_addr: z.string().min(1).optional().describe('Image load address for ASLR\'d addresses, e.g. "0x100000000". Omit with images to auto-derive it.'),
        images: z.string().min(1).optional().describe("Crash-log Binary Images text to auto-derive load_addr when load_addr is omitted."),
        dsym: z.string().min(1).optional().describe("Explicit dSYM bundle (or DWARF file); overrides sibling auto-find."),
        lease_id: z.string().optional().describe("Your active lease id (validates + logs when given)."),
      },
    },
    async ({ pcs, binary, arch, load_addr, images, dsym, lease_id }) => {
      try {
        let udid: string | undefined;
        if (lease_id !== undefined) {
          const lease = await orch.resolveLease(lease_id);
          udid = lease.udid;
        }
        const addresses = Array.isArray(pcs) ? pcs : [pcs];
        const result = await symbolicator.symbolicate(addresses, {
          ...(binary !== undefined ? { binary } : {}),
          ...(arch !== undefined ? { arch } : {}),
          ...(load_addr !== undefined ? { loadAddr: load_addr } : {}),
          ...(images !== undefined ? { images } : {}),
          ...(dsym !== undefined ? { dsym } : {}),
        });
        if (lease_id !== undefined) {
          await orch.logAction(lease_id, "symbolicate", `symbolicate ${addresses.length} pc(s) ${path.basename(result.binary)}`.slice(0, 160));
        }
        return ok({ ...(lease_id !== undefined ? { lease_id } : {}), ...(udid !== undefined ? { udid } : {}), ...result }, "symbolicate");
      } catch (err) {
        return fail((err as Error).message, "symbolicate");
      }
    },
  );

  server.registerTool(
    "lease_actions",
    {
      title: "Lease action history",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to see the action history recorded against a lease. There is no raw CLI for this orchestrator log. Show the recent one-line action history recorded against a lease (ui_* calls, serve-sim ops, app ops, traces).",
      inputSchema: {
        lease_id: z.string().describe("Lease id."),
        limit: z.number().int().positive().max(100).optional().describe("Return at most this many newest entries. Default all (max 100)."),
      },
    },
    async ({ lease_id, limit }) => {
      try {
        const actions = orch.leaseActions(lease_id, limit);
        return ok({ lease_id, actions }, "lease_actions");
      } catch (err) {
        return fail((err as Error).message, "lease_actions");
      }
    },
  );

  server.registerTool(
    "net_proxy_start",
    {
      title: "Start HTTPS proxy",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "WHEN you want to intercept, inspect, or mock HTTPS traffic. INSTEAD OF `xcrun simctl keychain UDID add-root-cert <ca>` + `mitmdump -p PORT -s <addon.py>` + `networksetup -setwebproxy/-setsecurewebproxy <svc> 127.0.0.1 PORT` (plus a pfctl anchor when blocking QUIC). Start HTTPS interception for your leased simulator (mitmdump + generated rewrite addon + mitm CA in the sim keychain). HOST-WIDE while running: the macOS web proxy of every network service points at mitmdump, so other apps' traffic passes through it too. One holder at a time: fails when another lease holds the proxy. Idempotent for the holding lease.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        rules: netProxyRulesSchema.optional().describe("Response-rewrite rules, first match wins. Default: none (transparent interception)."),
        block_quic: z
          .boolean()
          .optional()
          .describe(
            "Also block QUIC (UDP/443) via a PF anchor so apps fall back to TCP/TLS through the proxy. " +
              "Host-wide while running; removed on stop. Needs passwordless sudo for pfctl.",
          ),
      },
    },
    async ({ lease_id, rules, block_quic }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "net_proxy_start", phase: "P4", detail: NET_REAL_DETAIL });
        const { port, pid, quicBlocked } = await orch.startLeaseProxy(lease_id, rules ?? [], { blockQuic: block_quic === true });
        const count = rules?.length ?? 0;
        const quic = quicBlocked ? ", quic blocked" : "";
        await orch.logAction(lease_id, "net_proxy_start", `proxy :${port}${count > 0 ? ` (${count} rules)` : " (transparent)"}${quic}`);
        return ok({ lease_id, udid: lease.udid, port, pid, rule_count: count, quic_blocked: quicBlocked }, "net_proxy_start");
      } catch (err) {
        return fail(netProxyError(err), "net_proxy_start");
      }
    },
  );

  server.registerTool(
    "net_proxy_set_rules",
    {
      title: "Set proxy rules",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to replace the proxy rewrite rules. INSTEAD OF regenerating the addon and restarting `mitmdump -p PORT -s <new-addon.py>`. Replace the rewrite rules of the running network proxy (mitmdump restarts on the same port; the host proxy stays on). Only the holding lease may set rules. Pass [] to clear all rewrites (transparent interception).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
        rules: netProxyRulesSchema.describe("Replacement rules, first match wins."),
      },
    },
    async ({ lease_id, rules }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "net_proxy_set_rules", phase: "P4", detail: NET_REAL_DETAIL });
        await orch.setLeaseProxyRules(lease_id, rules);
        await orch.logAction(lease_id, "net_proxy_set_rules", `rules := ${rules.length} rule(s)`);
        return ok({ lease_id, udid: lease.udid, rule_count: rules.length }, "net_proxy_set_rules");
      } catch (err) {
        return fail(netProxyError(err), "net_proxy_set_rules");
      }
    },
  );

  server.registerTool(
    "net_proxy_stop",
    {
      title: "Stop HTTPS proxy",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to stop the network proxy and restore the host proxy. INSTEAD OF killing mitmdump + `networksetup -setwebproxystate off` (+ pfctl flush when QUIC was blocked). Stop the network proxy and restore the host proxy snapshot. Idempotent: stopping twice succeeds with stopped=false. Only the holding lease may stop.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { stopped, flowLogPath } = await orch.stopLeaseProxy(lease_id);
        await orch.logAction(lease_id, "net_proxy_stop", stopped ? "proxy stopped" : "proxy already stopped");
        return ok({
          lease_id,
          udid: lease.udid,
          stopped,
          ...(flowLogPath !== undefined ? { flow_log_path: flowLogPath } : {}),
        }, "net_proxy_stop");
      } catch (err) {
        return fail(netProxyError(err), "net_proxy_stop");
      }
    },
  );

  server.registerTool(
    "net_proxy_status",
    {
      title: "Proxy status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to check proxy running state, holder, or rule count. There is no raw CLI for this proxy state view. Show the network proxy state: running flag, port/pid, QUIC-block flag, the holding lease/session when active, and the rule count. Any valid lease may view it.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const {
          lease,
          running,
          port,
          pid,
          leaseId,
          sessionId,
          udid,
          ruleCount,
          quicBlocked,
          addonPath,
          flowLogPath,
          lastFlowLogPath,
        } = await orch.leaseProxyStatus(lease_id);
        return ok({
          lease_id,
          udid: lease.udid,
          running,
          ...(port !== undefined ? { port } : {}),
          ...(pid !== undefined ? { pid } : {}),
          ...(quicBlocked !== undefined ? { quic_blocked: quicBlocked } : {}),
          ...(leaseId !== undefined ? { holder_lease_id: leaseId } : {}),
          ...(sessionId !== undefined ? { holder_session_id: sessionId } : {}),
          ...(udid !== undefined ? { holder_udid: udid } : {}),
          ...(ruleCount !== undefined ? { rule_count: ruleCount } : {}),
          ...(addonPath !== undefined ? { addon_path: addonPath } : {}),
          ...(flowLogPath !== undefined ? { flow_log_path: flowLogPath } : {}),
          ...(lastFlowLogPath !== undefined ? { last_flow_log_path: lastFlowLogPath } : {}),
        }, "net_proxy_status");
      } catch (err) {
        return fail(netProxyError(err), "net_proxy_status");
      }
    },
  );

  server.registerTool(
    "net_capture_start",
    {
      title: "Start packet capture",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to capture packets the HTTP proxy cannot see (raw TCP/UDP, QUIC). INSTEAD OF `sudo -n tcpdump -i <iface> -s <snaplen> -w <pcap> [filter]`. Start a packet capture (tcpdump) on the host interface carrying simulator traffic. " +
        "Use for traffic the HTTP proxy cannot see: raw TCP/UDP sockets and QUIC (UDP/443). " +
        "Only one capture runs at a time; the holding lease owns it. " +
        "Capturing needs passwordless sudo for tcpdump.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        filter: z
          .string()
          .optional()
          .describe('BPF filter, e.g. "tcp port 6555" or "udp port 443". Omit to capture everything (noisy).'),
        snaplen: z
          .number()
          .int()
          .min(64)
          .max(65535)
          .optional()
          .describe("Bytes captured per packet (-s). Default 256: headers plus a protocol peek. TLS payloads stay encrypted."),
        interface: z.string().optional().describe("Capture interface (e.g. en0). Default: the default-route interface."),
      },
    },
    async ({ lease_id, filter, snaplen, interface: iface }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { pid, pcapPath } = await orch.startLeaseCapture(lease_id, { filter, snaplen, interface: iface });
        await orch.logAction(lease_id, "net_capture_start", `capture pid ${pid}${filter ? ` filter ${JSON.stringify(filter)}` : ""} -> ${pcapPath}`);
        return ok({ lease_id, udid: lease.udid, pid, pcap_path: pcapPath }, "net_capture_start");
      } catch (err) {
        return fail(netCaptureError(err), "net_capture_start");
      }
    },
  );

  server.registerTool(
    "net_capture_stop",
    {
      title: "Stop packet capture",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to stop the packet capture and get the pcap summary. INSTEAD OF SIGINT + `tcpdump -n -r <pcap>` for the summary. Stop the packet capture and return a per-flow packet/byte summary plus the pcap path. " +
        "Idempotent: stopping twice succeeds with stopped=false. Only the holding lease may stop. " +
        "The pcap file stays on disk for manual inspection (tcpdump -r / Wireshark) until your lease's next capture overwrites it.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the capture)."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { stopped, pcapPath, summary } = await orch.stopLeaseCapture(lease_id);
        await orch.logAction(lease_id, "net_capture_stop", stopped ? `capture stopped (${summary?.packets ?? 0} packets)` : "capture already stopped");
        return ok({
          lease_id,
          udid: lease.udid,
          stopped,
          ...(pcapPath !== undefined ? { pcap_path: pcapPath } : {}),
          ...(summary !== undefined ? { summary } : {}),
        }, "net_capture_stop");
      } catch (err) {
        return fail(netCaptureError(err), "net_capture_stop");
      }
    },
  );

  server.registerTool(
    "net_capture_status",
    {
      title: "Capture status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to check capture running state or pcap path. There is no raw CLI for this capture state view. Show the packet capture state: running flag, pid, filter, pcap path, and the holding lease/session when active. Any valid lease may view it.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const { lease, running, pid, leaseId, sessionId, udid, interface: iface, filter, pcapPath, startedAt, bytesWritten } =
          await orch.leaseCaptureStatus(lease_id);
        return ok({
          lease_id,
          udid: lease.udid,
          running,
          ...(pid !== undefined ? { pid } : {}),
          ...(leaseId !== undefined ? { holder_lease_id: leaseId } : {}),
          ...(sessionId !== undefined ? { holder_session_id: sessionId } : {}),
          ...(udid !== undefined ? { holder_udid: udid } : {}),
          ...(iface !== undefined ? { interface: iface } : {}),
          ...(filter !== undefined ? { filter } : {}),
          ...(pcapPath !== undefined ? { pcap_path: pcapPath } : {}),
          ...(startedAt !== undefined ? { started_at: startedAt } : {}),
          ...(bytesWritten !== undefined ? { bytes_written: bytesWritten } : {}),
        }, "net_capture_status");
      } catch (err) {
        return fail(netCaptureError(err), "net_capture_status");
      }
    },
  );

  server.registerTool(
    "net_assert_flow",
    {
      title: "Assert network flow",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to assert a URL was called by polling the flow log. There is no raw CLI for this flow-log poll (manual equivalent: read the flow log). Poll your holding proxy's flow log until min_count matching requests are seen (or the timeout elapses). Fails cleanly when the lease holds no running proxy.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
        url_regex: z
          .string()
          .min(1)
          .refine(
            (s) => {
              try {
                void new RegExp(s);
                return true;
              } catch {
                return false;
              }
            },
            "url_regex must be a valid regular expression",
          )
          .describe("Regex matched (search) against the full request URL."),
        method: z.string().min(1).optional().describe('HTTP method, e.g. "GET". Compared uppercase; omit to match all methods.'),
        min_count: z.number().int().positive().optional().describe("Succeed once this many matching flows are seen. Default 1."),
        timeout_sec: z
          .number()
          .min(0)
          .max(MAX_ASSERT_FLOW_SEC)
          .optional()
          .describe("Poll up to this many seconds. Default 5, max 120."),
        since: z
          .enum(["call", "run"])
          .optional()
          .describe("Match only flows starting after this call ('call', default) or every flow of this proxy run ('run')."),
        status: z.number().int().min(100).max(599).optional().describe("Only flows whose response status equals this."),
        min_bytes: z.number().int().min(0).optional().describe("Only flows with at least this many response bytes."),
        body_regex: z
          .string()
          .min(1)
          .refine(
            (s) => {
              try {
                void new RegExp(s);
                return true;
              } catch {
                return false;
              }
            },
            "body_regex must be a valid regular expression",
          )
          .optional()
          .describe("Regex matched (search) against the response body (needs body capture)."),
        rewritten: z.boolean().optional().describe("Only flows the proxy rewrote (true) or passed through untouched (false)."),
        rule: z.number().int().min(0).optional().describe("Only flows handled by this rule index."),
      },
    },
    async ({ lease_id, url_regex, method, min_count, timeout_sec, since, status, min_bytes, body_regex, rewritten, rule }) => {
      try {
        const held = await orch.leaseById(lease_id);
        if (held) requireSimLease(held, { verb: "net_assert_flow", phase: "P4", detail: NET_REAL_DETAIL });
        const { lease, count, total, newSinceCall, matched } = await orch.assertLeaseFlow(lease_id, {
          urlRegex: url_regex,
          ...(method !== undefined ? { method } : {}),
          ...(min_count !== undefined ? { minCount: min_count } : {}),
          ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(min_bytes !== undefined ? { minBytes: min_bytes } : {}),
          ...(body_regex !== undefined ? { bodyRegex: body_regex } : {}),
          ...(rewritten !== undefined ? { rewritten } : {}),
          ...(rule !== undefined ? { rule } : {}),
        });
        const needed = min_count ?? 1;
        if (count < needed) {
          return fail(
            `net_assert_flow: saw ${count} matching flow(s) for ${JSON.stringify(url_regex)} ` +
              `(needed ${needed}) out of ${total} total (${newSinceCall} new since call) within ${timeout_sec ?? 5}s.`,
            "net_assert_flow",
          );
        }
        await orch.logAction(lease_id, "net_assert_flow", `assert ${JSON.stringify(url_regex)}: ${count}/${total}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, count, total, new_since_call: newSinceCall, matched }, "net_assert_flow");
      } catch (err) {
        return fail(netProxyError(err), "net_assert_flow");
      }
    },
  );

  server.registerTool(
    "map_local",
    {
      title: "Mock response from file",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to mock a response by serving a local file. There is no raw CLI for this mitm rule upsert (manual equivalent: edit the addon + restart mitmdump). Serve a local file as the response for requests matching url_regex, without contacting upstream (missing-file reads at serve time return 502). Replaces a prior map_local for the same pattern; otherwise prepended (first match wins). Only the holding lease may map.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
        url_regex: z
          .string()
          .min(1)
          .refine(
            (s) => {
              try {
                void new RegExp(s);
                return true;
              } catch {
                return false;
              }
            },
            "url_regex must be a valid regular expression",
          )
          .describe("Regex matched (search) against the full request URL."),
        file: z.string().min(1).describe("Local file served as the response body (must exist and be a regular file)."),
      },
    },
    async ({ lease_id, url_regex, file }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "map_local", phase: "P4", detail: NET_REAL_DETAIL });
        const { ruleCount } = await orch.upsertLeaseMapRule(lease_id, {
          match: { url_regex },
          action: { map_local: file },
        });
        await orch.logAction(lease_id, "map_local", `${JSON.stringify(url_regex)} -> ${path.basename(file)}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, url_regex, file, rule_count: ruleCount }, "map_local");
      } catch (err) {
        return fail(netProxyError(err), "map_local");
      }
    },
  );

  server.registerTool(
    "map_remote",
    {
      title: "Redirect upstream URL",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to redirect matching requests to a fixed upstream URL. There is no raw CLI for this mitm rule upsert (manual equivalent: edit the addon + restart mitmdump). Rewrite the upstream URL to a fixed URL for requests matching url_regex. Replaces a prior map_remote for the same pattern; otherwise prepended (first match wins). Only the holding lease may map.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
        url_regex: z
          .string()
          .min(1)
          .refine(
            (s) => {
              try {
                void new RegExp(s);
                return true;
              } catch {
                return false;
              }
            },
            "url_regex must be a valid regular expression",
          )
          .describe("Regex matched (search) against the full request URL."),
        url: z
          .string()
          .min(1)
          .refine(
            (s) => {
              try {
                const u = new URL(s);
                return u.protocol === "http:" || u.protocol === "https:";
              } catch {
                return false;
              }
            },
            "url must be an absolute http(s) URL",
          )
          .describe("Fixed upstream URL the matched requests are rewritten to."),
      },
    },
    async ({ lease_id, url_regex, url }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "map_remote", phase: "P4", detail: NET_REAL_DETAIL });
        const { ruleCount } = await orch.upsertLeaseMapRule(lease_id, {
          match: { url_regex },
          action: { map_remote: url },
        });
        await orch.logAction(lease_id, "map_remote", `${JSON.stringify(url_regex)} -> ${url}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, url_regex, url, rule_count: ruleCount }, "map_remote");
      } catch (err) {
        return fail(netProxyError(err), "map_remote");
      }
    },
  );
}
