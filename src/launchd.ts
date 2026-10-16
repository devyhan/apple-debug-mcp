import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runner, defaultRunner } from "./exec.js";

export const LAUNCHD_LABEL = "com.sim-orchestration-mcp";
/** Single documented daemon log path for both stdout and stderr. */
export const DAEMON_LOG_PATH = path.join(os.homedir(), ".sim-orchestration-mcp", "daemon.log");
/** Marker comment identifying a plist rendered by `launchd create`. */
export const MANAGED_MARKER = "managed by sim-orchestration-mcp launchd create";

export function plistPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export interface PlistOptions {
  /** Absolute path to the node binary (default: current process.execPath). */
  nodePath: string;
  /** Daemon entry: npm-global bin when installed, else dist/index.js. */
  daemonPath: string;
  /** Working directory for the daemon (repo root). */
  workdir: string;
  /** Extra PATH segments for the daemon environment (homebrew + npm-global). */
  pathDirs: string[];
  port: number;
  host: string;
  logPath: string;
}

/** Render the launchd plist. The managed marker must stay on line 2. */
export function renderPlist(opts: PlistOptions): string {
  const pathValue = [...opts.pathDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const programArgs =
    opts.daemonPath.endsWith(".js")
    ? `    <string>${xmlEscape(opts.nodePath)}</string>\n    <string>${xmlEscape(opts.daemonPath)}</string>`
    : `    <string>${xmlEscape(opts.daemonPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathValue)}</string>
    <key>SIM_MCP_HOST</key>
    <string>${xmlEscape(opts.host)}</string>
    <key>SIM_MCP_PORT</key>
    <string>${opts.port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True when the plist text was rendered by `launchd create` (marker present). */
export function isManagedPlist(text: string): boolean {
  return text.includes(MANAGED_MARKER);
}

/**
 * Minimal line diff for the overwrite guard: lines removed (-) and added (+),
 * order-preserving. Not a full unified diff; enough for a human to confirm.
 */
export function diffPlists(oldText: string, newText: string): string[] {
  const oldLines = oldText.split("\n");
  const newLines = new Set(newText.split("\n"));
  const oldSet = new Set(oldLines);
  const out: string[] = [];
  for (const line of oldLines) {
    if (!newLines.has(line)) out.push(`- ${line}`);
  }
  for (const line of newText.split("\n")) {
    if (!oldSet.has(line)) out.push(`+ ${line}`);
  }
  return out;
}

export interface PreservedEnv {
  port?: number;
  host?: string;
  pathValue?: string;
}

/** Extract SIM_MCP_PORT/HOST/PATH from an existing plist so regen preserves them. */
export function parsePlistEnv(text: string): PreservedEnv {
  const out: PreservedEnv = {};
  const port = text.match(/<key>SIM_MCP_PORT<\/key>\s*<string>(\d+)<\/string>/);
  if (port) out.port = Number(port[1]);
  const host = text.match(/<key>SIM_MCP_HOST<\/key>\s*<string>([^<]+)<\/string>/);
  if (host) out.host = host[1];
  const pathValue = text.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
  if (pathValue) out.pathValue = pathValue[1];
  return out;
}

export interface DaemonPathResolution {
  daemonPath: string;
  /** Set when falling back to dist: callers must print this loudly. */
  fallbackWarning?: string;
}

/**
 * Stable daemon path: prefer the npm-global bin (survives repo moves/rebuilds),
 * fall back to the current dist entry with a loud warning. `SIM_MCP_DAEMON_PATH`
 * overrides both. All inputs injectable for tests.
 */
export function resolveDaemonPath(opts: {
  homeDir?: string;
  distPath?: string;
  exists?: (p: string) => boolean;
  envDaemonPath?: string;
} = {}): DaemonPathResolution {
  const exists = opts.exists ?? fs.existsSync;
  const home = opts.homeDir ?? os.homedir();
  if (opts.envDaemonPath) {
    return { daemonPath: opts.envDaemonPath };
  }
  const globalBin = path.join(home, ".npm-global", "bin", "sim-orchestration-mcp");
  if (exists(globalBin)) return { daemonPath: globalBin };
  const dist = opts.distPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  return {
    daemonPath: dist,
    fallbackWarning:
      `WARNING: npm-global bin not found at ${globalBin}; using ${dist}. ` +
      `The plist will break if this checkout moves. Run \`npm install -g .\` from the repo root for a stable path.`,
  };
}

