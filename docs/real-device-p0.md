# Real-device support P0: seams + fail-fast (design)

P0 goal: introduce the type/driver seams real-device support needs, with
**ZERO simulator behavior change**. No real-device backends land in P0: every
sim-assuming verb fails fast on a `real` lease with an ACTIONABLE error naming
the owning future phase. The full sim suite stays green.

Status: design only. Nothing here is implemented yet.

## 1. Phase map (referenced by every fail-fast error)

| Phase | Title | Scope |
|---|---|---|
| P1 | Real-device fleet & acquisition | `devicectl`/pairing-backed fleet inventory, trust/pairing UX, `transport` usb/wifi selection, kind-aware `lease_acquire` matching + dispatch, real liveness in `resolveLease` |
| P2 | Real-device app + UI drivers | `AppOps` / `UiDriver` real backends (devicectl install/launch, WDA/idb-backed UI automation) |
| P3 | Real-device observability & debug | Stream alternatives, device logs, `profile_trace` on device (first GO candidate, §7), remote debug sessions |
| P4 | Real-device network interception | Manual CA-profile install flow replacing the `simctl keychain` step, device-aware capture notes |
| sim-only | Never enabled on real | Verbs with no real-device meaning (`sim_boot/shutdown/slim`, serve-sim display/camera verbs). The error says so plainly instead of naming a phase. |

## 2. Type diffs (`src/store.ts`)

New file `src/devicekind.ts` (one-module-per-file convention):

```ts
export type DeviceKind = "sim" | "real";
export type DeviceTransport = "usb" | "wifi";
```

`Requirements` (`src/store.ts:9-17`) gains two optional fields:

```ts
export interface Requirements {
  udid?: string;
  device?: string;
  osVersion?: string;
  platform?: string;
  /** Default when omitted: "sim". P0 rejects "real" (see §8); P1 matches the real fleet. */
  deviceKind?: DeviceKind;
  /** Only meaningful with deviceKind "real" (P1). Accepted + persisted in P0, otherwise unused. */
  transport?: DeviceTransport;
}
```

`Lease` (`src/store.ts:19-40`) gains:

```ts
export interface Lease {
  // ... unchanged ...
  /** Always present after load migration (§3). Old persisted leases default to "sim". */
  deviceKind: DeviceKind;
  /** Present only on real leases that requested one (P1). */
  transport?: DeviceTransport;
}
```

`Ticket` needs no new top-level field: its embedded `requirements`
(`src/store.ts:49`) already carries `deviceKind`/`transport` through
acquire → queue → dispatch. Dispatch (`src/orchestrator.ts:672-692`) and
`createLease` (`src/orchestrator.ts:706-722`) copy
`requirements.deviceKind ?? "sim"` (+ `transport` when present) onto the new
lease — always `"sim"` in P0, wired correctly for P1.

`matches()` (`src/orchestrator.ts:93-99`) gains one line, sim-path identical:

```ts
if ((req.deviceKind ?? "sim") !== "sim") return false; // P0 fleet is sims only; P1 adds the real fleet
```

`lease_acquire` input schema (`src/server.ts:188-199`) gains
`device_kind: z.enum(["sim","real"]).optional()` and
`transport: z.enum(["usb","wifi"]).optional()`, plumbed into
`AcquireInput.requirements` (`src/orchestrator.ts:27-39`).

## 3. Migration story

Precedent: `Store.load` already normalizes defensively (non-array → `[]`,
terminal tickets pruned, corrupt file → fresh state with a stderr note,
`src/store.ts:89-106`); first-run dir migration lives in `src/migrate.ts:29-46`
and is out of scope here (no new state-file location).

P0 migration is load-time normalization inside `Store.load`, no version bump,
no rewrite pass:

- Every loaded `Lease` without `deviceKind` gets `deviceKind: "sim"`
  (in memory; persisted on the next mutating write via the existing atomic
  save, `src/store.ts:131-136`).
