import fs from "node:fs";
import path from "node:path";

/** Distinct exit codes (never 1) so supervisors can tell conflicts apart. */
export const EXIT_PORT_IN_USE = 10;
export const EXIT_ALREADY_RUNNING = 11;

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/** Lockfile lives next to the state file so SIM_MCP_STATE_FILE relocates it. */
export function lockFilePath(stateFile: string): string {
  return path.join(path.dirname(stateFile), "daemon.lock");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function checkNotRunning(lockPath: string): { running: boolean; pid?: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return { running: false };
  }
  let info: Partial<LockInfo>;
  try {
    info = JSON.parse(raw) as Partial<LockInfo>;
  } catch {
    return { running: false };
  }
  const pid = typeof info.pid === "number" ? info.pid : undefined;
  if (pid !== undefined && isPidAlive(pid)) return { running: true, pid };
  // Stale lock (dead pid or garbage): remove so the next start is clean.
  try {
    fs.rmSync(lockPath);
  } catch {
    // ignore
  }
  return { running: false };
}

export function alreadyRunningMessage(pid: number): string {
  return (
    `[sim-mcp] Another daemon is already running (pid ${pid}). ` +
    `Use \`apple-debug-mcp launchd restart\` to restart it, or stop it first.`
  );
}

export function writeLock(lockPath: string, info: LockInfo): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2) + "\n");
}

/** Remove the lock only when it still points at us (never a successor's). */
export function removeLock(lockPath: string, pid: number = process.pid): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const info = JSON.parse(raw) as Partial<LockInfo>;
    if (info.pid === pid) fs.rmSync(lockPath);
  } catch {
    // ignore
  }
}

export function isAddrInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
}

export function portInUseMessage(port: number): string {
  return (
    `[sim-mcp] Port ${port} is already in use. Another daemon (or process) is bound there — ` +
    `use \`apple-debug-mcp launchd restart\` to restart the managed daemon instead of starting a second one.`
  );
}
