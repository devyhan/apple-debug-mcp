import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactAxText } from "./ax-prune.js";
import { isRealLease, requireSimLease } from "./devicekind.js";
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

const UI_REAL_DETAIL = "real-device UI automation via WebDriverAgent/idb-backed UiDriver";

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
  /** Real-device UI backend (go-ios screenshot). Absent ⇒ real ui_screenshot fails with a missing-transport error. */
  realUi?: UiDriver;
}

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

function ok(data: unknown, extra: ToolResult["content"] = []): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...((data ?? {}) as object)}, null, 2) }, ...extra],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
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

  /** UI backend for a resolved lease: AXe for sims, go-ios screenshot for real devices. */
  function uiFor(lease: Lease, verb: string): UiDriver {
    if (!isRealLease(lease)) return axe;
    if (!deps.realUi) {
      throw new Error(`${verb} on real-device lease ${lease.leaseId} needs the go-ios screenshot transport, which is unavailable in this embedding.`);
    }
    return deps.realUi;
  }

  // ---------------- pool state ----------------

  server.registerTool(
    "pool_status",
    {
      description:
        "Show every simulator (UDID, device, OS, boot/slim state) overlaid with its current lease holder (sessionId/client) and the wait-queue depth. Also lists real devices (devicectl inventory) with availability and lease overlay.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok({ server: getServerInfo(), ...(await orch.poolStatus()) });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "sessions_list",
    {
      description:
        "Show which session is running on which simulator: groups active leases and queue tickets by caller-provided sessionId. Works for any client (Orca, Claude Code, TMA, scripts).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await orch.sessionsList());
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "sim_boot",
    {
      description: "Boot a simulator (waits for services). Prefer lease_acquire with autoBoot instead.",
      inputSchema: { udid: z.string().describe("Simulator UDID.") },
    },
    async ({ udid }) => {
      try {
        await simslim.boot(udid);
        return ok({ booted: udid });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "sim_shutdown",
    {
      description: "Shut down a simulator. Refuses when leased unless force=true (which releases the lease and auto-dispatches the queue).",
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
            );
          }
          released = await orch.release(holder.leaseId, holder.sessionId, { force: true });
        }
        await simslim.shutdown(udid);
        return ok({ shutdown: udid, released });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "sim_slim",
    {
      description:
        "Slim (disable background daemons) or restore a simulator via simslim. mode=on reboots unless noReboot=true; rebooting a leased sim needs force=true.",
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
          );
        }
        if (mode === "on") {
          await simslim.slimOn(udid, { except, noReboot: noReboot ?? true });
        } else {
          await simslim.slimOff(udid);
        }
        return ok({ udid, mode });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  // ---------------- leases & queue ----------------

  server.registerTool(
    "lease_acquire",
    {
      description:
        "Acquire a simulator (or real-device, via device_kind) lease for your session. Returns a lease immediately when a matching device is free (booting a sim when autoBoot), otherwise a queue ticket — poll queue_status until it is assigned. Pass YOUR OWN sessionId (any client: Orca, Claude Code, TMA, script) plus a client label.",
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
        if (!result.ok) return fail(result.reason);
        return ok(result);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "lease_release",
    {
      description:
        "Release your lease when work is done. The freed simulator is immediately auto-dispatched to the oldest matching queue ticket.",
      inputSchema: {
        lease_id: z.string().describe("Lease id from lease_acquire (or queue_status after assignment)."),
        session_id: sessionField("Must match the session that holds the lease."),
      },
    },
    async ({ lease_id, session_id }) => {
      try {
        return ok(await orch.release(lease_id, session_id));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "lease_heartbeat",
    {
      description: "Renew your lease TTL. Call periodically for long-running work.",
      inputSchema: {
        lease_id: z.string().describe("Lease id."),
        session_id: sessionField("Must match the session that holds the lease."),
      },
    },
    async ({ lease_id, session_id }) => {
      try {
        return ok({ lease: await orch.heartbeat(lease_id, session_id) });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "lease_list",
    {
      description: "List all active leases with holder sessions and expiry state.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await orch.leasesList());
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "queue_status",
    {
      description:
        "Poll the wait queue. With ticket_id, returns your ticket: status becomes assigned with lease_id/udid once auto-dispatched — then use the lease directly.",
      inputSchema: {
        ticket_id: z.string().optional().describe("Your queue ticket id. Omit to list the whole queue."),
      },
    },
    async ({ ticket_id }) => {
      try {
        return ok(await orch.queueStatus(ticket_id));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "queue_cancel",
    {
      description: "Cancel your waiting queue ticket.",
      inputSchema: {
        ticket_id: z.string().describe("Queue ticket id."),
        session_id: sessionField("Must match the session that owns the ticket."),
      },
    },
    async ({ ticket_id, session_id }) => {
      try {
        return ok(await orch.cancelTicket(ticket_id, session_id));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  // ---------------- lease-gated UI automation (AXe) ----------------

  server.registerTool(
    "ui_describe",
    {
      description: "Describe the accessibility UI hierarchy of your leased simulator (AXe describe-ui).",
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
        requireSimLease(lease, { verb: "ui_describe", phase: "P2", detail: UI_REAL_DETAIL });
        const out = await axe.describeUi(lease.udid, x !== undefined && y !== undefined ? { x, y } : undefined);
        const shape = format ?? "full";
        let payload = out;
        let kept: number | undefined;
        if (shape === "compact") {
          try {
            const pruned = compactAxText(out, { maxDepth: max_depth });
            payload = pruned.text;
            kept = pruned.kept;
          } catch (err) {
            return fail(`compact format failed: ${(err as Error).message}`);
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
        return ok({ udid: lease.udid, ui: text, truncated, format: shape, ...(kept !== undefined ? { kept } : {}) });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_tap",
    {
      description: "Tap a point or an accessibility element on your leased simulator (AXe tap).",
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
        requireSimLease(lease, { verb: "ui_tap", phase: "P2", detail: UI_REAL_DETAIL });
        // M4 (env-gated, default OFF): autonomous-tap pre-tap gate. Null when
        // manual (auto !== true) or the gate is off -> falls through
        // byte-identical. Deny -> no tap, audit line, standard deny response.
        m4 = maybeM4Decide({ leaseId: args.lease_id, query: shadowQuery, auto: args.auto });
        if (m4 !== null && m4.decision === "deny") {
          appendM4Audit({ leaseId: args.lease_id, query: shadowQuery, result: m4, tapped: false });
          await orch.logAction(args.lease_id, "ui_tap", `tap ${target} denied: ${m4.reason}`.slice(0, 160), { ...selectors, m4: `deny:${m4.reason}` });
          return fail(`m4 denied autonomous tap: ${m4.reason}`);
        }
        const out = await axe.tap(lease.udid, {
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
        return ok({ udid: lease.udid, output: out });
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
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_type",
    {
      description: "Type text on your leased simulator (AXe type). US-keyboard characters only.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        text: z.string().min(1).describe("Text to type."),
      },
    },
    async ({ lease_id, text }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "ui_type", phase: "P2", detail: UI_REAL_DETAIL });
        const out = await axe.typeText(lease.udid, text);
        await orch.logAction(lease_id, "ui_type", `type ${JSON.stringify(text.slice(0, 80))}`);
        return ok({ udid: lease.udid, output: out });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_swipe",
    {
      description: "Swipe from one point to another on your leased simulator (AXe swipe).",
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
        requireSimLease(lease, { verb: "ui_swipe", phase: "P2", detail: UI_REAL_DETAIL });
        const out = await axe.swipe(lease.udid, { x: args.start_x, y: args.start_y }, { x: args.end_x, y: args.end_y }, { duration: args.duration });
        await orch.logAction(args.lease_id, "ui_swipe", `swipe (${args.start_x},${args.start_y})->(${args.end_x},${args.end_y})`);
        return ok({ udid: lease.udid, output: out });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_gesture",
    {
      description: "Run a preset gesture on your leased simulator: scroll-up/down/left/right, swipe-from-left/right/top/bottom-edge.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        preset: z.enum(["scroll-up", "scroll-down", "scroll-left", "scroll-right", "swipe-from-left-edge", "swipe-from-right-edge", "swipe-from-top-edge", "swipe-from-bottom-edge"]),
        duration: z.number().optional().describe("Gesture duration in seconds."),
      },
    },
    async ({ lease_id, preset, duration }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "ui_gesture", phase: "P2", detail: UI_REAL_DETAIL });
        const out = await axe.gesture(lease.udid, preset, { duration });
        await orch.logAction(lease_id, "ui_gesture", `gesture ${preset}`);
        return ok({ udid: lease.udid, output: out });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_button",
    {
      description: "Press a hardware button on your leased simulator: home, lock, side-button, siri, apple-pay.",
      inputSchema: {
        lease_id: z.string().describe("Your active lease id."),
        button: z.enum(["apple-pay", "home", "lock", "side-button", "siri"]),
        duration: z.number().optional().describe("Hold duration in seconds."),
      },
    },
    async ({ lease_id, button, duration }) => {
      try {
        const lease = await orch.resolveLease(lease_id);
        requireSimLease(lease, { verb: "ui_button", phase: "P2", detail: UI_REAL_DETAIL });
        const out = await axe.button(lease.udid, button, duration);
        await orch.logAction(lease_id, "ui_button", `button ${button}`);
        return ok({ udid: lease.udid, output: out });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_screenshot",
    {
      description: "Capture a PNG screenshot from your leased simulator or real device. Returns the image plus its saved path.",
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
        return ok({ udid: lease.udid, path: file }, [{ type: "image", data, mimeType: "image/png" }]);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "ui_batch",
    {
      description:
        "Run ordered interaction steps in one AXe session (faster than separate calls). Each step starts with tap|swipe|gesture|touch|type|button|key|key-sequence|key-combo|sleep, e.g. 'tap --label Sign\\ In' or \"type 'hello'\".",
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
        requireSimLease(lease, { verb: "ui_batch", phase: "P2", detail: UI_REAL_DETAIL });
        const out = await axe.batch(lease.udid, steps, { continueOnError: continue_on_error, waitTimeout: wait_timeout });
        await orch.logAction(lease_id, "ui_batch", `batch ${steps.length} steps: ${steps.join("; ").slice(0, 120)}`);
        return ok({ udid: lease.udid, output: out });
      } catch (err) {
        return fail((err as Error).message);
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
