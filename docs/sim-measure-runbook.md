# Simulator footprint measurement runbook

How to take slim-vs-stock RAM/CPU numbers that survive comparison. Four
traps have invalidated past runs; each section below names the trap, the
rule, and where the rule comes from.

## 1. Use the `on` / `off` verbs; there is no `slim` verb

`simslim slim` fails with `unknown command "slim"`. The verbs are `on`
(slim) and `off` (restore to stock), per `simslim --help`:

- `on <udid>`: slim a simulator. `--no-reboot` stops daemons in the
  current boot session without a reboot. `--preserve-boot-state`
  returns an initially shutdown simulator to shutdown.
- `off <udid>`: restore a simulator to stock (re-enable + reboot).
- `status <udid>`: report how slim a booted simulator is.

Neither `on` nor `off` accepts `--json`; both fail with
`flag provided but not defined: -json`. Machine-readable output is
limited to `list`, `profiles`, `status`, `top`, and the
simulator-management commands (`simslim --help`, `--json` line). The
daemon's wrapper matches this: `slimOn`/`slimOff` pass no `--json`
(`src/simslim.ts:95-109`), while `list`, `status`, `boot`, and `top`
do (`src/simslim.ts:77,114,88,138`).

Rule: script state changes as `simslim on <udid> --no-reboot` /
`simslim off <udid>`, then read state with `simslim status <udid>
--json`. Never parse `on`/`off` stdout as JSON.

## 2. Let the simulator settle before sampling

`simslim boot` waits for services (`simslim --help`: `boot <udid> -
Boot a simulator and wait for its services`), but services-ready is
not idle. A fresh boot is a CPU storm: first-boot spawns run long
enough that simslim documents raising timeouts for them
(`--spawn-timeout` help: "Raise it for hosts where a busy first boot
makes individual spawns very slow"). Sampling `measure` or `top`
during that window attributes boot work to the steady-state
footprint.

Rule: after any boot or `on`/`off` transition, poll `simslim top
--json` (one-shot snapshot, same command the daemon runs in
`src/simslim.ts:137-143`) until per-sim CPU is flat across three
consecutive samples, then take the footprint from `simslim measure
<udid>` ("Report a booted simulator's memory footprint",
`simslim --help`). Record the settle wait in seconds next to the
number. The LW0 BOOT line's `readyMs` field stays `-1` until a
services-ready probe exists (`src/boottelemetry.ts`), so settle time
is currently manual and must be logged by hand.

## 3. Record host load with every number

Footprint numbers without host load are not comparable across runs:
a second booted sim, a parallel build, or a daemon sweep moves every
reading. The telemetry schema carries no host-load field by design
(see `BootEvent`/`AcquireEvent` in `src/boottelemetry.ts`: device
identity, outcome, and durations only), so load must be captured
out of band.

Rule: with each `measure` sample, record one `simslim top --json`
snapshot (per-sim RAM, CPU, process counts for the whole fleet, so
stray booted sims show up) plus host CPU pressure (`uptime` load
average is enough). A comparison is valid only if the fleet list is
identical on both sides and host load is within the same band.
If either differs, re-run rather than normalize.

## 4. Isolate scratch state, ports, and power state

Measurement daemons and one-off commands must not touch production
state or production ports.

- State file: the daemon resolves its state from `SIM_MCP_STATE_FILE`
  (default `~/.apple-debug-mcp/state.json`, `src/config.ts:52-55`),
  and both telemetry sinks derive their directory from it
  (`src/toolcalls.ts:42-46`, `src/boottelemetry.ts`
  `resolveBootFile`). Point every scratch daemon at its own file:
  `SIM_MCP_STATE_FILE=/tmp/meas/state.json`.
- Telemetry: scratch runs should not feed production logs. Disable
  both default-on sinks: `SIM_MCP_TOOLCALLS=0`
  (`src/toolcalls.ts:38-40`) and `SIM_MCP_BOOT_TELEMETRY=0`
  (`src/boottelemetry.ts` `isBootTelemetryEnabled`).
- Ports: the daemon listens on `SIM_MCP_PORT` (default 3100,
  `src/config.ts:51`); per-lease streams scan up from
  `SERVE_SIM_PORT_BASE` (default 3220, `src/config.ts:60`,
  `src/servesim.ts:20`); the net proxy scans up from
  `NETPROXY_PORT_BASE` (default 3240, `src/netproxy.ts:10`).
  serve-sim without an explicit `--port` binds 3100 and kills
  whatever sits there (`src/servesim.ts:117,261-262`). Give scratch
  daemons their own `SIM_MCP_PORT` and port bases.
- Sim inventory: take a `xcrun simctl list devices` snapshot before
  and after the run; diff it. Every UDID booted, created, or erased
  by the run must be accounted for.
- Power state: leave each simulator as found. Prefer
  `--preserve-boot-state` on `on`/`off` (returns an initially
  shutdown sim to shutdown, `simslim --help`), and shut down any sim
  the run booted before closing out.
