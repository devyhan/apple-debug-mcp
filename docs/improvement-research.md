# Improvement Research (2026-10-21)

Source: deep-research workflow on measured conclusions from iPhone 17 Pro +
Golfzon_QA (`com.qa.golfzon.app`) live verification (debugger breakpoints,
proxy response tampering, nickname rewrite). Three research tracks + critic +
synthesis; repo cites verified against file bodies.

## 0. Measured gaps (input)

1. `debug_attach` succeeds but the session starts STOPPED; calling
   `debug_interrupt` then times out and the guard auto-stops the session.
2. `debug_break` is file+line only (llmdb 0.2.0); on a third-party binary it
   stays `verified:false` — no symbol/address breakpoints.
3. `debug_continue` with no further stop times out and auto-stops the session
   (app keeps running).
4. Proxy response-body rewrite verified byte-exact via curl through mitmdump.
5. App fetched tampered version JSON but UI unchanged; forceupdate tamper never
   refetched (app-side throttle/cache).
6. Flow log records `{ts,method,url}` only; deleted on proxy stop;
   `net_assert_flow` matches stale flows across `set_rules` restarts.
7. Notices screen not found via AX; binary obfuscated; personalized endpoints
   need unknown version/session headers.

## P1. Proxy observability (`src/netproxy.ts`)

External API: mitmproxy `request(flow)` / `response(flow)` hooks receive
HTTPFlow; `flow.request.{method,pretty_url,headers,content}`,
`flow.response.{status_code,headers,content}` available; setting
`flow.response` in `request()` skips upstream AND `response()` still fires.
Sources: <https://docs.mitmproxy.org/stable/api/events.html>,
<https://docs.mitmproxy.org/archive/v5/addons-scripting/>

### P1a. Flow-log enrichment (in `buildAddon`, netproxy.ts:384-488)

1. Two-phase rows correlated by flow id: request row in `request()` +
   response row in `response()`, joined by `flow.id` (standard HTTPFlow attr;
   OPEN PROBE: verify against bundled mitmdump interpreter — system python3
   lacks the mitmproxy module). Fallback key: `(method,url,ts)`.
2. Response row fields: `status_code`, `resp_bytes`, `content_type`,
   `req_bytes`, `matched_rule` (change `_find` to return `(index,rule)`,
   netproxy.ts:433), `applied[]` (which action fields fired:
   status/headers/body/map_local/map_remote/request.*), `rewritten:bool`.
3. Headers: allowlist values (`content-type`, `content-length`,
   `cache-control`, `etag`, `location`) + names-only for the rest; redact
   values for denylist (`authorization`, `cookie`, `set-cookie`, `*-token`,
   `*-secret`).
4. Bodies: `flow.request.content` / `flow.response.content` (decompressed when
   not streamed; this addon never sets stream so content is present), cap 8KB
   with `truncated:true`, utf-8 errors=replace; skip non-text content-types
   (record sha + bytes only). PII scrub on JSON string values.
5. `error(flow)` hook row `{error: str(flow.error)}` so failed flows
   (DNS/TLS/upstream-refused) are distinguishable from never-requested.
6. Extend `FlowRecord` (netproxy.ts:78) with optional fields + `parseFlowLog`
   (netproxy.ts:490) tolerant parsing (old 3-field rows still parse).

DECISION (parent): metadata rows (status/bytes/rule/applied) ON by default
(tiny, safe); body capture OFF by default behind env gate (PII risk).
Plumb the flag via the addon template (RULES/FLOW_LOG precedent), not env
inheritance, unless spawn env passthrough is verified.

### P1b. Flow-log lifecycle

