# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-26

### Added

- Real-device support across six slices: fail-fast seams (P0); apps,
  inventory, syslog, xctrace (P1); open-url via Safari and measured
  cache-clear (P2a); cache-clear via `ios fsync` (P2a2); `app_reinstall`
  destructive verb (P2a3); WDA-less `ui_screenshot` via go-ios (P2b0);
  `ui_describe`/`ui_tap` via DeviceKit (P2b2); type/swipe/button/batch
  (P2b3). Lease with `device_kind: "real"` (devicectl inventory, go-ios
  UI transport, paired device with Developer Mode on).
- Real-device single-flight MJPEG streaming (`stream_*` wired through a
  supervised streamer with orphan reaping).
- Proxy observability (P1): enriched two-phase flow log by `flow.id`,
  response metadata, header allow/redact lists, 8KB body cap with PII
  scrub, `error()` rows, tolerant parsing, per-run logs with keep-5,
  10MB addon-side gate. Metadata on by default; bodies behind
  `SIM_MCP_PROXY_CAPTURE_BODIES`. Regression guard
  `test/netproxy-observability.test.ts`.
- Assert-flow correctness (P2): `since` (`call` default) + ts watermark,
  generation watermark across `set_rules` restarts, response-side
  assertions (`status`/`min_bytes`/`body_regex`/`rewritten`/`rule`),
  `new_since_call` on match and timeout paths.
- Debug robustness (D1) behind `SIM_MCP_DEBUG_ROBUSTNESS=1`:
  assume-stopped-after-attach fast path, wait-elapsed vs wedged-timeout
  distinction, `debug_run_until` parity with `debug_continue`.
- `app_cache_clear` (T1, sim + real-device): terminate-first,
  Caches-only + targeted plist keys, Documents/Keychain refusal,
  deleted/count report, relaunch left to caller.
- Adoption P1–P4 (71 tools): trigger-first descriptions, titles and
  annotations, toolcall telemetry; `next[]` chaining hints and error
  recovery paths (additive-only); in-protocol quickstart (server
  instructions + resource + 3 prompts); `pool_status` router text,
  optional `session_id` (explicit > transport > `anon-`), and the
  `ui_triage` describe+screenshot composite.
- Docs: T2 webview/hidden-screen procedures (`docs/webview-screens.md`,
  live-proven); P5 adoption baseline from 256 measured toolcalls
  (`docs/adoption.md`); README accuracy pass (11 groups, full env table,
  real devices, 48-file layout).

### Fixed

- Streaming `:3333` orphan: kill-before-respawn plus a connect-based
  port probe (bind probes lie when the port serves IPv6).
- Live-measured real-device corrections from the P1 slice.

### Docs

- Grounding verdicts with measured blockers: P4 real-device network
  (carried, gates stay), P2c0 debug transport (carried, upstream).
- P2-B scoping notes, WDA/DeviceKit bring-up runbook, screenshot
  round-trip proof; tool-count corrections 66 → 69 → 71.

## [0.4.0] - 2026-10-21

### Added

- M1 trace collection: `SIM_MCP_TRACE=1` writes one JSONL line per tool action
  with UDID/text scrubbing and size caps. Off by default, zero behavior change
  when unset.
- M1 describe snapshots: `SIM_MCP_SNAPSHOT=1` saves describe payloads, tap
  resolution echoes, and screenshot sidecars per action for offline replay.
- Offline eval harness (`npm run eval:baseline`, `eval-cli`): ExactMatch
  baseline over `data/eval/v1` (10 synthetic cases) and `data/eval/v2`
  (17 real-device cases collected on iPhone 17 / 17 Pro Max).
- OPT1 compact describe: `ui_describe {format: "compact"}` prunes the AX tree
  (interactive-first, depth-capped) before truncation — 24.7% of full size on
  the measured screen with tap grounding preserved. `format: "full"` default
  is unchanged.
- M3 shadow mode: `SIM_MCP_SHADOW=1` predicts every `ui_tap` target from the
  last describe and logs prediction-vs-outcome agreement to `shadow.jsonl`
  without affecting the tap.
