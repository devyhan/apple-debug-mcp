import os from "node:os";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  stateFile: string;
  simslimBin: string;
  axeBin: string;
  serveSimBin: string;
  llmdbBin: string;
  /** First port scanned for per-lease serve-sim stream helpers. */
  serveSimPortBase: number;
  mitmdumpBin: string;
  /** First port scanned for the lease-held mitmdump listener. */
  netProxyPortBase: number;
  tcpdumpBin: string;
  /** 0 = no cap on concurrently booted simulators managed by acquire. */
  maxSims: number;
  leaseTtlMs: number;
  sweepIntervalMs: number;
  execTimeoutMs: number;
  bootTimeoutMs: number;
  screenshotDir: string;
  /** False disables lease-interference (contamination) detection entirely. */
  contaminationCheck: boolean;
  /** Minimum gap between contamination spawns for one lease. */
  contaminationCheckMinIntervalMs: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}=${raw}`);
  return parsed;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export function loadConfig(): Config {
  return {
    host: str("SIM_MCP_HOST", "127.0.0.1"),
    port: num("SIM_MCP_PORT", 3100),
    stateFile: str(
      "SIM_MCP_STATE_FILE",
      path.join(os.homedir(), ".apple-debug-mcp", "state.json"),
    ),
    simslimBin: str("SIMSLIM_BIN", "simslim"),
    axeBin: str("AXE_BIN", "axe"),
    serveSimBin: str("SERVE_SIM_BIN", "serve-sim"),
    llmdbBin: str("LLMDB_BIN", "llmdb"),
    serveSimPortBase: num("SERVE_SIM_PORT_BASE", 3220),
    mitmdumpBin: str("MITMDUMP_BIN", "mitmdump"),
    netProxyPortBase: num("NETPROXY_PORT_BASE", 3240),
    tcpdumpBin: str("TCPDUMP_BIN", "tcpdump"),
    maxSims: num("SIM_MCP_MAX_SIMS", 0),
    leaseTtlMs: num("SIM_MCP_LEASE_TTL_MS", 30 * 60 * 1000),
    sweepIntervalMs: num("SIM_MCP_SWEEP_MS", 60 * 1000),
    execTimeoutMs: num("SIM_MCP_EXEC_TIMEOUT_MS", 60_000),
    bootTimeoutMs: num("SIM_MCP_BOOT_TIMEOUT_MS", 10 * 60_000),
    screenshotDir: str("SIM_MCP_SCREENSHOT_DIR", path.join(os.tmpdir(), "sim-mcp-shots")),
    contaminationCheck: str("SIM_MCP_CONTAMINATION_CHECK", "true") !== "false",
    contaminationCheckMinIntervalMs: num("SIM_MCP_CONTAMINATION_MIN_INTERVAL_MS", 30_000),
  };
}
