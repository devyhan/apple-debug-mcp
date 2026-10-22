import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactAxText } from "./ax-prune.js";
import { isRealLease, requireSimLease } from "./devicekind.js";
import { failureExtra, successExtra } from "./recovery.js";
import { instrumentToolcalls } from "./toolcalls.js";
import { registerDeviceExtras } from "./extras.js";
import { Llmdb } from "./llmdb.js";
import { appendM4Audit, maybeM4Decide, noteM4Ui } from "./m4.js";
import type { M4Result } from "./m4.js";
import { Orchestrator } from "./orchestrator.js";
import { ServeSim } from "./servesim.js";
import type { AppOps } from "./appops.js";
import type { LogOps } from "./logops.js";
import { Simslim } from "./simslim.js";
import type { Lease } from "./store.js";
import { appendShadowLog, buildShadowExtra, noteShadowUi } from "./shadow.js";
import { buildTapEchoExtra, buildTapFailureExtra, saveDescribeSnapshot, saveShotLink } from "./snapshot.js";
import type { UiDriver } from "./uidriver.js";
import { getServerInfo, getVersion } from "./version.js";
import { XCTrace } from "./xctrace.js";

export interface ServerDeps {
  orchestrator: Orchestrator;
  simslim: Simslim;
  axe: UiDriver;
  serveSim: ServeSim;
  simLog: LogOps;
  simApps: AppOps;
  xctrace: XCTrace;
  lldmdb: Llmdb;
  screenshotDir: string;
  realApps?: AppOps;
  realLog?: LogOps;
  /** Real-device UI backend (go-ios screenshot/describe/tap/type/swipe/button/batch; gesture is a precise driver limit). Absent ⇒ real ui_* fails with a missing-transport error. */
  realUi?: UiDriver;
}

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

function ok(data: unknown, extra: ToolResult["content"] = [], tool?: string): ToolResult {
  // P2: additive `next` only — every key from data keeps its value.
  const body = { ok: true, ...((data ?? {}) as object), ...successExtra(tool) };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }, ...extra],
  };
}

function fail(message: string, tool?: string): ToolResult {
  // P2: additive recovery fields only — `error` keeps its text verbatim.
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...failureExtra(message, tool) }, null, 2) }],
    isError: true,
  };
}

function sessionField(desc: string) {
  return z.string().min(1).describe(desc);
}

