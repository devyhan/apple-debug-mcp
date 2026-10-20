# Usage examples

> "Boot a simulator, hold it, and tap through login."

```json
{ "session_id": "sess-1", "client": "claude-code", "task": "login flow", "device": "iPhone 16" }
```

```json
{ "lease_id": "<from lease_acquire>" }
```

```json
{ "lease_id": "<lease>", "label": "Continue" }
```

That is `lease_acquire`, then `ui_describe`, then `ui_tap` on the named element
(`label` matches the accessibility label; `ui_button` is for hardware buttons
only). Finish with `lease_release`.

> "Record a 10-second Time Profiler trace of the app under test."

```json
{ "lease_id": "<lease>", "duration_sec": 10 }
```

That is `profile_trace`; the result carries the `.trace` path.

> "Rewrite one API response to a fixture file while the test runs."

```json
{ "lease_id": "<lease>", "rules": [{ "match": { "url_regex": "api\\.example\\.com/v1/feed" }, "action": { "map_local": "/tmp/feed.json" } }] }
```

```json
{ "lease_id": "<lease>", "url_regex": "api\\.example\\.com/v1/feed", "min_count": 1 }
```

That is `net_proxy_start`, then `net_assert_flow` to prove the app hit the
endpoint. Stop with `net_proxy_stop` as soon as the test is done.

> "Attach the debugger, break at a line, inspect locals, and detach."

```json
{ "lease_id": "<lease>", "bundle_id": "com.example.App" }
```

```json
{ "lease_id": "<lease>", "file": "./Sources/App/main.swift", "line": 42 }
```

```json
{ "lease_id": "<lease>" }
```

That is `debug_attach` (exactly one of `bundle_id`/`pid`; `debug_launch`
takes exactly one of a binary path or a `bundle_id` instead), `debug_break`
set, `debug_continue`, then `debug_locals` and `debug_detach` when done.