- M4 gated autonomous taps: `ui_tap {auto: true}` behind `SIM_MCP_M4=1` with a
  fail-fast gate chain (fresh describe, predictor non-abstain, explicit
  allowlist, dry-run). Dry-run is ON by default so enabling the gate alone can
  never tap; every decision is audited to `m4-audit.jsonl`. Verified live on
  iPhone 17 Pro Max (dry-run): allow-path and all deny paths, zero real taps.
- Lease contamination detection: out-of-band app launches on a leased device
  are detected and reported instead of silently skewing automation.

## [0.3.0] - 2026-10-20

### Added

- QUIC blocking: `net_proxy_start {block_quic: true}` drops UDP/443 via the
  PF anchor `com.apple/apple-debug-mcp.quicblock` (directly under `com.apple/`
  so stock pf.conf evaluates it), forcing apps to fall back to TCP/TLS through
  the proxy. PF is enabled with `pfctl -E` token refcounting (never a global
  `-d`); stop flushes only our anchor and releases our token. Actual
  `quic_blocked` state is returned by start and exposed by `net_proxy_status`.
  Live-verified: 3/3 UDP probes blocked, full restore on stop.
- Packet capture: new `net_capture_start`/`net_capture_stop`/
  `net_capture_status` tools (tcpdump on the default-route interface) for
  traffic the HTTP proxy cannot see: raw TCP/UDP sockets and QUIC. Stop
  returns a per-flow packet/byte summary plus the pcap path (kept until your
  lease's next capture). BPF filters are allowlisted, `TCPDUMP_BIN` env added,
  `doctor` and boot probe cover tcpdump, captures auto-stop on release and
  daemon shutdown. Live-verified on TCP and UDP traffic.
- Docs: packet-capture tool rows, `TCPDUMP_BIN` env tables, crash-recovery
  recipes for a stranded anchor/PF reference/tcpdump, sudo-scope updates.

### Fixed

- `pfctl -E` token is parsed from stderr (macOS prints it there, not stdout).
- Capture readback uses full `tcpdump -n -r`: the `-q` short form has no
  Flags/length to parse and summarized every capture as zero packets.
- A failed rules update now also removes the QUIC block, stops the replacement
  mitmdump child, and unlinks generated files instead of stranding them.
- Failure paths unlink generated addon/flow files; QUIC rollback hedges the
  restore claim when its own cleanup fails.

## [0.2.0] - 2026-10-20

### Added

- Debug reliability: actionable error hints (attach/session/target failures),
  `stop()` sessionId requirement, per-session op mutex, auto-stop on client
  timeout, tolerant JSON parsing, xctrace grace clamp + output check.
- Debug UX: `debug_launch` bundle-id form, leaseless `debug_doctor`/
  `debug_sessions`, batch breakpoints, `wait_sec`/`max_chars` options,
  uniform stopReason/state, symbolicate arch/dSYM auto-detect, run-until
  breakpoint cleanup.
- Symbolicate hardening: atos install hint, line-count guard, stderr surfacing.
- Debug docs: walkthrough, per-verb arg/gotcha table, agent session rules.
- Tests: 59 new tests (348 total), MCP-layer failure coverage.

## [0.1.0] - 2026-10-19

### Added

- MCP debug daemon for Apple Simulators over Streamable HTTP: one shared
  daemon holds the simulator pool, session leases, and a wait queue with
  auto-dispatch.
- 65 tools across 10 groups: pool/state, lease/queue, AXe UI automation,
  device extras, synthetic camera, app lifecycle, xctrace profiling, live
  streaming, llmdb debugging, crash symbolication, and an HTTPS intercept
  proxy.
- Operator-safe CLI: read-only `doctor`, `launchd create|remove|restart|status`
  with hand-edited-plist protection, `install` for client configs (user scope
  only), and single-source versioning from `package.json`.
- Live-simulator smoke test (`npm run smoke`) plus unit tests that run without
  macOS, Xcode, or any simulator.
