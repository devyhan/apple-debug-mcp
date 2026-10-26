/**
 * LW0 boot telemetry: one JSONL line per sim boot attempt + per acquire outcome.
 *
 * Two line kinds share one file, told apart by `kind`:
 * - BOOT: one per fleet.boot attempt (`{t, kind:"boot", ok, udidHash,
 *   deviceName, osVersion, platform, coldWarm, slim, slimMs, bootMs, readyMs,
 *   err?}`). All durations are integer milliseconds; -1 means not applicable.
 * - ACQUIRE: one per lease-producing or ticket-producing outcome
 *   (`{t, kind:"acquire", outcome:"MISS"|"HIT"|"QUEUE", leaseId|ticketId,
 *   waitMs, bootMs, slimMs, baselineMs, via:"acquire"|"dispatch"}`).
 *
 * Gate: enabled by default (per-boot volume, same order as toolcalls).
 * Set `SIM_MCP_BOOT_TELEMETRY=0` to disable. Destination:
 * `SIM_MCP_BOOT_TELEMETRY_FILE` (explicit file) wins, else
 * `<stateDir>/boot-telemetry.jsonl` where stateDir is the dirname of
 * `SIM_MCP_STATE_FILE` or the `~/.apple-debug-mcp` default — so scratch
 * daemons with their own state file never touch production telemetry.
 *
 * Privacy: names-only — udidHash (`udid:<12hex>`) via trace's scrubUdid,
 * server-generated lease/ticket ids, fleet inventory names; raw UDIDs,
 * session ids, client labels and tasks are never logged. Every export is
 * best-effort and never throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BOOT_ENABLE_ENV = "SIM_MCP_BOOT_TELEMETRY";
export const BOOT_FILE_ENV = "SIM_MCP_BOOT_TELEMETRY_FILE";
export const BOOT_STATE_FILE_ENV = "SIM_MCP_STATE_FILE";
export const BOOT_FILE_NAME = "boot-telemetry.jsonl";

export interface BootEvent {
  t: number;
  kind: "boot";
  ok: boolean;
  udidHash: string;
  deviceName: string;
  osVersion: string;
  platform: string;
  coldWarm: "cold" | "warm";
  slim: "slim" | "stock" | "partial" | "unknown";
  slimMs: number;
  bootMs: number;
  /** Boot-return -> services-ready probe; -1 in LW0 (no probe exists yet). */
  readyMs: number;
  /** Present only when ok:false; scrubbed + capped by the caller. */
  err?: string;
}

export interface AcquireEvent {
  t: number;
  kind: "acquire";
  outcome: "MISS" | "HIT" | "QUEUE";
  leaseId?: string;
  ticketId?: string;
  waitMs: number;
  /** -1 when no boot happened on this path. */
  bootMs: number;
  /** -1 when the slim step was skipped. */
  slimMs: number;
  /** -1 when no baseline snapshot was taken (queue outcomes). */
  baselineMs: number;
  via: "acquire" | "dispatch";
}

/** Master gate. Read per call (one env lookup) so tests can toggle it. Default ON. */
export function isBootTelemetryEnabled(): boolean {
  return process.env[BOOT_ENABLE_ENV] !== "0";
}

export function defaultBootDir(): string {
  const stateFile = process.env[BOOT_STATE_FILE_ENV];
  if (stateFile !== undefined && stateFile !== "") return path.dirname(stateFile);
  return path.join(os.homedir(), ".apple-debug-mcp");
}

/** Resolve the JSONL file: explicit file > state dir default. */
export function resolveBootFile(): string {
  const file = process.env[BOOT_FILE_ENV];
  if (file !== undefined && file !== "") return file;
  return path.join(defaultBootDir(), BOOT_FILE_NAME);
}

function appendLine(event: BootEvent | AcquireEvent): void {
  try {
    if (!isBootTelemetryEnabled()) return;
    const file = resolveBootFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // Parent may already exist; the append below is the real attempt.
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Telemetry must never break the lease path.
  }
}

/** Append one BOOT line. Best-effort: never throws. */
export function appendBoot(event: BootEvent): void {
  appendLine(event);
}

/** Append one ACQUIRE line. Best-effort: never throws. */
export function appendAcquire(event: AcquireEvent): void {
  appendLine(event);
}
