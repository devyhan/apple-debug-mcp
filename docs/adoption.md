# Adoption baseline (2026-10-26)

First measurement from the P1 toolcall telemetry
(`~/.apple-debug-mcp/toolcalls.jsonl`, one `{t, tool, ok}` line per
`tools/call`, names only by design; resource/prompt reads are kind-tagged
by the P3 instrumentation and never touch tool lines).

## Sample

256 rows over 2026-10-22 → 10-26. Effectively one heavy day: 10-25
carries 229 rows (live-verification day), 10-22/10-23/10-26 carry
1/2/24. Kind split: 254 tool, 1 resource (`quickstart`), 1 prompt
(`log-triage`).

## Core loop (top tools, all ok unless noted)

| Calls | Tool |
| --- | --- |
| 77 + 1 err | `ui_describe` |
| 37 + 1 err | `ui_tap` |
| 36 | `ui_screenshot` |
| 21 | `app_launch` |
| 15 / 14 | `lease_acquire` / `lease_release` |
| 14 | `ui_swipe` |
| 11 | `pool_status` |

The lease → drive → release loop is the whole story. Error rate is
5/256 (2.0%), scattered across 5 tools with no cluster:

| Time | Tool | Disposition |
| --- | --- | --- |
| 10-23 06:52 | `ui_describe` | isolated, cause unrecoverable (see below) |
| 10-25 15:46 | `ui_tap` | isolated, cause unrecoverable |
| 10-25 15:59 | `debug_attach` | D1 live-verification window (Golfzon_QA attach exceeds llmdb's ~10s DAP wait; documented in D1 STATUS) |
| 10-25 16:00 | `debug_continue` | same window (continue-with-no-stop before the wait-elapsed guard; closed behind `SIM_MCP_DEBUG_ROBUSTNESS=1`) |
| 10-25 16:20 | `app_terminate` | matches documented behavior (fails on a non-running app) |

Post-hoc cause analysis is limited on purpose: telemetry logs names
only, and `daemon.log` is short-lived (today's boot only, no
timestamps). The two debug errors independently corroborate the D1
gaps the research already closed behind the gate.

## Unused surface

Zero calls in this window: proxy (`net_proxy_*`, `map_*`,
`net_assert_flow`), packet capture, streaming, `ui_triage` (shipped
today — too new to judge), `profile_trace`, camera, `sim_slim`,
`debug_*` beyond attach/break/continue, and 2 of 3 quickstart
prompts. No need was observed for these in 4 days; that is not a
defect signal. The quickstart resource + 1 prompt read show the P3
surface is at least discoverable.

## Telemetry precision (verified)

- `instrumentToolcalls` wraps `registerTool` only; resource/prompt
  lines come from the separate P3 wrapper with `kind` tags
  (`src/toolcalls.ts`, `src/quickstart.ts:124-148`).
- Scratch runs set `SIM_MCP_TOOLCALLS=0` and leave no rows (verified
  after every P1/P2/D1/T1/T2 live probe).
- Appends are best-effort and never throw; argument values are never
  logged.

## Verdict + re-measure triggers

Adoption is healthy where need exists: the core loop dominates, errors
are rare and explained, and P1–P4 removed the known friction (trigger
descriptions, chaining hints, quickstart, router, minimal lease path).
No data-justified code change falls out of this sample — the unused
tail awaits real need, not more surface.

Revisit when any of these trips: rows pass 1000; any tool's error
rate exceeds 10%; the same tool errors 3+ times in a day; or a new
slice (e.g. the D1 gate flip) needs before/after numbers.
