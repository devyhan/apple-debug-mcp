# Real-device support P1: fleet + app lifecycle + syslog + xctrace (design)

P1 goal: make `device_kind: "real"` leases **functional** for app lifecycle,
fleet inventory, device logs, and tracing — behind the P0 seams
(`docs/real-device-p0.md`). Sim path stays byte-identical; every other P0
fail-fast guard stays in place.

Status: design only. Nothing here is implemented yet.

Conventions: sim path byte-identical; strict TS (`npm run build` +
`npm run typecheck` clean); one-class-per-file; prefer new files; smallest
focused vitest tests. Do NOT commit. Do NOT touch `CHANGELOG.md` /
`package.json`.

## 1. Environment findings (live, 2026-10-22, this host)

Probed with the exact commands below; outputs recorded verbatim in §1.1.

| Probe | Result | P1 implication |
|---|---|---|
| `which ios` / `ios --version` | **absent** (`command not found`) | go-ios CLI contracts are **UNVERIFIED** (§3.2); P1 must probe-at-boot + warn, never hard-require |
| `xcrun devicectl list devices` | works (devicectl 518.33); 10 known devices, **1 available+paired** (iPhone 16 Pro Max, `000A1FED-…`, os 27.0.1, devMode enabled) | live gate exists; inventory + `processes`/`apps` JSON schemas **VERIFIED** live (§3.1) |
| `-j/--json-output <path>` | file-only JSON; stdout stays human-readable | every devicectl call writes JSON to a tmp file, then parses (§3.1) |
| usbmuxd / lockdown | `/var/run/usbmuxd` present; `/var/db/lockdown` not permitted (needs root); no `~/Library/Lockdown` | pairing state must come from devicectl JSON (`pairingState`), never the filesystem |
| `security find-identity -v -p codesigning` | 2 valid Apple Development identities | signing present; `devicectl device install app` precondition satisfiable |
| `xctrace record --help` | `--device <name\|UDID>` confirmed | no CLI change needed; flip is guard deletion (§5) |
| `brew info go-ios` | **no formula** | install hint must NOT say `brew install go-ios`; exact steps UNVERIFIED, verify from go-ios README at implementation time |
| `devicectl device info processes` + `apps` on the live device | both work over an acquired tunnel (482 procs, 25 apps in default view) | `listRunning` via container-UUID join, VERIFIED (§4.2) |

### 1.1 Recorded outputs (provenance)

devicectl 518.33. `list devices` table: 9× `unavailable`, 1×
`available (paired)` (`000A1FED-73CC-57FF-9285-339181AB988E`, tunnelState
`disconnected`, i.e. wifi-paired, reachable on demand — the `processes` probe
below acquired a tunnel successfully). All 10 report `pairingState: paired`;
all but the Watch report `developerModeStatus: enabled`.

No USB-attached device was observed (no `tunnelState: connected`); the live
gate for P1 verification is the wifi-paired iPhone 16 Pro Max above. A USB
device would additionally exercise `transport: usb` matching — record which
transport the live run used.

## 2. Scope

GO in P1 (fail-fast → GO-via-transport):

- `lease_acquire(device_kind: real)` — real matching, queue, dispatch.
- `pool_status` — adds a real-device section (P0 §6.1 anticipated this).
- `app_install`, `app_uninstall`, `app_launch`, `app_terminate` — go-ios backend.
- `sim_log_stream`, `sim_log_show` — syslog-relay backend (leads: §4.3).
- `profile_trace` — guard deletion; `--device` already passed.

Keep fail-fast in P1 (unchanged guards, P0 phases stand):

- `app_open_url`, `app_cache_clear` — no CLI transport exists (devicectl has no
  open-url/copy-out-of-container; go-ios equivalents UNVERIFIED). Keep P2 with
  an updated detail naming the missing transport.
- All `ui_*` (P2), `stream_*` (P3), `debug_*` (P3), `net_*` mutating (P4),
  serve-sim/camera verbs (sim-only). No real-device UI/streaming/debug/proxy
  in P1.
