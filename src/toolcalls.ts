/**
 * P1 minimal toolcall telemetry: one JSONL line per tools/call.
 *
 * Research verdict (ANGLE 2): no existing artifact can count per-tool calls —
 * daemon.log carries no tool names, the lease_actions ring is in-memory,
 * ephemeral, capped and subset-only, state.json holds no counters, and
 * trace.jsonl is env-gated OFF and covers the same logAction subset. So this
 * module is the single choke point: `instrumentToolcalls` wraps
 * `McpServer.registerTool` once per server (idempotent via WeakSet) so every
 * registered callback appends exactly one line `{t, tool, ok}`.
 *
 * Gate: enabled by default (logging is observable-neutral: no response byte
 * changes). Set `SIM_MCP_TOOLCALLS=0` to disable. Destination:
 * `SIM_MCP_TOOLCALLS_FILE` (explicit file) wins, else
 * `<stateDir>/toolcalls.jsonl` where stateDir is the dirname of
 * `SIM_MCP_STATE_FILE` or the `~/.apple-debug-mcp` default.
 *
 * Privacy: tool name + timestamp + ok/err only; argument values are never
 * logged. Every export is best-effort and never throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TOOLCALLS_ENABLE_ENV = "SIM_MCP_TOOLCALLS";
export const TOOLCALLS_FILE_ENV = "SIM_MCP_TOOLCALLS_FILE";
export const TOOLCALLS_STATE_FILE_ENV = "SIM_MCP_STATE_FILE";
export const TOOLCALLS_FILE_NAME = "toolcalls.jsonl";

export interface ToolcallEvent {
  t: number;
  tool: string;
  ok: boolean;
}

/** Master gate. Read per call (one env lookup) so tests can toggle it. Default ON. */
export function isToolcallsEnabled(): boolean {
  return process.env[TOOLCALLS_ENABLE_ENV] !== "0";
}

export function defaultToolcallsDir(): string {
  const stateFile = process.env[TOOLCALLS_STATE_FILE_ENV];
  if (stateFile !== undefined && stateFile !== "") return path.dirname(stateFile);
  return path.join(os.homedir(), ".apple-debug-mcp");
}

/** Resolve the JSONL file: explicit file > state dir default. */
export function resolveToolcallsFile(): string {
  const file = process.env[TOOLCALLS_FILE_ENV];
  if (file !== undefined && file !== "") return file;
  return path.join(defaultToolcallsDir(), TOOLCALLS_FILE_NAME);
}

/** Append one line. Best-effort: never throws, never logs arg values. */
export function appendToolcall(tool: string, ok: boolean): void {
  try {
    if (!isToolcallsEnabled()) return;
    const event: ToolcallEvent = { t: Date.now(), tool, ok };
    const file = resolveToolcallsFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // Parent may already exist; the append below is the real attempt.
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Telemetry must never break the tool path.
  }
}

const instrumented = new WeakSet<object>();

type RegisterToolFn = McpServer["registerTool"];

/**
 * Wrap `server.registerTool` so every tool callback appends exactly one
 * telemetry line. Idempotent: a second call for the same server is a no-op,
 * so both `createMcpServer` and `registerDeviceExtras` can call it safely.
 */
export function instrumentToolcalls(server: McpServer): void {
  if (instrumented.has(server)) return;
  instrumented.add(server);
  const orig = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const wrapped = (name: string, config: unknown, cb: (...args: never[]) => unknown): unknown => {
    const counted = async (...args: never[]): Promise<unknown> => {
      let ok = true;
      try {
        const out = (await cb(...args)) as { isError?: unknown } | null | undefined;
        ok = (out as { isError?: boolean } | null | undefined)?.isError !== true;
        return out;
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        appendToolcall(name, ok);
      }
    };
    return orig(name, config, counted);
  };
  server.registerTool = wrapped as unknown as RegisterToolFn;
}
