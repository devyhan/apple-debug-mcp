# M4 Design: Gated Autonomous Taps (v1)

Autonomous navigation-only taps behind layered env gates. Default posture:
everything OFF / dry-run, zero behavior change unless an operator opts in twice
(master gate ON **and** dry-run explicitly disabled).

## 1. Scope (v1, user-confirmed)

Autonomous taps allowed only for navigation-only taps on:

1. Settings app main-screen rows,
2. General -> About screen rows,
3. Home screen app-icon taps.

Explicitly EXCLUDED: off-screen rows (scroll needed), text inputs,
toggles/switches, dynamic or 403 screens, coordinate taps, `value` /
`element_type` selector taps.

## 2. Request model

New optional `ui_tap` param `auto` (boolean, default absent/false):

- `auto` absent/false -> manual path, byte-identical behavior to today.
- `auto: true` -> M4 evaluation (Section 5). Pass -> tap proceeds (unless
  dry-run); fail -> deny response, no tap, manual path untouched.

Master gate OFF (`SIM_MCP_M4` unset, the default) means the `auto` flag does
not exist: it is ignored and the tap proceeds manually. Rationale: the
mandatory convention "OFF = zero behavior change" forbids a new deny path
when the gate is off.

## 3. Env vars + defaults

| Var | Default | Enabled/parse rule |
|---|---|---|
| `SIM_MCP_M4` | OFF (unset) | enabled iff `=== "1"` (mirrors `isShadowEnabled`, `src/shadow.ts:47-49`) |
| `SIM_MCP_M4_DRY_RUN` | ON | dry-run iff `!== "0"`; only exact `"0"` disables |
| `SIM_MCP_M4_FRESHNESS_MS` | `30000` | positive int; unparseable/<=0 -> fallback `30000`, never throws (unlike `config.ts:33-39` `num()`, which throws) |
| `SIM_MCP_M4_FILE` | unset | explicit audit file; wins over dir resolution |
| `SIM_MCP_M4_DIR` | `os.tmpdir()/sim-mcp-m4` | audit dir |
| `SIM_MCP_M4_ALLOWLIST_FILE` | unset | custom allowlist JSON; unset -> built-in v1 (Section 4) |

Read per call (one env lookup each) so tests can toggle, per the
M1/M3 precedent (`src/snapshot.ts:47-49`, `src/shadow.ts:47-49`).

Defense in depth is deliberate: enabling `SIM_MCP_M4=1` alone can never
produce a real autonomous tap; the operator must also set
`SIM_MCP_M4_DRY_RUN=0`.

## 4. Allowlist format + v1 entries

```ts
interface M4AllowlistEntry {
  /** Documentary screen tag; also logged in the audit record. */
  screen: "settings-main" | "settings-about" | "home";
  /** Exact AX label match (case-sensitive). */
  label: string;
  /** Optional exact AXUniqueId match; checked only when present. */
  id?: string;
}
```

Matching: exact string equality on `label` (+ `id` when the entry carries
one). No substrings, no case folding, no regex. Enforcement is membership
in this set; uniqueness on the live screen is enforced by the predictor
(ambiguous match -> abstain -> deny, `src/eval-baseline.ts:86-88`), which is
what keeps a short label like "General" safe.

Custom file (`SIM_MCP_M4_ALLOWLIST_FILE`): JSON array of entries. Parse
failure or wrong shape -> deny-all (fail closed); the audit record notes
`allowlist: "invalid"`.

V1 built-in entries (`V1_ALLOWLIST` in `src/m4-allowlist.ts`):

```ts
// settings-main: push-style navigation rows only (no toggles/inputs).
{ screen: "settings-main", label: "General" },
{ screen: "settings-main", label: "Display & Brightness" },
{ screen: "settings-main", label: "Wallpaper" },
{ screen: "settings-main", label: "Accessibility" },
{ screen: "settings-main", label: "Battery" },
// settings-about: back navigation only. About rows are display-only
// (Name opens a text input -> excluded; Version/Model rows are static).
{ screen: "settings-about", label: "General" }, // back button to General
// home: single bootstrap icon.
{ screen: "home", label: "Settings" },
```