- `sim_boot`/`sim_shutdown`/`sim_slim` holder branches: unchanged (sim-only).
- Unleased real UDIDs on udid-addressed verbs: still out of scope (P0 §6.3);
  no lease context → backend errors naturally. P1 does NOT add fleet-membership
  hints (keeps the change surface minimal; revisit if live use shows confusion).

P1 deletes the `SIM_MCP_REAL_LEASE` experimental hatch
(`src/devicekind.ts:33-46`, branch at `src/orchestrator.ts:320-337`) — P0 §11
acceptance criterion. `allowRealLease`/`REAL_LEASE_ENV` are removed; real
matching replaces the hatch.

## 3. Module/CLI contracts

### 3.1 devicectl (VERIFIED live — schemas below are from real output)

All calls: `xcrun devicectl … -j <tmpfile> -q`, then parse the file. devicectl
states JSON-to-file is the ONLY stable programmatic interface
(`devicectl --help`, live). Tmp files: `fs.mkdtempSync(os.tmpdir())` +
unlink after parse (best-effort); never a fixed path (concurrent calls).

**Inventory** — `devicectl list devices -j <f> -q` →
`{info: {...}, result: {devices: [...]}}`, each device:

```jsonc
{
  "identifier": "3D75A26C-F170-58B0-97C6-EBF539B7F7A8",   // CoreDevice id (NOT the lockdown udid)
  "deviceProperties": { "name": "B2C의 iPhone", "osVersionNumber": "18.6.2",
    "osBuildUpdate": "22G100", "developerModeStatus": "enabled", "...": "..." },
  "hardwareProperties": { "udid": "00008110-000529EE1406401E",   // lockdown udid → Lease.udid
    "marketingName": "iPhone 14", "platform": "iOS", "productType": "iPhone14,7",
    "serialNumber": "M2N777KVN6", "...": "..." },
  "connectionProperties": { "pairingState": "paired|…", "tunnelState": "unavailable|disconnected|…",
    "authenticationType": "manualPairing", "...": "..." },
  "capabilities": [ "..." ], "tags": [], "visibilityClass": "default"
}
```

**UDID decision (important):** `Lease.udid` for real leases is the
**lockdown udid** (`hardwareProperties.udid`, `00008110-…` form) — the same
namespace go-ios `ios list` and `xctrace --device` use. `identifier` is the
CoreDevice UUID devicectl prefers for `--device`, but `--device` also accepts
`udid` explicitly (`devicectl device install app --help`, live), so pass the
lockdown udid everywhere and keep one udid namespace across backends.

**Mapping to `PoolDevice`** (new interface, `src/realdevices.ts`):

```ts
export interface PoolDevice {
  udid: string;        // hardwareProperties.udid (lockdown)
  name: string;        // deviceProperties.name
  state: string;       // "available" | "unavailable" (from table State / tunnelState mapping, see below)
  platform?: string;   // hardwareProperties.platform ("iOS"/"watchOS"/…)
  osVersion?: string;  // deviceProperties.osVersionNumber
  kind: "real";        // literal: lets pool_status rows self-describe
  transport?: DeviceTransport;  // usb when tunnelState === "connected" via usb… see note
  trust: { paired: boolean; developerMode: string | null };  // pairingState === "paired", developerModeStatus
  coredeviceId: string;  // identifier (escape hatch for devicectl --device if udid form ever fails)
}
```

State mapping (from live rows): table `State` is `available (paired)` iff the
device is usable; in JSON the closest signal is
`connectionProperties.tunnelState !== "unavailable"` (live: the available
device reports `disconnected`, all unavailable ones `unavailable`).
`state = tunnelState === "unavailable" ? "unavailable" : "available"`.
Only `available` devices are acquirable; unavailable ones appear in
`pool_status` with `lease: null` (same shape as shutdown sims).

Transport note: devicectl JSON exposes no explicit usb/wifi bearer field.
`tunnelState: connected` arises for attached devices; P1 maps transport
heuristically (connected ⇒ `usb`, disconnected ⇒ `wifi`) and marks the field
**best-effort** in the tool description. `requirements.transport` filters on
this field when present; omitted transport matches either.

