# Tools

70 tools across 10 groups. Tools marked \* require a `lease_id` and accept only
the holding lease.

| Group | Tools |
| --- | --- |
| Pool/state (5) | `pool_status`, `sessions_list`, `sim_boot`, `sim_shutdown`, `sim_slim` |
| Lease/queue (7) | `lease_acquire`, `lease_release`, `lease_heartbeat`, `lease_list`, `queue_status`, `queue_cancel`, `lease_actions` |
| UI automation (8) \* | `ui_describe`, `ui_tap`, `ui_type`, `ui_swipe`, `ui_gesture`, `ui_button`, `ui_screenshot`, `ui_batch` |
| Device extras (5) | `sim_rotate`, `sim_ca_debug`, `sim_memory_warning`, `sim_log_stream`, `sim_log_show` |
| Synthetic camera (5) | `camera_start`, `camera_switch`, `camera_mirror`, `camera_status`, `camera_stop` |
| App lifecycle (7) \* | `app_open_url`, `app_install`, `app_uninstall`, `app_reinstall`, `app_launch`, `app_terminate`, `app_cache_clear` |
| Profiling (1) \* | `profile_trace` |
| Live streaming (2) \* | `stream_start`, `stream_stop` |
| Debugging (20) \* | `debug_attach`, `debug_launch`, `debug_break`, `debug_continue`, `debug_run_until`, `debug_wait`, `debug_interrupt`, `debug_bt`, `debug_threads`, `debug_locals`, `debug_scopes`, `debug_expand`, `debug_eval`, `debug_set_var`, `debug_output`, `debug_step`, `debug_detach`, `debug_sessions`, `debug_doctor`, `symbolicate` (lease optional) |
| Network proxy (7) \* | `net_proxy_start`, `net_proxy_set_rules`, `net_proxy_stop`, `net_proxy_status`, `net_assert_flow`, `map_local`, `map_remote` |
| Packet capture (3) \* | `net_capture_start`, `net_capture_stop`, `net_capture_status` |

Key behaviors:

- `lease_acquire`: matches conditions (`udid` / `device` substring / `osVersion`
  prefix / `platform`), auto-boots when needed, auto-slims stock simulators
  (`--no-reboot`, custom profiles untouched), else enqueues a ticket.
- `lease_release`, TTL expiry, and external-shutdown detection auto-dispatch the
  freed simulator to the first matching ticket (FIFO; `auto_boot` tickets may
  boot one). Release does not shut the simulator down — it hands over booted;
  call `sim_shutdown` separately to stop it.
- `sim_shutdown` refuses on a held simulator unless `force=true`; rebooting
  `sim_slim`, `sim_rotate`, `sim_ca_debug`, and `sim_memory_warning` behave the
  same, naming the holder in the error. `camera_start`/`camera_switch` are
  lease-gated the same way; `camera_mirror`/`camera_status`/`camera_stop`
  ignore leases.
- `ui_screenshot` returns a PNG path plus an image block (same shape on sim
  and real leases; real leases capture via WDA-less `ios screenshot`,
  describe via `ios ui source`, and tap via `ios ui tap` with x/y only —
  the remaining `ui_*` verbs stay sim-only P2). `sim_rotate` takes
  `portrait|portrait_upside_down|landscape_left|landscape_right`;
  `sim_ca_debug` takes `option=blended|copies|misaligned|offscreen|slow-animations`
  plus an `enabled` boolean.
- `sim_log_stream` collects live logs for a window (default 5s, max 60s),
  `sim_log_show` reads the past `--last` window (default `5m`); both are
  `xcrun simctl spawn`-based, so they need no serve-sim. Results are
  `{log, truncated, timedOut}` — `stream` always ends on window expiry, so
  `timedOut: true` is normal.
- Log filters: a full predicate (`predicate`, e.g. `process == "MyApp"`) or the
  `process` shorthand; both combine with AND. Predicates are rejected before
  the call when empty or unbalanced. Quote string literals with double quotes
  (`eventMessage CONTAINS "x"`); parens inside literals are ignored, so
  `process == "My(App)"` is valid.
- Output past `max_chars` (default 20000) keeps the tail with a
  `…[truncated N chars]` prefix. Prefer a narrow window (`timeout_sec`/`last`)
  plus a `process` filter.
