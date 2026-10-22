# Real devices — P3: screen streaming (wired, single-flight)

Scope: `stream_start`/`stream_stop` on real hardware via supervised
`ios screenshot --stream` (go-ios MJPEG, hardcoded `:3333`). Sim path
byte-identical. Covers `stream_*` only — `debug_*` (P3, upstream-blocked)
and `net_*` mutating (P4) are untouched.

## 1. `stream_*` on real hardware — WIRED single-flight

### 1.1 Design (why single-flight is honest, not broken)

`ios screenshot --stream` binds hardcoded `:3333` — `--port` is
silently ignored (both `--port=18923` and `--port 18923` still bind
`*:3333`, lsof-verified) and a second concurrent start fails
`listen tcp 0.0.0.0:3333: bind: address already in use` (exit 1).
Per-lease ports are therefore impossible against go-ios 1.3.2.

Instead of a per-lease facade that would fail with a cryptic bind
error, the backend is EXPLICITLY single-flight: one real-device
stream per host, a second udid gets a precise busy error naming the
holder, and a foreign `:3333` occupant gets a precise error with an
`lsof -i :3333` hint. The single-client MJPEG itself works fine
(~2.0-2.4fps, ~252KB JPEG frames, 1320x2868 portrait).

### 1.2 Backend: `RealStreamer` (`src/realstream.ts`)

One-class-per-file `StreamOps` implementation over a SUPERVISED
`ios screenshot --stream --udid=<udid>` child (not detached — the
daemon owns stop/shutdown):

- `REAL_STREAM_PORT = 3333`, `REAL_STREAM_URL =
  http://127.0.0.1:3333/`; `startStream`'s `portBase` is accepted and
  ignored (documented — hardcoded port).
- `startStream`: reuse when the tracked child is alive for the same
  udid AND HTTP-live (revalidation respawns a half-dead server);
  busy error naming the holder for a second udid; foreign-port
  error with lsof hint; readiness poll (HTTP 200, 15s budget,
  measured ready in ~1-2s); fail-fast with the helper's stderr tail
  on early exit (e.g. `Device not found: <udid>`, exit 1 — measured
  with a bogus udid, port untouched). Every failed start clears
  state so the next call retries instead of reporting busy.
- `stopStream`: idempotent, udid-scoped (a foreign udid is a no-op,
  the holder survives); SIGTERM + 2s grace, then SIGKILL + 1s.
- `stopAll`: never throws (daemon SIGINT/SIGTERM shutdown path,
  `src/index.ts`, beside the netProxy/netCapture forceStops).
- Liveness consults BOTH `exitCode` and `signalCode`: a node child
  killed by a signal reports `exitCode null` + `signalCode` set
  (measured: SIGTERM ⇒ `EXIT` event `null`/`SIGTERM`, `exitCode`
  stays null forever). Checking `exitCode` alone spins through the
  grace windows and falsely reports "ignored SIGKILL" — this exact
  bug was caught by the live e2e and is pinned by
  `test/realstream.test.ts` (signal-death respawn case).
- Seams for tests: `spawn` / `isPortFree` (exported from
  `src/servesim.ts`, one implementation) / `httpStatus` /
  timeouts / `sleep`.

### 1.3 Orchestrator routing (`src/orchestrator.ts`)

- New optional `realStreamer?: StreamOps` dep (wired in
  `src/index.ts` as `new RealStreamer({ iosBin })`; missing `ios`
  fails at call time with the go-ios install hint, warn-at-boot
  text extended with `stream_start`/`stream_stop`).
- `startLeaseStream`/`stopLeaseStream` branch on
  `deviceKindOf(lease)` via `streamerFor` (real without a backend
  ⇒ `LeaseError("…no real streamer is configured")`; stop without
  one still clears the record).
- Real `acquire stream:true` now auto-starts via `maybeStartStream`
  (failures ⇒ warning, lease stands — same degrade shape as sim);
  real dispatch `stream:true` auto-starts via
  `startDispatchedStream(…, "real")` (failures ⇒ `streamError`).
  The "never auto-stream" P3 placeholders are gone.
- `stopStreamQuiet(udid, kind)` routes teardown on
  release/expire/sweep (sweep collects `{udid, kind}` pairs); the
  `!isRealLease` guards are deleted.