**listRunning join (VERIFIED live)** — two calls:

- `devicectl device info processes --device <udid> -j <f> -q` →
  `{result: {deviceIdentifier, runningProcesses: [{executable: "file://…",
  processIdentifier: N}]}}` (482 entries live).
- `devicectl device info apps --device <udid> -j <f> -q` →
  `{result: {apps: [{bundleIdentifier, name, url, …}], …}}` (25 entries live,
  default flags).

Join: extract `<UUID>` from
`…/private/var/containers/Bundle/Application/<UUID>/….app/…` in `executable`,
match against the same `<UUID>` segment in each app's `url`
(`file:///private/var/containers/Bundle/Application/<UUID>/<Name>.app/`) →
`bundleIdentifier`. Unmapped executables (system daemons, `/Applications/…`,
framework `.app`s — 71 `.app/` paths observed live, most unmappable) are
**skipped**, mirroring sim `listRunning`'s garbage-line tolerance
(`src/simapps.ts:104-111`). Empty/both-fail ⇒ empty set, never throw
(contamination baseline already fail-softs, `src/orchestrator.ts:579-589`).
Live-verified example pair: process
`…/C21AAB1B-…/Hana1QPay.app/Hana1QPay` ↔ app url containing the same UUID.

**App install** — `devicectl device install app --device <udid> <path> -j <f>`
(USAGE verified live; installs `.app`; JSON result schema UNVERIFIED — no
install was attempted against the live device). P1 uses **go-ios** for
install/uninstall/launch/terminate per the phase brief, NOT devicectl install:
devicectl has no uninstall/launch/terminate (subcommands are
copy/info/install/notification/orientation, live `--help`), so splitting
install onto devicectl would fork error/transport behavior for no gain.
devicectl stays the inventory + listRunning transport.

### 3.2 go-ios (UNVERIFIED — binary absent; verify each line at implementation)

Grounded only in secondary sources (pkg.go.dev usage text for
`github.com/danielpaulus/go-ios`, DeepWiki excerpts):

- Default output is JSON; `--nojson` selects human text; `--udid=<udid>`
  selects the device (multiple corroborating snippets).
- `ios list` → `{"deviceList": ["udid1", …]}` (single source: mobile-mcp
  DeepWiki page). P1 does NOT depend on this — inventory is devicectl-backed.
- Commands `ios info`, `ios launch`, `ios apps`, `ios syslog` exist (pkg.go.dev
  command list). Exact argv/JSON for `install` / `uninstall` / `launch` /
  `terminate`(or kill?) / `syslog` / `os_trace_relay` is **UNVERIFIED**.
- Install method UNVERIFIED (`brew` has no formula — live). The P1
  implementation task must confirm install steps from the go-ios README and
  bake the confirmed command into the missing-binary error + doctor fix text;
  until then errors say "go-ios (`ios`) is not installed; see
  <confirmed-at-implementation>" — never a guessed command.

P1 contract for `src/realdevices.ts` (RealDeviceApps): shell out per method,
parse defensively (pid -1 fallback mirrors `SimApps.launch`,
`src/simapps.ts:64-73`):

| AppOps method | Specified transport (UNVERIFIED argv) |
|---|---|
| `install` | `ios install --path=<app> --udid=<udid>` (confirm flag names) |
| `uninstall` | `ios uninstall --bundleid=<id> --udid=<udid>` (confirm; may be `ios uninstall <bundleid>`) |
| `launch` | `ios launch <bundleid> --udid=<udid>` (+ `--arg=` passthrough for argv; confirm) |
| `terminate` | `ios kill <bundleid> --udid=<udid>` (confirm; command name uncertain) |
| `openUrl` | NOT implemented — handler keeps fail-fast (P2 detail, §6) |
| `clearCache` | NOT implemented — throws sim-only-equivalent error (unreachable: handler keeps fail-fast) |
| `listRunning` | devicectl join (§3.1), NOT go-ios |

