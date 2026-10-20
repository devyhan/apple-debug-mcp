# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
