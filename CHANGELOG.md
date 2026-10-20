# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