- `Requirements.deviceKind` stays optional with `undefined ≡ "sim"` at every
  read site (`matches`, acquire), so old queued tickets need no rewrite.
- Unknown future `deviceKind` values: fail the load of that record loudly
  (throw inside `Store.load` → fresh-state fallback already logs) rather than
  silently coercing — fail-closed on data we do not understand.

Sim-path byte-identical: a sim lease round-trips with one additive JSON key;
no existing key changes shape or order.

## 4. Driver seams

Precedent: `FleetOps` (`src/simslim.ts:46-52`, faked per-test as `FakeFleet`,
`test/orchestrator.test.ts:9-44`), `StreamOps` (`src/servesim.ts:65-69`,
faked in `test/stream.test.ts`), `ProxyOps` (`src/netproxy.ts:160-169`),
`CaptureOps` (`src/netcapture.ts:91-98`), `DebugOps` (`src/llmdb.ts:72-74`).
P0 follows the same shape: narrow interface, existing class implements it
unchanged, tests inject fakes.

### 4.1 `UiDriver` (new file `src/uidriver.ts`)

Full `Axe` public surface (`src/axe.ts:50-175`), method-for-method:

```ts
import type { Axe } from "./axe.js"; // types only; see below
export interface UiDriver {
  checkAvailable(): Promise<string>;
  describeUi(udid: string, point?: { x: number; y: number }): Promise<string>;
  tap(udid: string, target: TapTarget): Promise<string>;
  typeText(udid: string, text: string): Promise<string>;
  swipe(udid: string, from: { x: number; y: number }, to: { x: number; y: number }, opts?: SwipeOptions): Promise<string>;
  gesture(udid: string, preset: string, opts?: GestureOptions): Promise<string>;
  button(udid: string, button: string, duration?: number): Promise<string>;
  screenshot(udid: string, output: string): Promise<string>;
  batch(udid: string, steps: string[], opts?: BatchOptions): Promise<string>;
}
```

Option types `TapTarget`/`SwipeOptions`/`GestureOptions`/`BatchOptions`
(`src/axe.ts:3-35`) move to `src/uidriver.ts`; `axe.ts` re-exports them
(`export type { … } from "./uidriver.js"`) so existing importers are
untouched. `Axe` gains `implements UiDriver` with zero body changes.
`ServerDeps.axe` (`src/server.ts:21-31`) widens `Axe` → `UiDriver`;
`src/index.ts:49` still injects `new Axe(...)`.

### 4.2 `AppOps` (new file `src/appops.ts`)

Full `SimApps` public surface (`src/simapps.ts:34-116`):

```ts
export interface AppOps {
  openUrl(udid: string, url: string): Promise<void>;
  install(udid: string, appPath: string): Promise<void>;
  uninstall(udid: string, bundleId: string): Promise<void>;
  launch(udid: string, bundleId: string, argv?: string[]): Promise<LaunchResult>;
  terminate(udid: string, bundleId: string): Promise<void>;
  clearCache(udid: string, bundleId: string, opts?: CacheClearOptions): Promise<CacheClearResult>;
  listRunning(udid: string): Promise<Set<string>>;
}
```

`LaunchResult` (`src/simapps.ts:4-9`) moves to `src/appops.ts` with a
re-export from `simapps.ts`. `CacheClearOptions`/`CacheClearResult` stay in
`src/appcache.ts` (imported, not moved — cache-clearing internals are
sim-specific; the P2 backend reuses only the option shape).
`SimApps implements AppOps` unchanged. `ExtrasDeps.simApps`
(`src/extras.ts:17-25`) and the orchestrator's
`apps?: Pick<SimApps, "listRunning">` (`src/orchestrator.ts:130`) widen to the
interface; `src/index.ts:56,139` still inject `new SimApps(...)`.

### 4.3 `StreamOps` — pre-existing, keep in place

