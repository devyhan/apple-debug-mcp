import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ExecError } from "./exec.js";
import { Llmdb, MAX_CONTINUE_WAIT_SEC, STEP_MODES } from "./llmdb.js";
import { MAX_ASSERT_FLOW_SEC, MAX_PROXY_RULES } from "./netproxy.js";
import { Orchestrator } from "./orchestrator.js";
import { SimApps } from "./simapps.js";
import { Lease } from "./store.js";
import { Symbolicator } from "./symbolicate.js";
import { CA_DEBUG_OPTIONS, CAMERA_MIRROR_MODES, CAMERA_SOURCES, ORIENTATIONS, ServeSim } from "./servesim.js";
import { MAX_STREAM_SEC, SimLog } from "./simlog.js";
import { MAX_TRACE_SEC, XCTrace } from "./xctrace.js";

export interface ExtrasDeps {
  orchestrator: Orchestrator;
  serveSim: ServeSim;
  simLog: SimLog;
  simApps: SimApps;
  xctrace: XCTrace;
  lldmdb: Llmdb;
  symbolicator?: Symbolicator;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...(data as object) }, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
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

/** Missing-binary errors get an install hint; everything else passes through. */
function lldmdbError(err: unknown): string {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return `${msg}. llmdb is not installed; run: brew install alexmx/tools/llmdb (or set LLMDB_BIN)`;
  }
  if (/llmdb.*(not found|ENOENT)|spawn llmdb/i.test(msg)) {
    return `${msg}. llmdb is not installed; run: brew install alexmx/tools/llmdb (or set LLMDB_BIN)`;
  }
  return msg;
}

/** Missing-binary errors get an install hint; everything else passes through. */
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
 * unified-log capture, app lifecycle (openurl/install/uninstall/launch/
 * terminate), xctrace profiling, llmdb debugging (attach/launch/break/
 * continue/run-until/wait/interrupt/bt/threads/locals/scopes/expand/eval/
 * set-var/output/step/detach/sessions/doctor, all lease-gated), atos crash
 * symbolication (optional lease), mitm network proxying (net_proxy_start/
 * set_rules/stop/status/assert_flow/map_local/map_remote, all lease-gated),
 * and the per-lease action log.
 */