`RealDeviceApps` holds two binaries (`iosBin`, xcrun-devicectl needs no bin).
Missing `ios` at call time ⇒ actionable error naming install steps (confirmed
at implementation) + the `IOS_BIN` override (§7), following the
`serveSimError`/`lldmdError` ENOENT-hint precedent (`src/extras.ts:65-111`).

### 3.3 Syslog relay (SimLog seam — actual shape)

P0 §4.4 deliberately left `SimLog` concrete. The actual seam shape is: class
with `stream(udid, StreamOptions) / show(udid, ShowOptions) → BoundedResult`
(`src/simlog.ts:137-178`), `BoundedRunner` injection (`src/simlog.ts:4`),
option types `StreamOptions`/`ShowOptions`/`LogLevel`, and predicate helpers
(`validatePredicate`, `processPredicate`, `src/simlog.ts:67-113`). P1 adds the
second implementer, so P1 introduces the interface (deviation from P0 §4.4,
justified: no longer speculative):

- New `src/logops.ts`: `LogOps { stream(udid, opts): Promise<BoundedResult>;
  show(udid, opts): Promise<BoundedResult> }` over the existing option/result
  types (imported, not moved — same treatment as `CacheClearOptions`,
  P0 §4.2). `SimLog implements LogOps`, zero body changes.
- New `src/realsyslog.ts` (one-class-per-file): `RealSyslog implements LogOps`
  via `ios syslog --udid=<udid>` (argv UNVERIFIED) through `runBounded` with
  the same timeout/maxChars/tail semantics as `SimLog.stream`, so
  `timedOut/truncated` keep their meaning and the `sim_log_*` response shapes
  (`{udid, log, truncated, timedOut}`, `src/extras.ts:501,536`) are unchanged.
  - `stream`: relay until the window elapses; **client-side predicate
    filtering** — go-ios syslog emits plain text, so `predicate`/`process`
    become substring/regex line filters applied after capture (document the
    semantic difference: NSPredicate syntax is NOT supported on real; a
    best-effort `process == "X"` → substring `X` extraction plus full-text
    regex fallback; invalid-as-regex ⇒ literal substring). `level` is
    accepted-and-ignored with a one-line `warnings` note? No — response shape
    has no warnings field; ignore silently and document. (Cleaner alternative:
    reject `level` on real with an actionable error. **Decision: reject** —
    silent ignore violates the P0 "never misleading" rule of thumb, P0 §6.)
  - `show` (`--last` history): no device equivalent (syslog relay is
    live-only) ⇒ fail with an actionable error directing to `sim_log_stream`
    with a window. This keeps the verb table honest: `sim_log_show` on a real
    lease fails, but with a P1-transport reason, not a phase gate.
- `ExtrasDeps.simLog: SimLog` (`src/extras.ts:21`) widens to `LogOps` (mirrors
  the `AppOps` widening, P0 §4.2); new optional `realLog?: LogOps` holds the
  real backend; handlers dispatch by holder kind (§5).

### 3.4 New `src/realdevices.ts`

