import { promises as fsp } from "node:fs";
import path from "node:path";
import { Runner } from "./exec.js";

/**
 * T1 app cache clearing (no logout): terminate the app, resolve its data
 * container via `simctl get_app_container`, delete `Library/Caches/*`, and
 * optionally remove targeted plist keys. Documents and Keychain are never
 * touched so login survives; relaunch is left to the caller.
 *
 * Fail-soft: terminate failures (app not running) and per-entry / per-key
 * failures are recorded in `errors` and the run continues. Refusals (empty
 * bundle id, invalid plist target, unknown container) throw before any
 * deletion, and the tool layer converts them to `{ok:false}`.
 */

/** One targeted plist edit: container-relative plist path + keys to remove. */
export interface PlistKeyTarget {
  plist: string;
  keys: string[];
}

export interface CacheClearOptions {
  /** Optional targeted plist keys (e.g. throttle state). Validated before any spawn. */
  plistKeys?: PlistKeyTarget[];
}

export interface CacheClearResult {
  /** Absolute data-container path from `simctl get_app_container`. */
  container: string;
  /** Absolute `Library/Caches` path inside the container. */
  cachesDir: string;
  /** Absolute top-level Caches entries removed. */
  deleted: string[];
  /** Number of Caches entries removed (equals `deleted.length`). */
  deletedCount: number;
  /** Plist keys removed via plutil. */
  plistKeysRemoved: Array<{ plist: string; key: string }>;
  /** Whether the pre-clear terminate succeeded (false when the app was not running). */
  terminated: boolean;
  /** Bounded fail-soft notes; empty on a fully clean run. */
  errors: string[];
}

const MAX_REPORTED_ERRORS = 20;

/** True when target resolves inside root (or equals it). Never throws. */
export function isPathWithin(root: string, target: string): boolean {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Container-independent shape validation for a plist target. Throws on any
 * refusal: empty/absolute/escaping path, Documents or Keychain target,
 * non-.plist file, or empty key list. Runs before any spawn or deletion.
 */
export function assertPlistTargetShape(target: PlistKeyTarget): void {
  const rel = (target as { plist?: unknown } | null | undefined)?.plist;
  if (typeof rel !== "string" || rel.trim().length === 0) {
    throw new Error("Invalid plist target (expected a non-empty container-relative plist path)");
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`Invalid plist target ${JSON.stringify(rel)}: absolute paths are refused`);
  }
  const norm = path.normalize(rel);
  if (norm === ".." || norm.startsWith(`..${path.sep}`)) {
    throw new Error(`Invalid plist target ${JSON.stringify(rel)}: must stay inside the app container`);
  }
  const segs = norm.split(path.sep).filter((s) => s.length > 0 && s !== ".");
  if (segs.length > 0 && segs[0]?.toLowerCase() === "documents") {
    throw new Error(`Invalid plist target ${JSON.stringify(rel)}: must never touch Documents`);
  }
  if (segs.some((s) => s.toLowerCase().includes("keychain"))) {
    throw new Error(`Invalid plist target ${JSON.stringify(rel)}: must never touch Keychain`);
  }
  if (!rel.toLowerCase().endsWith(".plist")) {
    throw new Error(`Invalid plist target ${JSON.stringify(rel)}: must be a .plist file`);
  }
  const keys = (target as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`Invalid plist target ${JSON.stringify(rel)}: keys must be a non-empty array`);
  }
  for (const k of keys) {
    if (typeof k !== "string" || k.trim().length === 0) {
      throw new Error(`Invalid plist target ${JSON.stringify(rel)}: keys must be non-empty strings`);
    }
  }
}

/** Terminate-first cache clearing for one sim app. Single runner seam (faked in tests). */
export class AppCacheClearer {
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { runner: Runner; execTimeoutMs?: number }) {
    this.run = opts.runner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  async clear(udid: string, bundleId: string, opts: CacheClearOptions = {}): Promise<CacheClearResult> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    if (bundleId.trim().length === 0) throw new Error("Invalid bundle_id (expected a non-empty string)");
    const plistTargets = opts.plistKeys ?? [];
    for (const t of plistTargets) assertPlistTargetShape(t);

    const errors: string[] = [];
    const pushError = (m: string): void => {
      if (errors.length < MAX_REPORTED_ERRORS) errors.push(m.slice(0, 300));
    };

    // 1. Terminate first: cfprefsd caches make live plist edits unreliable.
    // Tolerant: clearing the cache of a non-running app is the common case.
    let terminated = true;
    try {
      await this.run("xcrun", ["simctl", "terminate", udid, bundleId], { timeoutMs: this.execTimeoutMs });
    } catch (err) {
      terminated = false;
      pushError(`terminate: ${(err as Error).message}`);
    }

    // 2. Resolve the data container. Unknown apps fail here; nothing is deleted.
    let container: string;
    try {
      const { stdout } = await this.run("xcrun", ["simctl", "get_app_container", udid, bundleId, "data"], {
        timeoutMs: this.execTimeoutMs,
      });
      container = stdout.trim();
    } catch (err) {
      throw new Error(`Unknown app container for bundle_id ${JSON.stringify(bundleId)}: ${(err as Error).message}`);
    }
    if (container.length === 0 || !path.isAbsolute(container)) {
      throw new Error(`Unknown app container for bundle_id ${JSON.stringify(bundleId)}: empty path`);
    }

    // 3. Delete Library/Caches/* (top-level entries only; recursive each).
    const cachesDir = path.join(container, "Library", "Caches");
    const deleted: string[] = [];
    let entries: string[];
    try {
      entries = (await fsp.readdir(cachesDir)).sort();
    } catch {
      entries = []; // Missing Caches dir: nothing to do.
    }
    for (const entry of entries) {
      const target = path.join(cachesDir, entry);
      if (!isPathWithin(cachesDir, target)) {
        pushError(`refused to delete outside Caches: ${entry}`);
        continue;
      }
      try {
        await fsp.rm(target, { recursive: true, force: true });
        deleted.push(target);
      } catch (err) {
        pushError(`delete ${entry}: ${(err as Error).message}`);
      }
    }

    // 4. Targeted plist keys via plutil (each failure is isolated).
    const plistKeysRemoved: Array<{ plist: string; key: string }> = [];
    for (const t of plistTargets) {
      const abs = path.resolve(container, t.plist);
      if (!isPathWithin(container, abs)) {
        pushError(`refused plist target outside container: ${t.plist}`);
        continue;
      }
      for (const key of t.keys) {
        try {
          await this.run("plutil", ["-remove", key, abs], { timeoutMs: this.execTimeoutMs });
          plistKeysRemoved.push({ plist: abs, key });
        } catch (err) {
          pushError(`plist ${t.plist} key ${key}: ${(err as Error).message}`);
        }
      }
    }

    return {
      container,
      cachesDir,
      deleted,
      deletedCount: deleted.length,
      plistKeysRemoved,
      terminated,
      errors,
    };
  }
}