Caveat (must verify per Section 8): AX labels vary by iOS version and
locale. Every entry must be confirmed against a fresh `ui_describe` on the
target sim before `DRY_RUN=0`; dry-run audit lines are the verification
vehicle.

## 5. Gate evaluation

`evaluateM4(input, predictor?)` in `src/m4.ts` (new file). Pure decision
besides reading its own fresh-cache; never throws (catch-all -> deny).
Order (fail-fast, first failure is the recorded `reason`):

1. **Fresh describe.** Same-lease cache entry exists and
   `Date.now() - entry.t <= freshnessMs`. Reasons: `no-describe`, `stale`.
2. **Predictor non-abstain.** `ExactMatchShadowPredictor` (reuse via the
   `ShadowPredictor` interface, `src/shadow-predictor.ts:12-23`) over the
   cached UI with the request `{label?, id?}` query. `abstain` for any
   reason (`no-match`, `ambiguous`, `invalid-ui`, `empty-query`,
   `src/eval-baseline.ts:25-29`) -> deny, reason `abstain:<reason>`.
   Coordinate-only taps carry an empty query and always deny here.
3. **Allowlist.** Request selector matches a v1 (or custom-file) entry ->
   else deny, reason `not-allowlisted`.
4. **Dry-run.** If dry-run is on (the default), convert allow -> deny with
   reason `dry-run` and `wouldTap: true`.

Result: `{ decision: "allow" | "deny", reason, wouldTap, gates: {...} }`.

## 6. Freshness rule

- M4 keeps its OWN timestamped cache (`noteM4Ui(leaseId, ui, describeId?)`,
  `{ui, t: Date.now(), describeId?}` per lease, FIFO cap 1000, head-cap UI
  at 32KB) in `src/m4.ts`. It does not reuse the M3 shadow cache because
  that cache has no timestamps (`src/shadow.ts:65-71`), and editing
  `shadow.ts` would violate "prefer new files".
- Same-session = same `leaseId` key (leases are session-owned).
- Recent = age <= `SIM_MCP_M4_FRESHNESS_MS` (default 30s).
- Only FULL-hierarchy describes refresh the cache. Point describes
  (`x`+`y` present) return element-only payloads that could false-match, so
  the `ui_describe` hook skips them. (M3 caches all describes,
  `src/server.ts:344`; M4 deliberately differs -- documented here.)

## 7. Dry-run semantics

- Default ON: `process.env.SIM_MCP_M4_DRY_RUN !== "0"`.
- Dry-run allow-path: evaluate all gates, append the audit line with
  `decision: "deny", reason: "dry-run", wouldTap: true, tapped: false`,
  merge an `m4: "deny:dry-run"` fragment into `logAction` extra, and return
  the standard deny response. `axe.tap` is never reached.
- Explicit `SIM_MCP_M4_DRY_RUN=0` + decision allow -> tap proceeds; audit
  records `tapped: true` (or `false` if `axe.tap` then throws).
- Dry-run is implemented as the final evaluation gate (Section 5, step 4),
  not a branch in `server.ts`, so there is exactly one deny path.

## 8. Audit JSONL log format + path

Path resolution mirrors `resolveShadowFile` (`src/shadow.ts:56-61`):
`SIM_MCP_M4_FILE` > `dirOverride` > `SIM_MCP_M4_DIR` >
`os.tmpdir()/sim-mcp-m4`, filename `m4-audit.jsonl`. One line per autonomous
request (`auto: true` with master gate ON), appended via node:fs only.

Record (all string echoes scrubbed with `scrubText`, `src/trace.ts:67-69`,
then head-capped at 200 chars per the `SHADOW_ECHO_MAX_CHARS` precedent,
`src/shadow.ts:44`; whole line kept under `TRACE_EVENT_MAX_BYTES` 4096,
`src/trace.ts:28`, with the same oversize fallback shape as
`src/shadow.ts:263-270`):