export interface LaunchdRunOpts {
  runner?: Runner;
  homeDir?: string;
  fetchHealth?: (url: string) => Promise<{ ok: boolean; version?: string }>;
  /** Current dist entry, for daemon-path fallback. Test seam. */
  distPath?: string;
  exists?: (p: string) => boolean;
}

function defaultFetchHealth(url: string): Promise<{ ok: boolean; version?: string }> {
  return fetch(url, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      if (!res.ok) return { ok: false };
      const body = (await res.json().catch(() => ({}))) as { version?: unknown };
      return {
        ok: true,
        version: typeof body.version === "string" ? body.version : undefined,
      };
    })
    .catch(() => ({ ok: false }));
}

export async function isPlistLoaded(runner: Runner, label: string = LAUNCHD_LABEL): Promise<boolean> {
  try {
    const { stdout } = await runner("launchctl", ["list", label], { timeoutMs: 10_000 });
    // `launchctl list <label>` exits 0 and prints the job table only when loaded.
    return stdout.includes(label) || stdout.includes("\"PID\"");
  } catch {
    return false;
  }
}

/** Count active leases in the state file (0 when missing/unparseable). */
export function countLeases(stateFile: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { leases?: unknown };
    return Array.isArray(parsed.leases) ? parsed.leases.length : 0;
  } catch {
    return 0;
  }
}

export interface LaunchdCommandResult {
  exitCode: number;
  output: string;
}

export async function launchdCreate(
  args: { force?: boolean; port?: number; host?: string },
  opts: LaunchdRunOpts = {},
): Promise<LaunchdCommandResult> {
  const runner = opts.runner ?? defaultRunner;
  const home = opts.homeDir ?? os.homedir();
  const plist = plistPath(home);
  const lines: string[] = [];
  const { daemonPath, fallbackWarning } = resolveDaemonPath({
    homeDir: home,
    distPath: opts.distPath,
    exists: opts.exists,
    envDaemonPath: process.env.SIM_MCP_DAEMON_PATH || undefined,
  });
  if (fallbackWarning) lines.push(fallbackWarning);

  // Preserve port/env across regen unless explicitly overridden.
  let port = args.port ?? Number(process.env.SIM_MCP_PORT ?? 3100);
  let host = args.host ?? process.env.SIM_MCP_HOST ?? "127.0.0.1";
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(plist, "utf8");
  } catch {
    existing = null;
  }
  if (existing && args.port === undefined && args.host === undefined) {
    const preserved = parsePlistEnv(existing);
    if (preserved.port) port = preserved.port;
    if (preserved.host) host = preserved.host;
  }

  const pathDirs = [path.join(home, ".npm-global", "bin"), "/opt/homebrew/bin"];
  const rendered = renderPlist({
    nodePath: process.execPath,
    daemonPath,
    workdir: process.cwd(),
    pathDirs,
    port,
    host,
    logPath: path.join(home, ".sim-orchestration-mcp", "daemon.log"),
  });

  if (existing && existing === rendered) {
    return { exitCode: 0, output: `launchd plist already up to date: ${plist}\n` };
  }
  if (existing && !isManagedPlist(existing) && !args.force) {
    const diff = diffPlists(existing, rendered);
    return {
      exitCode: 2,
      output:
        `Refusing to overwrite a hand-edited plist at ${plist}.\n` +
        `Diff of the proposed change:\n${diff.join("\n")}\n` +
        `Re-run with --force to overwrite, or edit the plist by hand.\n`,
    };
  }
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, rendered);
  lines.push(`Wrote ${plist}`);

  // (Re)load via launchctl.
  const loaded = await isPlistLoaded(runner);
  try {
    if (loaded) await runner("launchctl", ["unload", plist], { timeoutMs: 15_000 });
    await runner("launchctl", ["load", plist], { timeoutMs: 15_000 });
  } catch (err) {
    return {
      exitCode: 1,
      output: lines.join("\n") + `\nlaunchctl failed: ${(err as Error).message}\n`,
    };
  }
  lines.push(`Loaded ${LAUNCHD_LABEL} (port ${port}). Logs: ${path.join(home, ".sim-orchestration-mcp", "daemon.log")}`);
  return { exitCode: 0, output: lines.join("\n") + "\n" };
}