- App lifecycle is `xcrun simctl`-based with no extra dependencies:
  `app_launch` returns `{pid}`; `terminate` fails on a non-running app ("found
  nothing to terminate"); `uninstall` quietly succeeds on a missing bundle
  (idempotent). Every call is recorded in `lease_actions`. On real-device
  leases `app_install`/`app_uninstall`/`app_launch`/`app_terminate` use
  go-ios, `app_open_url` uses devicectl (http(s) via Safari; other schemes
  stay P2), and `app_cache_clear` stays P2 (no container-delete transport
  for third-party apps). `app_reinstall` composes uninstall→install in one
  call over the same backends per lease kind, requires
  `confirm_data_loss: true` (refused at validation with zero spawns
  otherwise), wipes Documents/Keychain (`logged_out: true` — the opposite
  of `app_cache_clear`), and names the half-state when install fails after
  uninstall.
- `profile_trace` records with `xcrun xctrace record --device` into a `.trace`
  file (default template "Time Profiler", default 5s, max 60s). `--attach`
  often cannot find the simulator process ("Cannot find process"), so
  whole-system recording is the default.
- Streaming is opt-in: `lease_acquire` with `stream: true` (a stream failure
  only warns; the lease stands) or `stream_start`/`stream_stop` (both
  idempotent; `stream_start` returns the existing URL when already streaming).
  The URL lives on the lease's `streamUrl`, visible in
  `pool_status`/`sessions_list`/`lease_list`. One stream costs one serve-sim
  helper process plus MJPEG CPU — turn it on to look, off when done;
  `ui_screenshot` is cheaper for stills. Ports scan upward from
  `SERVE_SIM_PORT_BASE` because serve-sim kills whatever occupies its requested
  port instead of scanning (and its `:3100` default would collide with this
  daemon).
- Debugging wraps the llmdb CLI (an lldb-dap wrapper with session JSON):
  `debug_attach {bundle_id|pid}` (exactly one) or `debug_launch {path|bundle_id, args?}`
  opens one session per lease, then break/continue/inspect. Needs a debuggable
  (`get-task-allow`) third-party build plus one-time host developer-tools
  authorization — stock Apple apps refuse attach. llmdb 0.2.0 takes `file:line`
  breakpoints only (no symbol breakpoints), `expand` takes a variablesReference
  number (not an expression), and `launch` takes exactly one of a binary path
  or a bundle ID (the bundle form launches via simctl, then attaches).
- `symbolicate` is `atos`-based host-local crash symbolication: `lease_id` is
  optional (validated and logged when given), with no udid/force gates. `binary`
  is effectively required (no live-pid mode).
- Debug verbs, per-verb args and gotchas (one session per lease; every verb
  below except `attach`/`launch`/`detach`/`sessions`/`doctor` needs it):

| Verb | Args | Gotcha |
| --- | --- | --- |
| `attach` | exactly one of `bundle_id`/`pid` | re-attaching replaces the old session; stock Apple apps refuse |
| `launch` | exactly one of `path`/`bundle_id` (+`args`) | bundle form = simctl launch + `attach --app`; llmdb CLI itself is path-only |
| `break` | set `file`+`line` or `breakpoints[]` / list / `delete` id or ids / `exception` filters | `file:line` only, no symbol breakpoints; one op per call (a batch counts as one) |
| `continue` / `run_until` / `wait` / `interrupt` | `wait_sec` (max 600) | `continue` blocks server-side for the full wait; exec timeout adds grace |
| `bt` / `threads` | `thread`/`depth` | stopped-thread only; list threads first for multi-threaded stops |
| `locals` / `scopes` / `expand` | `frame` (default 0) | `expand` takes a variablesReference number, not an expression |
| `eval` / `set_var` | `expr` (+`frame`); `target`+`value` | evaluated in the stopped frame's context |
| `output` | `clear?` | captured target stdout/stderr; `clear` drains for the next read |
| `step` | `over` (default)/`in`/`out` | one source line per call |
| `detach` | — | idempotent (`stopped=false` when already gone); release/expire also stops it |
| `sessions` / `doctor` / `symbolicate` | `lease_id` optional for `symbolicate` | cross-lease/host-local diagnostics; `symbolicate` needs `binary` |

  Argv shapes follow llmdb 0.2.0 exactly — if `llmdb --help` drifts,
  the wrapper and this table need a joint update.
- Network proxy: `net_proxy_start {lease_id, rules?}` intercepts the lease
  simulator's HTTPS (mitmdump + generated rewrite addon + mitm CA into the
  simulator keychain); `net_proxy_set_rules` swaps rules (restarts only
  mitmdump, same port); `net_proxy_stop` is idempotent and restores the host
  proxy snapshot; `net_assert_flow` polls the holder's flow log (JSONL). Rules
  are `match{url_regex?, method?}` →
  `action{status?, headers?, body?, delay_ms?, request?, map_local?, map_remote?}`,
  first match wins, max 50; omitted `match` matches everything, `rules: []` is
  transparent intercept-and-log. `net_proxy_start {block_quic: true}` additionally
  blocks QUIC (UDP/443) via a PF anchor so apps fall back to TCP/TLS through
  the proxy; the anchor is flushed (and PF restored) on stop. See
  [Security](security.md) for the host-wide warning and consent boundary.
- Packet capture: `net_capture_start {lease_id, filter?, snaplen?, interface?}`
  runs tcpdump on the default-route interface for traffic the HTTP proxy cannot
  see (raw TCP/UDP sockets, QUIC); `net_capture_stop` is idempotent and returns
  a per-flow packet/byte summary plus the pcap path (kept on disk until your
  lease's next capture overwrites it). BPF filters are allowlisted; capturing
  needs passwordless sudo for tcpdump. TLS payloads stay encrypted — headers
  and flow sizes only.
