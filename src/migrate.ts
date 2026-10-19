import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Current on-disk state directory name under $HOME. */
export const STATE_DIR_NAME = ".apple-debug-mcp";
/** Pre-rename state directory; moved to STATE_DIR_NAME on first run. */
export const LEGACY_STATE_DIR_NAME = ".sim-orchestration-mcp";

export function stateDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, STATE_DIR_NAME);
}

export function legacyStateDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, LEGACY_STATE_DIR_NAME);
}

export interface StateMigrationResult {
  migrated: boolean;
  from?: string;
  to?: string;
}

/**
 * First-run migration: move the pre-rename state dir to the new path when
 * the new dir is absent and the legacy dir exists. Idempotent; logs the move.
 * Never merges: when the new dir already exists the legacy dir is left alone.
 */
export function migrateLegacyStateDir(
  homeDir: string = os.homedir(),
  log: (msg: string) => void = console.log,
): StateMigrationResult {
  const from = legacyStateDir(homeDir);
  const to = stateDir(homeDir);
  if (fs.existsSync(to)) return { migrated: false };
  let legacy: fs.Stats;
  try {
    legacy = fs.statSync(from);
  } catch {
    return { migrated: false };
  }
  if (!legacy.isDirectory()) return { migrated: false };
  fs.renameSync(from, to);
  log(`[sim-mcp] Migrated legacy state dir ${from} -> ${to}`);
  return { migrated: true, from, to };
}
