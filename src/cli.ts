import { doctorHelp, formatDoctorReport, runDoctor } from "./doctor.js";
import { installCommand, installHelp } from "./install.js";
import {
  launchdCreate,
  launchdHelp,
  launchdRemove,
  launchdRestart,
  launchdStatus,
} from "./launchd.js";
import { getVersion } from "./version.js";

export const CLI_COMMANDS = ["launchd", "doctor", "install", "version", "--version", "help", "--help", "-h"] as const;

export function isCliCommand(argv: string[]): boolean {
  return argv.length > 0 && (CLI_COMMANDS as readonly string[]).includes(argv[0]!);
}

export function topLevelHelp(): string {
  return [
    "Usage: apple-debug-mcp [command]",
    "",
    "No command: start the daemon (Streamable HTTP on SIM_MCP_HOST:SIM_MCP_PORT).",
    "",
    "Commands:",
    "  launchd create|remove|restart|status   manage the macOS launchd daemon",
    "  doctor                                 read-only environment + daemon checks",
    "  install --client <list>                register the daemon URL in client configs",
    "  version                                print the daemon version",
    "  help                                   this help",
  ].join("\n") + "\n";
}

function takeValue(args: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  }
  return undefined;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

/** Run a CLI subcommand. Returns the process exit code. Prints to stdout/stderr. */
export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "version" || cmd === "--version") {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(topLevelHelp());
    return 0;
  }
  if (cmd === "doctor") {
    if (hasFlag(rest, "--help", "-h")) {
      process.stdout.write(doctorHelp());
      return 0;
    }
    const checks = await runDoctor();
    const { text, exitCode } = formatDoctorReport(checks);
    process.stdout.write(text);
    return exitCode;
  }
  if (cmd === "launchd") {
    const [sub, ...subArgs] = rest;
    if (sub === undefined || hasFlag(rest, "--help", "-h") || !["create", "remove", "restart", "status"].includes(sub)) {
      process.stdout.write(launchdHelp());
      return sub === undefined ? 0 : 2;
    }
    const force = hasFlag(subArgs, "--force");
    const portRaw = takeValue(subArgs, ["--port"]);
    const host = takeValue(subArgs, ["--host"]);
    const port = portRaw !== undefined ? Number(portRaw) : undefined;
    if (portRaw !== undefined && (!Number.isInteger(port) || (port as number) <= 0)) {
      process.stderr.write(`Invalid --port ${portRaw}\n`);
      return 2;
    }
    const stateFile = takeValue(subArgs, ["--state-file"]);
    const result =
      sub === "create"
        ? await launchdCreate({ force, port, host }, {})
        : sub === "remove"
          ? await launchdRemove({ force }, {})
          : sub === "restart"
            ? await launchdRestart({ force, stateFile }, {})
            : await launchdStatus({ port, host }, {});
    (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
    return result.exitCode;
  }
  if (cmd === "install") {
    if (hasFlag(rest, "--help", "-h")) {
      process.stdout.write(installHelp());
      return 0;
    }
    const clientsRaw = takeValue(rest, ["--client"]);
    if (!clientsRaw) {
      process.stderr.write(`Missing --client. ${installHelp()}`);
      return 2;
    }
    const result = await installCommand(
      {
        clientsRaw,
        dryRun: hasFlag(rest, "--dry-run"),
        status: hasFlag(rest, "--status"),
        remove: hasFlag(rest, "--remove"),
      },
      {},
    );
    (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
    return result.exitCode;
  }
  process.stderr.write(`Unknown command ${cmd ?? "(none)"}.\n${topLevelHelp()}`);
  return 2;
}
