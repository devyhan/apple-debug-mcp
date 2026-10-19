# Security

- **Lease-gated mutation.** UI, apps, profiling, streaming, debugging, and the
  proxy all require the holding `lease_id`; cross-lease calls fail naming the
  holder. Only one proxy holder exists across all leases.
- **sudo is narrow and explicit.** Host proxy control needs passwordless sudo
  for exactly four `networksetup` subcommands — `-setwebproxy`,
  `-setsecurewebproxy`, `-setwebproxystate`, `-setsecurewebproxystate` —
  always as `sudo -n` (never interactive). Reads (`-listallnetworkservices`,
  `-getwebproxy`/`-getsecurewebproxy`) need no sudo. Nothing is checked or
  changed at daemon boot, because every `-set*` mutates host state;
  `net_proxy_start` fails with a sudoers-setup hint when authorization is
  missing.
- **Rules validate before any host change.** A bad rule is rejected without
  touching host networking.
- **Host-wide proxy warning.** While the proxy is on, all host web traffic
  (including other apps' background traffic) flows through mitmdump, and
  intranet sites on a private CA may break until stop/restore. Keep it on only
  as long as the test needs. The mitm CA stays in the simulator keychain after
  stop (harmless without the proxy; full removal is
  `xcrun simctl keychain <udid> reset`).
- **No silent destructive actions.** `doctor` is read-only (no `--fix`);
  restart refuses under active leases; hand-edited plists need `--force`;
  local-only mode exists because process-scoped interception
  (`mitmdump --mode local:…`) needs a manually approved macOS System Extension
  and is unverifiable in unattended environments, so only host mode ships.
- **Localhost only by default.** The daemon binds `127.0.0.1:3100`; the MCP
  endpoint has no authentication, so do not rebind it to a shared interface.

To report a vulnerability privately, see [SECURITY.md](../SECURITY.md).
