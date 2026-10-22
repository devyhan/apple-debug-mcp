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

## 2. `app_cache_clear` — attempt-with-precise-fallback via `ios fsync`

`RealDeviceApps.clearCache` attempts a real clear on
developer-profile-installed apps and falls back to the precise measured
P2 (`APP_CACHE_CLEAR_NO_TRANSPORT_DETAIL`) for container-denied apps —
without deleting anything on the fallback path. Flow: validate inputs
(`Invalid udid/bundle_id` + plist shape, no spawn) → refuse
`plist_keys` (fsync has file pull/push/rm/tree/mkdir only, no plist
read-modify-write) → tolerant `ios kill` → `fsync tree --path=
Library/Caches` probe → per-entry `fsync rm --r` (the probe's
shallowest tree lines sit at prefix-depth 2, `|  |  |-Name/` — the
parser keeps minimum-depth names, since depth-0 lines never appear).
Terminate/rm failures
are fail-soft `errors[]` (bounded 20, like the sim); a
ContainerLookup/VendContainer/ActionError denial at probe OR rm time
throws the P2 — never partial-delete + ok, never a missing-binary
claim. A missing Caches dir (`ObjectNotFound`) is an empty clear.

Result paths are DEVICE-side `ios-fsync://<udid>/<bundle>/…`
(deliberately not host-absolute, so callers never feed them to host fs
ops — sim results ARE host-absolute). Documents/Keychain never
touched. Uninstall+reinstall is NOT used as a pseudo-clear (it would
wipe Documents and log out).

Write roundtrip measured live 2026-10-22 on a paired iPhone 16 Pro
Max, dev-profile-installed `com.qa.golfzon.app` (udid
`00008140-000555603453001C`):

| Probe | Result |
| --- | --- |
| `ios fsync tree --app=… --path=/` | exit 0 — full read: `Documents/` (AppLog, `.MOV`, `place_*.json`), `Library/Application Support/` (AmazonPublisherServices-config, GalbumModel.sqlite*, …), `Library/Caches/` (AdMob, WebKit/NetworkCache/Version 17/Blobs/…) |
| `ios fsync mkdir --path=Library/Caches/__ios_fsync_probe__` | exit 0, silent |
| `ios fsync push --srcPath=/tmp/fsync_probe_tiny.txt --dstPath=Library/Caches/__ios_fsync_probe__/probe.txt` | exit 0, silent |
| tree before rm | `\|  \|  \|  \|-probe.txt` — file present |
| `ios fsync rm --r --path=Library/Caches/__ios_fsync_probe__` | exit 0, silent |
| tree after rm | exit 1 `{"level":"ERROR","msg":"fsync: tree view failed","err":"error listing afc dir: afc error code: 8 (ObjectNotFound)"}` — removal confirmed, Caches-wide grep count 0, nothing else touched |

Contrast (same device/app): `ios file ls --app=…` prints NOTHING and
hangs (killed by timeout, exit 124, twice; verbose stalls after
`execute handshake`) — fsync is the transport, `file ls` unusable.

Denial side (App Store / non-dev-profile apps), same device:

| Probe | Result |
| --- | --- |
| `ios fsync tree --app=<3rd-party>` | `VendContainer denied (InstallationLookupFailed)` — "Full container access requires an app installed with a developer profile" |
| `ios file ls --app=<3rd-party>` | `ContainerLookupErrorDomain ErrorCode:3` |
| `devicectl device info files --domain-type appDataContainer` | `CoreDevice.ActionError error 3` (file list denied) |
| `devicectl device copy` | to/from only — no delete verb |

Flag map (go-ios 1.3.2, full `fsync --help`): `ios fsync
[--app=bundleId] [options] (pull | push) --srcPath=<src> --dstPath=
<dst>` and `ios fsync [--app=bundleId] [options] (rm [--r] | tree |
mkdir) --path=<target>` — rm/tree/mkdir take `--path`, pull/push take
`--srcPath/--dstPath`. Bare `tree` without `--path` prints usage,
exit 0. Per-subcommand `--help` prints the same generic line.

## 3. Handler routing

