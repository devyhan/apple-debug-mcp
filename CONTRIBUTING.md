# Contributing

Thanks for looking. This is a small project and issues are welcome even when you
have no fix in mind.

## Getting set up

```
git clone https://github.com/devyhan/apple-debug-mcp.git
cd apple-debug-mcp
npm install
npm test
```

That is the whole setup. **The unit test suite needs no macOS-only toolchain,
no booted simulator, and no network** — every helper binary and every network
wait is stubbed. If a change you make requires a live simulator or a credential
to test, that is a signal the change is in the wrong layer.

| Command | What it does |
| --- | --- |
| `npm test` | Builds (via `pretest`), then runs the suite. This is the one to run. |
| `npm run typecheck` | Types only, no emit. |
| `npm run build` | Compile to `dist/`. |
| `npm run smoke` | Live E2E against real simulators. Needs macOS + Xcode + simslim/axe. |

`npm run smoke` is separate from `npm test` on purpose: it depends on Xcode,
simulator runtimes, and helper CLIs we do not control, and your pull request
should not fail because Apple shipped something overnight. CI runs it on main
pushes, weekly, and on PRs labeled `run-smoke` instead.

## Shape of the code

```
src/index.ts       the executable: daemon boot, Streamable HTTP, CLI dispatch
src/server.ts      MCP tool definitions and registration
src/orchestrator.ts acquire/release/dispatch, lease TTL, wait queue
src/store.ts       JSON persistence for leases and queue state
src/simslim.ts     simulator lifecycle via simslim
src/axe.ts         UI automation via AXe
src/servesim.ts    streaming and device helpers via serve-sim
src/simlog.ts      simctl log streaming and history
src/simapps.ts     app lifecycle via simctl
src/xctrace.ts     profiling via xctrace
src/llmdb.ts       debugging via the llmdb CLI
src/symbolicate.ts crash symbolication via atos
src/netproxy.ts    HTTPS interception via mitmdump
src/extras.ts      rotation, CoreAnimation flags, memory warnings
src/exec.ts        bounded child-process helper
src/cli.ts         doctor/launchd/install/version subcommands
src/version.ts     single version source (package.json)
src/singleton.ts   daemon lockfile
src/launchd.ts     launchd plist management
src/doctor.ts      read-only environment checks
src/install.ts     client config registration
src/migrate.ts     state migration
```

A tool module never touches daemon singletons directly — lease ownership is
checked at the boundary, which is what keeps the modules testable without a
simulator in the way.

## Adding a tool

1. Put it in the module for its area, or add a module and register it with the
   server.
2. Gate it on the holding `lease_id` if it drives a simulator. A tool that
   accepts any lease (or none) must say so in its description, because the
   lease gate is what keeps two sessions from driving one simulator.
3. Record simulator-affecting calls in `lease_actions` so an operator can see
   who did what.
4. Project the result down. Helper CLIs return far more than a model can read —
   return the fields that answer the question, plus a path when more remains.
5. Write the description for the model, not for a person. If the helper has a
   trap, the description is where it goes.

## Things that will be asked in review

- **Lease gates stay exact.** A new simulator-driving tool takes `lease_id`
  and rejects cross-lease calls naming the holder. `force` flags are for the
  operator, never the default path.
- **Never start a second daemon to work around a busy pool.** The wait queue
  exists for that.
- **No new dependencies** without a reason in the pull request. The dependency
  list is two packages (the MCP SDK and zod) and staying small is deliberate
  for something that runs as a local daemon.
- Match the surrounding style. Comments explain why, not what.

## Commit messages

A short subject line, then a body explaining *why* if it is not obvious. Long,
specific messages are fine and preferred over short vague ones.

## Reporting a bug

Include what you ran, what you expected, what happened, and the output of
`apple-debug-mcp doctor` **with any host-specific paths redacted**.

Never paste simulator keychain material, provisioning profiles, app binaries,
or real device logs carrying personal data into an issue. For anything that
looks like a security problem, see [SECURITY.md](SECURITY.md) and report it
privately instead.

## Licence

Contributions are accepted under the [MIT licence](LICENSE).