`StreamOps` (`src/servesim.ts:65-69`, implemented by `ServeSim`) already
satisfies the P0 seam requirement, including the fake-in-tests precedent.
P0 does NOT move it (zero churn); P1's real streaming backend implements the
same interface. Same for `FleetOps`: P1 adds a devicectl-backed
implementation; P0 only relies on the interface existing.

### 4.4 Explicitly NOT seamed in P0

`SimLog`, `XCTrace`, `Llmdb`, `NetProxy`, `NetCapture` stay concrete: each is
either sim-only-forever-adjacent (log/trace go through `simctl`/`xctrace`
differently per kind) or host-wide (proxy/capture). Seaming them now would be
speculative abstraction with no second implementer in sight. Their verbs are
covered by fail-fast (§6) instead.

## 5. Fail-fast helper (`src/devicekind.ts`)

```ts
import type { Lease } from "./store.js";

/** undefined ≡ "sim": tolerant read for in-flight/hand-built leases. */
export function deviceKindOf(lease: Pick<Lease, "deviceKind">): DeviceKind {
  return lease.deviceKind ?? "sim";
}

export function isRealLease(lease: Pick<Lease, "deviceKind">): boolean {
  return deviceKindOf(lease) === "real";
}

/** Throw an actionable error when the lease is real-kind. No-op for sim. */
export function requireSimLease(
  lease: Lease,
  opts: { verb: string; phase: "P1" | "P2" | "P3" | "P4" | "sim-only"; detail: string },
): void {
  if (!isRealLease(lease)) return;
  const where = opts.phase === "sim-only"
    ? "this verb is sim-only by design and has no real-device equivalent"
    : `real-device support lands in ${opts.phase} (${opts.detail})`;
  throw new Error(
    `${opts.verb} does not support real-device leases yet: ${where}. ` +
    `Lease ${lease.leaseId} holds real device ${lease.udid}. ` +
    `Acquire a simulator lease (device_kind "sim", the default) to use ${opts.verb}.`,
  );
}
```

Conventions: one shared helper (every verb's error names the verb, the lease,
the device, and the owning phase); thrown inside the existing `try` so it
flows through the established `fail()` envelope; sim path is a single
`!== "real"` comparison.

`resolveLease` (`src/orchestrator.ts:443-482`) short-circuits for real leases
immediately after the unknown/expired checks, BEFORE the fleet list and the
booted-sim check:

```ts
if (isRealLease(lease)) return lease; // P0: validity only; every sim-assuming verb fail-fasts itself (§6)
```

This skips the booted-sim eviction (meaningless for real devices) and the
contamination check (`listRunning` is `simctl`-based,
`src/orchestrator.ts:565-587`). Sim path byte-identical — the branch only
triggers on `deviceKind === "real"`, unconstructible via public API in P0 (§8).

Release/sweep/expire teardown (`release`, `sweepLocked`, `resolveLease`
expiry arm): skip `stopStreamQuiet` for real leases. Rationale: it would shell
out to `serve-sim --kill <real-udid>` on every real release; the call is
provably harmless (idempotent exit-0, `src/servesim.ts:317-320`, never throws,
`src/orchestrator.ts:846-853`) but a kind guard keeps real releases hermetic
and offline. Debug/proxy/capture quiet-stops are already no-ops without a
recorded session/holder — no change needed.

## 6. Exhaustive fail-fast verb table

Rule of thumb: **fail fast when the verb would otherwise produce a wrong /
misleading result or a confusing backend error on a real lease; GO when the
result is trivially correct** (idempotent no-op, read-only view, host-local
diagnostic). Every fail-fast goes through `requireSimLease` (verb + phase +
detail); GO verbs need no P0 change beyond the `resolveLease` short-circuit.

Tool order follows `src/server.ts` then `src/extras.ts` registration order.
Line refs are the `"name",` registration lines.

### 6.1 `src/server.ts` — pool / leases / queue (all GO except acquire)

