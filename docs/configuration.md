# Configuration

How to point an MCP client at the daemon, and every environment variable.

`install` writes Streamable-HTTP URL entries only. Shapes verified against the
real configs on macOS:

```json
{
  "mcpServers": {
    "apple-debug": { "type": "http", "url": "http://127.0.0.1:3100/mcp" }
  }
}
```

Claude Code (user scope, `~/.claude.json` → `mcpServers`); manual equivalent:

```
claude mcp add -s user --transport http apple-debug http://127.0.0.1:3100/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.apple-debug]
url = "http://127.0.0.1:3100/mcp"
```

Muse (`~/.config/muse/settings.json` → `mcpServers`):

```json
"apple-debug": { "type": "streamable-http", "url": "http://127.0.0.1:3100/mcp" }
```

Preview or inspect without writing:

```
apple-debug-mcp install --client codex,muse --dry-run  # preview the change
apple-debug-mcp install --client all --status          # registration status only
```

Unknown client names fail as "Unsupported" without touching any file. Every
edited config is backed up to `<config>.bak-sim-mcp` first (created once, never
overwritten).

`install` writes user scope only. Project scope could point sessions at
different daemons and split the pool — one shared daemon is the premise.

## Defaults

- Daemon path: the npm-global bin (`~/.npm-global/bin/apple-debug-mcp`) first,
  falling back to the checkout's `dist/index.js` with a loud warning.
  `SIM_MCP_DAEMON_PATH` overrides both.
- Log: `~/.apple-debug-mcp/daemon.log`, stdout and stderr combined.
- State: `~/.apple-debug-mcp/state.json` (leases/queue), lockfile
  `daemon.lock` beside it.
- The CLI never pings the npm registry. The local `package.json` is the only
  version source.

## Environment variables (all optional)

| Variable | Default | Description |
| --- | --- | --- |
| `SIM_MCP_HOST` / `SIM_MCP_PORT` | `127.0.0.1` / `3100` | Listen address |
| `SIM_MCP_STATE_FILE` | `~/.apple-debug-mcp/state.json` | Lease/queue persistence file |
| `SIMSLIM_BIN` / `AXE_BIN` | `simslim` / `axe` | Binary paths |
| `SERVE_SIM_BIN` | `serve-sim` | serve-sim binary path (optional dependency) |
| `LLMDB_BIN` | `llmdb` | llmdb binary path (optional dependency) |
| `MITMDUMP_BIN` | `mitmdump` | mitmdump binary path (optional dependency) |
| `TCPDUMP_BIN` | `tcpdump` | tcpdump binary path (optional dependency, ships with macOS) |
| `SERVE_SIM_PORT_BASE` | `3220` | First port scanned for per-lease stream helpers |
| `NETPROXY_PORT_BASE` | `3240` | First port scanned for the lease-held proxy listener |
| `SIM_MCP_MAX_SIMS` | `0` (uncapped) | Cap on concurrently booted simulators; excess waits |
| `SIM_MCP_LEASE_TTL_MS` | `1800000` (30 min) | Lease survival without a heartbeat |
| `SIM_MCP_SWEEP_MS` | `60000` (60 s) | Lease/queue sweep interval |
| `SIM_MCP_EXEC_TIMEOUT_MS` | `60000` (60 s) | Helper child-process timeout |
| `SIM_MCP_BOOT_TIMEOUT_MS` | `600000` (10 min) | Simulator boot timeout |
| `SIM_MCP_SCREENSHOT_DIR` | `$TMPDIR/sim-mcp-shots` | Screenshot storage |
| `SIM_MCP_DAEMON_PATH` | _(unset)_ | Override the daemon entry the plist launches |
