# Instructions for AI agents

If you are an AI assistant working with this daemon, follow these rules. They
are the short form of the README's lease, queue, and proxy sections.

```
1. There is exactly one shared daemon. Never start a per-session server — the pool and queue would not be shared. If /health is unreachable, say so instead of working around it with direct simctl.
2. Pass your tool's session ID as session_id with a client label so sessions_list shows who runs where.
3. A wait ticket is normal. Poll queue_status; do not boot simulators out of band to skip the line.
4. Only the holding lease may call that lease's gated tools. On a holder-mismatch error, stop and report the holder — do not retry with force=true unless the user asked for preemption.
5. Renew long work with lease_heartbeat before the TTL (default 30 min) expires.
6. Release with lease_release when done. Release hands the simulator over booted — shut it down with sim_shutdown only if the task needs it stopped.
7. Turn the proxy and streams off when done: net_proxy_stop, stream_stop. Both cost host-wide resources while on.
8. One debug session per lease: re-attaching replaces the old session. Call debug_detach when done debugging (even if you keep the lease); release also stops it.
```

- There must be exactly one shared daemon. Never start a per-session stdio
  server — the pool and queue would not be shared. If `/health` is unreachable,
  say so instead of working around it with direct `simctl`.
- Pass your tool's session ID as `session_id` with a `client` label so
  `sessions_list` shows who runs where. The server does not enforce the format.
- A wait ticket is normal. Poll `queue_status`; do not boot simulators out of
  band to skip the line.
- Only the holding lease may call that lease's gated tools. On a
  holder-mismatch error, stop and report the holder — do not retry with
  `force=true` unless the user asked for preemption.
- Renew long work with `lease_heartbeat` before the TTL (default 30 min)
  expires; expired leases are reclaimed and redispatched.
- Release with `lease_release` when done. Release hands the simulator over
  booted — shut it down with `sim_shutdown` only if the task needs it stopped.
- Turn the proxy and streams off when done: `net_proxy_stop`, `stream_stop`.
  Both cost host-wide resources while on.
- One debug session per lease: re-attaching replaces the old session. Call
  `debug_detach` when done debugging (even if you keep the lease); release
  and TTL expiry also stop it.