| Verb (line) | P0 verdict | Rationale |
|---|---|---|
| `pool_status` (:71) | GO, unchanged | Sim-fleet view; real leases simply have no sim row. P1 adds a real-device section. |
| `sessions_list` (:87) | GO, unchanged | Echoes leases incl. new `deviceKind` key — part of the live-observability path (§8). |
| `sim_boot` (:103) | GO, unchanged (no lease context) | Pure `simslim.boot(udid)` passthrough; a real UDID fails inside simslim with its own error. Nothing lease-aware to gate. |
| `sim_shutdown` (:119) | Fail-fast when holder is real (`sim-only`) | Holder branch (`src/server.ts:128-138`) checks `isRealLease(holder)` first: "sim_shutdown is sim-only (simulators boot/shutdown via simslim); release the real lease instead of shutting down hardware." |
| `sim_slim` (:148) | Fail-fast when holder is real (`sim-only`) | Same hook in the holder branch (`src/server.ts:162-168`). |
| `lease_acquire` (:184) | `device_kind: "real"` → fail-fast P1 (§8); default/`"sim"` unchanged | Rejection text: "kind=real acquisition lands in P1 (real-device fleet: devicectl inventory, pairing, transport). Omit device_kind (default sim) for a simulator lease." |
| `lease_release` (:224) | GO, unchanged + §5 teardown guard | Kind-agnostic bookkeeping; quiet-stops no-op for real. |
| `lease_heartbeat` (:243) | GO, unchanged | Timestamp bump only. |
| `lease_list` (:261) | GO, unchanged | Echoes `deviceKind` — live-observability path (§8). |
| `queue_status` (:276) | GO, unchanged | Waiting-ticket view; embeds requirements incl. `deviceKind`. |
| `queue_cancel` (:294) | GO, unchanged | Deletes own waiting ticket. |

### 6.2 `src/server.ts` — `ui_*` (all fail-fast P2)

| Verb (line) | Guard placement | Error detail |
|---|---|---|
| `ui_describe` (:314) | After `resolveLease`, before `axe.describeUi` (:328) | P2 (real-device UI automation via WebDriverAgent/idb-backed UiDriver) |
| `ui_tap` (:360) | After `resolveLease`, before M4 gate (:396) | same |
| `ui_type` (:454) | After `resolveLease` (:464) | same |
| `ui_swipe` (:475) | After `resolveLease` (:489) | same |
| `ui_gesture` (:500) | After `resolveLease` (:511) | same |
| `ui_button` (:522) | After `resolveLease` (:533) | same |
| `ui_screenshot` (:544) | After `resolveLease`, before `mkdir` (:553) | same |
| `ui_batch` (:569) | After `resolveLease`, before `axe.batch` (:582) | same |

All eight route exclusively through the `UiDriver` seam (§4.1), so P2 swaps
one injection with no handler edits.

### 6.3 `src/extras.ts` — udid-addressed serve-sim / camera / log verbs

These take a raw `udid`, not a lease, so the hook is
`leaseForUdid(udid)` → `isRealLease(holder)` → fail-fast. `leaseGate`
(`src/extras.ts:262-273`) is the shared choke point for the gated verbs; the
ungated ones get an explicit holder lookup (same one-liner, no behavior change
when unleased or sim-leased).