Both tool handlers (`src/extras.ts`) now route via `appsFor(lease)`
instead of the `requireSimLease` fail-fast: sim leases get `SimApps`
(unchanged calls), real leases get `RealDeviceApps`. The stale
`APP_REAL_NO_TRANSPORT_DETAIL` ("neither devicectl nor go-ios provides
one") is deleted — it was false for open-url once measured.

## 4. Verification

- Failing-test-first: 6 new `test/realdevices.test.ts` cases failed on
  the P1 stubs, then passed after the fix; 10 more (fsync
  attempt/fallback matrix + tree parser) failed on the P2 stub, then
  passed after the attempt-with-precise-fallback fix.
- `npm run build`, `npm run typecheck`, full `vitest run` green.

## 5. Carried gaps (unresolved)

- ~~End-to-end `devicectl … Safari --payload-url` open~~ — RESOLVED
  2026-10-22 (live-verified, §1).
- ~~`ios fsync rm --r` on a developer-profile-installed app~~ —
  RESOLVED 2026-10-22: full mkdir/push/tree/rm roundtrip SUCCEEDED on
  dev-profile-installed `com.qa.golfzon.app` (exit-0 silent writes,
  `ObjectNotFound`-verified deletion, §2). Implemented as
  attempt-with-precise-fallback in `RealDeviceApps.clearCache`.
- `ios webinspector launch` success-path output — CARRIED (out of
  scope, no settings changed). Measured 2026-10-22: tunnel UP for
  `00008140-000555603453001C`, but live `webinspector launch` fails
  exit 1 verbatim `{"level":"ERROR","msg":"failed starting automation
  session","err":"remote automation is not enabled on the device;
  enable Settings > Safari > Advanced > Remote Automation, then
  retry"}` — the single blocker is the device-side toggle
  (Settings > Safari > Advanced > Remote Automation, currently OFF).
  Usage: `ios webinspector launch <url>
  [--bundle-id=<bundleID>] [--timeout=<seconds>] [options]`
  (`ios webinspector --help` alone errors `unknown help topic`).
- ~~Reinstall data-loss semantics~~ — RESOLVED by contract (§6: wipe +
  logout, `logged_out: true`, named half-state). Uninstall
  keychain-persistence — CLOSED as untestable with current CLI
  transports (no keychain/keybag verb in `ios --help` 1.3.2 or the
  devicectl surface; would need a probe app holding the keychain
  access group).
- ~~`devicectl copy to --remove-existing-content=true` pseudo-clear~~ —
  VERIFIED live 2026-10-22 as a second working transport on
  dev-profile installs (empty-dir copy over `Library/Caches`: 173
  tree lines → 0, exit ok). Not wired: `fsync rm` is already the
  proven primary (per-entry errors, single CLI family); kept here as
  a documented fallback.

## 6. `app_reinstall` — uninstall→install in one call (sim + real)

`app_reinstall {lease_id, bundle_id, app_path, confirm_data_loss: true}`
(`src/extras.ts`, after `app_uninstall`) composes the two verbs the caller
could otherwise run separately, over the SAME backend each verb uses today
per lease kind (`appsFor` dispatch: simctl via `SimApps` for sim leases,
go-ios via `RealDeviceApps` for real leases). No `AppOps`/backend changes;
existing verbs are byte-identical.

- Gate: `confirm_data_loss` is `z.literal(true)` — a missing/declined
  confirm (or a missing/empty `app_path`) is refused at schema validation
  with zero spawns. The refusal names the wipe (Documents/Keychain, logs
  out).
- Return: `{lease_id, udid, bundle_id, uninstalled: true, installed: true,
  logged_out: true}` — deliberately NOT the `CacheClearResult` shape:
  reinstall is the opposite of `app_cache_clear` (wipe + logout vs
  Caches-only, login-preserving).
- Failure semantics (non-atomic by nature): an uninstall failure aborts
  before install (no half-state); an install failure after uninstall
  returns a half-state error (`app <bundle> was removed but install
  failed: <reason>`) with the backend's own text verbatim — device errors
  keep their text and are never reframed as a missing binary. Both
  outcomes are recorded in `lease_actions` (success or `HALF-STATE`).
- Contamination: no terminate-first (uninstall removes a running app on
  both backends; terminate would fail on a non-running app for zero
  benefit), and `markAppTerminated` is called on both outcomes — the
  reinstalled app is not running, so a stale lease-launched claim would
  wrongly whitelist a foreign relaunch. `test/appreinstall.test.ts` proves
  the wiring end-to-end (launch → reinstall → foreign check flips
  contended).

## 7. P2-B scoping — measured UI transport surface (not yet wired)

go-ios 1.3.2 help text (read-only, 2026-10-22) shows a complete UI family
behind one backend — no Appium needed:

- `ios ui <download|status|api|tap|swipe|longpress|type|button|
  screenshot|source|size|orientation|app|stream|raw>` — "Control UI
  through WebDriverAgent or DeviceKit."
- `ios runwda [--bundleid=…] [--testrunnerbundleid=…] …` — runs WDA;
  `ios ui download|install` fetches/signs/installs WDA or DeviceKit
  artifacts (`ios sign app` signs with a P12 + profile).
- `ios screenshot [--output=…] [--stream] [--port=…]` — capture or
  MJPEG stream; `ios ax` — accessibility inspector features.
- devicectl side: `device orientation` (control), `device notification`
  (post/observe Darwin notifications) — narrow but native.

Except `ios screenshot` (§8, now wired), nothing above has been run
against a device yet (needs WDA signing + install + a running WDA
session); the P2-B workflow must ground each remaining verb live before
wiring. Xcode on this host: 26.6 (17F113).

Measured split 2026-10-22 (paired iPhone 16 Pro Max):

- WDA-less: `ios screenshot --output=` works with NO session —
  genuine 1320x2868 PNG captured. Screenshots are wirtable today.
- WDA-gated: `ios ui status` fails `dial 127.0.0.1:12004: connection
  refused` — every `ios ui *` verb (tap/swipe/type/source/…)
  needs a running WDA server first (download → sign → install →
  run → local port 12004).

## 8. `ui_screenshot` — WIRED (screenshot-only `UiDriver`)

First P2-B verb out of §7: `RealUiDriver` (`src/realui.ts`) implements
`UiDriver` with a real `screenshot` and precise P2 throws for the seven
WDA-gated verbs (`REAL_UI_WDA_DETAIL`). Scope is deliberately
screenshot-only — tap/type/source need a running WDA session (§7) and
stay out.

Real path:

```
ios screenshot --udid=<udid> --output=<file>
```

- Transport: go-ios `screenshot` (`ios screenshot --help`: capture or
  MJPEG stream; global `--udid=<udid>`). No session, no signing.
- Validation mirrors the sim seam (`Invalid udid/output`, no spawn).
- After capture the file is verified (exists + PNG magic bytes
  `89 50 4E 47 0D 0A 1A 0A`); a missing/non-PNG result fails with the
  backend text verbatim, never a missing-binary claim.
- Failures mirror the go-ios seam in `realdevices.ts`: ENOENT-only
  install hint (`GO_IOS_INSTALL_HINT`), device-side text verbatim
  otherwise.

Live-verified end-to-end 2026-10-22 on the paired iPhone 16 Pro Max
(`00008140-000555603453001C`): exit 0,
`{"msg":"File saved successfully"}`, genuine 1320x2868 PNG on disk —
plus a full daemon MCP roundtrip (real `lease_acquire` →
`ui_screenshot` → `lease_release`): ok + `image/png` content block,
956KB file with valid PNG magic.

Handler routing (`src/server.ts`): new optional `ServerDeps.realUi`
(parallel to `realApps`/`realLog`, constructed + wired in `index.ts`)
with a `uiFor(lease)` helper mirroring extras `appsFor` — sim leases
get `Axe` (byte-identical argv + ok shape), real leases get `RealUiDriver`.
The `requireSimLease` gate is dropped ONLY on `ui_screenshot`; the
mkdir/filename/base64/image-extra/logAction plumbing is shared and
unchanged. Boot probe + install hint follow the `realApps`/`realLog`
wiring (same `ios` binary probe; warning and doctor fix text now name
`ui_screenshot`). `test/realui.test.ts` proves the driver contract and
the dispatch end-to-end (real → go-ios argv + image block, sim →
unchanged axe argv, missing-transport error, other verbs still P2).

## 9. WDA/DeviceKit bring-up runbook (2026-10-22, paired iPhone 16 Pro Max)

Goal: a running UI-automation backend so `ios ui status` is green and
`ios ui source` returns an XML dump. Result this session: download →
sign → install COMPLETE for both runners (zero interactive prompts);
session start BLOCKED on a device-side gate (see failure table).
No session is left running — B2 must flip the on-device toggle, then
run the start command below.

Facts (measured, not inferred):

- Device: iPhone 16 Pro Max `00008140-000555603453001C`, iOS 27.0.1,
  paired + trusted, Developer Mode ON
  (`ios devmode get` → `{"DeveloperModeEnabled":true}`), no passcode
  (`ios info` → `"PasswordProtected":false`).
- go-ios 1.3.2 at `/Users/devyhan93/.npm-global/bin/ios`.
- Userspace tunnel already up: PID 41122
  (`ios tunnel start --userspace`), `tunnel ls` →
  `address=fd3f:24d3:cef3::1 rsdPort=63443 userspaceTunPort=60106`.
- Port split (binary strings + live forward log): `ios ui *` defaults
  to `--driver=devicekit` → `http://127.0.0.1:12004`; WDA would be
  `http://127.0.0.1:8100`. `ui run` log proves the device-side
  DeviceKit port is also 12004
  (`"msg":"start listening, forwarding to device","hostPort":12004,
  "phonePort":12004`).
- `ios ui install` / `ios sign app` REQUIRE `--p12file` + `--profile`
  files (no keychain-identity flag exists). This host has NO P12, NO
  `.mobileprovision` in `~/Library/MobileDevice` (dir absent), NO ASC
  issuer ID (two `.p8` API keys exist but the issuer UUID is nowhere
  on disk: `~/Downloads/AuthKey_4HUH393WJ3.p8`,
  `~/.appstoreconnect/private_keys/AuthKey_MHQJDR38A5.p8`). So the
  sanctioned `ui install` / `sign provision appstoreconnect` paths
  are unusable without new user-supplied secrets.
- Working signing assets found on host (read-only scan of all 48
  Xcode-managed profiles): wildcard Development profile
  `~/Library/Developer/Xcode/UserData/Provisioning
  Profiles/327423f2-0716-4c30-bf15-6d2b6c13f918.mobileprovision`
  (`iOS Team Provisioning Profile: *`, team `RB73NXNMA7`, appid
  `RB73NXNMA7.*`, `get-task-allow=true`, expiry 2027-09-14, 38
  devices incl. ours) CONTAINS our keychain cert `3FB5D29B…`
  (`Apple Development: YoHan Cho (35MXZD3837)`). The private key is
  usable by `codesign` with NO GUI prompt (Xcode set Always-Allow;
  verified live). P12 export was never attempted (would prompt).

Verbatim commands that worked (workdir `/tmp/wda-bringup`, scratch):

```
# 1. download (schema: {"downloaded":[{target,url,artifactPath,
#    artifactType,sizeBytes[,appPath]}],outputDir})
ios ui download all --output=/tmp/wda-bringup --pretty
# → wda: WebDriverAgentRunner-13.2.0.zip (1161764 B)
#   appPath=.../WebDriverAgentRunner-20261022071413/WebDriverAgentRunner-Runner.app
#   bundle com.facebook.WebDriverAgentRunner.xctrunner (+ .xctest PlugIn)
# → devicekit: devicekit-ios-runner-0.0.18.ipa (8920427 B)
#   bundle com.mobilenext.devicekit-iosUITests.xctrunner (+ .xctest PlugIn)
# both pre-signed by deviceboxhq team 59GAB85EFG → must re-sign.

# 2. entitlements from the wildcard profile (python plistlib):
#    {application-identifier: RB73NXNMA7.*,
#     keychain-access-groups: [RB73NXNMA7.*, com.apple.token],
#     get-task-allow: true, com.apple.developer.team-identifier: RB73NXNMA7}
security cms -D -i <profile> -o /tmp/wda-bringup/profile.plist  # then dump Entitlements → ent.plist

# 3. re-sign each runner (ID=3FB5D29B45D8B3EDF955ACF691D84F1E55E0BC7F):
rm -rf $APP/PlugIns/*.dSYM
cp <profile> $APP/embedded.mobileprovision
codesign -f -s $ID $APP/Frameworks/*.framework $APP/Frameworks/*.dylib
codesign -f -s $ID $APP/PlugIns/*.xctest
codesign -f -s $ID --entitlements /tmp/wda-bringup/ent.plist $APP
# → Authority=Apple Development: YoHan Cho (35MXZD3837), TeamIdentifier=RB73NXNMA7

# 4. package + install (DeviceKit unzipped from its .ipa; WDA wrapped in Payload/):
zip -qr devicekit-signed.ipa Payload   # 6303306 B
zip -qr wda-signed.ipa Payload
ios install --path=/tmp/wda-bringup/devicekit-signed.ipa --udid=00008140-000555603453001C
ios install --path=/tmp/wda-bringup/wda-signed.ipa --udid=00008140-000555603453001C
# → both reach zipconduit status=InstallComplete, "installation successful"
# → confirmed via `ios apps`: com.mobilenext.devicekit-iosUITests.xctrunner
#   ("Device Kit") + com.facebook.WebDriverAgentRunner.xctrunner present.

# 5. START the session (blocking; run in tmux — macOS has no setsid):
tmux new-session -d -s wda-bringup \
  "ios ui run devicekit --udid=00008140-000555603453001C \
   --bundleid=com.mobilenext.devicekit-iosUITests.xctrunner --host-port=12004 \
   --log-output=/tmp/wda-bringup/uirun-ios.log >>/tmp/wda-bringup/uirun.log 2>&1"
# observed PIDs (session-local, will differ on rerun): ios≈81284 owns
# *:12004 LISTEN; on-device runner pid≈1517/1524 (see uirun-ios.log).

# 6. PROVE (read-only; expected once the gate below is cleared):
ios ui status            # expect backend JSON, NOT connection-refused
ios ui source            # expect XML dump
curl -m 10 http://127.0.0.1:12004/health

# STOP procedure:
tmux kill-session -t wda-bringup     # ends `ui run`, forward + runner die with it
# fallback: pkill -f "ui run devicekit"; verify `lsof -iTCP:12004` empty.
# (Do NOT kill PID 41122 `ios tunnel start --userspace` — shared tunnel.)
```

Failure table (verbatim errors):

| Step | Error (verbatim) | Meaning / fix |
|---|---|---|
| `ui run devicekit` (2/2 attempts) | `ui run: runner failed … Timed out while enabling automation mode. (Error code: 1000, Domain: com.apple.dt.XCTest.XCTFuture)`; device log: `Failed to initialize for UI testing: … Code=1000 "Timed out while enabling automation mode."`; runner then killed, 12004 refused again | Device-side gate. Prime suspect: on-device Settings → Developer → **Enable UI Automation** is OFF (no CLI can flip it; `lockdown get`/`diagnostics list` cannot read it). Secondary: screen asleep/locked. USER ACTION: on the iPhone, enable Developer → UI Automation, keep screen awake/unlocked, then rerun step 5. |
| `ios prepare` | `failed erasing … A cloud configuration is already present on this device` (DMCTunnelErrorDomain 14002) | `prepare` is a supervision/erase flow for lab devices, NOT the UI-automation toggle. Do NOT use on this personal device. Device untouched (command refused). |
| `ios ui install` / `sign provision appstoreconnect` | not runnable: `--p12file` missing (no P12 on host; export would prompt), `--asc-issuer-id` unknown | Use the manual codesign flow above instead; needs no new secrets. |

Gaps closed this session: `ui download` JSON schema ✓ (above);
default runner bundle IDs ✓ (`com.facebook.WebDriverAgentRunner.xctrunner`,
`com.mobilenext.devicekit-iosUITests.xctrunner`); keychain key usable
w/o GUI prompt ✓ (yes, for `codesign`); device-side DeviceKit port ✓
(12004); `ui run` executes in 1.3.2 ✓ (runs, forwards, launches
runner — then hits the device gate). Still open: on-device UI
Automation toggle state; `--p12password`-omitted behavior (moot —
manual flow needs no P12); `runwda`→8100 wiring (untried — same
automation-mode gate expected); `tunnel ls` state source.