- Handlers (`src/extras.ts`): the `:576`/`:597` P3 gates and
  `STREAM_REAL_DETAIL` are deleted; errors map kind-aware
  (`realStreamError` adds the go-ios hint on `spawn ios ENOENT`,
  `serveSimError` otherwise). `stream_start` description documents
  the single-flight real arm. Sim behavior unchanged.

### 1.4 Probe matrix (`ios screenshot --stream`, go-ios 1.3.2)

Measured 2026-10-22 on the paired iPhone 16 Pro Max
(`00008140-000555603453001C`); port 3333 verified free before/after
(lsof), probe children killed exactly (the unrelated `wda` tmux
session and DeviceKit/tunnel processes untouched).

| Probe | Result (verbatim) |
| --- | --- |
| `ios screenshot --help` | `go-ios 1.3.2`, `Command: screenshot`, `Capture screenshot or stream MJPEG.`, `Usage: ios screenshot [options] [--output=<outfile>] [--stream] [--port=<port>]` (only Global options listed) |
| Startup line | `{"level":"INFO","msg":"starting server, open your browser here","module":"go-ios/instruments","udid":"00008140-000555603453001C","host":"0.0.0.0","port":"3333","url":"http://0.0.0.0:3333/"}` |
| `--udid` selection | HONORED: `--udid=00008140-…` streams that device (12s = 6563832B); bogus udid ⇒ exit 1 `{"level":"ERROR","msg":"Device not found: 00000000-0000000000000000","err":"Device '…' not found. Is it attached to the machine?"}` with `:3333` untouched |
| `--port` flag | IGNORED: `--port=18923` and `--port 18923` both still bind `*:3333` (`ios … TCP *:dec-notes (LISTEN)`); nothing ever listens on 18923 (lsof-verified free before/after) |
| Readiness | `GET /` → `000` at t=1s, `200` at t=2s after spawn (~1-2s; the 15s budget is generous) |
| `GET /` headers | `HTTP/1.1 200 OK`, `Server: go-ios-screenshotr-mjpeg-stream`, `Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString`, `Transfer-Encoding: chunked`, `Cache-Control: no-cache, private`, `Access-Control-Allow-Origin: *` |
| Body framing | `--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: 252385\r\n\r\n<JPEG>` — FFD8 magic at offset 0x46 |
| Rate / size | 5s = 2524736B / 10 frames; 6s = 3027872B / 12 frames; e2e 5s = 2845929B / 12 frames ⇒ ~2.0-2.4fps, ~252KB/frame, ~0.5MB/s |
| Frame dims | JPEG SOF0 1320x2868 portrait |
| CPU | `ios` at 40.7% during 1-client stream |
| Second concurrent `ios screenshot --stream` | Exit 1: `{"level":"ERROR","msg":"failed starting mjpeg","err":"listen tcp 0.0.0.0:3333: bind: address already in use"}` — first server keeps serving, still sole LISTEN on :3333 |
| `HEAD /` | Empty response (GET-stream only; GET works as above) |
| Signal death | SIGTERM ⇒ `EXIT` event `null`/`SIGTERM`, `exitCode` stays `null` forever (`signalCode` set) — liveness must check both (see §1.2) |

### 1.5 Live e2e (`/tmp/e2e-realstream.mjs`, scratch daemon :3210)

Full roundtrip against the new build, 2026-10-22, PASSED with zero
strays (`lsof -i :3333` empty, no `ios screenshot` process after):

1. `lease_acquire device_kind real` ⇒ lease, no `streamUrl`.
2. `stream_start` ⇒ `{url: http://127.0.0.1:3333/, port: 3333}` in
   ~1.1s (1086ms / 1103ms across runs).
3. `GET /` ⇒ 200 + multipart headers; 5s ⇒ 2845929B / 12 frames,
   JPEG magic present.
4. Second `stream_start` ⇒ same URL (reuse, single helper).
5. `stream_stop` ⇒ `stopped: true`, then `stopped: false`
   (idempotent).
6. `lease_release`; `:3333` free, no helper left.
7. Bonus: scratch SIGTERM ⇒ shutdown hook `stopAll` reaped the
   live helper (verified `lsof -i :3333` empty after).

Covered by `test/realstream.test.ts` (20 cases: 11 unit + 9
orchestrator routing, failing-first) plus updated
`test/realacquire.test.ts` (auto-start positive + no-backend
warning/streamError cases). Full suite: 50 files / 753 tests green.

Unblock conditions for per-lease ports (future): upstream go-ios
honors `--port`. Until then the explicit single-flight semantic
above is the contract.