```json
{
  "t": 1729500000000,
  "leaseId": "lease-abc",
  "tool": "ui_tap",
  "auto": true,
  "query": { "label": "General" },
  "gates": {
    "fresh": { "pass": true, "ageMs": 1200, "describeId": "describe-..." },
    "predict": { "decision": "predict", "target": { "label": "General", "index": 4 }, "confidence": 1 },
    "allow": { "pass": true, "entry": { "screen": "settings-main", "label": "General" } }
  },
  "decision": "deny",
  "reason": "dry-run",
  "dryRun": true,
  "wouldTap": true,
  "tapped": false
}
```

Deny-shape notes: on early gate failure, later gate blocks are omitted
(fail-fast); `predict` failure uses
`{ "decision": "abstain", "reason": "<reason>", "confidence": 0 }` mirroring
`toLogPrediction` (`src/shadow.ts:222-239`).

## 9. Exact integration points in `ui_tap` (`src/server.ts`)

All edits confined to `src/server.ts`; new logic lives in new files.

1. **Schema** (`src/server.ts:358-367`): add
   `auto: z.boolean().optional().describe("Request an autonomous allowlisted tap (M4; ignored unless SIM_MCP_M4=1).")`.
2. **`ui_describe` hook** (`src/server.ts:344`, next to `noteShadowUi`):
   ```ts
   if (x === undefined && y === undefined) noteM4Ui(lease_id, payload, snap?.id);
   ```
   Full-hierarchy only (Section 6). No-op unless `SIM_MCP_M4=1`.
3. **`ui_tap` pre-tap gate** (after `resolveLease`, before `axe.tap`,
   `src/server.ts:387-391`): reuse the existing `shadowQuery`
   (`src/server.ts:382-385`):
   ```ts
   const m4 = maybeM4Decide({ leaseId: args.lease_id, query: shadowQuery, auto: args.auto });
   if (m4 !== null && m4.decision === "deny") {
     appendM4Audit({ leaseId: args.lease_id, query: shadowQuery, ...m4, tapped: false });
     await orch.logAction(args.lease_id, "ui_tap", `tap ${target} denied: ${m4.reason}`.slice(0, 160), { ...selectors, m4: `deny:${m4.reason}` });
     return fail(`m4 denied autonomous tap: ${m4.reason}`);
   }
   ```
   `maybeM4Decide` returns `null` when `auto !== true` or the master gate is
   off -> manual path falls through byte-identical. It never throws
   (catch-all -> deny, so a broken M4 can only block autonomous taps, never
   crash `ui_tap` or alter manual taps).
4. **Allow path**: after `axe.tap` resolves, append the audit line with
   `tapped: true` and merge `m4: "allow"` into the existing `logAction`
   extra spread (`src/server.ts:398-402`). On `axe.tap` throw, the existing
   failure path (`src/server.ts:404-421`) is unchanged; append an audit line
   with `tapped: false` inside the same inner try (never masking the error).
5. **No other tools change.** `ui_type`/`ui_swipe`/`ui_gesture` untouched.

New files: `src/m4.ts` (gates, fresh cache, decision, audit -- mirrors the
single-module M3 precedent `src/shadow.ts`) and `src/m4-allowlist.ts`
(entry type, `V1_ALLOWLIST`, matcher). Zero edits to `shadow.ts`,
`snapshot.ts`, `trace.ts`, `shadow-predictor.ts`.

Trace linkage: `describe_id` in the audit record joins to M1 describe
snapshots when `SIM_MCP_SNAPSHOT=1`; no new linkage mechanism.

## 10. Test plan (`test/m4.test.ts`, vitest)

Mirror the `test/shadow.test.ts:21-56` pattern: save/restore all `SIM_MCP_M4*`
keys per test, `clearM4Ui()` in before/afterEach, tmp dirs for audit output,
tiny AX fixtures.

- **Gate OFF (default):** `maybeM4Decide` returns `null` even with
  `auto: true`; `noteM4Ui` is a no-op; no audit file created.
- **Freshness:** no entry -> `deny:no-describe`; aged entry (inject old `t`
  or tiny `SIM_MCP_M4_FRESHNESS_MS`) -> `deny:stale`; other lease's entry ->
  deny; point-describe hook skipped (call-level: no exported hook for
  pointed describes -- assert via `noteM4Ui` contract test + code review of
  the one-line call site).
