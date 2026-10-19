# Troubleshooting

Start with `doctor` — every failure prints its exact fix:

```
apple-debug-mcp doctor
apple-debug-mcp launchd status   # plist present? loaded? /health reachable (which version)?
tail -f ~/.apple-debug-mcp/daemon.log
```

Common failures:

- `/health` unreachable but the plist is loaded: the daemon crashed at boot —
  the log shows why (missing `simslim`/`axe` is the usual cause).
- Port conflict: the daemon exits `10` when the port is taken, `11` when
  another daemon holds the lockfile (generic failures exit `1`). Restart via
  `apple-debug-mcp launchd restart`, never by launching a second daemon.
- `launchd restart` refuses with active leases: wait for release or re-run with
  `--force` (drops in-flight work).
- Hand-edited plist: `create`/`remove` show a diff and refuse without `--force`.
- `install` reports "already installed" on the second run — that is the
  idempotent success path, not an error.
- Optional-tool failure naming `serve-sim`, `llmdb`, or `mitmdump`: install
  that binary (see the README prerequisites); the daemon runs fine without it
  otherwise.
- `debug_attach` refused: the build needs `get-task-allow`, the host needs its
  one-time developer-tools approval, and stock Apple apps always refuse.
- Host proxy left on after a daemon crash (SIGKILL skips cleanup): kill
  mitmdump and switch every service off by hand:

```
pkill -f "mitmdump -p "
networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r svc; do
  svc="${svc#\*}"   # strip the disabled marker
  sudo networksetup -setwebproxystate "$svc" off
  sudo networksetup -setsecurewebproxystate "$svc" off
done
```

Normal shutdown (SIGINT/SIGTERM), `lease_release`, TTL expiry, sweeps, and
external-shutdown detection all restore the snapshot automatically.
