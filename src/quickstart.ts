/**
 * P3 discoverability: server instructions + ONE quickstart resource + 3 prompts.
 *
 * Additive-only by construction: this module registers resources/prompts only,
 * which live in separate SDK maps with separate list handlers, so tools/list
 * keeps exactly 70 tools. Call `registerQuickstart` once per server from
 * `createMcpServer` (never from `registerDeviceExtras`: standalone bare-server
 * tests must not gain resources/prompts). All strings are grounded in
 * docs/agents.md (8 rules), README quickstart, docs/examples.md (3 chains),
 * and the tool arg shapes in src/server.ts / src/extras.ts.
 *
 * P3 measurement: research-2 proved the minimal additive seam — resources and
 * prompts have no isError convention (failures throw McpError), so ok=false
 * iff the callback throws. `instrumentQuickstartCalls` wraps
 * registerResource/registerPrompt (mirroring toolcalls.ts: same WeakSet
 * idempotency, same SIM_MCP_TOOLCALLS gate + file, never-throw, no arg
 * values) and appends `{t, tool, ok, kind}` lines where kind is
 * "resource"|"prompt". Existing `{t, tool, ok}` tool lines stay byte-identical
 * because toolcalls.ts is untouched — the `kind` key appears ONLY on
 * resource/prompt lines.
 */
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isToolcallsEnabled, resolveToolcallsFile } from "./toolcalls.js";

/** Server instructions: published via the McpServer ctor options (initialize only). */
export const QUICKSTART_INSTRUCTIONS =
  "apple-debug-mcp: shared Apple Simulator debug daemon (one Mac, many agent sessions). " +
  "Loop: lease_acquire(session_id=YOUR session id, client, task) -> drive via ui_*/app_*/debug_*/net_* " +
  "with the returned lease_id -> lease_heartbeat on long work -> lease_release. " +
  "lease_id comes from lease_acquire (or queue_status once a wait ticket shows assigned); " +
  "session_id is your own tool's session id. " +
  "NEVER start a per-session server: one shared daemon owns the pool/queue; if /health is unreachable " +
  "say so, never work around with direct `xcrun simctl`. " +
  "Only the holding lease may drive its sim; on holder-mismatch stop and report. " +
  "Turn off proxy/stream when done (net_proxy_stop, stream_stop). " +
  "One debug session per lease; debug_detach when done.";

/** Canonical absolute URI for the ONE quickstart resource (must round-trip `new URL(u).toString()`). */
export const QUICKSTART_URI = "apple-debug-mcp://quickstart";

/** Quickstart body: 8 agents.md rules (condensed) + 3 grounded tool chains. */
export const QUICKSTART_BODY = [
  "# apple-debug-mcp quickstart",
  "Shared sim pool. Loop: lease -> drive -> release.",
  "- session_id = YOUR tool's session id (+client label); lease_id = from lease_acquire, or queue_status once a ticket shows assigned.",
  "1. One shared daemon only. Never start a per-session server; if /health is down, say so (no direct `xcrun simctl`).",
  "2. Wait tickets are normal: poll queue_status; never boot out of band to skip the line.",
  "3. Only the holding lease drives its sim; on holder-mismatch stop and report, no force=true unless asked.",
  "4. Heartbeat long work (lease_heartbeat, TTL 30min); release when done (lease_release hands over booted).",
  "5. Stop proxy/stream when done: net_proxy_stop, stream_stop (both host-wide while on).",
  "6. One debug session per lease; debug_detach when done (release also stops it).",
  "Chain A login tap:",
  "lease_acquire{session_id,client,task,device} -> ui_describe{lease_id} -> ui_tap{lease_id,label} -> lease_release{lease_id,session_id}",
  "Chain B mock API:",
  "net_proxy_start{lease_id,rules:[{match:{url_regex},action:{map_local}}]} -> net_assert_flow{lease_id,url_regex} -> net_proxy_stop{lease_id}",
  "Chain C debug a line:",
  "debug_attach{lease_id,bundle_id} -> debug_break{lease_id,file,line} -> debug_continue{lease_id} -> debug_locals{lease_id} -> debug_detach{lease_id}",
].join("\n");

export const PROMPT_DEBUG_SESSION = "ios-debug-session";
export const PROMPT_PROXY_TAMPER = "proxy-tamper";
export const PROMPT_LOG_TRIAGE = "log-triage";

const DEBUG_SESSION_MESSAGE =
  "Debug {{bundle_id}} at {{file}}:{{line}}. " +
  "1) If no lease_id: lease_acquire{session_id,client,task}; if a ticket returns, poll queue_status{ticket_id} until assigned. " +
  "2) app_launch{lease_id,bundle_id} if not running. " +
  "3) debug_attach{lease_id,bundle_id} (exactly one of bundle_id/pid; debuggable get-task-allow build only). " +
  "4) debug_break{lease_id,file,line} (exactly one op per call). " +
  "5) debug_continue{lease_id}, then debug_bt{lease_id} and debug_locals{lease_id}. " +
  "6) debug_detach{lease_id}; lease_release{lease_id,session_id} when done.";

const PROXY_TAMPER_MESSAGE =
  "Tamper {{url_regex}}. " +
  "1) net_proxy_start{lease_id,rules:[{match:{url_regex},action:{map_local:file}}]} or action:{status} " +
  "(action needs >=1 field; rules max 50, first match wins). Proxy is HOST-WIDE while on: keep it only for the test. " +
  "2) Drive the app to hit the endpoint. " +
  "3) net_assert_flow{lease_id,url_regex,min_count} to prove the hit (fails cleanly without a running proxy). " +
  "4) net_proxy_stop{lease_id} immediately when done.";