| Verb (line) | P0 verdict | Detail |
|---|---|---|
| `sim_rotate` (:276) | Fail-fast `sim-only` | In `leaseGate`: serve-sim display rotation has no hardware equivalent. |
| `sim_ca_debug` (:299) | Fail-fast `sim-only` | Same. |
| `sim_memory_warning` (:324) | Fail-fast `sim-only` | Same. |
| `camera_start` (:346) | Fail-fast `sim-only` | Feed injection relaunches the app under a sim helper; no real-HW equivalent planned. |
| `camera_switch` (:378) | Fail-fast `sim-only` | Same. |
| `camera_mirror` (:403) | Fail-fast `sim-only` | Un-gated today; add holder lookup. Without it, serve-sim fails with a confusing "no server running" error. |
| `camera_status` (:422) | GO, unchanged | Read-only; serve-sim truthfully reports `{alive:false}` for a udid with no helper. |
| `camera_stop` (:440) | GO, unchanged | Idempotent exit-0 (`src/servesim.ts:230-236`); `stopped:true` is trivially correct. |
| `sim_log_stream` (:458) | Fail-fast P3 | Un-gated; add holder lookup. Detail: P3 device-log capture (devicectl/syslog replacement for `simctl spawn log`). |
| `sim_log_show` (:487) | Fail-fast P3 | Same. |
| Unleased real UDIDs | Out of scope | No lease context exists; the backend (`simslim`/`xcrun`/`serve-sim`) errors naturally. P1 may add a fleet-membership hint. Documented, not gated. |

### 6.4 `src/extras.ts` — `stream_*` / `app_*` / `profile_trace`

| Verb (line) | P0 verdict | Detail |
|---|---|---|
| `stream_start` (:520) | Fail-fast P3 | Guard in the handler before `startLeaseStream` (and/or inside `startLeaseStream`, `src/orchestrator.ts:757-772` — handler-level keeps the orchestrator seam-agnostic; pick handler-level). Detail: P3 real-device screen streaming. |
| `stream_stop` (:540) | Fail-fast P3 | Same placement. (Not GO: `stopStream` shells to serve-sim; a real lease never has a serve-sim helper, so "already stopped" would be a lie about the wrong backend.) |
| `app_open_url` (:559) | Fail-fast P2 | After `resolveLease`, before `simApps.openUrl`. Detail: P2 AppOps real backend (devicectl). |
| `app_install` (:580) | Fail-fast P2 | Same. |
| `app_uninstall` (:601) | Fail-fast P2 | Same. |
| `app_launch` (:622) | Fail-fast P2 | Same (before launch + `markAppLaunched`). |
| `app_terminate` (:645) | Fail-fast P2 | Same. |
| `app_cache_clear` (:667) | Fail-fast P2 | Same. Sim container paths + `terminate` have no real equivalent in P0. |
| `profile_trace` (:710) | Fail-fast P3 — decided NOT GO-trivial (§7) | After `resolveLease`, before `xctrace.record`. |

### 6.5 `src/extras.ts` — `debug_*` (fail-fast P3, except noted GO)

All session verbs operate on `lease.debugSessionId` via `llmdb`, never on the
udid directly — but a real lease can never acquire a session in P0, and the
natural `requireDebugSession` error ("call debug_attach first",
`src/extras.ts:206-211`) does not name a phase. Guard goes immediately after
`resolveLease`, before `requireDebugSession`, in each verb.

| Verb (line) | P0 verdict | Detail |
|---|---|---|
| `debug_attach` (:741) | Fail-fast P3 | Both forms: `bundle_id` is sim-app attach; `pid` is a HOST pid — attaching to host pids under a device lease would be actively misleading. Detail: P3 remote debug sessions. |
| `debug_break` (:783) | Fail-fast P3 | Before op parsing? No — after `resolveLease` (:833), keeping arg-validation errors first (existing tests may assert them). Same for all session verbs: validate args, resolve, kind-guard, session. |
| `debug_continue` (:891) | Fail-fast P3 | Same. |
| `debug_bt` (:922) | Fail-fast P3 | Same. |
| `debug_locals` (:949) | Fail-fast P3 | Same. |
| `debug_eval` (:971) | Fail-fast P3 | Same. |
| `debug_step` (:994) | Fail-fast P3 | Same. |
| `debug_detach` (:1021) | GO, unchanged | No session → `stopped:false` is trivially correct (idempotent-by-contract). |
| `debug_sessions` (:1063) | GO, unchanged | Host-local daemon listing; optional-lease form validates + logs, harmless on real. |
| `debug_launch` (:1089) | Fail-fast P3 | After the exactly-one check (:1102), after `resolveLease` (:1105): `bundle_id` form is sim-launch-then-attach; `path` form launches a HOST binary attributed to a device lease — misleading either way. |
| `debug_doctor` (:1164) | GO, unchanged | Host-local diagnostics; same optional-lease reasoning as `debug_sessions`. |
| `debug_threads` (:1190) | Fail-fast P3 | Session verb, same placement. |
| `debug_scopes` (:1211) | Fail-fast P3 | Same. |
| `debug_expand` (:1233) | Fail-fast P3 | Same. |
| `debug_set_var` (:1256) | Fail-fast P3 | Same. |
| `debug_output` (:1280) | Fail-fast P3 | Same. |
| `debug_run_until` (:1304) | Fail-fast P3 | Same. |
| `debug_wait` (:1336) | Fail-fast P3 | Same. |
| `debug_interrupt` (:1367) | Fail-fast P3 | Same (before the already-stopped fast path). |