Mirror the pcap pattern (netcapture.ts:272, extras.ts:1462-1463 "stays on disk
until next capture overwrites").

1. Stop deleting `flowLogPath` in teardown (netproxy.ts:1005-1011);
   truncate/roll at next start instead (already truncates at :763).
2. Per-run files `flow-{port}-{runId}.jsonl` (`runId` = start timestamp); keep
   last 5 per port (rotation in `startProxy`); return archived path from
   `stopProxy`; expose `last_flow_log_path` in `net_proxy_status` (status
   currently drops `flow_log_path` when stopped, extras.ts:1399-1414; keep a
   lastRun record on the class after teardown).
3. Size cap: addon-side check (file > 10MB -> stop body capture, keep metadata
   rows).

## P2. `net_assert_flow` correctness (netproxy.ts:884-918, extras.ts:1519-1572)

1. ts watermark (no addon change, fixes stale-match immediately): capture
   `Date.now()` at assert start; match only rows with `ts*1000 >= startTs`
   (same-host clock as addon's `time.time()`). Add `since:'call'|'run'`
   param; default `'call'`.
2. Generation watermark (robust across `set_rules` restarts): ActiveProxy
   gains `ruleGeneration++` in `applyRules` (:933); `buildAddon` embeds
   generation, stamps each row; `assertFlow` filters `row.gen == current`
   unless `since_run` requested. Alternative minimal fix: `applyRules`
   appends a `{"marker":"rules-reloaded","ts"}` row; `assertFlow` filters
   after the last marker (opt-out flag keeps old behavior).
3. Response-side assertions on enriched rows: optional `status`, `min_bytes`,
   `body_regex`, `rewritten`, `rule` params in `AssertFlowSpec` (:85-94) +
   zod schema (extras.ts:1524-1549); matched rows already returned (:1567).
4. Timeout semantics: return `matched:[]` + `total` on timeout (already does)
   plus `new_since_call` count so callers distinguish "old flows exist" from
   "nothing new".

## D1. Debug robustness (`src/extras.ts`, `src/llmdb.ts`)

1. interrupt-on-STOPPED and continue-with-no-stop both funnel into
   `withDebugTimeoutGuard` auto-stop (extras.ts:216-235). llmdb verb inventory
   has no state query, so: add a TS-side "assume stopped after attach, skip
   interrupt" guard (return informative ok instead of timeout+auto-stop), and
   distinguish wait-elapsed from wedged-timeout before auto-stop.
   OPEN PROBES (need live llmdb JSON): exact attach response
   state/stopReason field names; exact interrupt-on-already-stopped
   stderr/exit behavior (for the fast-path matcher); exact
   `continue --wait N` response when wait elapses with no stop (normal
   no-stop reply vs exec-kill timeout — determines guard fix shape).
2. Symbol breakpoints are an llmdb-CLI gap, not a protocol gap: DAP has
   `setFunctionBreakpoints` and lldb-dap supports it + disassemble
   (<https://github.com/microsoft/debug-adapter-protocol/blob/main/overview.md>).
   OUT OF SCOPE for this repo (upstream llmdb feature or direct DAP needed).
   Until then, third-party-binary breakpoints stay `verified:false`; tamper
   work stays on the proxy path.
3. OPEN PROBE: lldb-dap exception filter ids served through llmdb
   (`objc_throw`/`cpp_throw`/`swift_*` — needs `llmdb break exception` with no
   args on a live session).

## T1. `app_cache_clear` tool (no logout)

New tool in `SimApps` (simapps.ts — natural home; no `get_app_container`
usage exists yet) + registration in extras.ts.

Implementation: terminate app -> `simctl get_app_container <udid> <bundle>
data` -> delete `Library/Caches/*` (+ optional targeted throttle plist
keys; never touch Documents/Keychain so login survives) -> report deleted
paths/count (leave relaunch to caller). MUST terminate first: cfprefsd
caches make live plist edits unreliable. Refuse empty bundle id; lease-gated
(udid from lease). Validated pattern, low risk.

NO-CODE-CHANGE alternatives (procedures, for the record): cache-busting
request mutation via existing `request.url` rewrite (netproxy.ts:287-290) or
`map_remote` (netproxy.ts:862-877); response `Cache-Control:no-store`
injection via existing response-headers rewrite (netproxy.ts:339) — one probe
decides HTTP-cache vs in-memory/UserDefaults throttle.

## T2. Hidden/webview screens (procedures, no code)

- WKWebView DOM is a single AX element unless the app marks it up
  (<https://fbidb.io/idb/fbsimulatorax/>). Notices screen needs
  screenshot-diff or JS-bridge introspection, not AX search.
- Screenshot-first fallback: axe screenshot + coordinate tap/scroll +
  re-describe (axe.ts:66-94 already supports all three).
- WebInspector path (MEDIUM, gated): iOS 16.4+ needs
  `webView.isInspectable=true`; check Mac Safari Develop menu against the
  booted sim. If inspectable: ios-webkit-debug-proxy / inspect-webkit via sim
  socket `com.apple.webinspectord_sim.socket`. If not, closed without app
  cooperation — do not invest further.
- Traffic-to-screen mapping: with header capture, identify notice/section
  endpoints, `map_local` a tampered payload to force a badge/route, deep-link
  via `app_open_url` (simapps.ts:43-47) if the app registers schemes.

## Open probes (need live runs)

1. Exact llmdb attach/interrupt/continue JSON shapes (D1).
2. `flow.id` in bundled mitmdump interpreter (P1a correlation).
3. mitmdump `-s` addon reload without restart (repo restarts child in
   `applyRules`, netproxy.ts:933-936; upstream hot-reload only via controller
   commands — not pursued).
4. Response-body capture cost on large media flows (size-cap design proposed,
   unmeasured).
5. Whether Golfzon_QA honors HTTP Cache-Control (likely in-memory/UserDefaults
   throttle — one no-store probe decides).
6. App WKWebView `isInspectable` (Safari Develop menu check).
7. Exact GZ_SESSION_ID transport (header vs cookie vs body) — answered by
   header capture once P1a runs.
