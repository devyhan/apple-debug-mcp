/**
 * P2 agent guidance: additive `next[]` on success + recovery fields on failure.
 *
 * Contract (additive-only, never-throw):
 * - Success payloads keep every existing key byte-identical and gain
 *   `next: string[]` (2-5 tool names from NEXT_ACTIONS) when the tool is
 *   known. No existing handler emits a `next` key, so the merge never
 *   overwrites.
 * - Failure payloads keep `{ok:false, error}` byte-identical and gain
 *   `recoverable: boolean`, plus `recover_with_tool` / `recover_args_hint`
 *   when a grounded recovery exists. Classification is purely off the error
 *   message (+ optional tool name for same-tool retries), so every fail()
 *   site is covered without per-site edits.
 *
 * Every export is best-effort and never throws: guidance must never break
 * the tool path.
 */

export interface Recovery {
  recoverable: boolean;
  recover_with_tool?: string;
  recover_args_hint?: Record<string, unknown>;
}

/** Per-tool follow-ups. Every name must be one of the 71 registered tools. */
export const NEXT_ACTIONS: Record<string, readonly string[]> = {
  // server.ts (20)
  pool_status: ["lease_acquire", "sessions_list", "lease_list", "queue_status"],
  sessions_list: ["lease_list", "pool_status", "queue_status", "lease_acquire"],
  sim_boot: ["lease_acquire", "pool_status", "sim_slim"],
  sim_shutdown: ["pool_status", "lease_acquire", "sim_boot"],
  sim_slim: ["lease_acquire", "pool_status", "sim_boot"],
  lease_acquire: ["queue_status", "ui_describe", "app_install", "stream_start", "ui_triage"],
  lease_release: ["lease_acquire", "pool_status", "queue_status"],
  lease_heartbeat: ["lease_list", "lease_release", "ui_describe"],
  lease_list: ["lease_heartbeat", "lease_release", "sessions_list"],
  queue_status: ["queue_cancel", "lease_acquire", "pool_status", "ui_describe"],
  queue_cancel: ["lease_acquire", "queue_status", "pool_status"],
  ui_describe: ["ui_tap", "ui_screenshot", "ui_type", "ui_batch"],
  ui_tap: ["ui_describe", "ui_screenshot", "ui_type", "ui_triage"],
  ui_type: ["ui_describe", "ui_tap", "ui_screenshot"],
  ui_swipe: ["ui_describe", "ui_screenshot", "ui_gesture"],
  ui_gesture: ["ui_describe", "ui_screenshot", "ui_swipe"],
  ui_button: ["ui_describe", "ui_screenshot", "ui_tap"],
  ui_screenshot: ["ui_describe", "ui_tap", "lease_actions", "lease_release"],
  ui_batch: ["ui_describe", "ui_screenshot", "lease_actions", "lease_release"],
  ui_triage: ["ui_tap", "ui_type", "ui_describe", "ui_screenshot"],
  // extras.ts (51)
  sim_rotate: ["ui_screenshot", "ui_describe", "lease_acquire"],
  sim_ca_debug: ["ui_screenshot", "profile_trace", "sim_rotate"],
  sim_memory_warning: ["sim_log_stream", "profile_trace", "ui_describe"],
  camera_start: ["camera_status", "app_launch", "ui_screenshot"],
  camera_switch: ["camera_status", "ui_screenshot", "camera_stop"],
  camera_mirror: ["camera_status", "ui_screenshot", "camera_stop"],
  camera_status: ["camera_stop", "camera_switch", "camera_start"],
  camera_stop: ["camera_status", "camera_start", "lease_release"],
  sim_log_stream: ["sim_log_show", "ui_describe", "profile_trace"],
  sim_log_show: ["sim_log_stream", "profile_trace", "symbolicate"],
  stream_start: ["ui_screenshot", "ui_describe", "stream_stop"],
  stream_stop: ["stream_start", "lease_release", "ui_screenshot"],
  app_open_url: ["ui_describe", "ui_screenshot", "app_launch"],
  app_install: ["app_launch", "app_uninstall", "ui_describe"],
  app_uninstall: ["app_install", "app_reinstall", "lease_actions"],
  app_reinstall: ["app_launch", "ui_describe", "app_install"],
  app_launch: ["ui_describe", "debug_attach", "ui_screenshot", "ui_triage"],
  app_terminate: ["app_launch", "app_uninstall", "ui_describe"],
  app_cache_clear: ["app_launch", "ui_describe", "app_reinstall"],
  profile_trace: ["symbolicate", "sim_log_show", "ui_describe"],
  debug_attach: ["debug_break", "debug_continue", "debug_bt", "debug_threads"],
  debug_break: ["debug_continue", "debug_bt", "debug_run_until", "debug_locals"],
  debug_continue: ["debug_bt", "debug_locals", "debug_threads", "debug_step"],
  debug_bt: ["debug_locals", "debug_threads", "debug_eval", "symbolicate"],
  debug_locals: ["debug_eval", "debug_scopes", "debug_expand", "debug_bt"],
  debug_eval: ["debug_locals", "debug_set_var", "debug_step", "debug_continue"],
  debug_step: ["debug_locals", "debug_bt", "debug_eval", "debug_continue"],
  debug_detach: ["debug_attach", "debug_sessions", "lease_release"],
  debug_sessions: ["debug_attach", "debug_doctor", "debug_detach"],
  debug_launch: ["debug_break", "debug_continue", "debug_bt", "debug_attach"],
  debug_doctor: ["debug_attach", "debug_sessions", "debug_launch"],
  debug_threads: ["debug_bt", "debug_locals", "debug_eval"],
  debug_scopes: ["debug_locals", "debug_expand", "debug_eval"],
  debug_expand: ["debug_eval", "debug_locals", "debug_set_var"],
  debug_set_var: ["debug_eval", "debug_continue", "debug_locals"],
  debug_output: ["debug_bt", "debug_locals", "debug_continue"],
  debug_run_until: ["debug_bt", "debug_locals", "debug_break", "debug_continue"],
  debug_wait: ["debug_bt", "debug_locals", "debug_interrupt", "debug_output"],
  debug_interrupt: ["debug_bt", "debug_locals", "debug_continue", "debug_detach"],
  symbolicate: ["debug_bt", "sim_log_show", "profile_trace"],
  lease_actions: ["ui_describe", "lease_release", "ui_screenshot"],
  net_proxy_start: ["net_proxy_status", "net_proxy_set_rules", "net_assert_flow"],
  net_proxy_set_rules: ["net_assert_flow", "net_proxy_status", "map_local", "map_remote"],
  net_proxy_stop: ["net_proxy_start", "net_proxy_status", "lease_release"],
  net_proxy_status: ["net_proxy_start", "net_proxy_set_rules", "net_assert_flow"],
  net_capture_start: ["net_capture_status", "net_capture_stop", "net_assert_flow"],
  net_capture_stop: ["net_capture_status", "net_capture_start", "lease_release"],
  net_capture_status: ["net_capture_start", "net_capture_stop", "net_proxy_status"],
  net_assert_flow: ["net_proxy_set_rules", "net_proxy_status", "map_local", "map_remote"],
  map_local: ["net_assert_flow", "net_proxy_set_rules", "net_proxy_status"],
  map_remote: ["net_assert_flow", "net_proxy_set_rules", "net_proxy_status"],
};