### 6.6 `src/extras.ts` — misc + `net_*`

| Verb (line) | P0 verdict | Detail |
|---|---|---|
| `symbolicate` (:1409) | GO, unchanged | Host-local `atos`; explicitly touches no simulator (description at :1411-1412). |
| `lease_actions` (:1451) | GO, unchanged | In-memory bookkeeping; kind-agnostic. |
| `net_proxy_start` (:1470) | Fail-fast P4 | Before `startLeaseProxy`: start runs `xcrun simctl keychain <udid> add-root-cert` (`src/netproxy.ts:1274`) — hard sim dependency. Detail: P4 manual CA-profile install replacing the keychain step. |
| `net_proxy_set_rules` (:1501) | Fail-fast P4 | A real lease can never hold the proxy in P0; the natural busy/not-running error would mislead users into retrying. |
| `net_proxy_stop` (:1523) | GO, unchanged | Idempotent: `stopped:false` when idle is correct; `ProxyBusyError` when another lease holds is already actionable. |
| `net_proxy_status` (:1549) | GO, unchanged | Read-only global view; any valid lease may view (by design, :1552). |
| `net_capture_start` (:1595) | GO, unchanged | Host `tcpdump`; `udid` is status metadata only (`src/netcapture.ts:76-83,299`). Caveat (document in tool description in P1, not P0): captures the host interface — USB-attached device traffic is invisible; WiFi-routed traffic is visible. |
| `net_capture_stop` (:1631) | GO, unchanged | Idempotent (`stopped:false` correct); holder check already actionable. |
| `net_capture_status` (:1660) | GO, unchanged | Read-only view. |
| `net_assert_flow` (:1693) | Fail-fast P4 | Requires holding the proxy, impossible for real leases in P0; natural "no running proxy" error misleads. |
| `map_local` (:1778) | Fail-fast P4 | Requires holding the proxy; same reasoning. |
| `map_remote` (:1818) | Fail-fast P4 | Same. |

Count check: 19 server verbs + 50 extras verbs = 69 tools, all classified:
49 fail-fast = 8 (ui) + 3 (sim_shutdown/sim_slim holder branches, acquire-real
branch) + 38 extras (6 serve-sim/camera + 2 sim_log + 2 stream + 6 app +
1 trace + 16 debug + 5 net mutating); 20 pure GO = 8 server
(pool/lease/queue views) + 12 extras (read-only, idempotent, or host-local).
49 + 20 = 69. Every other line is byte-identical.

## 7. `profile_trace`: decided NOT GO-trivial in P0

`xctrace record --device <udid>` mechanically accepts real-device UDIDs, which
makes `profile_trace` the tempting single-verb carve-out. P0 still fail-fasts
it (P3), for three reasons:

1. **Consistency over cleverness.** Every other device-touching verb fail-fasts;
   one silent pass-through breaks the "real lease ⇒ phase-named errors" contract
   operators will rely on.
