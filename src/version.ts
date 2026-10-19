import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Fallback when package.json cannot be located (should never happen in practice). */
export const UNKNOWN_VERSION = "0.0.0-dev";

let cachedVersion: string | null = null;
let cachedSha: string | undefined | null = null;

function repoRoot(): string {
  // src/version.ts -> repo root; dist/version.js -> repo root. Same depth either way.
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** Read the `version` field from a package.json file. Exported for tests. */
export function readPackageVersion(pkgPath: string): string {
  const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`No version field in ${pkgPath}`);
  }
  return parsed.version;
}

/**
 * Single source of truth for the daemon version: package.json.
 * Never hardcode a version string elsewhere; call this instead.
 */
export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = readPackageVersion(path.join(repoRoot(), "package.json"));
  } catch {
    cachedVersion = UNKNOWN_VERSION;
  }
  return cachedVersion;
}

/** Short git SHA of the checkout, or undefined when unavailable (tarball, no git). */
export function getGitSha(): string | undefined {
  if (cachedSha !== null) return cachedSha;
  try {
    cachedSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    cachedSha = undefined;
  }
  return cachedSha;
}

export interface ServerInfo {
  name: string;
  version: string;
  gitSha?: string;
}

/** Version payload shared by /health, the MCP handshake, and pool_status. */
export function getServerInfo(): ServerInfo {
  const info: ServerInfo = { name: "apple-debug-mcp", version: getVersion() };
  const sha = getGitSha();
  if (sha) info.gitSha = sha;
  return info;
}

/** Reset memoized values. Tests only. */
export function __resetVersionCache(): void {
  cachedVersion = null;
  cachedSha = null;
}