export function registerDeviceExtras(server: McpServer, deps: ExtrasDeps): void {
  const { orchestrator: orch, serveSim, simLog, simApps, xctrace, lldmdb } = deps;
  const symbolicator = deps.symbolicator ?? new Symbolicator();

  /** Leases carry at most one llmdb session; every debug verb except attach/detach needs it. */
  function requireDebugSession(lease: Lease): string {
    if (!lease.debugSessionId) {
      throw new Error(`Lease ${lease.leaseId} has no debug session attached; call debug_attach first.`);
    }
    return lease.debugSessionId;
  }

  /** Mirrors sim_shutdown: leased sims need force=true. Returns the holder (if any). */
  async function leaseGate(udid: string, force: boolean | undefined): Promise<{ holder: Lease | null; refusal: ToolResult | null }> {
    const holder = await orch.leaseForUdid(udid);
    if (holder && !force) {
      return {
        holder,
        refusal: fail(
          `Simulator ${udid} is leased to session ${holder.sessionId} (lease ${holder.leaseId}). Pass force=true to proceed anyway.`,
        ),
      };
    }
    return { holder, refusal: null };
  }

  server.registerTool(
    "sim_rotate",
    {
      description: "Rotate a simulator display via serve-sim. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        orientation: z.enum(ORIENTATIONS).describe("Target orientation."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, orientation, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force);
        if (refusal) return refusal;
        await serveSim.rotate(udid, orientation);
        if (holder) await orch.logAction(holder.leaseId, "sim_rotate", `rotate ${orientation}${force ? " (force)" : ""}`);
        return ok({ udid, orientation });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "sim_ca_debug",
    {
      description: "Toggle a CoreAnimation debug visualization via serve-sim. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        option: z.enum(CA_DEBUG_OPTIONS).describe("Debug visualization to toggle."),
        enabled: z.boolean().describe("true = on, false = off."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, option, enabled, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force);
        if (refusal) return refusal;
        const state = enabled ? "on" : "off";
        await serveSim.caDebug(udid, option, state);
        if (holder) await orch.logAction(holder.leaseId, "sim_ca_debug", `ca-debug ${option} ${state}${force ? " (force)" : ""}`);
        return ok({ udid, option, enabled });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "sim_memory_warning",
    {
      description: "Simulate a memory warning on a simulator via serve-sim. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force);
        if (refusal) return refusal;
        await serveSim.memoryWarning(udid);
        if (holder) await orch.logAction(holder.leaseId, "sim_memory_warning", `memory-warning${force ? " (force)" : ""}`);
        return ok({ udid, memoryWarning: true });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "camera_start",
    {
      description:
        "Launch an app with a synthetic serve-sim camera feed (placeholder, host webcam, or image/video file). Relaunches the app; needs a debuggable (get-task-allow) build. Refuses when leased unless force=true.",
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
        const { holder, refusal } = await leaseGate(udid, force);
        if (refusal) return refusal;
        await serveSim.start(udid, bundle_id, { source, file, webcam });
        if (holder) {
          await orch.logAction(holder.leaseId, "camera_start", `camera ${bundle_id} ${source ?? "placeholder"}${force ? " (force)" : ""}`);
        }
        return ok({ udid, bundle_id, source: source ?? "placeholder" });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "camera_switch",
    {
      description:
        "Hot-swap a running serve-sim camera feed without relaunching the app. Refuses when leased unless force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        source: z.enum(CAMERA_SOURCES).describe("Feed source to switch to."),
        file: z.string().optional().describe("Image/video path. Required when source is file."),
        force: z.boolean().optional().describe("Proceed even when another session holds the lease. Default false."),
      },
    },
    async ({ udid, source, file, force }) => {
      try {
        const { holder, refusal } = await leaseGate(udid, force);
        if (refusal) return refusal;
        await serveSim.switchSource(udid, source, file);
        if (holder) await orch.logAction(holder.leaseId, "camera_switch", `switch ${source}${force ? " (force)" : ""}`);
        return ok({ udid, source });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "camera_mirror",
    {
      description: "Set preview mirroring (auto|on|off) for a running serve-sim camera feed. Read-only vs leases.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        mode: z.enum(CAMERA_MIRROR_MODES).describe("Preview mirroring mode."),
      },
    },
    async ({ udid, mode }) => {
      try {
        await serveSim.mirror(udid, mode);
        return ok({ udid, mode });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "camera_status",
    {
      description: "Show a simulator's serve-sim camera helper state ({alive:false} when idle).",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
      },
    },
    async ({ udid }) => {
      try {
        const s = await serveSim.status(udid);
        return ok({ udid, ...s });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "camera_stop",
    {
      description: "Stop a simulator's serve-sim camera helper (terminates injected apps). Idempotent.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
      },
    },
    async ({ udid }) => {
      try {
        await serveSim.stop(udid);
        return ok({ udid, stopped: true });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "sim_log_stream",
    {
      description: "Capture live unified-log output from a simulator for a bounded window (xcrun simctl spawn log stream).",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        predicate: z.string().optional().describe("Log predicate filter, e.g. 'process == \"MyApp\"'."),
        process: z.string().optional().describe("Process-name shorthand, e.g. \"Preferences\". ANDed with predicate."),
        level: z.enum(["default", "info", "debug"]).optional().describe("Log level filter. Default default."),
        timeout_sec: z.number().positive().max(MAX_STREAM_SEC).optional().describe("Capture window in seconds. Default 5, max 60."),
        max_chars: z.number().int().positive().optional().describe("Truncate output (tail kept). Default 20000."),
      },
    },
    async ({ udid, predicate, process, level, timeout_sec, max_chars }) => {
      try {
        const r = await simLog.stream(udid, {
          predicate,
          process,
          level: level ?? "default",
          timeoutSec: timeout_sec ?? 5,
          maxChars: max_chars,
        });
        return ok({ udid, log: r.stdout, truncated: r.truncated, timedOut: r.timedOut });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "sim_log_show",
    {
      description: "Show recent historical unified-log output from a simulator (xcrun simctl spawn log show --last).",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
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
        const r = await simLog.show(udid, {
          last: last ?? "5m",
          predicate,
          process,
          info,
          debug,
          signpost,
          maxChars: max_chars,
        });
        return ok({ udid, log: r.stdout, truncated: r.truncated, timedOut: r.timedOut });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "stream_start",
    {
      description:
        "Start (or reuse) a live MJPEG stream for your leased simulator via a serve-sim helper on a scanned port. Idempotent: returns the existing URL when already streaming.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const { lease, url, port } = await orch.startLeaseStream(lease_id);
        await orch.logAction(lease_id, "stream_start", `stream ${url}`);
        return ok({ lease_id, udid: lease.udid, url, port });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "stream_stop",
    {
      description: "Stop the live stream for your lease. Idempotent: stopping twice succeeds.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const { lease, stopped } = await orch.stopLeaseStream(lease_id);
        await orch.logAction(lease_id, "stream_stop", stopped ? "stream stopped" : "stream already stopped");
        return ok({ lease_id, udid: lease.udid, stopped });
      } catch (err) {
        return fail(serveSimError(err));
      }
    },
  );

  server.registerTool(
    "app_open_url",
    {
      description: "Open a URL on your leased simulator (xcrun simctl openurl; stock handler, e.g. Safari for https:).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        url: z.string().min(1).describe("URL to open, e.g. https://www.apple.com."),
      },
    },
    async ({ lease_id, url }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await simApps.openUrl(lease.udid, url);
        await orch.logAction(lease_id, "app_open_url", `open ${url.slice(0, 120)}`);
        return ok({ lease_id, udid: lease.udid, url });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "app_install",
    {
      description: "Install an .app bundle onto your leased simulator (xcrun simctl install).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        app_path: z.string().min(1).describe("Host path to the .app bundle to install."),
      },
    },
    async ({ lease_id, app_path }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await simApps.install(lease.udid, app_path);
        await orch.logAction(lease_id, "app_install", `install ${path.basename(app_path).slice(0, 120)}`);
        return ok({ lease_id, udid: lease.udid, app_path });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "app_uninstall",
    {
      description: "Remove an app from your leased simulator (xcrun simctl uninstall).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to remove, e.g. com.example.App."),
      },
    },
    async ({ lease_id, bundle_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await simApps.uninstall(lease.udid, bundle_id);
        await orch.logAction(lease_id, "app_uninstall", `uninstall ${bundle_id}`);
        return ok({ lease_id, udid: lease.udid, bundle_id });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "app_launch",
    {
      description: "Launch an app by bundle id on your leased simulator (xcrun simctl launch). Returns its pid.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to launch, e.g. com.apple.Preferences."),
        args: z.array(z.string()).optional().describe("Argv passed to the app."),
      },
    },
    async ({ lease_id, bundle_id, args }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { pid, output } = await simApps.launch(lease.udid, bundle_id, args ?? []);
        await orch.logAction(lease_id, "app_launch", `launch ${bundle_id} (pid ${pid})`);
        return ok({ lease_id, udid: lease.udid, bundle_id, pid, output });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "app_terminate",
    {
      description: "Terminate an app by bundle id on your leased simulator (xcrun simctl terminate).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().min(1).describe("Bundle id to terminate, e.g. com.apple.Preferences."),
      },
    },
    async ({ lease_id, bundle_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await simApps.terminate(lease.udid, bundle_id);
        await orch.logAction(lease_id, "app_terminate", `terminate ${bundle_id}`);
        return ok({ lease_id, udid: lease.udid, bundle_id });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "profile_trace",
    {
      description:
        "Record a bounded xctrace profile (Time Profiler by default) on your leased simulator and save the .trace file.",
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
        return ok({ lease_id, udid: lease.udid, path: output, template: used, duration_sec: duration_sec ?? 5 });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "debug_attach",
    {
      description:
        "Attach the llmdb debugger to a running target for your lease (one session per lease; re-attaching replaces it). Needs a debuggable (get-task-allow) build; stock Apple apps refuse attach.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        bundle_id: z.string().optional().describe("App bundle id running in the booted Simulator (exactly one of bundle_id or pid)."),
        pid: z.number().int().positive().optional().describe("Host pid to attach to (exactly one of bundle_id or pid)."),
      },
    },
    async ({ lease_id, bundle_id, pid }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { sessionId, response } = await lldmdb.attach({ bundleId: bundle_id, pid });
        const replaced = await orch.setDebugSession(lease_id, sessionId);
        if (replaced && replaced !== sessionId) {
          try {
            await lldmdb.stop(replaced);
          } catch {
            // The replaced session is already gone; the new attach wins regardless.
          }
        }
        const target = bundle_id !== undefined ? bundle_id : `pid ${pid}`;
        await orch.logAction(lease_id, "debug_attach", `attach ${target} (session ${sessionId})`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result: response });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_break",
    {
      description:
        "Manage breakpoints in your lease's debug session. Exactly one op per call: set (file+line, with optional condition/hit_condition), list (list=true), delete (delete=<id>), or exception filters (exception=[...], [] clears).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        file: z.string().min(1).optional().describe("Source file path for set, e.g. ./Sources/App/main.swift."),
        line: z.number().int().positive().optional().describe("1-based line number for set."),
        list: z.boolean().optional().describe("List breakpoints in the session."),
        delete: z.number().int().positive().optional().describe("Delete the breakpoint with this id."),
        exception: z
          .array(z.string().min(1))
          .optional()
          .describe("Stop on thrown exceptions: filter ids to enable (e.g. [\"swift_throw\"]), [] to clear."),
        condition: z.string().min(1).optional().describe("Set only: fire only when this expression is true, e.g. n > 100."),
        hit_condition: z.string().min(1).optional().describe("Set only: fire on a hit-count match, e.g. >5 or 3."),
      },
    },
    async ({ lease_id, file, line, list, delete: del, exception, condition, hit_condition }) => {
      try {
        const ops = [
          list === true ? "list" : null,
          del !== undefined ? "delete" : null,
          exception !== undefined ? "exception" : null,
          file !== undefined || line !== undefined || condition !== undefined || hit_condition !== undefined
            ? "set"
            : null,
        ].filter((op): op is string => op !== null);
        if (ops.length === 0) {
          return fail("debug_break needs exactly one op: set (file+line), list=true, delete=<id>, or exception=[...].");
        }
        if (ops.length > 1) {
          return fail(`debug_break takes exactly one op per call (got ${ops.join("+")}).`);
        }
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const op = ops[0]!;
        if (op === "list") {
          const result = await lldmdb.breakList(sessionId);
          await orch.logAction(lease_id, "debug_break", "break list");
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result });
        }
        if (op === "delete") {
          const result = await lldmdb.breakDelete(sessionId, del as number);
          await orch.logAction(lease_id, "debug_break", `break delete ${del}`);
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result });
        }
        if (op === "exception") {
          const result = await lldmdb.breakException(sessionId, exception as string[]);
          const summary = (exception as string[]).length === 0 ? "break exception (clear)" : `break exception ${(exception as string[]).join(",")}`;
          await orch.logAction(lease_id, "debug_break", summary.slice(0, 160));
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result });
        }
        if (file === undefined || line === undefined) {
          return fail("debug_break set needs both file and line.");
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
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, op, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_continue",
    {
      description: "Resume execution until the next stop (or the wait elapses).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        wait_sec: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Block up to this many seconds for the next stop. Default 60, max 600."),
      },
    },
    async ({ lease_id, wait_sec }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.cont(sessionId, wait_sec ?? 60);
        await orch.logAction(lease_id, "debug_continue", `continue (wait ${wait_sec ?? 60}s)`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_bt",
    {
      description: "Structured backtrace for the stopped thread (or an explicit thread id) in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        depth: z.number().int().positive().optional().describe("Maximum stack depth. Default full stack."),
        thread: z.number().int().positive().optional().describe("Thread id (see debug_threads). Default the stopped thread."),
      },
    },
    async ({ lease_id, depth, thread }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.backtrace(sessionId, depth, thread);
        const qualifiers = [
          thread !== undefined ? `thread ${thread}` : "",
          depth !== undefined ? `depth ${depth}` : "",
        ].filter((s) => s.length > 0);
        await orch.logAction(lease_id, "debug_bt", qualifiers.length > 0 ? `bt (${qualifiers.join(", ")})` : "bt");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_locals",
    {
      description: "Typed locals for a stack frame in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.locals(sessionId, frame ?? 0);
        await orch.logAction(lease_id, "debug_locals", `locals (frame ${frame ?? 0})`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_eval",
    {
      description: "Evaluate an expression in the context of a frame in your lease's debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        expr: z.string().min(1).describe("Expression to evaluate, e.g. self.state.count."),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, expr, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.eval(sessionId, expr, frame ?? 0);
        await orch.logAction(lease_id, "debug_eval", `eval ${JSON.stringify(expr.slice(0, 80))}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_step",
    {
      description: "Step one source line in your lease's debug session: over (default) | in | out.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        mode: z.enum(STEP_MODES).optional().describe("Step mode. Default over."),
      },
    },
    async ({ lease_id, mode }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.step(sessionId, mode ?? "over");
        await orch.logAction(lease_id, "debug_step", `step ${mode ?? "over"}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_detach",
    {
      description: "Detach your lease's debug session. Idempotent: detaching twice succeeds with stopped=false.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = lease.debugSessionId ?? null;
        if (!sessionId) return ok({ lease_id, udid: lease.udid, stopped: false });
        try {
          const result = await lldmdb.stop(sessionId);
          await orch.clearDebugSession(lease_id);
          await orch.logAction(lease_id, "debug_detach", `detach session ${sessionId}`);
          return ok({ lease_id, udid: lease.udid, session_id: sessionId, stopped: true, result });
        } catch (err) {
          if (/no session with id/i.test((err as Error).message)) {
            await orch.clearDebugSession(lease_id);
            await orch.logAction(lease_id, "debug_detach", `detach session ${sessionId} (already gone)`);
            return ok({ lease_id, udid: lease.udid, session_id: sessionId, stopped: false });
          }
          throw err;
        }
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_sessions",
    {
      description: "List active llmdb debug sessions across all agents on this host's daemon.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const result = await lldmdb.sessions();
        await orch.logAction(lease_id, "debug_sessions", "sessions");
        return ok({ lease_id, udid: lease.udid, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_launch",
    {
      description:
        "Launch a binary (or .app bundle) under the debugger for your lease (one session per lease; re-launching replaces it). Takes a filesystem path — llmdb has no bundle-id launch, so use app_launch + debug_attach for sim apps by bundle id.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        path: z.string().min(1).describe("Path to the binary (or .app bundle) to debug."),
        args: z.array(z.string()).optional().describe("Argv forwarded to the binary."),
      },
    },
    async ({ lease_id, path: target, args }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { sessionId, response } = await lldmdb.launch(target, args ?? []);
        const replaced = await orch.setDebugSession(lease_id, sessionId);
        if (replaced && replaced !== sessionId) {
          try {
            await lldmdb.stop(replaced);
          } catch {
            // The replaced session is already gone; the new launch wins regardless.
          }
        }
        await orch.logAction(lease_id, "debug_launch", `launch ${path.basename(target)} (session ${sessionId})`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result: response });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_doctor",
    {
      description: "Diagnose the local llmdb environment (lldb-dap, socket dir, daemon reachability).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const result = await lldmdb.doctor();
        await orch.logAction(lease_id, "debug_doctor", "doctor");
        return ok({ lease_id, udid: lease.udid, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_threads",
    {
      description: "List threads in your lease's stopped debug session.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.threads(sessionId);
        await orch.logAction(lease_id, "debug_threads", "threads");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_scopes",
    {
      description: "List a frame's variable scopes (Locals, Globals, Registers) in your lease's debug session; expand a ref to read it.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        frame: z.number().int().min(0).optional().describe("Frame index. Default 0 (top frame)."),
      },
    },
    async ({ lease_id, frame }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.scopes(sessionId, frame ?? 0);
        await orch.logAction(lease_id, "debug_scopes", `scopes (frame ${frame ?? 0})`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_expand",
    {
      description:
        "Expand a structured value into its children by variablesReference (the non-zero ref from a debug_locals/debug_scopes entry). Takes a ref, not an expression — use debug_eval for expressions.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        ref: z.number().int().positive().describe("variablesReference to expand (must be non-zero)."),
      },
    },
    async ({ lease_id, ref }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.expand(sessionId, ref);
        await orch.logAction(lease_id, "debug_expand", `expand ref ${ref}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_set_var",
    {
      description: "Assign a new value to a variable during a stop in your lease's debug session.",
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
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.setVar(sessionId, target, value, frame ?? 0);
        await orch.logAction(lease_id, "debug_set_var", `set ${target} = ${value.slice(0, 60)}`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_output",
    {
      description: "Print the debug target's captured stdout/stderr/console output.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        clear: z.boolean().optional().describe("Drain the buffer so the next call returns only newer output. Default false."),
      },
    },
    async ({ lease_id, clear }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.output(sessionId, clear ?? false);
        await orch.logAction(lease_id, "debug_output", clear === true ? "output (clear)" : "output");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_run_until",
    {
      description: "Set a breakpoint at file:line and continue; returns when it hits (or the target terminates).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        file: z.string().min(1).describe("Source file path, e.g. ./Sources/App/main.swift."),
        line: z.number().int().positive().describe("1-based line number."),
        wait_sec: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Block up to this many seconds. Default 60, max 600."),
      },
    },
    async ({ lease_id, file, line, wait_sec }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.runUntil(sessionId, file, line, wait_sec ?? 60);
        await orch.logAction(lease_id, "debug_run_until", `run-until ${file}:${line}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_wait",
    {
      description: "Block until your lease's debug session leaves `running` (stops or terminates).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        timeout: z.number().positive().max(MAX_CONTINUE_WAIT_SEC).optional().describe("Timeout in seconds. Default 60, max 600."),
      },
    },
    async ({ lease_id, timeout }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.wait(sessionId, timeout ?? 60);
        await orch.logAction(lease_id, "debug_wait", `wait (timeout ${timeout ?? 60}s)`);
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "debug_interrupt",
    {
      description: "Pause your lease's running debug session; returns once stopped.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const sessionId = requireDebugSession(lease);
        const result = await lldmdb.interrupt(sessionId);
        await orch.logAction(lease_id, "debug_interrupt", "interrupt");
        return ok({ lease_id, udid: lease.udid, session_id: sessionId, result });
      } catch (err) {
        return fail(lldmdbError(err));
      }
    },
  );

  server.registerTool(
    "symbolicate",
    {
      description:
        "Symbolicate hex addresses against a Mach-O binary via atos (host-local, read-only; touches no simulator). lease_id is optional — when given, the lease is validated and the call is logged against it.",
      inputSchema: {
        pcs: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)])
          .describe('Program counters to symbolicate: one hex address or an array (max 100), e.g. "0x100234567".'),
        binary: z.string().min(1).optional().describe("Mach-O binary (or dSYM) the addresses belong to. Required for atos."),
        arch: z.string().min(1).optional().describe('Slice for universal binaries, e.g. "arm64".'),
        load_addr: z.string().min(1).optional().describe('Image load address for ASLR\'d addresses, e.g. "0x100000000".'),
        lease_id: z.string().optional().describe("Your active lease id (validates + logs when given)."),
      },
    },
    async ({ pcs, binary, arch, load_addr, lease_id }) => {
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
        });
        if (lease_id !== undefined) {
          await orch.logAction(lease_id, "symbolicate", `symbolicate ${addresses.length} pc(s) ${path.basename(result.binary)}`.slice(0, 160));
        }
        return ok({ ...(lease_id !== undefined ? { lease_id } : {}), ...(udid !== undefined ? { udid } : {}), ...result });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "lease_actions",
    {
      description: "Show the recent one-line action history recorded against a lease (ui_* calls, serve-sim ops, app ops, traces).",
      inputSchema: {
        lease_id: z.string().describe("Lease id."),
        limit: z.number().int().positive().max(100).optional().describe("Return at most this many newest entries. Default all (max 100)."),
      },
    },
    async ({ lease_id, limit }) => {
      try {
        const actions = orch.leaseActions(lease_id, limit);
        return ok({ lease_id, actions });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "net_proxy_start",
    {
      description:
        "Start HTTPS interception for your leased simulator (mitmdump + generated rewrite addon + mitm CA in the sim keychain). HOST-WIDE while running: the macOS web proxy of every network service points at mitmdump, so other apps' traffic passes through it too. One holder at a time: fails when another lease holds the proxy. Idempotent for the holding lease.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        rules: netProxyRulesSchema.optional().describe("Response-rewrite rules, first match wins. Default: none (transparent interception)."),
      },
    },
    async ({ lease_id, rules }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { port, pid } = await orch.startLeaseProxy(lease_id, rules ?? []);
        const count = rules?.length ?? 0;
        await orch.logAction(lease_id, "net_proxy_start", `proxy :${port}${count > 0 ? ` (${count} rules)` : " (transparent)"}`);
        return ok({ lease_id, udid: lease.udid, port, pid, rule_count: count });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );

  server.registerTool(
    "net_proxy_set_rules",
    {
      description:
        "Replace the rewrite rules of the running network proxy (mitmdump restarts on the same port; the host proxy stays on). Only the holding lease may set rules. Pass [] to clear all rewrites (transparent interception).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
        rules: netProxyRulesSchema.describe("Replacement rules, first match wins."),
      },
    },
    async ({ lease_id, rules }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        await orch.setLeaseProxyRules(lease_id, rules);
        await orch.logAction(lease_id, "net_proxy_set_rules", `rules := ${rules.length} rule(s)`);
        return ok({ lease_id, udid: lease.udid, rule_count: rules.length });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );

  server.registerTool(
    "net_proxy_stop",
    {
      description:
        "Stop the network proxy and restore the host proxy snapshot. Idempotent: stopping twice succeeds with stopped=false. Only the holding lease may stop.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id (must hold the proxy)."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const { stopped } = await orch.stopLeaseProxy(lease_id);
        await orch.logAction(lease_id, "net_proxy_stop", stopped ? "proxy stopped" : "proxy already stopped");
        return ok({ lease_id, udid: lease.udid, stopped });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );

  server.registerTool(
    "net_proxy_status",
    {
      description:
        "Show the network proxy state: running flag, port/pid, the holding lease/session when active, and the rule count. Any valid lease may view it.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const { lease, running, port, pid, leaseId, sessionId, udid, ruleCount, addonPath, flowLogPath } =
          await orch.leaseProxyStatus(lease_id);
        return ok({
          lease_id,
          udid: lease.udid,
          running,
          ...(port !== undefined ? { port } : {}),
          ...(pid !== undefined ? { pid } : {}),
          ...(leaseId !== undefined ? { holder_lease_id: leaseId } : {}),
          ...(sessionId !== undefined ? { holder_session_id: sessionId } : {}),
          ...(udid !== undefined ? { holder_udid: udid } : {}),
          ...(ruleCount !== undefined ? { rule_count: ruleCount } : {}),
          ...(addonPath !== undefined ? { addon_path: addonPath } : {}),
          ...(flowLogPath !== undefined ? { flow_log_path: flowLogPath } : {}),
        });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );

  server.registerTool(
    "net_assert_flow",
    {
      description:
        "Poll your holding proxy's flow log until min_count matching requests are seen (or the timeout elapses). Fails cleanly when the lease holds no running proxy.",
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
      },
    },
    async ({ lease_id, url_regex, method, min_count, timeout_sec }) => {
      try {
        const { lease, count, total, matched } = await orch.assertLeaseFlow(lease_id, {
          urlRegex: url_regex,
          ...(method !== undefined ? { method } : {}),
          ...(min_count !== undefined ? { minCount: min_count } : {}),
          ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}),
        });
        const needed = min_count ?? 1;
        if (count < needed) {
          return fail(
            `net_assert_flow: saw ${count} matching flow(s) for ${JSON.stringify(url_regex)} ` +
              `(needed ${needed}) out of ${total} total within ${timeout_sec ?? 5}s.`,
          );
        }
        await orch.logAction(lease_id, "net_assert_flow", `assert ${JSON.stringify(url_regex)}: ${count}/${total}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, count, total, matched });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );

  server.registerTool(
    "map_local",
    {
      description:
        "Serve a local file as the response for requests matching url_regex, without contacting upstream (missing-file reads at serve time return 502). Replaces a prior map_local for the same pattern; otherwise prepended (first match wins). Only the holding lease may map.",
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
        const { ruleCount } = await orch.upsertLeaseMapRule(lease_id, {
          match: { url_regex },
          action: { map_local: file },
        });
        await orch.logAction(lease_id, "map_local", `${JSON.stringify(url_regex)} -> ${path.basename(file)}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, url_regex, file, rule_count: ruleCount });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );

  server.registerTool(
    "map_remote",
    {
      description:
        "Rewrite the upstream URL to a fixed URL for requests matching url_regex. Replaces a prior map_remote for the same pattern; otherwise prepended (first match wins). Only the holding lease may map.",
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
        const { ruleCount } = await orch.upsertLeaseMapRule(lease_id, {
          match: { url_regex },
          action: { map_remote: url },
        });
        await orch.logAction(lease_id, "map_remote", `${JSON.stringify(url_regex)} -> ${url}`.slice(0, 160));
        return ok({ lease_id, udid: lease.udid, url_regex, url, rule_count: ruleCount });
      } catch (err) {
        return fail(netProxyError(err));
      }
    },
  );
}