2. **Unhandled preconditions.** Real-device tracing needs pairing/trust,
   Developer Mode, and template availability that differ from sims; P0 has no
   surface to report those failures actionably. A raw xctrace stderr is exactly
   the confusing error P0 exists to prevent.
3. **Cheap promotion path.** `XCTrace.record` (`src/xctrace.ts:62-87`) already
   takes a bare udid — P3 promotes this verb by deleting one guard line plus
   pairing preconditions. Documented here as the first P3 GO candidate.

## 8. Constructing `kind=real` (tests + live observability)

### 8.1 Tests: store-level construction (no new API)

Real leases are built by writing directly to the `Store` — the same seam
every orchestrator test already uses (`Store.load(tmpState())`,
`test/orchestrator.test.ts:50-62`). Documented recipe (no production helper;
production code must not grow test-only surface):

```ts
const store = Store.load(tmpState());
const realLease: Lease = {
  leaseId: "lease_test_real", udid: "REAL-UDID-1",
  sessionId: "s1", client: "vitest",
  createdAt: Date.now(), lastHeartbeat: Date.now(), ttlMs: 60_000,
  deviceKind: "real", transport: "usb",
};
await store.mutate((s) => { s.leases.push(realLease); return { value: undefined, dirty: true }; });
// resolveLease(realLease.leaseId) now returns it (short-circuit, §5);
// requireSimLease(realLease, { verb: "ui_tap", phase: "P2", detail: "…" }) throws.
```

Public `lease_acquire(device_kind: "real")` fail-fasts in P0 (P1 owns real
matching), so tests never go through acquire for real leases. Likewise,
hand-built real *tickets* never dispatch (`matches` returns false, §2) — by
design; P1 wires the real fleet into `dispatchLocked`.

### 8.2 Live observability (cheap, honest, env-gated)

Two Chamges, both additive:

1. **Echo** (free): `lease_list`, `sessions_list`, `queue_status` serialize the
   stored records, so `deviceKind`/`transport` are visible live the moment a
   real lease exists. No handler changes.
