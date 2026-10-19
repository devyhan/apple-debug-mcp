# Security policy

This daemon drives simulators on the Mac it runs on, can rewrite host web
traffic while its intercept proxy is on, and serves unauthenticated localhost
HTTP. A bug here is not an inconvenience, so please report one privately rather
than in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/devyhan/apple-debug-mcp/security/advisories/new)**
(Security tab → Report a vulnerability). It is private to the maintainers until
an advisory is published.

If that is unavailable to you, open a public issue saying only that you have a
security report and how to reach you — no details.

**Please do not include real credentials or real data.** No sudoers files, no
keychain exports, no provisioning profiles, no app binaries, and no device logs
carrying personal data. A redacted reproduction is enough; if a real value is
genuinely load-bearing, say so and we will arrange somewhere to put it. Anything
pasted into an issue or an advisory comment is retained even after editing.

Expect an acknowledgement within a few days. This is a volunteer project with no
paid support, so a fix may take longer than an acknowledgement — you will be told
which is happening. Credit in the advisory is offered unless you decline.

## In scope

Anything that lets someone reach further than the holding lease allows, or that
reaches the host beyond what the operator consented to:

- **Escaping the lease gate.** A simulator-driving tool reachable without the
  holding `lease_id`, or a cross-lease call that succeeds instead of failing
  naming the holder.
- **Proxy overreach.** Host proxy changes outside the four documented
  `networksetup -set*` subcommands, any change made at daemon boot rather than
  inside `net_proxy_start`, or a stop path that leaves the host proxy on.
- **Silent destructive actions.** A `launchd` or `install` path that overwrites
  a hand-edited file without showing a diff and requiring `--force`.
- **Daemon exposure.** Anything that binds the unauthenticated MCP endpoint
  beyond localhost by default, or that logs request bodies carrying app data.
- **Supply chain.** A dependency or build step that could introduce any of the
  above.

## Out of scope

- **The helper CLIs themselves.** Vulnerabilities in simslim, AXe, serve-sim,
  llmdb, mitmproxy, or the Xcode toolchain belong to those projects.
- **An operator who ignores the proxy warning.** While the intercept proxy is
  on, all host web traffic flows through mitmdump by design. Keep it on only
  as long as the test needs.
- **Anything requiring an attacker who already has your machine.** The daemon
  stores lease/queue state as plain JSON in your home directory. That protects
  against nothing except forgetting; it is documented as such.
- **A model calling a tool the user did not want.** A model deciding to shut
  down a simulator when you asked something else is a client-side authorization
  question. A tool that *lies* about whether it mutates is in scope; a tool
  honestly labelled and then invoked is not.

## What this daemon does with your data

It runs simulators on your machine and returns the results. There is no service
in between: no telemetry, no analytics, no crash reporting, and no network
destination other than the localhost daemon port. The only thing written to disk
is lease/queue state and the daemon log, in your own home directory.

## Supported versions

Pre-1.0. Fixes land on the latest release only. Once 1.0 ships, this section will
name a support window.