- **Predictor:** ambiguous fixture -> `deny:abstain:ambiguous`; no-match ->
  `deny:abstain:no-match`; empty query (coord tap) -> `deny:abstain:empty-query`;
  invalid (non-JSON) UI -> `deny:abstain:invalid-ui`. Injectable fake
  `ShadowPredictor` for determinism.
- **Allowlist:** exact label allow (with `DRY_RUN=0`); wrong case / substring
  / unknown label -> `deny:not-allowlisted`; entry with `id` requires id
  match; custom-file override loads; malformed custom file -> deny-all.
- **Dry-run:** default (unset) and `"1"` with passing gates ->
  `deny:dry-run`, `wouldTap: true`; exact `"0"` -> `allow`.
- **Audit format:** line parses as JSON; echoes capped at 200 chars; UDID run
  scrubbed to `udid:<12hex>`; line < 4096B (oversize fixture triggers the
  fallback shape); path precedence file > override > env > default.
- **Never-throw:** throwing predictor, unwritable audit dir (point
  `SIM_MCP_M4_DIR` at a file), garbage env values -> deny/null, no throw.
- **Gates:** `npm run typecheck` clean; full `npx vitest run` green.
- **Manual verification (target sim, dry-run):** fresh `ui_describe` on each
  of the 3 screens; confirm every v1 label matches exactly; run
  `auto: true` taps and confirm audit `wouldTap` lines before ever setting
  `DRY_RUN=0`.

## 11. Key decisions (with provenance)

- Two-file split (`m4.ts` + `m4-allowlist.ts`) mirrors the M3 precedent of
  gate+cache+eval+audit in one module (`src/shadow.ts:1-26`) while keeping
  the curated list separately reviewable.
- Reuse `ShadowPredictor`/`ExactMatchShadowPredictor`
  (`src/shadow-predictor.ts:12-23`) and M2 abstain reasons
  (`src/eval-baseline.ts:25-29`) instead of a new predictor: v1 needs
  exact-match only, and abstain-on-ambiguity is a load-bearing safety gate.
- Own timestamped cache rather than extending `src/shadow.ts:65-71`: the M3
  cache has no `t`, and touching it violates "prefer new files".
- `auto` flag ignored (not denied) when the master gate is OFF: required by
  "OFF = zero behavior change".
- Dry-run as final evaluation gate, not a `server.ts` branch: one deny path,
  minimal diff at the `axe.tap` call site (`src/server.ts:388`).

## 12. Verified targets (measured, dry-run audit)

Target: iPhone 17 Pro Max, iOS 26.5, ko-KR locale. Verified 2026-10-21 via
`auto: true` taps with `SIM_MCP_M4=1` (dry-run ON). Every audit line:
`decision: "deny"`, `tapped: false`; all screens confirmed unchanged.

| Screen | Label | Result |
|---|---|---|
| settings-main | `일반` | dry-run allow-path (`wouldTap: true`, target id `com.apple.settings.general`) |
| settings-main | `손쉬운 사용` | dry-run allow-path (target id `com.apple.settings.accessibility`) |
| settings-main | `디스플레이 및 밝기` | `abstain:no-match` -- row off-screen, absent from AX tree (correctly denied) |
| settings-main | `배경화면` | `abstain:no-match` -- row off-screen, absent from AX tree (correctly denied) |
| settings-main | `배터리` | `abstain:no-match` -- row off-screen, absent from AX tree (correctly denied) |
| settings-main | `카메라` | `not-allowlisted` (predicted, then denied at gate 3 -- gate order verified) |
| settings-main | `General` (builtin EN entry) | `abstain:no-match` -- builtin EN list does not match KO sim (fail-closed) |
| settings-about | `일반` (back button) | dry-run allow-path (target id `BackButton`, unique) |
| home | `설정` | dry-run allow-path; Settings NOT launched |
| (coord tap) | -- | `abstain:empty-query` |
| (fresh lease, no describe) | -- | `no-describe` |

`SIM_MCP_M4_DRY_RUN=0` is NOT authorized by this verification: it additionally
requires an operator decision plus an allowlist file carrying the confirmed
per-target labels above. The builtin EN list must not be used on a KO sim.