2. **Experimental hatch** (~20 lines in `Orchestrator.acquire`,
   `src/orchestrator.ts:302-370`): when `SIM_MCP_REAL_LEASE=1` (precedent: the
   injectable-env gate pattern, `src/debug-robustness.ts:19-25`) AND
   `requirements.deviceKind === "real"` AND an explicit `requirements.udid` is
   given, create a real-kind lease directly: no fleet lookup, no boot, no slim,
   no baseline capture, no auto-stream (a `stream: true` request becomes a
   warning, following the `maybeStartStream` precedent,
   `src/orchestrator.ts:796-817`). Missing-udid → fail ("experimental real
   leases require an explicit udid"); gate off → the standard P1 fail-fast (§6.1).

This makes every §6 error observable end-to-end against a live daemon with no
mocking, and P1 deletes the hatch when real matching lands. If reviewers judge
even this too much surface, drop (2): the design stands on (1) + store-level
tests.

## 9. Change list (implementation order)

1. `src/devicekind.ts` (new): `DeviceKind`, `DeviceTransport`, `deviceKindOf`,
   `isRealLease`, `requireSimLease`, `allowRealLease(env)` gate.
2. `src/store.ts`: `Requirements` + `Lease` fields (§2); `Store.load`
   normalization (§3).
3. `src/uidriver.ts` (new): `UiDriver` + moved option types; `src/axe.ts`:
   re-export types, `implements UiDriver`.
4. `src/appops.ts` (new): `AppOps` + moved `LaunchResult`; `src/simapps.ts`:
   re-export, `implements AppOps`.
5. `src/server.ts`: `ServerDeps.axe: UiDriver`; acquire schema
   `device_kind`/`transport`; 8× `requireSimLease` in `ui_*`; holder-kind
   branches in `sim_shutdown`/`sim_slim`.
6. `src/extras.ts`: `ExtrasDeps.simApps: AppOps`; `leaseGate` real-holder
   branch; holder lookups in `camera_mirror`/`sim_log_*`; `requireSimLease`
   after `resolveLease` in stream/app/trace/debug/net-mutating verbs per §6.
7. `src/orchestrator.ts`: `matches` kind line; `resolveLease` short-circuit;
   acquire real-branch (fail-fast + env-gated hatch); `createLease`/dispatch
   kind passthrough; release-path stream-skip for real.
8. `src/index.ts`: no changes (concrete classes still injected; interfaces are
   compile-time). Verify by build.

Non-goals (explicitly untouched): `CHANGELOG.md`, `package.json` version,
`FleetOps`/`StreamOps`/`ProxyOps`/`CaptureOps`/`DebugOps` shapes,
`SimLog`/`XCTrace`/`Llmdb`/`NetProxy`/`NetCapture` internals, any real backend.

## 10. Test plan

Conventions (observed): no vitest config (defaults), `test/*.test.ts` with
`vitest` imports, stub runners (`test/stream.test.ts`), `FakeFleet implements
FleetOps` (`test/orchestrator.test.ts:9-44`), tmp state files
(`test/orchestrator.test.ts:50-52`). No test today exercises MCP tool handlers
directly (`createMcpServer` appears in zero test files), so P0 tests target the
same seams: pure helpers + classes. Smallest focused new files:

1. `test/devicekind.test.ts`
   - `Store.load` on a fixture state file WITHOUT `deviceKind` yields leases
     with `deviceKind === "sim"` (migration default-to-sim, §3).
   - `deviceKindOf`/`isRealLease`: explicit sim, explicit real, missing (≡ sim).
   - `requireSimLease`: no-op for sim; throws for real with message containing
     verb, lease id, udid, and phase — table-driven over one verb per group
     (ui/app/debug/stream/net/sim-only/acquire) asserting the §6 phase mapping.
2. `test/real-failfast.test.ts`
   - Store-built real lease (§8.1) + `Orchestrator.resolveLease` returns it
     (short-circuit) while a sim lease for an unknown udid is still evicted
     (sim path unchanged).
   - `acquire({ requirements: { deviceKind: "real" } })` → `{ ok: false }`
     with P1 text; with `SIM_MCP_REAL_LEASE=1` + explicit udid → real lease
     (hatch); hatch without udid → fail.
   - `matches` unit coverage via acquire-against-fake-fleet: real-kind
     requirements never match sim devices.
3. `test/seams.test.ts`
   - Compile-time conformance: `const _u: UiDriver = new Axe({ runner: stub })`,
     `const _a: AppOps = new SimApps({ runner: stub })` (mirrors the
     `FakeFleet implements FleetOps` precedent), plus one stub-runner
     delegation call each (e.g. `button`, `launch`) proving the interface
     routes to the real implementation.
   - `StreamOps` unchanged: existing `test/stream.test.ts` covers it; no new test.

Verification gates (all must pass, in order): focused new tests →
`npx vitest run` (full sim suite green) → `npm run build` → `npm run
typecheck` (strict + `noUncheckedIndexedAccess`, `tsconfig.json`). No commit.

## 11. Risks

- **Error-text coupling.** Tests asserting exact strings make P1 renames noisy;
  mitigate by asserting substrings (verb, phase token, lease id) not full text.
- **Hatch lifetime.** The §8.2 env hatch must die in P1 (real matching replaces
  it); leaving it would let unvalidated real leases bypass pairing. Tracked as
  P1 acceptance criterion.
- **`camera_status`/`camera_stop`/`debug_detach`/capture-verb GO calls.** Each
  rests on "trivially correct no-op/view" (§6 rule of thumb). If review prefers
  uniform fail-fast for all device verbs, flip them to `sim-only`/P3/P4 — one
  line each, no design change.