const requirementsShape = {
  udid: z.string().optional().describe("Exact simulator UDID to require."),
  device: z.string().optional().describe('Case-insensitive substring of device name, e.g. "iPhone 17 Pro".'),
  osVersion: z.string().optional().describe('OS version prefix, e.g. "26" or "26.5".'),
  platform: z.string().optional().describe('Platform, e.g. "iOS".'),
  device_kind: z.enum(["sim", "real"]).optional().describe('Device kind. Default "sim". "real" leases use the devicectl/go-ios transports (paired device with Developer Mode on).'),
  transport: z.enum(["usb", "wifi"]).optional().describe('Only meaningful with device_kind "real": best-effort usb/wifi match from devicectl state. Omit to match either.'),
};

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`, truncated: true };
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { orchestrator: orch, simslim, axe, serveSim, simLog, simApps, xctrace, lldmdb, screenshotDir } = deps;
  const server = new McpServer({ name: "apple-debug-mcp", version: getVersion() });
  instrumentToolcalls(server); // P1 single choke point: one {t, tool, ok} line per tools/call; never logs arg values.

  /** UI backend for a resolved lease: AXe for sims, go-ios for real devices. */
  function uiFor(lease: Lease, verb: string): UiDriver {
    if (!isRealLease(lease)) return axe;
    if (!deps.realUi) {
      throw new Error(`${verb} on real-device lease ${lease.leaseId} needs the go-ios UI transport, which is unavailable in this embedding.`);
    }
    return deps.realUi;
  }

  // ---------------- pool state ----------------

  server.registerTool(
    "pool_status",
    {
      title: "Pool status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to list, show, or check the status of simulators and devices, see who holds what lease, or check the wait-queue depth. There is no raw CLI for this orchestrator overlay (raw pieces: `simslim list --json` + `xcrun devicectl list devices`). Show every simulator (UDID, device, OS, boot/slim state) overlaid with its current lease holder (sessionId/client) and the wait-queue depth. Also lists real devices (devicectl inventory) with availability and lease overlay.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok({ server: getServerInfo(), ...(await orch.poolStatus()) }, [], "pool_status");
      } catch (err) {
        return fail((err as Error).message, "pool_status");
      }
    },
  );

  server.registerTool(
    "sessions_list",
    {
      title: "Sessions list",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to see who is on which simulator, which session holds what, or what your own session is running. There is no raw CLI for this orchestrator state view. Show which session is running on which simulator: groups active leases and queue tickets by caller-provided sessionId. Works for any client (Orca, Claude Code, TMA, scripts).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await orch.sessionsList(), [], "sessions_list");
      } catch (err) {
        return fail((err as Error).message, "sessions_list");
      }
    },
  );

  server.registerTool(
    "sim_boot",
    {
      title: "Boot simulator",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to boot or start a simulator. INSTEAD OF `simslim boot UDID --json`. Boot a simulator (waits for services). Prefer lease_acquire with autoBoot instead.",
      inputSchema: { udid: z.string().describe("Simulator UDID.") },
    },
    async ({ udid }) => {
      try {
        await simslim.boot(udid);
        return ok({ booted: udid }, [], "sim_boot");
      } catch (err) {
        return fail((err as Error).message, "sim_boot");
      }
    },
  );

  server.registerTool(
    "sim_shutdown",
    {
      title: "Shut down simulator",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to shut down a simulator. INSTEAD OF `simslim shutdown UDID --json`. Shut down a simulator. Refuses when leased unless force=true (which releases the lease and auto-dispatches the queue).",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        force: z.boolean().optional().describe("Release the active lease first. Default false."),
      },
    },
    async ({ udid, force }) => {
      try {
        const holder = await orch.leaseForUdid(udid);
        let released: unknown = null;
        if (holder) {
          requireSimLease(holder, { verb: "sim_shutdown", phase: "sim-only", detail: "simulators boot/shutdown via simslim" });
          if (!force) {
            return fail(
              `Simulator ${udid} is leased to session ${holder.sessionId} (lease ${holder.leaseId}). Pass force=true to preempt.`,
              "sim_shutdown",
            );
          }
          released = await orch.release(holder.leaseId, holder.sessionId, { force: true });
        }
        await simslim.shutdown(udid);
        return ok({ shutdown: udid, released }, [], "sim_shutdown");
      } catch (err) {
        return fail((err as Error).message, "sim_shutdown");
      }
    },
  );

  server.registerTool(
    "sim_slim",
    {
      title: "Slim simulator",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to slim a simulator for low RAM or restore its stock daemons. INSTEAD OF `simslim on UDID [--except categories] [--no-reboot]` or `simslim off UDID`. Slim (disable background daemons) or restore a simulator via simslim. mode=on reboots unless noReboot=true; rebooting a leased sim needs force=true.",
      inputSchema: {
        udid: z.string().describe("Simulator UDID."),
        mode: z.enum(["on", "off"]).describe("on = slim, off = restore stock."),
        except: z.string().optional().describe("Comma-separated categories to keep enabled, e.g. \"store,web\"."),
        noReboot: z.boolean().optional().describe("Slim the live boot session without rebooting. Default true."),
        force: z.boolean().optional().describe("Allow rebooting a leased simulator. Default false."),
      },
    },
    async ({ udid, mode, except, noReboot, force }) => {
      try {
        const holder = await orch.leaseForUdid(udid);
        if (holder) requireSimLease(holder, { verb: "sim_slim", phase: "sim-only", detail: "simulator daemon profiles via simslim" });
        const reboot = mode === "on" && noReboot === false;
        if (holder && reboot && !force) {
          return fail(
            `Simulator ${udid} is leased to session ${holder.sessionId}; slimming with reboot would interrupt it. Use noReboot or force=true.`,
            "sim_slim",
          );
        }
        if (mode === "on") {
          await simslim.slimOn(udid, { except, noReboot: noReboot ?? true });
        } else {
          await simslim.slimOff(udid);
        }
        return ok({ udid, mode }, [], "sim_slim");
      } catch (err) {
        return fail((err as Error).message, "sim_slim");
      }
    },
  );

  // ---------------- leases & queue ----------------

  server.registerTool(
    "lease_acquire",
    {
      title: "Acquire lease",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to get, lease, checkout, or acquire a simulator or real device for your session. There is no raw CLI for orchestrator leases (lease + wait queue + autoboot have no CLI equivalent). Acquire a simulator (or real-device, via device_kind) lease for your session. Returns a lease immediately when a matching device is free (booting a sim when autoBoot), otherwise a queue ticket — poll queue_status until it is assigned. Pass YOUR OWN sessionId (any client: Orca, Claude Code, TMA, script) plus a client label.",
      inputSchema: {
        session_id: sessionField("Your session id, in your own tool's format. Used for ownership and sessions_list."),
        client: z.string().optional().describe('Free-form client label, e.g. "orca", "claude-code", "tma". Default "unknown".'),
        task: z.string().optional().describe("Short human-readable description of what you will do."),
        ...requirementsShape,
        queue: z.boolean().optional().describe("Take a queue ticket when nothing is free. Default true."),
        auto_boot: z.boolean().optional().describe("Boot a matching shutdown sim when none is booted. Default true."),
        slim: z.boolean().optional().describe("Slim the sim (low RAM) before handing it over. Default true."),
        slim_except: z.string().optional().describe("Categories to keep enabled when slimming, e.g. \"store,web\"."),
        ttl_ms: z.number().int().positive().optional().describe("Lease TTL without heartbeat. Default = server setting."),
        stream: z.boolean().optional().describe("Start a live MJPEG stream for the lease (serve-sim helper on a scanned port). Default false."),
      },
    },
    async (args) => {
      try {
        const result = await orch.acquire({
          sessionId: args.session_id,
          client: args.client,
          task: args.task,
          requirements: {
            udid: args.udid,
            device: args.device,
            osVersion: args.osVersion,
            platform: args.platform,
            ...(args.device_kind !== undefined ? { deviceKind: args.device_kind } : {}),
            ...(args.transport !== undefined ? { transport: args.transport } : {}),
          },
          queue: args.queue,
          autoBoot: args.auto_boot,
          slim: args.slim,
          slimExcept: args.slim_except,
          ttlMs: args.ttl_ms,
          stream: args.stream,
        });
        if (!result.ok) return fail(result.reason, "lease_acquire");
        return ok(result, [], "lease_acquire");
      } catch (err) {
        return fail((err as Error).message, "lease_acquire");
      }
    },
  );

  server.registerTool(
    "lease_release",
    {
      title: "Release lease",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to release, free, or return a leased device when work is done. There is no raw CLI for orchestrator lease release (state + queue auto-dispatch). Release your lease when work is done. The freed simulator is immediately auto-dispatched to the oldest matching queue ticket.",
      inputSchema: {
        lease_id: z.string().describe("Lease id from lease_acquire (or queue_status after assignment)."),
        session_id: sessionField("Must match the session that holds the lease."),
      },
    },
    async ({ lease_id, session_id }) => {
      try {
        return ok(await orch.release(lease_id, session_id), [], "lease_release");
      } catch (err) {
        return fail((err as Error).message, "lease_release");
      }
    },
  );

  server.registerTool(
    "lease_heartbeat",
    {
      title: "Lease heartbeat",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to renew a lease TTL or send a keepalive for long-running work. There is no raw CLI for orchestrator lease heartbeats. Renew your lease TTL. Call periodically for long-running work.",
      inputSchema: {
        lease_id: z.string().describe("Lease id."),
        session_id: sessionField("Must match the session that holds the lease."),
      },
    },
    async ({ lease_id, session_id }) => {
      try {
        return ok({ lease: await orch.heartbeat(lease_id, session_id) }, [], "lease_heartbeat");
      } catch (err) {
        return fail((err as Error).message, "lease_heartbeat");
      }
    },
  );

  server.registerTool(
    "lease_list",
    {
      title: "List leases",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to list active leases, holder sessions, or expiry state. There is no raw CLI for this orchestrator state view. List all active leases with holder sessions and expiry state.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await orch.leasesList(), [], "lease_list");
      } catch (err) {
        return fail((err as Error).message, "lease_list");
      }
    },
  );

  server.registerTool(
    "queue_status",
    {
      title: "Queue status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "WHEN you want to poll the wait queue or check whether your ticket was assigned a lease. There is no raw CLI for the orchestrator wait queue. Poll the wait queue. With ticket_id, returns your ticket: status becomes assigned with lease_id/udid once auto-dispatched — then use the lease directly.",
      inputSchema: {
        ticket_id: z.string().optional().describe("Your queue ticket id. Omit to list the whole queue."),
      },
    },
    async ({ ticket_id }) => {
      try {
        return ok(await orch.queueStatus(ticket_id), [], "queue_status");
      } catch (err) {
        return fail((err as Error).message, "queue_status");
      }
    },
  );

  server.registerTool(
    "queue_cancel",
    {
      title: "Cancel queue ticket",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to cancel your waiting queue ticket. There is no raw CLI for the orchestrator wait queue. Cancel your waiting queue ticket.",
      inputSchema: {
        ticket_id: z.string().describe("Queue ticket id."),
        session_id: sessionField("Must match the session that owns the ticket."),
      },
    },
    async ({ ticket_id, session_id }) => {
      try {
        return ok(await orch.cancelTicket(ticket_id, session_id), [], "queue_cancel");
      } catch (err) {
        return fail((err as Error).message, "queue_cancel");
      }
    },
  );

  // ---------------- lease-gated UI automation (AXe) ----------------

  server.registerTool(
    "ui_describe",
    {
      title: "Describe UI",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "WHEN you want to see, read, or dump the UI hierarchy, or find an element, label, or button. INSTEAD OF `axe describe-ui --udid UDID [--point X,Y]` on sims, or `ios ui source --udid=UDID` on real devices. Describe the accessibility UI hierarchy of your leased simulator or real device (AXe describe-ui; go-ios `ios ui source` on real devices).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        x: z.number().optional().describe("With y: describe only the element at this point."),
        y: z.number().optional().describe("With x: describe only the element at this point."),
        format: z.enum(["full", "compact"]).optional().describe("Output shape: full raw AX JSON (default) or compact pruned nodes."),
        max_depth: z.number().int().nonnegative().optional().describe("Max depth for format=compact (root is 0). Omit for unlimited."),
        max_chars: z.number().int().positive().optional().describe("Truncate output. Default 20000."),
      },
    },
    async ({ lease_id, x, y, format, max_depth, max_chars }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const out = await uiFor(lease, "ui_describe").describeUi(lease.udid, x !== undefined && y !== undefined ? { x, y } : undefined);
        const shape = format ?? "full";
        let payload = out;
        let kept: number | undefined;
        if (shape === "compact") {
          try {
            const pruned = compactAxText(out, { maxDepth: max_depth });
            payload = pruned.text;
            kept = pruned.kept;
          } catch (err) {
            return fail(`compact format failed: ${(err as Error).message}`, "ui_describe");
          }
        }
        const { text, truncated } = truncate(payload, max_chars ?? 20000);
        // M1 snapshot (env-gated, default OFF): persist the full payload; null when off.
        const snap = saveDescribeSnapshot({ leaseId: lease_id, ui: payload, format: shape, truncated });
        // M3 shadow (env-gated, default OFF): cache the full payload; no-op when off.
        noteShadowUi(lease_id, payload, snap?.id);
        // M4 (env-gated, default OFF): cache full-hierarchy payloads only;
        // point describes return element-only payloads that could false-match.
        if (x === undefined && y === undefined) noteM4Ui(lease_id, payload, snap?.id);
        await orch.logAction(lease_id, "ui_describe", x !== undefined && y !== undefined ? `describe at (${x},${y})` : "describe full hierarchy",
          { ...(x !== undefined && y !== undefined ? { x, y } : {}), truncated, format: shape, ...(kept !== undefined ? { kept } : {}), ...(snap ? { snapshot_id: snap.id } : {}) });
        return ok({ udid: lease.udid, ui: text, truncated, format: shape, ...(kept !== undefined ? { kept } : {}) }, [], "ui_describe");
      } catch (err) {
        return fail((err as Error).message, "ui_describe");
      }
    },
  );

  server.registerTool(
    "ui_tap",
    {
      title: "Tap UI",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to tap, click, or press an element or point. INSTEAD OF `axe tap --udid UDID (-x X -y Y | --id/--label/--value ...)` on sims, or coords-only `ios ui tap --x=X --y=Y --udid=UDID` on real devices. Tap a point or an accessibility element on your leased simulator or real device (AXe tap; go-ios `ios ui tap` with x/y only on real devices).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        x: z.number().optional().describe("X coordinate (with y)."),
        y: z.number().optional().describe("Y coordinate (with x)."),
        id: z.string().optional().describe("Tap element matching accessibilityIdentifier."),
        label: z.string().optional().describe("Tap element matching accessibilityLabel."),
        value: z.string().optional().describe("Tap element matching AXValue."),
        element_type: z.string().optional().describe("Narrow matches, e.g. Button, TextField."),
        wait_timeout: z.number().optional().describe("Seconds to poll for the element. Default 0."),
        auto: z.boolean().optional().describe("Request an autonomous allowlisted tap (M4; ignored unless SIM_MCP_M4=1)."),
      },
    },
    async (args) => {
      const target = args.x !== undefined && args.y !== undefined ? `(${args.x},${args.y})`
        : [args.id && `id=${args.id}`, args.label && `label=${args.label}`, args.value && `value=${args.value}`, args.element_type && `type=${args.element_type}`].filter(Boolean).join(" ") || "default";
      const selectors = {
        ...(args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.element_type !== undefined ? { element_type: args.element_type } : {}),
        ...(args.wait_timeout !== undefined ? { wait_timeout: args.wait_timeout } : {}),
      };
      // M3 shadow query: request selectors only (label/id); coord-only taps
      // carry neither, so the predictor input is an empty query (skipped).
      const shadowQuery = {
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
      };
      // M4 allow-path decision, hoisted so the failure path can audit the
        // tap that never ran. Null unless auto:true with the gate on.
        let m4: M4Result | null = null;
      try {
        const lease = await orch.resolveLease(args.lease_id);
        // M4 (env-gated, default OFF): autonomous-tap pre-tap gate. Null when
        // manual (auto !== true) or the gate is off -> falls through
        // byte-identical. Deny -> no tap, audit line, standard deny response.
        m4 = maybeM4Decide({ leaseId: args.lease_id, query: shadowQuery, auto: args.auto });
        if (m4 !== null && m4.decision === "deny") {
          appendM4Audit({ leaseId: args.lease_id, query: shadowQuery, result: m4, tapped: false });
          await orch.logAction(args.lease_id, "ui_tap", `tap ${target} denied: ${m4.reason}`.slice(0, 160), { ...selectors, m4: `deny:${m4.reason}` });
          return fail(`m4 denied autonomous tap: ${m4.reason}`, "ui_tap");
        }
        const out = await uiFor(lease, "ui_tap").tap(lease.udid, {
          x: args.x, y: args.y, id: args.id, label: args.label, value: args.value,
          elementType: args.element_type, waitTimeout: args.wait_timeout,
        });
        // M4 allow path: audit the tap that ran; null unless auto+gate on.
        if (m4 !== null) {
          appendM4Audit({ leaseId: args.lease_id, query: shadowQuery, result: m4, tapped: true });
        }
        // M1 snapshot (env-gated, default OFF): tap resolution echo; null when off.
        const tapExtra = buildTapEchoExtra(out, { leaseId: args.lease_id });
        // M3 shadow (env-gated, default OFF): predict-then-compare after the
        // tap resolves; null/no-op when off. MCP response untouched.
        const shadowExtra = buildShadowExtra({ leaseId: args.lease_id, query: shadowQuery, tapOk: true });
        appendShadowLog({ leaseId: args.lease_id, query: shadowQuery, tapOk: true });
        await orch.logAction(args.lease_id, "ui_tap", `tap ${target}`.slice(0, 160), {
          ...selectors,
          ...(tapExtra ?? {}),
          ...(shadowExtra ?? {}),
          ...(m4 !== null ? { m4: "allow" } : {}),
        });
        return ok({ udid: lease.udid, output: out }, [], "ui_tap");
      } catch (err) {
        // M1 snapshot failure echo (env-gated, default OFF): null when off, so
        // the failure path is unchanged unless snapshots are on. Never masks.
        try {
          const failure = buildTapFailureExtra(err, { leaseId: args.lease_id, selectors });
          const shadowExtra = buildShadowExtra({ leaseId: args.lease_id, query: shadowQuery, tapOk: false });
          appendShadowLog({ leaseId: args.lease_id, query: shadowQuery, tapOk: false });
          // M4 allow-path failure: audit the tap that never ran. No-op unless
          // an autonomous tap was allowed and axe.tap then threw.
          if (m4 !== null) {
            appendM4Audit({ leaseId: args.lease_id, query: shadowQuery, result: m4, tapped: false });
          }
          if (failure || shadowExtra) {
            await orch.logAction(args.lease_id, "ui_tap", `tap ${target} failed`.slice(0, 160), {
              ...(failure ?? { tap_ok: false, ...selectors }),
              ...(shadowExtra ?? {}),
            });
          }
        } catch {
          // Never mask the original tap error.
        }
        return fail((err as Error).message, "ui_tap");
      }
    },
  );

  server.registerTool(
    "ui_type",
    {
      title: "Type text",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to type text into the focused field. INSTEAD OF `axe type --stdin --udid UDID` on sims, or `ios ui type --text=... --udid=UDID` on real devices. Type text on your leased simulator or real device (AXe type; go-ios `ios ui type` on real devices). US-keyboard characters only.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        text: z.string().min(1).describe("Text to type."),
      },
    },
    async ({ lease_id, text }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const out = await uiFor(lease, "ui_type").typeText(lease.udid, text);
        await orch.logAction(lease_id, "ui_type", `type ${JSON.stringify(text.slice(0, 80))}`);
        return ok({ udid: lease.udid, output: out }, [], "ui_type");
      } catch (err) {
        return fail((err as Error).message, "ui_type");
      }
    },
  );

  server.registerTool(
    "ui_swipe",
    {
      title: "Swipe",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to swipe or drag from one point to another. INSTEAD OF `axe swipe --udid UDID --start-x X --start-y Y --end-x X --end-y Y [--duration S]` on sims, or `ios ui api --rpc-method=device.io.swipe --params={x1,y1,x2,y2}` on real devices. Swipe from one point to another on your leased simulator or real device (AXe swipe; go-ios `ios ui api device.io.swipe` on real devices — the `ui swipe` CLI sends a param shape the runner rejects).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        start_x: z.number().describe("Start X."),
        start_y: z.number().describe("Start Y."),
        end_x: z.number().describe("End X."),
        end_y: z.number().describe("End Y."),
        duration: z.number().optional().describe("Swipe duration in seconds."),
      },
    },
    async (args) => {
      try {
        const lease = await orch.resolveLease(args.lease_id);
        const out = await uiFor(lease, "ui_swipe").swipe(lease.udid, { x: args.start_x, y: args.start_y }, { x: args.end_x, y: args.end_y }, { duration: args.duration });
        await orch.logAction(args.lease_id, "ui_swipe", `swipe (${args.start_x},${args.start_y})->(${args.end_x},${args.end_y})`);
        return ok({ udid: lease.udid, output: out }, [], "ui_swipe");
      } catch (err) {
        return fail((err as Error).message, "ui_swipe");
      }
    },
  );

  server.registerTool(
    "ui_gesture",
    {
      title: "Run gesture",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to scroll or swipe from a screen edge using a preset gesture. INSTEAD OF `axe gesture <preset> --udid UDID` on sims (no real-device equivalent — use ui_swipe there). Run a preset gesture on your leased simulator: scroll-up/down/left/right, swipe-from-left/right/top/bottom-edge. On real devices every preset fails with a precise unsupported error (no go-ios equivalent) — use ui_swipe with explicit coordinates.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        preset: z.enum(["scroll-up", "scroll-down", "scroll-left", "scroll-right", "swipe-from-left-edge", "swipe-from-right-edge", "swipe-from-top-edge", "swipe-from-bottom-edge"]),
        duration: z.number().optional().describe("Gesture duration in seconds."),
      },
    },
    async ({ lease_id, preset, duration }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const out = await uiFor(lease, "ui_gesture").gesture(lease.udid, preset, { duration });
        await orch.logAction(lease_id, "ui_gesture", `gesture ${preset}`);
        return ok({ udid: lease.udid, output: out }, [], "ui_gesture");
      } catch (err) {
        return fail((err as Error).message, "ui_gesture");
      }
    },
  );

  server.registerTool(
    "ui_button",
    {
      title: "Press button",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to press a hardware button (home, lock, side-button, siri, apple-pay). INSTEAD OF `axe button <name> --udid UDID` on sims, or `ios ui button <home|lock> --udid=UDID` on real devices. Press a hardware button on your leased simulator or real device (AXe button; go-ios `ios ui button` with home/lock on real devices — siri/side-button/apple-pay and hold durations are precise unsupported errors there).",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        button: z.enum(["apple-pay", "home", "lock", "side-button", "siri"]),
        duration: z.number().optional().describe("Hold duration in seconds."),
      },
    },
    async ({ lease_id, button, duration }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const out = await uiFor(lease, "ui_button").button(lease.udid, button, duration);
        await orch.logAction(lease_id, "ui_button", `button ${button}`);
        return ok({ udid: lease.udid, output: out }, [], "ui_button");
      } catch (err) {
        return fail((err as Error).message, "ui_button");
      }
    },
  );

  server.registerTool(
    "ui_screenshot",
    {
      title: "Take screenshot",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "WHEN you want to capture a screenshot or screen PNG. INSTEAD OF `axe screenshot --udid UDID --output PATH` on sims, or `ios screenshot --udid=UDID --output=PATH` on real devices. Capture a PNG screenshot from your leased simulator or real device. Returns the image plus its saved path.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
      },
    },
    async ({ lease_id }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        fs.mkdirSync(screenshotDir, { recursive: true });
        const file = path.join(screenshotDir, `${lease.udid}-${Date.now()}.png`);
        await uiFor(lease, "ui_screenshot").screenshot(lease.udid, file);
        const data = fs.readFileSync(file).toString("base64");
        // M1 snapshot (env-gated, default OFF): shot->describe link; null when off.
        const shot = saveShotLink({ leaseId: lease_id, shotPath: file });
        await orch.logAction(lease_id, "ui_screenshot", `screenshot ${path.basename(file)}`, shot ?? undefined);
        return ok({ udid: lease.udid, path: file }, [{ type: "image", data, mimeType: "image/png" }], "ui_screenshot");
      } catch (err) {
        return fail((err as Error).message, "ui_screenshot");
      }
    },
  );

  server.registerTool(
    "ui_batch",
    {
      title: "Run UI batch",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "WHEN you want to run a batch of many interaction steps fast in one session. INSTEAD OF `axe batch --udid UDID --step ...` on sims, or per-step `ios ui ...` calls on real devices. Run ordered interaction steps in one AXe session (faster than separate calls). Each step starts with tap|swipe|gesture|touch|type|button|key|key-sequence|key-combo|sleep, e.g. 'tap --label Sign\\ In' or \"type 'hello'\". On real devices tap/swipe/type/button/sleep steps run per-step via go-ios; gesture/touch/key steps fail with precise unsupported errors.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        steps: z.array(z.string().min(1)).min(1).max(50).describe("Ordered steps, one AXe command fragment each."),
        continue_on_error: z.boolean().optional().describe("Keep going after a failed step. Default false."),
        wait_timeout: z.number().optional().describe("Seconds to poll for selector-based elements. Default 0."),
      },
    },
    async ({ lease_id, steps, continue_on_error, wait_timeout }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        const out = await uiFor(lease, "ui_batch").batch(lease.udid, steps, { continueOnError: continue_on_error, waitTimeout: wait_timeout });
        await orch.logAction(lease_id, "ui_batch", `batch ${steps.length} steps: ${steps.join("; ").slice(0, 120)}`);
        return ok({ udid: lease.udid, output: out }, [], "ui_batch");
      } catch (err) {
        return fail((err as Error).message, "ui_batch");
      }
    },
  );

  registerDeviceExtras(server, {
    orchestrator: orch,
    serveSim,
    simLog,
    simApps,
    xctrace,
    lldmdb,
    ...(deps.realApps !== undefined ? { realApps: deps.realApps } : {}),
    ...(deps.realLog !== undefined ? { realLog: deps.realLog } : {}),
  });

  return server;
}
