# Real devices — P4: network interception (design)

Scope: `net_proxy_*` / `net_assert_flow` / `map_*` on real hardware.
Sim path byte-identical. P4-S1 verdict: NOTHING runnable lands —
every traffic-bearing path needs on-device manual steps with no
programmatic API, so all five mutating verbs stay P4-gated with a
sharpened detail naming the measured blockers.

## 1. P4-S1: seam map + probe matrix + verdict

### 1.1 Seam map (as built, sim-only)

Proxy side:

- `ProxyOps` (`src/netproxy.ts:160-173`): `startProxy` /
  `setProxyRules` / `stopProxy` / `proxyStatus` / `proxyRules` /
  `assertFlow` / `upsertMapRule`. `NetProxy` ctor opts
  (`src/netproxy.ts:1199-1222`): `MITMDUMP_BIN`, `NETPROXY_PORT_BASE`
  (default 3240), CA pem `~/.mitmproxy/mitmproxy-ca-cert.pem`,
  workdir `tmp/sim-mcp-netproxy`.
- Provisioning order (`src/netproxy.ts:1254-1357`): rules+CA
  validation → `findFreePort` → `snapshotHost` (networksetup reads,
  no sudo) → `simctl keychain add-root-cert` (:1274, sim-only CLI)
  → addon+flowlog write → `mitmdump -p -s` spawn (no
  `--listen-host` flag: binds 127.0.0.1) → TCP ready-wait →
  `sudo -n networksetup setwebproxy/setsecurewebproxy` LAST.
  QUIC via PF anchor `com.apple/apple-debug-mcp.quicblock`.
- Orchestrator: `opts.proxy?: ProxyOps` (`src/orchestrator.ts:175,
  195`), injected in `src/index.ts:63-67,172`; mutex-guarded
  start/set/stop/assert/upsert/status (:1149-1262) pass
  `found.udid` straight through; `stopProxyQuiet` on
  release/sweep/expire (:1269-1278); `forceStop` on shutdown
  (`src/index.ts:301`).
- Gates (`src/extras.ts`, detail `NET_REAL_DETAIL` at :35):
  `net_proxy_start` :1613, `net_proxy_set_rules` :1638,
  `net_assert_flow` :1877 (gates on the holder lease),
  `map_local` :1933, `map_remote` :1988. `net_proxy_stop`
  (:1648-1672) and `net_proxy_status` (:1674-1718) are UNGATED by
  design (idempotent stop / read-only global view) — safe but
  useless on a real lease.
- Single global holder (`ProxyBusyError`): correct for the sim
  path (host proxy toggle is host-wide) but wrong-shaped for
  real-device mode, where each device would point at the host
  directly and one mitmdump per lease/port could run.

Capture side (reference; verbs already GO-unchanged):

- `CaptureOps` (`src/netcapture.ts:91-98`); `net_capture_start`
  (:1720-1754) / `stop` (:1756-1783) / `status` (:1785-1816) use
  `resolveLease` ONLY — no P4 gate. `udid` is status metadata.
- Host `tcpdump` on a host MAC interface (default-route `en0`)
  cannot see iPhone radio/USB traffic; only Mac-routed traffic
  (Internet Sharing / device proxy → Mac) is visible. The P0
  tool-description caveat for this is still absent (docs-only
  follow-up, not P4-S1).

### 1.2 Probe matrix (read-only, this host, 2026-10-22)

| Probe | Result (verbatim) |
| --- | --- |
| `sudo -n true` | FAILS — no passwordless sudo; daemon capture + QUIC PF anchor unusable on this host today |
| `rvictl -l` (rvictl 1.3.0, `/Library/Apple/usr/bin/rvictl`) | `Could not get list of devices` (needs-root vs no-device ambiguous without sudo) |
| `ifconfig -l` | no `rvi*` interface present |
| devicectl | iPhone 16 Pro Max available (paired) via coredevice.local, network transport, UUID `000A1FED-…` |
| USB profiler | NO iPhone — device is Wi-Fi-only, not USB-attached |
| UDID mapping | classic lockdown UDID `00008140-…` (rvictl form) vs coredevice UUID mapping unresolved in-repo |
| READY | mitmdump 12.1.1, tcpdump binary, mitm CA (+cert/p12), `ios` 1.3.2, daemon healthy, repo clean |
| MISSING | RVI interface, passwordless sudo, `.mobileconfig` packaging (none exists), RVI/USB-capture design (absent from docs) |

### 1.3 Verdict: no zero-manual-step sub-slice (implement nothing)

`net_proxy_*` / `map_*`: every traffic-bearing path requires (a)
iPhone Wi-Fi proxy → host LAN IP:port — a device network-settings
change (the phone cannot use the Mac loopback the current spawn
binds) — and (b) CA profile install + Settings > General > About >
Certificate Trust Settings enablement, both on-device user actions
with no programmatic API and forbidden to the agent by the
live-device safety rule (no settings/profile changes). The
host-only rules/addon/flow-log/assert engine is reusable code but
produces zero observable interceptions until those steps happen.

`net_capture_*` RVI alternative (`rvictl -s <USB-UDID>` → `rvi0`,
`tcpdump -i rvi0`, `rvictl -x` teardown): partially
daemon-automatable in shape, but blocked on USB-attached+trusted
(one-time Trust tap is itself a device-side manual step; current
device is Wi-Fi-only), passwordless sudo for rvictl/tcpdump
(absent: `sudo -n true` FAILS), and the classic-UDID resolver
(unresolved). `rvictl -s` also mutates host network state.

Therefore: all five mutating verbs stay P4-gated; `stop`/`status`
and the capture verbs keep their current (ungated) behavior; sim
path byte-identical. Pinned by `test/real-p4-gate.test.ts`
(failing-first: gate detail names `Wi-Fi proxy`, `Certificate
Trust Settings`, `add-root-cert`, `127.0.0.1`, `sudo -n true`).

### 1.4 Unblock conditions (future P4 work)

Proxy path:

1. USER (on-device, manual): set iPhone Wi-Fi proxy to host LAN
   IP:port; install the mitm CA profile and enable it under
   Certificate Trust Settings.
2. DAEMON: new `src/realproxy.ts` `RealNetProxy implements
   ProxyOps` (no `ProxyOps` change): skip keychain+networksetup,
   spawn mitmdump with `--listen-host 0.0.0.0` on a scanned port,
   return `{port, lanIp, caPemPath}` + manual-step checklist;
   orchestrator picks the backend by `deviceKindOf(lease)`
   (mirroring `appsFor`/`logFor`, `src/extras.ts:225-242`) or
   injects a `realProxy` ctor dep (precedent:
   `realFleet`/`realApps`/`realStreamer`); per-backend
   `ProxyBusyError` (or per-port map); `.mobileconfig`
   packaging for the CA step.
3. Relax the gates at `src/extras.ts:1613/1638/1877/1933/1988`
   once the backend lands.

RVI path:

1. USB-attached+trusted device; passwordless sudo provisioned for
   `rvictl`/`tcpdump`; classic-UDID resolver
   (`xctrace list devices` / `devicectl details` output).
2. DAEMON: supervised `rvictl -s`/`-x` lifecycle around the
   existing `NetCapture` with `interface=rvi0`, reusing the
   holder/mutex/teardown seams.