export async function launchdRemove(
  args: { force?: boolean },
  opts: LaunchdRunOpts = {},
): Promise<LaunchdCommandResult> {
  const runner = opts.runner ?? defaultRunner;
  const home = opts.homeDir ?? os.homedir();
  const plist = plistPath(home);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(plist, "utf8");
  } catch {
    existing = null;
  }
  if (!existing) return { exitCode: 0, output: `No plist at ${plist}; nothing to remove.\n` };
  if (!isManagedPlist(existing) && !args.force) {
    return {
      exitCode: 2,
      output:
        `Refusing to remove a hand-edited plist at ${plist}.\n` +
        `Re-run with --force, or \`launchctl unload ${plist} && rm ${plist}\` by hand.\n`,
    };
  }
  try {
    if (await isPlistLoaded(runner)) await runner("launchctl", ["unload", plist], { timeoutMs: 15_000 });
  } catch (err) {
    return { exitCode: 1, output: `launchctl unload failed: ${(err as Error).message}\n` };
  }
  fs.rmSync(plist);
  return { exitCode: 0, output: `Unloaded and removed ${plist}\n` };
}

export async function launchdRestart(
  args: { force?: boolean; stateFile?: string },
  opts: LaunchdRunOpts = {},
): Promise<LaunchdCommandResult> {
  const runner = opts.runner ?? defaultRunner;
  const home = opts.homeDir ?? os.homedir();
  const plist = plistPath(home);
  const stateFile =
    args.stateFile ?? process.env.SIM_MCP_STATE_FILE ?? path.join(home, ".sim-orchestration-mcp", "state.json");
  if (!fs.existsSync(plist)) {
    return {
      exitCode: 2,
      output: `No plist at ${plist}. Run \`sim-orchestration-mcp launchd create\` first.\n`,
    };
  }
  const leases = countLeases(stateFile);
  if (leases > 0 && !args.force) {
    return {
      exitCode: 2,
      output:
        `Refusing to restart: ${leases} active lease(s) held (state: ${stateFile}).\n` +
        `Restarting drops in-flight simulator work. Re-run with --force to restart anyway.\n`,
    };
  }
  try {
    await runner("launchctl", ["unload", plist], { timeoutMs: 15_000 });
    await runner("launchctl", ["load", plist], { timeoutMs: 15_000 });
  } catch (err) {
    return { exitCode: 1, output: `launchctl restart failed: ${(err as Error).message}\n` };
  }
  return { exitCode: 0, output: `Restarted ${LAUNCHD_LABEL}\n` };
}

export async function launchdStatus(
  args: { port?: number; host?: string },
  opts: LaunchdRunOpts = {},
): Promise<LaunchdCommandResult> {
  const runner = opts.runner ?? defaultRunner;
  const home = opts.homeDir ?? os.homedir();
  const plist = plistPath(home);
  const port = args.port ?? Number(process.env.SIM_MCP_PORT ?? 3100);
  const host = args.host ?? process.env.SIM_MCP_HOST ?? "127.0.0.1";
  const lines: string[] = [];
  lines.push(`plist: ${plist} (${fs.existsSync(plist) ? "present" : "missing"})`);
  const loaded = await isPlistLoaded(runner);
  lines.push(`loaded: ${loaded ? "yes" : "no"}`);
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth;
  const health = await fetchHealth(`http://${host}:${port}/health`);
  lines.push(
    `/health: ${health.ok ? `reachable${health.version ? ` (version ${health.version})` : ""}` : "unreachable"}`,
  );
  return { exitCode: 0, output: lines.join("\n") + "\n" };
}

export function launchdHelp(): string {
  return [
    "Usage: sim-orchestration-mcp launchd <create|remove|restart|status> [options]",
    "",
    "  create [--port N] [--host H] [--force]  write + load the launchd plist",
    "  remove [--force]                        unload + delete the plist",
    "  restart [--force]                       unload + load (refuses when leases held)",
    "  status [--port N] [--host H]            plist + loaded + /health",
    "",
    "Hand-edited plists are never overwritten or removed without --force.",
  ].join("\n") + "\n";
}
