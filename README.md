# apple-debug-mcp

[![npm version](https://img.shields.io/npm/v/apple-debug-mcp)](https://www.npmjs.com/package/apple-debug-mcp)
[![CI](https://github.com/devyhan/apple-debug-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/devyhan/apple-debug-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP debug daemon for Apple Simulators: multiple AI agent sessions share one Mac's simulator pool while the daemon tracks who holds which simulator (leases) and auto-dispatches freed simulators to the next waiter in line. It runs locally as a single shared daemon over Streamable HTTP, built on [simslim](https://github.com/MobAI-App/simslim) for simulator lifecycle (boot/shutdown/slim, low-RAM slim boots) and [AXe](https://github.com/cameroncooke/AXe) for UI automation. The same lease tools also cover attached real devices (`device_kind: "real"`, devicectl inventory plus a go-ios UI transport).

> **Not affiliated with Apple.** This is an independent community project. Apple, Xcode, Simulator, and Instruments are trademarks of Apple Inc., used here only to describe what this software connects to.

Published on npm as [`apple-debug-mcp`](https://www.npmjs.com/package/apple-debug-mcp).

```
Agent sessions (Orca / Claude Code / TMA / scripts)
        │  Streamable HTTP (POST /mcp), one MCP connection per session
        ▼
apple-debug-mcp daemon ── shared state: leases + wait queue + auto-dispatch
        │  child processes
        ├── simslim ── boot/shutdown/slim, pool state
        ├── axe ────── sim UI, lease holders only
        └── devicectl/go-ios ── real-device leases
```

## Features

- **71 tools across 11 groups** — pool/lease/queue, AXe UI automation, device extras, synthetic camera, app lifecycle, xctrace profiling, live streaming, llmdb debugging, crash symbolication, an HTTPS intercept proxy, and packet capture
- **One shared daemon** — leases, the wait queue, and auto-dispatch live in a single process; per-session stdio servers would split the pool
- **Lease ownership gates** — each lease holds one simulator or real device and only its holder may drive UI, apps, debugging, or the proxy through it
- **Wait queue with auto-dispatch** — when no simulator matches, callers get a ticket; releases, TTL expiry, and external-shutdown detection hand the next match to the first fitting ticket (FIFO)
- **Optional dependencies degrade gracefully** — serve-sim, llmdb, mitmdump, and tcpdump are probed at boot; the daemon starts without them and only the tools that need them fail, with install hints
- **Operator-safe CLI** — `doctor` is read-only, `launchd restart` refuses while leases are held, hand-edited plists are never overwritten silently
- **Single version source** — `package.json` feeds `/health`, the MCP handshake (`serverInfo`), and the `server` field of `pool_status` alike

## Prerequisites

- macOS + Xcode (Simulator runtime)
- Node.js 22 or later
- `simslim` and `axe`:

```
brew install mobai-app/tap/simslim
brew install cameroncooke/axe/axe
```

Optional, enabling only the tools named:

```
npm install -g serve-sim          # sim_rotate, sim_ca_debug, sim_memory_warning, camera_*, stream_*
brew install alexmx/tools/llmdb   # debug_*
brew install mitmproxy            # net_proxy_*, net_assert_flow, map_local, map_remote
npm install -g go-ios             # real-device leases (device_kind: "real"): ui_*, app_install/app_uninstall/app_launch/app_terminate, sim_log_stream, stream_start/stream_stop
```

Real-device leases need no devicectl install (it ships with Xcode), but the
device must be paired with Developer Mode on; without go-ios the real-device
verbs above fail with an install hint.

tcpdump ships with macOS (`net_capture_*`); packet capture additionally needs
passwordless sudo for tcpdump, e.g. via `sudo visudo`:

```
%admin ALL=(ALL) NOPASSWD: /usr/sbin/tcpdump
```

## Install

Consumer install (no checkout needed):

```
npm install -g apple-debug-mcp
apple-debug-mcp --version
apple-debug-mcp doctor            # read-only check; every failure prints its exact fix
```

From a checkout of this repo, five steps:

```
1. npm install
2. npm run build
3. npm install -g .   # recommended: the launchd plist points at the stable npm-global bin (~/.npm-global/bin)
4. apple-debug-mcp doctor            # read-only check; every failure prints its exact fix
5. apple-debug-mcp launchd create    # write the plist + load it
```

Then register the daemon URL in your clients and verify it answers:

```
apple-debug-mcp install --client all   # Claude Code / Codex / Muse (user scope)
curl http://127.0.0.1:3100/health      # {"ok":true,"version":"...","gitSha":"...",...}
tail -f ~/.apple-debug-mcp/daemon.log
```

Defaults (fixed):

- Daemon path: the npm-global bin (`~/.npm-global/bin/apple-debug-mcp`) first, falling back to this checkout's `dist/index.js` with a loud warning. `SIM_MCP_DAEMON_PATH` overrides both.
- Log: `~/.apple-debug-mcp/daemon.log`, stdout and stderr combined.
- State: `~/.apple-debug-mcp/state.json` (leases/queue), lockfile `daemon.lock` beside it.
- `install` writes user scope only. Project scope could point sessions at different daemons and split the pool — one shared daemon is the premise.
- The CLI never pings the npm registry. The local `package.json` is the only version source.

## Quick start

Check the daemon is up, then take a lease:

```
apple-debug-mcp launchd status
```

```json
{ "session_id": "<your session id>", "client": "claude-code", "task": "log in and screenshot" }
```

Call `lease_acquire` with that body. With spare capacity you get a lease immediately; otherwise you get a wait ticket (`ticket_id`, `position`) — poll `queue_status` until it shows `status: "assigned"` with a `lease_id`. (`session_id` is optional: it defaults to the MCP transport session id and explicit wins; without either the server assigns an anonymous id returned on the lease.) Drive the simulator with the `ui_*` tools, renew long work with `lease_heartbeat`, and finish with `lease_release`, which instantly dispatches the freed simulator to the first matching ticket.

## Configuration

Full reference: [Configuration](docs/configuration.md).

`install` writes Streamable-HTTP URL entries only. Shapes verified against the real configs on macOS:

```json
{
  "mcpServers": {
    "apple-debug": { "type": "http", "url": "http://127.0.0.1:3100/mcp" }
  }
}
```

Claude Code (user scope, `~/.claude.json` → `mcpServers`); manual equivalent:

```
claude mcp add -s user --transport http apple-debug http://127.0.0.1:3100/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.apple-debug]
url = "http://127.0.0.1:3100/mcp"
```

Muse (`~/.config/muse/settings.json` → `mcpServers`):

```json
"apple-debug": { "type": "streamable-http", "url": "http://127.0.0.1:3100/mcp" }
```

Preview or inspect without writing:

```
apple-debug-mcp install --client codex,muse --dry-run  # preview the change
apple-debug-mcp install --client all --status          # registration status only
```

Unknown client names fail as "Unsupported" without touching any file. Every edited config is backed up to `<config>.bak-sim-mcp` first (created once, never overwritten).

Environment variables (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `SIM_MCP_HOST` / `SIM_MCP_PORT` | `127.0.0.1` / `3100` | Listen address |
| `SIM_MCP_STATE_FILE` | `~/.apple-debug-mcp/state.json` | Lease/queue persistence file |
| `SIMSLIM_BIN` / `AXE_BIN` | `simslim` / `axe` | Binary paths |
| `SERVE_SIM_BIN` | `serve-sim` | serve-sim binary path (optional dependency) |
| `LLMDB_BIN` | `llmdb` | llmdb binary path (optional dependency) |
| `MITMDUMP_BIN` | `mitmdump` | mitmdump binary path (optional dependency) |
| `TCPDUMP_BIN` | `tcpdump` | tcpdump binary path (optional dependency, ships with macOS) |
| `IOS_BIN` | `ios` | go-ios binary path (real-device transports; optional dependency) |
| `SERVE_SIM_PORT_BASE` | `3220` | First port scanned for per-lease stream helpers |
| `NETPROXY_PORT_BASE` | `3240` | First port scanned for the lease-held proxy listener |
| `SIM_MCP_MAX_SIMS` | `0` (uncapped) | Cap on concurrently booted simulators; excess waits |
| `SIM_MCP_LEASE_TTL_MS` | `1800000` (30 min) | Lease survival without a heartbeat |
| `SIM_MCP_SWEEP_MS` | `60000` (60 s) | Lease/queue sweep interval |
| `SIM_MCP_EXEC_TIMEOUT_MS` | `60000` (60 s) | Helper child-process timeout |
| `SIM_MCP_BOOT_TIMEOUT_MS` | `600000` (10 min) | Simulator boot timeout |
| `SIM_MCP_SCREENSHOT_DIR` | `$TMPDIR/sim-mcp-shots` | Screenshot storage |
| `SIM_MCP_TRACE` / `SIM_MCP_TRACE_FILE` / `SIM_MCP_TRACE_DIR` | off / _(unset)_ / `$TMPDIR/sim-mcp-traces` | JSONL action/exec trace (`=1` enables; explicit file wins) |
| `SIM_MCP_SNAPSHOT` / `SIM_MCP_SNAPSHOT_DIR` | off / `$TMPDIR/sim-mcp-snapshots` | describe/tap/screenshot sidecars for offline replay (`=1` enables) |
| `SIM_MCP_TOOLCALLS` / `SIM_MCP_TOOLCALLS_FILE` | on / `<stateDir>/toolcalls.jsonl` | per-tool call telemetry, names only (`=0` disables) |
| `SIM_MCP_PROXY_CAPTURE_BODIES` | off | proxy flow-log body capture (`=1` enables; metadata rows always on) |
| `SIM_MCP_DEBUG_ROBUSTNESS` | off | debug assume-stopped + wait-elapsed guards (`=1` enables) |
| `SIM_MCP_CONTAMINATION_CHECK` | `true` | Lease-interference detection on/off (`false` disables) |
| `SIM_MCP_CONTAMINATION_MIN_INTERVAL_MS` | `30000` (30 s) | Minimum gap between contamination spawns per lease |
| `SIM_MCP_DAEMON_PATH` | _(unset)_ | Override the daemon entry the plist launches |

## Upgrade

```
git pull
npm install
npm run build
npm install -g .   # when the launchd plist points at the npm-global bin
apple-debug-mcp launchd restart        # refused while leases are held; --force overrides
apple-debug-mcp launchd status         # loaded + /health + version
```

Re-running `launchd create` regenerates the plist while preserving its port/host. A hand-edited plist shows a diff and is never overwritten without `--force`.

## Uninstall

```
apple-debug-mcp install --client all --remove  # unregister from client configs
apple-debug-mcp launchd remove                 # unload + delete the plist
npm uninstall -g apple-debug-mcp               # when installed via npm-global
```

## Tools

Full reference: [Tools](docs/tools.md).

71 tools across 11 groups. Tools marked \* require a `lease_id` and accept only the holding lease.

| Group | Tools |
| --- | --- |
| Pool/state (5) | `pool_status`, `sessions_list`, `sim_boot`, `sim_shutdown`, `sim_slim` |
| Lease/queue (7) | `lease_acquire`, `lease_release`, `lease_heartbeat`, `lease_list`, `queue_status`, `queue_cancel`, `lease_actions` |
| UI automation (9) \* | `ui_describe`, `ui_tap`, `ui_type`, `ui_swipe`, `ui_gesture`, `ui_button`, `ui_screenshot`, `ui_batch`, `ui_triage` |
| Device extras (5) | `sim_rotate`, `sim_ca_debug`, `sim_memory_warning`, `sim_log_stream`, `sim_log_show` |
| Synthetic camera (5) | `camera_start`, `camera_switch`, `camera_mirror`, `camera_status`, `camera_stop` |
| App lifecycle (7) \* | `app_open_url`, `app_install`, `app_uninstall`, `app_reinstall`, `app_launch`, `app_terminate`, `app_cache_clear` |
| Profiling (1) \* | `profile_trace` |
| Live streaming (2) \* | `stream_start`, `stream_stop` |
| Debugging (20) \* | `debug_attach`, `debug_launch`, `debug_break`, `debug_continue`, `debug_run_until`, `debug_wait`, `debug_interrupt`, `debug_bt`, `debug_threads`, `debug_locals`, `debug_scopes`, `debug_expand`, `debug_eval`, `debug_set_var`, `debug_output`, `debug_step`, `debug_detach`, `debug_sessions`, `debug_doctor`, `symbolicate` (lease optional) |
| Network proxy (7) \* | `net_proxy_start`, `net_proxy_set_rules`, `net_proxy_stop`, `net_proxy_status`, `net_assert_flow`, `map_local`, `map_remote` |
| Packet capture (3) \* | `net_capture_start`, `net_capture_stop`, `net_capture_status` |

Key behaviors:

- `lease_acquire`: matches conditions (`udid` / `device` substring / `osVersion` prefix / `platform`), auto-boots when needed, auto-slims stock simulators (`--no-reboot`, custom profiles untouched), else enqueues a ticket. Pass `device_kind: "real"` (plus optional `transport: "usb"|"wifi"`) to lease an attached real device instead of a simulator.
- `lease_release`, TTL expiry, and external-shutdown detection auto-dispatch the freed simulator to the first matching ticket (FIFO; `auto_boot` tickets may boot one). Release does not shut the simulator down — it hands over booted; call `sim_shutdown` separately to stop it.
- `sim_shutdown` refuses on a held simulator unless `force=true`; rebooting `sim_slim`, `sim_rotate`, `sim_ca_debug`, and `sim_memory_warning` behave the same, naming the holder in the error. `camera_start`/`camera_switch` are lease-gated the same way; `camera_mirror`/`camera_status`/`camera_stop` ignore leases.
- `ui_screenshot` returns a PNG path plus an image block. `ui_triage` returns the describe payload plus a screenshot in one call. `sim_rotate` takes `portrait|portrait_upside_down|landscape_left|landscape_right`; `sim_ca_debug` takes `option=blended|copies|misaligned|offscreen|slow-animations` plus an `enabled` boolean.
- `sim_log_stream` collects live logs for a window (default 5s, max 60s), `sim_log_show` reads the past `--last` window (default `5m`); both are `xcrun simctl spawn`-based, so they need no serve-sim. Results are `{log, truncated, timedOut}` — `stream` always ends on window expiry, so `timedOut: true` is normal.
- Log filters: a full predicate (`predicate`, e.g. `process == "MyApp"`) or the `process` shorthand; both combine with AND. Predicates are rejected before the call when empty or unbalanced. Quote string literals with double quotes (`eventMessage CONTAINS "x"`); parens inside literals are ignored, so `process == "My(App)"` is valid.
- Output past `max_chars` (default 20000) keeps the tail with a `…[truncated N chars]` prefix. Prefer a narrow window (`timeout_sec`/`last`) plus a `process` filter.
- App lifecycle is `xcrun simctl`-based with no extra dependencies: `app_launch` returns `{pid}`; `terminate` fails on a non-running app ("found nothing to terminate"); `uninstall` quietly succeeds on a missing bundle (idempotent). Every call is recorded in `lease_actions`. `app_reinstall` composes uninstall→install in one call, requires `confirm_data_loss: true`, and wipes Documents/Keychain (`logged_out: true`).
- `profile_trace` records with `xcrun xctrace record --device` into a `.trace` file (default template "Time Profiler", default 5s, max 60s). `--attach` often cannot find the simulator process ("Cannot find process"), so whole-system recording is the default. Note: on this host family simulator-target recording stalls at "Starting recording..." (host recording works), so the smoke test asserts the validation path only.
- Streaming is opt-in: `lease_acquire` with `stream: true`, or `stream_start`/`stream_stop` later. A stream failure only warns; the lease stands. Both calls are idempotent — `stream_start` returns the existing URL when already streaming. The URL lives on the lease's `streamUrl`, visible in `pool_status`/`sessions_list`/`lease_list`. One stream costs one serve-sim helper process plus MJPEG CPU, so turn it on to look and off when done; `ui_screenshot` is cheaper for stills. Ports scan upward from `SERVE_SIM_PORT_BASE` because serve-sim kills whatever occupies its requested port instead of scanning (and its `:3100` default would collide with this daemon).
- Debugging wraps the llmdb CLI (an lldb-dap wrapper with session JSON): `debug_attach {bundle_id|pid}` (exactly one) or `debug_launch {path, args?}` opens one session per lease, then break/continue/inspect. Needs a debuggable (`get-task-allow`) third-party build plus one-time host developer-tools authorization — stock Apple apps refuse attach. llmdb 0.2.0 takes `file:line` breakpoints only (no symbol breakpoints), `expand` takes a variablesReference number (not an expression), and `launch` takes a binary path (not a bundle ID).
- `symbolicate` is `atos`-based host-local crash symbolication: `lease_id` is optional (validated and logged when given), with no udid/force gates. `binary` is effectively required (no live-pid mode).
- Network proxy: `net_proxy_start {lease_id, rules?}` intercepts the lease simulator's HTTPS (mitmdump + generated rewrite addon + mitm CA into the simulator keychain). `net_proxy_set_rules` swaps rules (restarts only mitmdump, same port). `net_proxy_stop` is idempotent and restores the host proxy snapshot. `net_assert_flow` polls the holder's flow log (JSONL). Rules are `match{url_regex?, method?}` → `action{status?, headers?, body?, delay_ms?, request?, map_local?, map_remote?}`, first match wins, max 50. Omitted `match` matches everything; `rules: []` is transparent intercept-and-log. `net_proxy_start {block_quic: true}` additionally blocks QUIC (UDP/443) via a PF anchor so apps fall back to TCP/TLS through the proxy; the anchor is flushed (and PF restored) on stop. See [Security](#security) for the host-wide warning and consent boundary.
- Packet capture: `net_capture_start {lease_id, filter?, snaplen?, interface?}` runs tcpdump on the default-route interface for traffic the HTTP proxy cannot see (raw TCP/UDP sockets, QUIC); `net_capture_stop` is idempotent and returns a per-flow packet/byte summary plus the pcap path (kept on disk until your lease's next capture overwrites it). BPF filters are allowlisted; capturing needs passwordless sudo for tcpdump. TLS payloads stay encrypted — headers and flow sizes only.

## Usage examples

More: [Usage examples](docs/examples.md).

> "Boot a simulator, hold it, and tap through login."

```json
{ "session_id": "sess-1", "client": "claude-code", "task": "login flow", "device": "iPhone 16" }
```

```json
{ "lease_id": "<from lease_acquire>" }
```

```json
{ "lease_id": "<lease>", "label": "Continue" }
```

That is `lease_acquire`, then `ui_describe`, then `ui_tap` on the named element (`label` matches the accessibility label; `ui_button` is for hardware buttons only). Finish with `lease_release`.

> "Record a 10-second Time Profiler trace of the app under test."

```json
{ "lease_id": "<lease>", "duration_sec": 10 }
```

That is `profile_trace`; the result carries the `.trace` path.

> "Rewrite one API response to a fixture file while the test runs."

```json
{ "lease_id": "<lease>", "rules": [{ "match": { "url_regex": "api\\.example\\.com/v1/feed" }, "action": { "map_local": "/tmp/feed.json" } }] }
```

```json
{ "lease_id": "<lease>", "url_regex": "api\\.example\\.com/v1/feed", "min_count": 1 }
```

That is `net_proxy_start`, then `net_assert_flow` to prove the app hit the endpoint. Stop with `net_proxy_stop` as soon as the test is done.

## Instructions for AI agents

Short form: [Instructions for AI agents](docs/agents.md).

- There must be exactly one shared daemon. Never start a per-session stdio server — the pool and queue would not be shared. If `/health` is unreachable, say so instead of working around it with direct `simctl`.
- Pass your tool's session ID as `session_id` with a `client` label so `sessions_list` shows who runs where. The server does not enforce the format. `session_id` is optional on `lease_acquire` (transport-session default, explicit wins, else an anonymous id is assigned and returned).
- A wait ticket is normal. Poll `queue_status`; do not boot simulators out of band to skip the line.
- Only the holding lease may call that lease's gated tools. On a holder-mismatch error, stop and report the holder — do not retry with `force=true` unless the user asked for preemption.
- Renew long work with `lease_heartbeat` before the TTL (default 30 min) expires; expired leases are reclaimed and redispatched.
- Release with `lease_release` when done. Release hands the simulator over booted — shut it down with `sim_shutdown` only if the task needs it stopped.
- Turn the proxy and streams off when done: `net_proxy_stop`, `stream_stop`. Both cost host-wide resources while on.

## Troubleshooting

Full reference: [Troubleshooting](docs/troubleshooting.md).

Start with `doctor` — every failure prints its exact fix:

```
apple-debug-mcp doctor
apple-debug-mcp launchd status   # plist present? loaded? /health reachable (which version)?
tail -f ~/.apple-debug-mcp/daemon.log
```

Common failures:

- `/health` unreachable but the plist is loaded: the daemon crashed at boot — the log shows why (missing `simslim`/`axe` is the usual cause).
- Port conflict: the daemon exits `10` when the port is taken, `11` when another daemon holds the lockfile (generic failures exit `1`). Restart via `apple-debug-mcp launchd restart`, never by launching a second daemon.
- `launchd restart` refuses with active leases: wait for release or re-run with `--force` (drops in-flight work).
- Hand-edited plist: `create`/`remove` show a diff and refuse without `--force`.
- `install` reports "already installed" on the second run — that is the idempotent success path, not an error.
- Optional-tool failure naming `serve-sim`, `llmdb`, `mitmdump`, or `tcpdump`: install that binary (see [Prerequisites](#prerequisites)); the daemon runs fine without it otherwise.
- `debug_attach` refused: the build needs `get-task-allow`, the host needs its one-time developer-tools approval, and stock Apple apps always refuse.
- Host proxy left on after a daemon crash (SIGKILL skips cleanup): kill mitmdump and switch every service off by hand:

```
pkill -f "mitmdump -p "
networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r svc; do
  svc="${svc#\*}"   # strip the disabled marker
  sudo networksetup -setwebproxystate "$svc" off
  sudo networksetup -setsecurewebproxystate "$svc" off
done
```

Normal shutdown (SIGINT/SIGTERM), `lease_release`, TTL expiry, sweeps, and external-shutdown detection all restore the snapshot automatically.

- QUIC block or capture left behind after a daemon crash (SIGKILL skips cleanup): flush only our anchor, release enable references the daemon leaked, and kill a stranded tcpdump:
  - `sudo pfctl -a com.apple/apple-debug-mcp.quicblock -F all` (never flush the main ruleset)
  - a leaked `-E` enable reference has no token listing and no visible refcount: if PF was Disabled before the crash and no other PF user exists, `sudo pfctl -d` returns it to Disabled; when in doubt, reboot instead of guessing (or release your own known token via `sudo pfctl -X <token>`)
  - `sudo pkill -f "tcpdump -i .* -w .*apple-debug-mcp-netcapture"` (match the state dir so unrelated captures survive)

## Security

Full reference: [Security](docs/security.md).

- **Lease-gated mutation.** UI, apps, profiling, streaming, debugging, the proxy, and packet capture all require the holding `lease_id`; cross-lease calls fail naming the holder. Only one proxy holder and one capture holder exist across all leases.
- **sudo is narrow and explicit.** Host proxy control needs passwordless sudo for exactly four `networksetup` subcommands — `-setwebproxy`, `-setsecurewebproxy`, `-setwebproxystate`, `-setsecurewebproxystate` — always as `sudo -n` (never interactive). QUIC blocking (`block_quic`) adds `pfctl -s info`/`-E`/`-X` (enable references, never a global `-d`) and `pfctl -a <own anchor> -f`/`-F` (flush touches only that anchor, never the user's ruleset). Packet capture adds `tcpdump` capture while `-r` readback needs no sudo. Reads (`-listallnetworkservices`, `-getwebproxy`/`-getsecurewebproxy`) need no sudo. Nothing is checked or changed at daemon boot, because every `-set*` mutates host state. `net_proxy_start` fails with a sudoers-setup hint when authorization is missing.
- **Rules validate before any host change.** A bad rule is rejected without touching host networking.
- **Host-wide proxy warning.** While the proxy is on, all host web traffic (including other apps' background traffic) flows through mitmdump, and intranet sites on a private CA may break until stop/restore. Keep it on only as long as the test needs. The mitm CA stays in the simulator keychain after stop (harmless without the proxy; full removal is `xcrun simctl keychain <udid> reset`). QUIC blocking is likewise host-wide while active (all apps' UDP/443 is dropped until the anchor is flushed on stop). Packet captures record host-wide traffic on the interface — use a BPF `filter` to narrow what is recorded.
- **No silent destructive actions.** `doctor` is read-only (no `--fix`); restart refuses under active leases; hand-edited plists need `--force`; local-only mode exists because process-scoped interception (`mitmdump --mode local:…`) needs a manually approved macOS System Extension and is unverifiable in unattended environments, so only host mode ships.
- **Localhost only by default.** The daemon binds `127.0.0.1:3100`; the MCP endpoint has no authentication, so do not rebind it to a shared interface.

## What this is not

This is a local, single-host debug daemon. It manages simulators and attached real devices on the Mac it runs on, keeps its state in a local JSON file, and serves MCP over unauthenticated localhost HTTP. It is not a multi-host device farm, not a CI XCTest runner, and not a general macOS automation server — the tools cover the simulator debug loop (boot, lease, drive UI, profile, debug, intercept) and project their results down to what a model can usefully read.

It is also not a simulator runtime itself. Booting, slimming, and UI driving delegate to simslim, AXe, serve-sim, llmdb, and the Xcode toolchain; when those drift, `doctor` and the weekly CI smoke run are the early warning.

## Development

Requires Node.js 22 or later, macOS + Xcode for anything past unit tests.

```
npm install
npm test        # unit tests (orchestrator/wrappers/store/CLI/launchd/doctor/install/…)
npm run typecheck
npm run smoke   # live-simulator E2E (daemon boot → boot → queue → dispatch → shutdown)
npm run dev     # tsx hot run
```

| Command | What it does |
| --- | --- |
| `npm test` | Runs the suite. This is the one to run. |
| `npm run typecheck` | Types only, no emit. |
| `npm run build` | Compile to `dist/`. |
| `npm run smoke` | Live E2E against real simulators. Needs macOS + Xcode + simslim/axe. |

CI has three jobs: `check` (Linux, every PR/push: typecheck + unit tests + build across Node 22/24/26), `package` (pack-from-clean tarball install plus `--version`/`--help` and a health/stdio guard), and `smoke-macos` (main pushes, weekly Mondays, manual dispatch, and PRs labeled `run-smoke`: installs simslim/axe via brew and runs the live smoke to catch external CLI/Xcode drift early). Dependabot opens weekly npm and GitHub Actions update PRs.

Layout (`src/`, 48 files) — server: `index.ts` (HTTP daemon/session map), `server.ts` (MCP tool definitions), `extras.ts`, `quickstart.ts`, `recovery.ts`; pool: `orchestrator.ts` (acquire/release/dispatch), `store.ts` (JSON persistence), `singleton.ts`, `migrate.ts`; sim UI: `axe.ts`, `ax-prune.ts`, `uidriver.ts`, `servesim.ts`; sim apps/logs: `simslim.ts`, `simapps.ts`, `appops.ts`, `appcache.ts`, `simlog.ts`, `logops.ts`; real devices: `realdevices.ts`, `realui.ts`, `realstream.ts`, `realsyslog.ts`, `devicekind.ts`; debug: `llmdb.ts`, `debug-robustness.ts`, `symbolicate.ts`; trace: `xctrace.ts`; network: `netproxy.ts`, `netcapture.ts`; observability: `trace.ts`, `snapshot.ts`, `toolcalls.ts`; eval: `eval-baseline.ts`, `eval-cli.ts`, `eval-dataset.ts`, `eval-harness.ts`; experiments (env-gated): `m4.ts`, `m4-allowlist.ts`, `shadow.ts`, `shadow-predictor.ts`; CLI/ops: `cli.ts`, `doctor.ts`, `install.ts`, `launchd.ts`, `config.ts`, `version.ts`, `exec.ts`; plus `test/`.

(A Korean translation of this README is welcome later — contributions accepted.)

## Licence

MIT — see the `license` field in `package.json`.
