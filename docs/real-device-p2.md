# Real devices — P2 slice A: `app_open_url` + `app_cache_clear`

Scope: `RealDeviceApps.openUrl` + `RealDeviceApps.clearCache` ONLY (real
path; sim path behavior-identical). Slice A of P2; `ui_*` (P2),
`stream_*`/`debug_*` (P3), `net_*` mutating (P4) are untouched.

## 1. `app_open_url` — GO for http(s), P2 for other schemes

Real path (`src/realdevices.ts` `RealDeviceApps.openUrl`):

```
xcrun devicectl device process launch --device <udid> --payload-url <url> com.apple.mobilesafari
```

- Transport: devicectl `--payload-url` (documented in
  `devicectl device process launch --help`, 518.33). Options precede the
  bundle positional: trailing positionals are app argv and would swallow a
  `--payload-url` placed after the bundle.
- Target: Safari `com.apple.mobilesafari` (verified live via
  `devicectl device info apps --include-all-apps`). Default `--activate`
  foregrounds it, matching `simctl openurl` behavior.
- Validation mirrors the sim (`Invalid udid/url/scheme`, no spawn).
- Failures go through `devicectlError`: missing Xcode names the install
  steps, pair/trust failures get the checklist, device-side text is kept
  verbatim — a device failure never claims a missing binary.

Scheme split (honest — hardware has no stock-handler dispatch CLI):

- `http:`/`https:` → Safari launch above. Note: a user-changed default
  browser is NOT honored (devicectl needs an explicit bundle).
- Anything else (`myapp:`, `tel:`, …) → precise P2
  (`APP_OPEN_URL_NON_HTTP_DETAIL`): devicectl needs an explicit target
  bundle, and go-ios 1.3.2 has no openurl verb (only
  Remote-Automation-gated `ios webinspector launch <url>`).

Live-verified end-to-end 2026-10-22 on a paired iPhone 16 Pro Max:
`openUrl(https://www.apple.com)` → devicectl success, Safari running
(confirmed via the listRunning join). Payload-URL delivery itself is
inferred from devicectl success, not pixel-verified.

## 2. `app_cache_clear` — still P2, now with a measured reason

No honest non-destructive container-delete transport exists for
third-party apps (`APP_CACHE_CLEAR_NO_TRANSPORT_DETAIL`). Measured live
on a paired iPhone 16 Pro Max (read-only probes, 2026-10-22):

| Probe | Result |
| --- | --- |
| `ios file ls --app=<3rd-party>` | `ContainerLookupErrorDomain ErrorCode:3` |
| `ios fsync tree --app=<3rd-party>` | `VendContainer denied (InstallationLookupFailed)` — "Full container access requires an app installed with a developer profile" |
| `devicectl device info files --domain-type appDataContainer` | `CoreDevice.ActionError error 3` (file list denied) |
| `devicectl device copy` | to/from only — no delete verb |

`ios fsync rm --r` exists but is gated on a developer-profile install
(untestable without a dev-signed app + a write op — out of scope) and
its flag mapping (`--path` vs `--srcPath/--dstPath`) is ambiguous in
help text. Uninstall+reinstall would wipe Documents and log out,
violating the no-logout contract, so it is NOT used as a pseudo-clear.

Inputs are still validated first (`Invalid udid/bundle_id`, no spawn)
so malformed calls fail identically on both lease kinds.

## 3. Handler routing

Both tool handlers (`src/extras.ts`) now route via `appsFor(lease)`
instead of the `requireSimLease` fail-fast: sim leases get `SimApps`
(unchanged calls), real leases get `RealDeviceApps`. The stale
`APP_REAL_NO_TRANSPORT_DETAIL` ("neither devicectl nor go-ios provides
one") is deleted — it was false for open-url once measured.

## 4. Verification

- Failing-test-first: 6 new `test/realdevices.test.ts` cases failed on
  the P1 stubs, then passed after the fix.
- `npm run build`, `npm run typecheck`, full `vitest run` green.

## 5. Carried gaps (unresolved)

- ~~End-to-end `devicectl … Safari --payload-url` open~~ — RESOLVED
  2026-10-22 (live-verified, §1).
- `ios webinspector launch` preconditions (Remote Automation, tunnel,
  `--bundle-id` default) — help text only.
- `ios fsync rm --r` on a developer-profile-installed app (needs a
  dev-signed test app + a write op).
- Uninstall keychain-persistence / reinstall data-loss semantics.
- `devicectl copy to --remove-existing-content=true` pseudo-clear —
  speculative, still dev-profile-gated.
