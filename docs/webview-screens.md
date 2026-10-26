# Webview / hidden screens

For screens where `ui_describe` returns chrome but no content (WKWebView
renders as opaque to AX). Three procedures, no code changes.

## Symptom

`ui_describe` lists simulator chrome only. Measured on Safari + apple.com
(2026-10-26 probe): the full hierarchy was 5 nodes — `BackButton
(enabled=false)`, `PageFormatMenuButton`, `TabBarItemTitle
("apple.com")`, `ReloadButton`, `MoreMenuButton` — while the simultaneous
screenshot showed the whole rendered page. Zero web-content nodes.

## A. Screenshot-first fallback

Tool order: `ui_screenshot` → `ui_tap`/`ui_swipe` by coordinates →
`ui_screenshot` → `ui_describe` to confirm state changed.

1. `ui_screenshot` (`lease_id` only; `src/server.ts:637-656`). Returns the
   PNG plus its saved path.
2. Read target coordinates off the image. Tap with `ui_tap` using `x` + `y`
   (`src/server.ts:443-451`); scroll with `ui_swipe` using `start_x`,
   `start_y`, `end_x`, `end_y` (`src/server.ts:562-573`). Coordinates route
   to `axe tap -x/-y` (`src/axe.ts:45-48`) and `axe swipe --start-x ...`
   (`src/axe.ts:74-92`).
3. Screenshot again, then `ui_describe` (`src/server.ts:395-407`) and check
   for a state delta rather than new nodes.

Live proof (same probe): `ui_tap {x:392, y:700}` returned `ok` with
`✓ Tap at (392.0, 700.0) completed successfully` and dismissed a popover;
`ui_tap {x:163, y:306}` followed a "Learn more" link; `ui_swipe
{215,650 → 215,250}` returned `ok`. Re-describe deltas confirmed each
action: `BackButton enabled=false→true` after navigation, and the toolbar
collapsed to a single `TabBarItemTitle` node after the scroll.

## B. WebInspector path

Gated: iOS 16.4+ exposes web content to the inspector only when the app
sets `webView.isInspectable=true`. Current verdicts from the 2026-10-26
probe (sim 401454C3, iPhone 17 Pro, iOS 26.5):

- Inspector socket: PRESENT. `com.apple.webinspectord` exists on-demand
  (`state = not running`) with a live listen socket
  (`com.apple.webinspectord_sim.socket`, `srw-rw-rw-`).
- Host Safari: `IncludeDevelopMenu=1` and
  `WebKitDeveloperExtrasEnabledPreferenceKey=1` already set; Safari.app
  itself was not running.
- Golfzon_QA (`com.qa.golfzon.app`, 매장찾기 screen): NO RUNTIME VERDICT
  yet — static scan found `WKWebView` strings only in embedded
  third-party SDK frameworks, never in first-party code, which says
  nothing about runtime `isInspectable`. Needs the manual check below.

Manual check (human, ~2 min):

1. Open Safari on the Mac (Develop menu already enabled per the defaults
   above; confirm under Safari Settings > Advanced > Show features for
   web developers).
2. Keep the target sim booted with the suspect screen frontmost.
3. Safari menu bar > Develop > Simulator - \<device\>: listed page titles
   mean inspectable webviews; a missing/empty submenu means not
   inspectable. If not inspectable, stop here — no app cooperation, no
   further path.

## C. Traffic-to-screen mapping

Use the proxy to find which endpoints feed the screen, tamper one, and
reach the screen directly.

1. `net_proxy_start` with `lease_id` (and no `rules` for transparent
   capture; `src/extras.ts:1689-1697`). Add `block_quic: true` if the app
   uses QUIC (`src/extras.ts:1698-1704`).
2. Drive the app to the screen, then confirm the endpoint with
   `net_assert_flow` (`lease_id`, `url_regex`, optional `min_count`;
   `src/extras.ts:1928-1944`). Read request/response headers from the
   flow log path in `net_proxy_status` (`flow_log_path` /
   `last_flow_log_path`; `src/extras.ts:1814-1815`); allowlisted header
   values and per-rule `applied[]` are recorded per row
   (`src/netproxy.ts:102-107`).
3. `map_local` with `lease_id`, `url_regex`, `file`
   (`src/extras.ts:2018-2041`) to serve a tampered payload for that
   endpoint. The file must exist and be a regular file or the rule is
   rejected (`src/netproxy.ts:405-417`); at serve time a match returns
   the file as HTTP 200 and a missing file returns 502
   (`src/netproxy.ts:774-781`). Same-pattern maps replace in place,
   otherwise the rule is prepended (first match wins;
   `src/netproxy.ts:1378-1382`). Rule shape: `match: {url_regex?,
   method?}`, `action: {map_local?, ...}` (`src/netproxy.ts:18-58`,
   `src/extras.ts:132-187`); `map_local` and `map_remote` are mutually
   exclusive (`src/netproxy.ts:383-384`).
4. Re-enter the screen via deep link: `app_open_url` with `lease_id` +
   `url` (`src/extras.ts:652-660`), which runs
   `xcrun simctl openurl` (`src/simapps.ts:40-44`). The URL must carry a
   scheme (`src/simapps.ts:15-20`); non-http(s) schemes work only if the
   app registers them.

## Tool/param reference

| Tool/param | Source |
|---|---|
| `ui_describe` (`lease_id`, `x`/`y`, `format`, `max_depth`, `max_chars`) | `src/server.ts:395-407` |
| `ui_screenshot` (`lease_id`) → PNG + path | `src/server.ts:637-656` |
| `ui_tap` (`x`/`y`, `id`/`label`/`value`, `element_type`, `wait_timeout`) | `src/server.ts:443-458` |
| `ui_swipe` (`start_x/y`, `end_x/y`, `duration`) | `src/server.ts:562-574` |
| `axe tap -x/-y`, `axe swipe`, `axe screenshot` | `src/axe.ts:45-48,74-92,118-123` |
| `app_open_url` (`lease_id`, `url`) | `src/extras.ts:652-660`, `src/simapps.ts:40-44` |
| URL scheme requirement | `src/simapps.ts:15-20` |
| `net_proxy_start` (`rules?`, `block_quic?`) | `src/extras.ts:1689-1704` |
| `net_assert_flow` (`url_regex`, `min_count?`, …) | `src/extras.ts:1928-1944` |
| `flow_log_path` / `last_flow_log_path` | `src/extras.ts:1767,1814-1815` |
| `map_local` (`lease_id`, `url_regex`, `file`) | `src/extras.ts:2018-2041` |
| Rule/match/action shapes | `src/netproxy.ts:18-58`, `src/extras.ts:132-187` |
| `map_local` file check; 200/502 serve; prepend/replace | `src/netproxy.ts:405-417,774-781,1378-1382` |