/** Fresh lease args hint (exact zod arg names; <> placeholders stay literal). */
function freshLeaseHint(): Record<string, unknown> {
  return { session_id: "<your-session-id>", client: "<your-client>", task: "<what-you-will-do>" };
}

/** Tools whose lease refusal carries force=true (sim_shutdown/sim_slim/leaseGate verbs). */
const FORCE_RETRY_TOOLS = new Set([
  "sim_shutdown",
  "sim_slim",
  "sim_rotate",
  "sim_ca_debug",
  "sim_memory_warning",
  "camera_start",
  "camera_switch",
]);

const INSTALL_COMMANDS: [RegExp, string][] = [
  [/serve-sim/i, "npm install -g serve-sim (or set SERVE_SIM_BIN)"],
  [/llmdb/i, "brew install alexmx/tools/llmdb (or set LLMDB_BIN)"],
  [/mitmdump/i, "brew install mitmproxy (or set MITMDUMP_BIN)"],
  [/tcpdump/i, "macOS ships tcpdump; ensure it is on PATH (or set TCPDUMP_BIN)"],
  [/go-ios/i, "npm install -g go-ios (or set IOS_BIN)"],
  [/devicectl/i, "install Xcode + accept the license (xcode-select --install)"],
];

/**
 * Classify an error message into a recovery. Never throws; unknown errors
 * are recoverable=false with no tool (E17). Order is specific-first: every
 * early return was chosen so a later generic rule cannot shadow it.
 */