const LOG_TRIAGE_MESSAGE =
  "Triage logs on {{udid}}. " +
  "History: sim_log_show{udid,last,process} (sim history only; real devices are live-only). " +
  "Live: sim_log_stream{udid,process,timeout_sec} during the repro. " +
  "Results are {log,truncated,timedOut}; timedOut:true is normal for stream. " +
  "Narrow with process + max_chars (tail kept, default 20000); combine predicate AND process for precision.";

export interface QuickstartCallEvent {
  t: number;
  tool: string;
  ok: boolean;
  kind: "resource" | "prompt";
}

/** Append one kind-tagged line. Best-effort: never throws, never logs arg values. */
export function appendQuickstartCall(tool: string, ok: boolean, kind: QuickstartCallEvent["kind"]): void {
  try {
    if (!isToolcallsEnabled()) return;
    const event: QuickstartCallEvent = { t: Date.now(), tool, ok, kind };
    const file = resolveToolcallsFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // Parent may already exist; the append below is the real attempt.
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Telemetry must never break the resource/prompt path.
  }
}

const quickstartInstrumented = new WeakSet<object>();

type RegisterResourceFn = McpServer["registerResource"];
type RegisterPromptFn = McpServer["registerPrompt"];

/**
 * Wrap `registerResource`/`registerPrompt` so every read/prompt callback
 * appends exactly one kind-tagged telemetry line. Idempotent per server.
 * Never touches registerTool, so tool lines stay byte-identical.
 */
export function instrumentQuickstartCalls(server: McpServer): void {
  if (quickstartInstrumented.has(server)) return;
  quickstartInstrumented.add(server);
  const origResource = server.registerResource.bind(server) as (...args: unknown[]) => unknown;
  const origPrompt = server.registerPrompt.bind(server) as (...args: unknown[]) => unknown;
  const wrap = (kind: QuickstartCallEvent["kind"], orig: (...args: unknown[]) => unknown) =>
    (name: string, ...rest: unknown[]): unknown => {
      const cb = rest[rest.length - 1] as (...args: never[]) => unknown;
      const counted = async (...args: never[]): Promise<unknown> => {
        let ok = true;
        try {
          return await cb(...args);
        } catch (err) {
          ok = false;
          throw err;
        } finally {
          appendQuickstartCall(name, ok, kind);
        }
      };
      return orig(name, ...rest.slice(0, -1), counted);
    };
  server.registerResource = wrap("resource", origResource) as unknown as RegisterResourceFn;
  server.registerPrompt = wrap("prompt", origPrompt) as unknown as RegisterPromptFn;
}

/**
 * Register the ONE quickstart resource + exactly 3 prompts. Call once per
 * server instance from createMcpServer (per-session fresh instances make
 * the SDK's duplicate-registration throw unreachable in practice).
 */
export function registerQuickstart(server: McpServer): void {
  instrumentQuickstartCalls(server);

  server.registerResource(
    "quickstart",
    QUICKSTART_URI,
    { mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: QUICKSTART_URI, mimeType: "text/markdown", text: QUICKSTART_BODY }],
    }),
  );

  // Prompt args are strings on the wire; keep every arg z.string() so no
  // coercion can fail. Only required/optional shapes carry meaning here.
  server.registerPrompt(
    PROMPT_DEBUG_SESSION,
    {
      description: "Attach llmdb to a running app, set a file:line breakpoint, continue, inspect locals, detach.",
      argsSchema: {
        lease_id: z.string().optional().describe("Existing lease id; else lease_acquire first."),
        bundle_id: z.string().describe("App bundle id to debug."),
        file: z.string().describe("Source file for the breakpoint."),
        line: z.string().describe("1-based line number for the breakpoint."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: DEBUG_SESSION_MESSAGE.replaceAll("{{bundle_id}}", args.bundle_id)
              .replaceAll("{{file}}", args.file)
              .replaceAll("{{line}}", args.line),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    PROMPT_PROXY_TAMPER,
    {
      description: "Intercept HTTPS, rewrite one endpoint to a fixture or status, assert the flow, stop the proxy.",
      argsSchema: {
        lease_id: z.string().describe("Holding lease id."),
        url_regex: z.string().describe("Regex matched against the full request URL."),
        file: z.string().optional().describe("Fixture file for map_local; mutually exclusive with status."),
        status: z.string().optional().describe("Override status code 100-599; mutually exclusive with file."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: PROXY_TAMPER_MESSAGE.replaceAll("{{url_regex}}", args.url_regex) },
        },
      ],
    }),
  );

  server.registerPrompt(
    PROMPT_LOG_TRIAGE,
    {
      description: "Read recent or live simulator logs around a repro, narrowed by process.",
      argsSchema: {
        udid: z.string().describe("Simulator UDID."),
        process: z.string().optional().describe("Process-name filter."),
        last: z.string().optional().describe("History window, e.g. 10m (default 5m)."),
        timeout_sec: z.string().optional().describe("Live window in seconds (default 5, max 60)."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: LOG_TRIAGE_MESSAGE.replaceAll("{{udid}}", args.udid) },
        },
      ],
    }),
  );
}
