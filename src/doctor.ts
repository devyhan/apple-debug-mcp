import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Axe } from "./axe.js";
import { loadConfig } from "./config.js";
import { Runner, defaultRunner } from "./exec.js";
import { isPlistLoaded, plistPath } from "./launchd.js";
import { Llmdb } from "./llmdb.js";
import { NetCapture } from "./netcapture.js";
import { NetProxy } from "./netproxy.js";
import { GO_IOS_INSTALL_HINT, RealDevices } from "./realdevices.js";
import { ServeSim } from "./servesim.js";
import { Simslim } from "./simslim.js";

export interface DoctorCheck {
  name: string;
  /** "pass" | "fail" | "warn" (warn = optional dependency missing). */
  status: "pass" | "fail" | "warn";
  detail: string;
  /** Exact command(s) to fix. Always set on fail/warn. */
  fix?: string;
}

export interface DoctorOpts {
  runner?: Runner;
  homeDir?: string;
  fetchHealth?: (url: string) => Promise<{ ok: boolean; version?: string }>;
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

function nodeCheck(): DoctorCheck {
  const major = Number(process.version.replace(/^v/, "").split(".")[0]);
  if (Number.isInteger(major) && major >= 18) {
    return { name: "node", status: "pass", detail: process.version };
  }
  return {
    name: "node",
    status: "fail",
    detail: `node ${process.version} < 18`,
    fix: "brew install node  # need node >= 18",
  };
}

/**
 * Run every startup probe plus daemon/launchd reachability. Reuses the same
 * checkAvailable() probes the daemon runs at boot so doctor and startup agree.
 * Prints nothing; callers format via formatDoctorReport(). No --fix: failures
 * print exact fix commands for the user to run by hand (never touches
 * sudo/proxy/keychain/launchd/brew automatically).
 */
export async function runDoctor(opts: DoctorOpts = {}): Promise<DoctorCheck[]> {
  const runner = opts.runner ?? defaultRunner;
  const home = opts.homeDir ?? os.homedir();
  const config = loadConfig();
  const checks: DoctorCheck[] = [nodeCheck()];

  // Xcode / Simulator runtime.
  try {
    await runner("xcrun", ["simctl", "list", "devices"], { timeoutMs: 30_000 });
    checks.push({ name: "xcode/sim-runtime", status: "pass", detail: "xcrun simctl list devices ok" });
  } catch (err) {
    checks.push({
      name: "xcode/sim-runtime",
      status: "fail",
      detail: (err as Error).message.slice(0, 200),
      fix: "xcode-select --install  # then install Xcode + a Simulator runtime from the App Store / developer portal",
    });
  }

  // Required binaries (same probes as daemon startup).
  const simslim = new Simslim({ bin: config.simslimBin, runner, execTimeoutMs: config.execTimeoutMs });
  const axe = new Axe({ bin: config.axeBin, runner, execTimeoutMs: config.execTimeoutMs });
  for (const [name, check, fix] of [
    ["simslim", () => simslim.checkAvailable(), "brew install mobai-app/tap/simslim"],
    ["axe", () => axe.checkAvailable(), "brew install cameroncooke/axe/axe"],
  ] as const) {
    try {
      const version = await check();
      checks.push({ name, status: "pass", detail: version.split("\n")[0]!.slice(0, 120) });
    } catch {
      checks.push({ name, status: "fail", detail: "required binary not usable", fix });
    }
  }

  // Optional binaries (warn, never fail).
  const serveSim = new ServeSim({ bin: config.serveSimBin, runner, execTimeoutMs: config.execTimeoutMs });
  const lldmdb = new Llmdb({ bin: config.llmdbBin, runner, execTimeoutMs: config.execTimeoutMs });
  const netProxy = new NetProxy({ bin: config.mitmdumpBin, runner, execTimeoutMs: config.execTimeoutMs });
  const netCapture = new NetCapture({ bin: config.tcpdumpBin, runner });
  const realDevices = new RealDevices({ runner, execTimeoutMs: config.execTimeoutMs });
  for (const [name, check, fix] of [
    ["serve-sim", () => serveSim.checkAvailable(), "npm install -g serve-sim"],
    ["llmdb", () => lldmdb.checkAvailable(), "brew install alexmx/tools/llmdb"],
    ["mitmdump", () => netProxy.checkAvailable(), "brew install mitmproxy"],
    ["tcpdump", () => netCapture.checkAvailable(), "macOS ships tcpdump; check TCPDUMP_BIN"],
    ["devicectl", () => realDevices.checkAvailable(), "xcode-select --install  # then install Xcode (devicectl ships with Xcode)"],
    ["ios", () => runner(config.iosBin, ["--version"], { timeoutMs: 30_000 }).then((r) => r.stdout), `${GO_IOS_INSTALL_HINT}  # go-ios for real-device app verbs + syslog + ui_screenshot (or set IOS_BIN)`],
  ] as const) {
    try {
      const version = await check();
      checks.push({ name, status: "pass", detail: version.split("\n")[0]!.slice(0, 120) });
    } catch {
      checks.push({ name, status: "warn", detail: "optional binary not usable (some tools will fail)", fix });
    }
  }

  // launchd plist present + loaded.
  const plist = plistPath(home);
  const present = fs.existsSync(plist);
  const loaded = await isPlistLoaded(runner);
  if (present && loaded) {
    checks.push({ name: "launchd", status: "pass", detail: `${plist} present + loaded` });
  } else if (present) {
    checks.push({
      name: "launchd",
      status: "fail",
      detail: `${plist} present but not loaded`,
      fix: `launchctl load ${plist}`,
    });
  } else {
    checks.push({
      name: "launchd",
      status: "fail",
      detail: `no plist at ${plist}`,
      fix: "apple-debug-mcp launchd create",
    });
  }

  // Daemon :port /health reachability + version.
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth;
  const health = await fetchHealth(`http://${config.host}:${config.port}/health`);
  if (health.ok) {
    checks.push({
      name: `daemon :${config.port}`,
      status: "pass",
      detail: `/health reachable${health.version ? ` (version ${health.version})` : ""}`,
    });
  } else {
    checks.push({
      name: `daemon :${config.port}`,
      status: "fail",
      detail: "/health unreachable",
      fix: "apple-debug-mcp launchd status  # then launchd create/restart, or run `npm start` in the repo",
    });
  }

  return checks;
}

export function formatDoctorReport(checks: DoctorCheck[]): { text: string; exitCode: number } {
  const lines = checks.map((c) => {
    const mark = c.status === "pass" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    const base = `[${mark}] ${c.name}: ${c.detail}`;
    return c.fix ? `${base}\n      fix: ${c.fix}` : base;
  });
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  lines.push(failed === 0 ? (warned === 0 ? "doctor: all checks passed" : `doctor: passed with ${warned} warning(s)`) : `doctor: ${failed} check(s) failed`);
  return { text: lines.join("\n") + "\n", exitCode: failed === 0 ? 0 : 1 };
}

export function doctorHelp(): string {
  return [
    "Usage: apple-debug-mcp doctor",
    "",
    "Read-only environment + daemon health checks. Every failure prints the",
    "exact command to fix it; doctor itself changes nothing (no --fix).",
  ].join("\n") + "\n";
}