One file, two exports (interface + class; the class file holds the fleet
provider; app lifecycle lives in the SAME file per the phase brief — brief
explicitly says "New src/realdevices.ts: RealDeviceApps … + inventory mapping
… provider beside FleetOps", so one module hosts both, each class small):

- `RealDevices` — inventory provider. `list(): Promise<PoolDevice[]>` via
  devicectl JSON (§3.1); `checkAvailable(): Promise<string>` via
  `xcrun devicectl --version` (live: prints `518.33`). No boot/slim methods —
  deliberately NOT `FleetOps` (see §5 deviation note).
- `RealDeviceApps implements AppOps` — §3.2 + §3.1-join `listRunning`.
- Shared `assertUdid/assertBundleId/assertAppPath` stay in `simapps.ts`
  (unexported); `realdevices.ts` duplicates the 3-line guards (precedent:
  small local asserts beat cross-imports of unexported helpers; do NOT export
  from simapps — sim file stays untouched).

## 4. Dispatch design

### 4.1 Orchestrator: kind-aware fleet

- Constructor gains optional `realFleet?: Pick<RealDevices, "list">`
  (mirrors `apps?`, `src/orchestrator.ts:132`; `src/index.ts:131` injects
  `new RealDevices()`). Absent ⇒ real acquire fails with the missing-transport
  error (same posture as missing `apps` for contamination).
- `matches()` (`src/orchestrator.ts:94-101`): keep the sim line; add a real
  branch operating on `PoolDevice`: same `udid`/`device`/`osVersion`/`platform`
  semantics (name substring, os prefix, platform exact-ci), plus
  `transport` equality when requested, plus availability
  (`state === "available"`). Sim branch byte-identical.
- `acquire()` (`src/orchestrator.ts:308-395`): replace the P0 real branch
  (`:320-337`, fail-fast + hatch) with real matching: `realFleet.list()` →
  filter unheld + `matchesReal` → deterministic `udid` sort → `createLease`
  (already kind-generic, `:741-759`) → `captureBaseline` (kind-aware apps,
  below) → stream request becomes a warning (keep the hatch's warning text
  shape: real leases never auto-stream in P1). No boot, no slim, no maxSims
  interaction. `queue=false` + none free ⇒ actionable reason naming
  `pool_status` + pairing/availability checklist.
- `dispatchLocked()` (`src/orchestrator.ts:666-739`): partition waiting tickets
  by `requirements.deviceKind`; real tickets resolve against ONE `realFleet`
  list snapshot (no boot/slim arm); sim logic untouched. Held-set is shared
  across kinds (udid namespaces could theoretically collide; belt-and-braces).
- `resolveLease()` (`src/orchestrator.ts:469-509`): replace the P0
  short-circuit (`:488`) with real liveness — real lease ⇒ check udid still
  present+available in `realFleet.list()`; gone ⇒ evict with the same
  teardown shape as the sim arm (minus stream-stop, already kind-guarded
  `:478,412`) and a device-specific message ("device … is no longer
  available; lease … was released"). Contamination check runs for real too
  once apps are kind-aware (below); on `listRunning` failure it fail-softs
  exactly like sim (`checkContamination` — verify current tolerance at
  implementation; sim baseline already fail-softs, `:579-589`).
- kind-aware `apps`: constructor gains `realApps?: Pick<AppOps,"listRunning">`;
  `captureBaseline`/`checkContamination` select by `deviceKindOf(lease)`.
  `markAppLaunched/markAppTerminated` (`:555-562`) are kind-agnostic (in-memory
  sets) — unchanged; real `app_launch`/`app_terminate` handlers keep calling
  them.
- `poolStatus()` (`:177-233`): add a `devices: PoolDeviceView[]` section
  (real fleet + lease overlay, same lease-pick shape as `:212-223`,
  `slim: null`, `slimDetail: null`, `ramBytes: null`) plus
  `countsReal: {total, available, leased}`. `simulators`/`counts`/`queue` keys
  byte-identical. `pool_status` description (`src/server.ts:79`) gains one
  sentence. Real-fleet failure inside poolStatus ⇒ `devices: []` + a
  top-level `realError: string` (view must never fail; precedent: slimStatus
  catch-null, `:190-199`).
- `ServerDeps.simApps: SimApps` (`src/server.ts:30`) is concrete but only
  passed through to `registerDeviceExtras` (`src/server.ts:614`) — widen to
  `AppOps` and add `realApps?: AppOps`, `realLog?: LogOps` pass-throughs.
  `src/index.ts` wires all three.

### 4.2 Extras handlers: dispatch by `lease.deviceKind`

App verbs (`app_install/uninstall/launch/terminate`): replace
`requireSimLease` with
`const apps = isRealLease(lease) ? realApps(else throw missing-transport) : simApps`
(`src/extras.ts:609-697`). `logAction`/`markApp*` calls unchanged. Response
shapes unchanged (`{lease_id, udid, …}`).

Log verbs (`sim_log_stream/show`, udid-addressed, `src/extras.ts:477-541`):
keep the `leaseForUdid` holder lookup; holder-real ⇒ `realLog.stream/show`;
holder-sim-or-none ⇒ existing sim path (unleased real UDIDs stay out of scope,
§2). `sim_log_show` on real fails inside `RealSyslog.show` with the
stream-instead guidance (§3.3) — handler code needs no show/stream split.

Trace (`profile_trace`, `src/extras.ts:743-773`): delete the guard line
(`:759`). `XCTrace.record` already passes `--device <udid>` (`src/xctrace.ts:78`)
— no class change. Attach default: keep `allProcesses` default for uniformity
(P0 §7 precondition note stands); document that `--attach` resolves on real
hardware (unlike sims, `src/xctrace.ts:48-51`), so real callers SHOULD prefer
`attach`. Pairing/trust/Developer-Mode failures surface as xctrace stderr;
P1 maps the two known signatures (unverified strings — confirm live at
implementation, else pass through verbatim): not-paired and
Developer-Mode-disabled. Output filename already udid-keyed (`:761`).

Descriptions: `lease_acquire` `device_kind` text (`src/server.ts:60-61`) drops
"P0 rejects" → "real leases use the devicectl/go-ios transports (§3)". App/log
verb descriptions gain "(simulator or real-device lease)" — exact wording at
implementation; keep it to one clause each.

### 4.3 Deviation from P0 §4.3, recorded

P0 §4.3 anticipated "a devicectl-backed implementation" of `FleetOps`. P1 does
NOT do that: `FleetOps.boot/slimStatus/slimNoReboot` (`src/simslim.ts:47-52`)
have no hardware meaning, and stub implementations that throw would be
lie-methods every caller must tiptoe around. Instead the orchestrator holds a
second narrow provider (`Pick<RealDevices,"list">`) and branches on
`deviceKind` at the four call sites (§4.1). The `FleetOps` shape stays frozen
(P0 §9 non-goal honored).

## 5. Fail-fast table delta (vs P0 §6)

| Verb | P0 | P1 |
|---|---|---|
| `lease_acquire(device_kind: real)` | fail-fast P1 | **GO** — real matching/queue/dispatch (§4.1) |
| `pool_status` | GO (sims only) | **GO** — adds `devices[]` + `countsReal` + `realError?` |
| `app_install/uninstall/launch/terminate` | fail-fast P2 | **GO-via-go-ios** (§3.2); missing `ios` ⇒ install-steps error |
| `app_open_url`, `app_cache_clear` | fail-fast P2 | **still fail-fast P2**, detail updated: no CLI transport in P1 |
| `sim_log_stream` (leased real) | fail-fast P3 | **GO-via-syslog-relay** (§3.3); `level` rejected, predicate is client-side substring/regex |
| `sim_log_show` (leased real) | fail-fast P3 | **fail-fast with P1 reason** (live-only relay; use stream) — guard moves from handler to `RealSyslog.show` |
| `profile_trace` | fail-fast P3 | **GO** — guard deleted; `--device` already passed; preconditions documented |
| `ui_*` ×8, `stream_*`, `debug_*` (16), `net_*` mutating (5), serve-sim/camera sim-only (6), `sim_shutdown/slim` holder branches | fail-fast | **unchanged** — every other guard byte-identical |

`APP_REAL_DETAIL` (`src/extras.ts:28`) stays for the two remaining app gates;
`LOG_REAL_DETAIL` (`:32`) is deleted with the handler guards (replaced by
transport errors); `STREAM_REAL_DETAIL`/`DEBUG_REAL_DETAIL`/`NET_REAL_DETAIL`
untouched.

## 6. Optional-binary wiring (warn-at-boot pattern)

Precedent (found, do not reinvent): required probes exit-1
(`src/index.ts:66-77`); optional probes warn-and-continue naming affected verbs
+ install command (`src/index.ts:79-128`, four blocks); `*_BIN` env overrides
in `src/config.ts:54-61`; doctor `warn` rows with `fix` (`src/doctor.ts:96-113`,
"warn = optional dependency missing"); call-time ENOENT hints
(`src/extras.ts:65-111`).

- `src/config.ts`: add `iosBin: str("IOS_BIN", "ios")`. devicectl needs no bin
  (ships with Xcode; invoked as `xcrun devicectl`); Xcode presence is already
  doctor-gated (`src/doctor.ts:69-79`).
- `src/index.ts`: add a fifth optional block probing
  `new RealDevices().checkAvailable()` (`devicectl --version`) AND
  `ios --version`, warning separately: devicectl-missing ⇒ real inventory/
  acquire/listRunning unavailable; ios-missing ⇒ app verbs + syslog
  unavailable on real leases. Daemon always starts.
- `src/doctor.ts`: two `warn` rows (`devicectl` via `xcrun devicectl --version`,
  fix: install Xcode; `ios`, fix: confirmed-at-implementation install steps —
  see §3.2).
- Call-time: `RealDevices.list` failure ⇒ error naming `xcrun devicectl`
  (pairing/trust checklist when stderr matches; else verbatim stderr);
  `RealDeviceApps`/`RealSyslog` ENOENT on `ios` ⇒ install-steps error.

## 7. Test plan

Precedent: stub `Runner` recording calls (`test/simapps.test.ts:18-28`),
`FakeFleet implements FleetOps` (`test/orchestrator.test.ts:9-44` and
`test/simapps.test.ts:30-40`), tmp state files (`test/simapps.test.ts:44`),
MCP-level `registerDeviceExtras` + `InMemoryTransport` dispatch tests
(`test/simapps.test.ts:42-73,158-205`), store-built real leases
(`test/real-failfast.test.ts:43-50`).

1. `test/realdevices.test.ts`
   - Inventory: stub runner serving a checked-in devicectl JSON fixture
     (scrubbed from the live capture in §1.1 — keep identifier/udid/name/
     os/pairing/tunnel fields, drop serials) ⇒ `PoolDevice[]` mapping incl.
     state/transport/trust; unavailable devices listed but flagged.
   - `listRunning`: stubbed `processes` + `apps` fixtures (live shapes, §3.1)
     ⇒ bundle-id set; unmapped executables skipped; empty ⇒ empty set.
   - App methods: stub `ios` asserting exact argv per method (argv confirmed at
     implementation, §3.2); blank-input validation without spawn (mirrors
     `test/simapps.test.ts:82-89,103-109`); ENOENT ⇒ install-steps error text.
2. `test/realacquire.test.ts`
   - Fake real fleet + `acquire({deviceKind: real})` ⇒ real lease (no boot/
     slim calls — assert via call-recording fake); deterministic udid order;
     held exclusion; transport filter; unavailable excluded; queue=false none
     free ⇒ actionable reason; ticket dispatch on release assigns real waiter
     (mirrors `test/orchestrator.test.ts` dispatch coverage).
   - `resolveLease` on real: present ⇒ returns; gone from fleet ⇒ evicted with
     device-worded error (extends `test/real-failfast.test.ts:52-69`).
   - Hatch deletion: `SIM_MCP_REAL_LEASE=1` no longer special (env ignored);
     update `test/real-failfast.test.ts:71-79` (P1 fail-fast test becomes a GO
     test or moves here).
3. `test/reallog.test.ts`
   - `RealSyslog.stream` via stub `BoundedRunner`: timeout/maxChars/tail
     passthrough; `process`-shorthand substring filter; predicate regex filter
     + literal fallback; `level` rejected.
   - `RealSyslog.show` ⇒ stream-instead error.
   - `SimLog implements LogOps` compile-time conformance (mirrors
     `test/seams.test.ts`).
4. `test/real-dispatch.test.ts` (MCP level, mirrors `test/simapps.test.ts:158+`)
   - Store-built real lease + `app_launch` ⇒ routes to fake `realApps`
     (assert calls, pid passthrough, `markAppLaunched` observed via
     `leaseActions`); sim lease ⇒ sim backend (no cross-talk).
   - `app_open_url`/`app_cache_clear` on real ⇒ still fail-fast P2.
   - `sim_log_stream` with real holder ⇒ fake `realLog`; sim holder ⇒ simLog.
   - `profile_trace` on real ⇒ `xctrace.record` invoked (stub runner asserts
     `--device <udid>` present); on sim unchanged.
   - `pool_status` includes `devices[]` from fake real fleet; real-fleet throw
     ⇒ `realError` set, sims intact.
5. Updates to existing tests: `test/real-failfast.test.ts` — hatch tests
   removed; `devicekind.test.ts` phase-table entries for promoted verbs flipped
   to GO (assert no-throw via dispatch fakes, not message text, per P0 §11
   substring rule).

Fixtures live next to tests (`test/fixtures/devicectl-*.json`), scrubbed of
serials/ECIDs/hostnames. No test shells out to real `devicectl`/`ios`
(hermetic; live verification is manual against the §1 gate).

Gates (in order): focused new tests → `npx vitest run` (full suite green) →
`npm run build` → `npm run typecheck`. No commit.

## 8. Change list (implementation order)

1. `src/realdevices.ts` (new): `PoolDevice`, `RealDevices`, `RealDeviceApps`.
2. `src/logops.ts` (new): `LogOps`; `src/simlog.ts`: `implements LogOps`
   (body-untouched); `src/realsyslog.ts` (new): `RealSyslog`.
3. `src/config.ts`: `iosBin`; `src/index.ts`: fifth optional probe block(s) +
   inject `realFleet`/`realApps`/`realLog`; `src/doctor.ts`: two warn rows.
4. `src/devicekind.ts`: delete `allowRealLease`/`REAL_LEASE_ENV`.
5. `src/orchestrator.ts`: `matchesReal`, real acquire branch (replacing
   `:320-337`), real dispatch partition, real liveness in `resolveLease`,
   kind-aware apps selection, `poolStatus` real section.
6. `src/server.ts`: acquire-schema text (`:60-61`), `ServerDeps` widening +
   pass-throughs (`:30`, `:614`).
7. `src/extras.ts`: `ExtrasDeps` gains `realApps?`/`realLog?`; dispatch in
   4 app verbs + 2 log verbs; delete trace guard (`:759`); keep the 2
   remaining app gates with updated detail; delete `LOG_REAL_DETAIL`.
8. Tests (§7) + fixtures. Verify live against the §1 gate (real acquire →
   install/launch/terminate a scratch app → stream → trace), recording the
   transport used.

## 9. Risks

- **go-ios truth gap.** Every `ios` argv/JSON line is UNVERIFIED (§3.2). The
  implementation task MUST install go-ios first, confirm each command against
  `ios --help` + the live device, and correct §3.2 before coding call sites.
  If `ios kill`/terminate has no equivalent, `app_terminate` keeps fail-fast
  (P2 detail) instead of shipping a broken backend.
- **`ios list` ignored by design.** Inventory is devicectl-only. If a device is
  visible to go-ios but not devicectl (or vice versa), app verbs fail with
  transport errors on an acquirable lease. Mitigation: `RealDeviceApps` errors
  include the udid + "visible to devicectl but unreachable via go-ios?"
  checklist line.
- **Transport heuristic.** usb/wifi mapping from `tunnelState` is best-effort
  (§3.1). A wrong guess misroutes `transport`-filtered acquires; default
  (omitted transport) is unaffected. Revisit if devicectl exposes a bearer.
- **Contamination semantics on real.** `listRunning` needs TWO devicectl calls
  (tunnel setup each — observed ~1s for processes live); the resolveLease path
  calls it on every verb. Mitigation: existing min-interval throttle
  (`contaminationCheckMinIntervalMs`) applies; consider caching the apps-list
  join per lease with a short TTL at implementation.
- **Error-text coupling (P0 §11, inherited).** Assert substrings, never full
  text, in every new test.