export function recoveryFor(message: string, tool?: string): Recovery {
  try {
    const msg = typeof message === "string" ? message : String(message);

    // E7: missing binary with an install-hint suffix (serve-sim/go-ios/llmdb/tcpdump/mitmdump).
    if (/is not installed/i.test(msg)) {
      for (const [re, cmd] of INSTALL_COMMANDS) {
        if (re.test(msg)) return { recoverable: false, recover_args_hint: { install: cmd } };
      }
      return { recoverable: false };
    }
    // E9: unconfigured embedding (missing transport / proxy / capture / streamer).
    if (
      /unavailable in this embedding/i.test(msg) ||
      /no proxy is configured/i.test(msg) ||
      /no capture is configured/i.test(msg) ||
      /no .*streamer is configured/i.test(msg)
    ) {
      return { recoverable: false };
    }
    // E6: attach refused (out-of-band rebuild; keep hint, retry debug_attach after).
    if (/attach refused|attach denied|get-task-allow|Developer Tools|DevToolsSecurity|not debuggable/i.test(msg)) {
      return {
        recoverable: false,
        recover_args_hint: { retry: "rebuild as Debug with get-task-allow, approve Developer Tools access, then retry debug_attach" },
      };
    }
    // E6: debug session expired / client-timeout auto-stop -> re-attach.
    if (
      /no session with id|unknown session|session (not found|expired|closed|gone|invalid)|auto-stopped|call debug_attach to open a new session/i.test(
        msg,
      )
    ) {
      return { recoverable: true, recover_with_tool: "debug_attach", recover_args_hint: { lease_id: "<your-lease-id>" } };
    }
    // E6: target exited -> relaunch first (app_launch next[] leads back to debug_attach).
    if (/target process exited|no process found|no such process|process .*(terminated|died|gone|not running)/i.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "app_launch",
        recover_args_hint: { lease_id: "<your-lease-id>", bundle_id: "<relaunch-target>" },
      };
    }
    // E1: unknown lease / ticket -> fresh lease (re-queue for tickets).
    if (/Unknown lease |Unknown ticket /.test(msg)) {
      return { recoverable: true, recover_with_tool: "lease_acquire", recover_args_hint: freshLeaseHint() };
    }
    // Ticket already assigned/consumed -> poll it for the lease.
    if (/is already (assigned|waiting)/.test(msg)) {
      return { recoverable: true, recover_with_tool: "queue_status", recover_args_hint: { ticket_id: "<ticket-id>" } };
    }
    // E2: expired / released (TTL lapse, sim unbooted, real device gone).
    if (/expired and was released|is no longer booted; lease|is no longer available; lease/.test(msg)) {
      return { recoverable: true, recover_with_tool: "lease_acquire", recover_args_hint: freshLeaseHint() };
    }
    // E4: proxy busy (ProxyBusyError) -> view holder status, wait, retry.
    if (/must call net_proxy_stop first|the network proxy \(port \d+\) is held by session/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "net_proxy_status",
        recover_args_hint: { lease_id: "<your-valid-lease-id>" },
      };
    }
    // E4: proxy not running -> start it.
    if (/No network proxy is running/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "net_proxy_start",
        recover_args_hint: { lease_id: "<your-lease-id>" },
      };
    }
    // E4: capture busy (CaptureBusyError) -> view status, wait, retry.
    if (/Packet capture is (already running|running) for lease/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "net_capture_status",
        recover_args_hint: { lease_id: "<your-valid-lease-id>" },
      };
    }
    // E3: sim leased to another session (force-capable verbs) -> same tool with force.
    if (/is leased to session/.test(msg)) {
      if (tool !== undefined && FORCE_RETRY_TOOLS.has(tool)) {
        return {
          recoverable: true,
          recover_with_tool: tool,
          recover_args_hint: { udid: "<same-udid>", force: true },
        };
      }
      return { recoverable: true, recover_with_tool: "pool_status" };
    }
    // E3: lease held by another session -> confirm the holder, use your own lease.
    if (/is held by session/.test(msg)) {
      return { recoverable: true, recover_with_tool: "lease_list" };
    }
    // E3: ticket belongs to another session -> list the queue, use your own ticket.
    if (/belongs to session/.test(msg)) {
      return { recoverable: true, recover_with_tool: "queue_status" };
    }
    // E5: no debug session -> attach first.
    if (/has no debug session attached/.test(msg)) {
      return { recoverable: true, recover_with_tool: "debug_attach", recover_args_hint: { lease_id: "<your-lease-id>" } };
    }
    // E8: real-kind lease on a sim-only/P3/P4 verb -> sim lease.
    if (/does not support real-device leases yet/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "lease_acquire",
        recover_args_hint: { session_id: "<your-session-id>", device_kind: "sim" },
      };
    }
    // E10: acquire failures surfaced through lease_acquire.
    if (/No matching .* is free and queue=false/.test(msg)) {
      return { recoverable: true, recover_with_tool: "lease_acquire", recover_args_hint: { queue: true } };
    }
    if (/Boot of .* failed/.test(msg)) {
      return { recoverable: true, recover_with_tool: "lease_acquire", recover_args_hint: { queue: true } };
    }
    if (/Real-device inventory failed/.test(msg)) {
      return { recoverable: true, recover_with_tool: "pool_status" };
    }
    if (/sessionId is required/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "lease_acquire",
        recover_args_hint: { session_id: "<your-session-id>" },
      };
    }
    // E16: real-device UI limits without a CLI equivalent -> not recoverable.
    if (/no go-ios CLI equivalent/.test(msg)) {
      return { recoverable: false };
    }
    // E16: gesture presets -> explicit-coordinate swipe.
    if (/ui_gesture preset .* is not supported on a real-device lease/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "ui_swipe",
        recover_args_hint: {
          lease_id: "<your-lease-id>",
          start_x: "<x>",
          start_y: "<y>",
          end_x: "<x>",
          end_y: "<y>",
        },
      };
    }
    // E16: unsupported button name -> one of the DeviceKit buttons.
    if (/ui_button .* is not supported on a real-device lease/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "ui_button",
        recover_args_hint: { lease_id: "<your-lease-id>", button: "<home|lock|volumeUp|volumeDown>" },
      };
    }
    // E16: selector taps -> describe first, then tap the frame center.
    if (/takes coordinates only/.test(msg)) {
      return { recoverable: true, recover_with_tool: "ui_describe", recover_args_hint: { lease_id: "<your-lease-id>" } };
    }
    // E16: button duration -> same button without duration.
    if (/takes no duration|no --duration flag/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "ui_button",
        recover_args_hint: { lease_id: "<your-lease-id>", button: "<same-button>" },
      };
    }
    // E15: compact-format failure -> full describe.
    if (/compact format failed/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "ui_describe",
        recover_args_hint: { lease_id: "<your-lease-id>", format: "full" },
      };
    }
    // E14: m4 autonomous-tap denial -> manual coordinate tap.
    if (/m4 denied autonomous tap/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "ui_tap",
        recover_args_hint: { lease_id: "<your-lease-id>", x: "<frame-center-x>", y: "<frame-center-y>" },
      };
    }
    // E13: reinstall half-state -> install the bundle directly.
    if (/half-state/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "app_install",
        recover_args_hint: { lease_id: "<your-lease-id>", app_path: "<same-app-path>" },
      };
    }
    // E12: assert-flow shortfall -> retry with a larger window.
    if (/saw \d+ matching flow\(s\)/.test(msg)) {
      return {
        recoverable: true,
        recover_with_tool: "net_assert_flow",
        recover_args_hint: { url_regex: "<same-regex>", timeout_sec: "<larger-value>" },
      };
    }
    // E11: arg validation -> same tool with fixed args (the error text names the fix).
    if (
      /needs exactly one op|takes exactly one op|needs both file and line|takes either file\+line|Exactly one of|Invalid |must be a valid regular expression|needs at least one of|must be an absolute http/i.test(
        msg,
      )
    ) {
      return tool === undefined ? { recoverable: true } : { recoverable: true, recover_with_tool: tool };
    }
    // E17: unknown errors stay unrecoverable with no tool.
    return { recoverable: false };
  } catch {
    return { recoverable: false };
  }
}

/** Success-side extra: `{next:[...]}` for known tools, `{}` otherwise. Never throws. */
export function successExtra(tool?: string): { next: string[] } | Record<string, never> {
  try {
    if (tool === undefined) return {};
    const names = NEXT_ACTIONS[tool];
    if (names === undefined) return {};
    return { next: [...names] };
  } catch {
    return {};
  }
}

/** Failure-side extra: always carries `recoverable`. Never throws. */
export function failureExtra(message: string, tool?: string): Recovery {
  try {
    return recoveryFor(message, tool);
  } catch {
    return { recoverable: false };
  }
}
