# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
