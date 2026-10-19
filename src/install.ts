import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

/**
 * Supported MCP clients. Config paths and entry formats were verified against
 * the real configs on a macOS machine (2026-10-16); see README. Unknown
 * clients are rejected, never guess-written.
 */
export type ClientName = "claude-code" | "codex" | "muse";
export const SUPPORTED_CLIENTS: ClientName[] = ["claude-code", "codex", "muse"];

export const BACKUP_SUFFIX = ".bak-sim-mcp";

/** Uniform MCP server key for every client. */
export const SERVER_KEY = "apple-debug";
/** Pre-rename keys, removed on install (without --remove) while adding SERVER_KEY. */
export const LEGACY_SERVER_KEYS = ["sim-orchestration-mcp", "sim-orchestration"];

export interface ClientSpec {
  name: ClientName;
  /** Config file path, given a home dir. */
  configPath: (homeDir: string) => string;
  kind: "json" | "toml";
  /** MCP server key. Uniform `apple-debug` for every client. */
  serverKey: string;
  restartStep: string;
}

export const CLIENT_SPECS: Record<ClientName, ClientSpec> = {
  "claude-code": {
    name: "claude-code",
    configPath: (home) => path.join(home, ".claude.json"),
    kind: "json",
    serverKey: SERVER_KEY,
    restartStep: "Restart Claude Code (or /mcp → reconnect) to pick up the new server.",
  },
  codex: {
    name: "codex",
    configPath: (home) => path.join(home, ".codex", "config.toml"),
    kind: "toml",
    serverKey: SERVER_KEY,
    restartStep: "Restart Codex (config.toml is read at startup).",
  },
  muse: {
    name: "muse",
    configPath: (home) => path.join(home, ".config", "muse", "settings.json"),
    kind: "json",
    serverKey: SERVER_KEY,
    restartStep: "Restart the Muse session to pick up the new server.",
  },
};

export function parseClientList(raw: string): { clients: ClientName[]; unknown: string[] } {
  const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.includes("all")) return { clients: [...SUPPORTED_CLIENTS], unknown: [] };
  const clients: ClientName[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    if ((SUPPORTED_CLIENTS as string[]).includes(part)) {
      if (!clients.includes(part as ClientName)) clients.push(part as ClientName);
    } else {
      unknown.push(part);
    }
  }
  return { clients, unknown };
}

export function daemonMcpUrl(): string {
  const config = loadConfig();
  return `http://${config.host}:${config.port}/mcp`;
}

// ---------------- JSON clients (claude-code, muse) ----------------

export function jsonEntryFor(client: ClientName, url: string): Record<string, string> {
  // Shapes verified on-machine: Claude Code uses {"type":"http"}, Muse uses
  // {"type":"streamable-http"}. URL-only otherwise.
  if (client === "claude-code") return { type: "http", url };
  return { type: "streamable-http", url };
}

/**
 * Merge the server entry into parsed JSON config. Preserves every other key
 * and preserves extra keys on an existing entry (e.g. Muse's "mode").
 */
export function upsertJsonEntry(
  parsed: Record<string, unknown>,
  client: ClientName,
  url: string,
): { changed: boolean; created: boolean } {
  let servers = parsed["mcpServers"];
  if (servers === undefined) {
    servers = {};
    parsed["mcpServers"] = servers;
  }
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`mcpServers is not an object; refusing to merge`);
  }
  const table = servers as Record<string, unknown>;
  const serverKey = CLIENT_SPECS[client].serverKey;
  const existing = table[serverKey];
  const entry = jsonEntryFor(client, url);
  if (
    existing !== undefined &&
    typeof existing === "object" &&
    existing !== null &&
    (existing as Record<string, unknown>)["url"] === url &&
    (existing as Record<string, unknown>)["type"] === entry.type
  ) {
    return { changed: false, created: false };
  }
  const created = existing === undefined;
  table[serverKey] = { ...(typeof existing === "object" && existing !== null ? existing : {}), ...entry };
  return { changed: true, created };
}

export function removeJsonEntry(parsed: Record<string, unknown>, serverKey: string): boolean {
  const servers = parsed["mcpServers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;
  const table = servers as Record<string, unknown>;
  if (!(serverKey in table)) return false;
  delete table[serverKey];
  return true;
}

export function readJsonStatus(
  filePath: string,
  client: ClientName,
): { installed: boolean; url?: string; detail: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { installed: false, detail: "no config file" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { installed: false, detail: "config file is not valid JSON" };
  }
  const servers = (parsed as Record<string, unknown>)?.["mcpServers"];
  const entry = (servers as Record<string, unknown> | undefined)?.[CLIENT_SPECS[client].serverKey] as
    | Record<string, unknown>
    | undefined;
  if (!entry || typeof entry !== "object") return { installed: false, detail: "entry missing" };
  const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
  const expected = jsonEntryFor(client, url ?? "");
  if (url && entry["type"] === expected.type) return { installed: true, url, detail: `url ${url}` };
  return { installed: false, url, detail: url ? `entry present with unexpected shape (type ${String(entry["type"])})` : "entry present without url" };
}

// ---------------- TOML client (codex) ----------------

const SECTION_RE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

function sectionHeader(name: string): string {
  return `[mcp_servers.${name}]`;
}

/**
 * Text-based TOML merge for `[mcp_servers.<serverKey>]`: touches only the
 * `url` line inside that exact section (inserting it when absent), appends a
 * new section when missing, and leaves every other line byte-identical.
 */
export function upsertTomlEntry(
  text: string,
  serverKey: string,
  url: string,
): { text: string; changed: boolean; created: boolean } {
  const header = sectionHeader(serverKey);
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx === -1) {
    const block = `${header}\nurl = ${JSON.stringify(url)}\n`;
    if (text === "") return { text: block, changed: true, created: true };
    const sep = text.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${text}${sep}${block}`, changed: true, created: true };
  }
  // End of our section = next section header or EOF.
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const urlIdx = lines.findIndex(
    (l, i) => i > headerIdx && i < end && /^\s*url\s*=/.test(l),
  );
  if (urlIdx !== -1) {
    const want = `url = ${JSON.stringify(url)}`;
    if (lines[urlIdx]!.trim() === want) return { text, changed: false, created: false };
    const next = [...lines];
    next[urlIdx] = want;
    return { text: next.join("\n"), changed: true, created: false };
  }
  const next = [...lines];
  next.splice(headerIdx + 1, 0, `url = ${JSON.stringify(url)}`);
  return { text: next.join("\n"), changed: true, created: false };
}

/**
 * Remove `[mcp_servers.<serverKey>]` and its dotted children
 * (`[mcp_servers.<serverKey>.*]`), leaving everything else byte-identical.
 */
export function removeTomlEntry(text: string, serverKey: string): { text: string; changed: boolean } {
  const header = sectionHeader(serverKey);
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx === -1) return { text, changed: false };
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const m = lines[i]!.match(SECTION_RE);
    if (m && m[1] !== header.slice(1, -1) && !m[1]!.startsWith(`${header.slice(1, -1)}.`)) {
      end = i;
      break;
    }
  }
  // Swallow one preceding blank line so repeated add/remove cycles are stable.
  let start = headerIdx;
  if (start > 0 && lines[start - 1]!.trim() === "") start -= 1;
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  return { text: next.join("\n"), changed: true };
}

export function readTomlStatus(
  filePath: string,
  serverKey: string,
): { installed: boolean; url?: string; detail: string } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { installed: false, detail: "no config file" };
  }
  const header = sectionHeader(serverKey);
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx === -1) return { installed: false, detail: "section missing" };
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i]!)) break;
    const m = lines[i]!.match(/^\s*url\s*=\s*"([^"]*)"/);
    if (m) return { installed: true, url: m[1], detail: `url ${m[1]}` };
  }
  return { installed: false, detail: "section present without url" };
}

/** Pre-rename keys still present in a JSON client config (never includes SERVER_KEY). */
export function findLegacyJsonKeys(filePath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  const servers = (parsed as Record<string, unknown>)?.["mcpServers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  const table = servers as Record<string, unknown>;
  return LEGACY_SERVER_KEYS.filter((k) => k !== SERVER_KEY && k in table);
}

/** Pre-rename sections still present in a TOML client config. */
export function findLegacyTomlKeys(filePath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").map((l) => l.trim());
  return LEGACY_SERVER_KEYS.filter((k) => k !== SERVER_KEY && lines.includes(sectionHeader(k)));
}

// ---------------- command ----------------

export interface InstallArgs {
  clientsRaw: string;
  dryRun?: boolean;
  status?: boolean;
  remove?: boolean;
}

export interface InstallOpts {
  homeDir?: string;
  url?: string;
}

export interface InstallResult {
  exitCode: number;
  output: string;
}

function backupOnce(filePath: string): string | null {
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  if (fs.existsSync(backupPath)) return null; // keep the original pre-edit backup
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export async function installCommand(args: InstallArgs, opts: InstallOpts = {}): Promise<InstallResult> {
  const { clients, unknown } = parseClientList(args.clientsRaw);
  const lines: string[] = [];
  if (unknown.length > 0) {
    return {
      exitCode: 2,
      output:
        `Unsupported client(s): ${unknown.join(", ")}. ` +
        `Supported: ${SUPPORTED_CLIENTS.join(", ")}, all. Nothing was changed.\n`,
    };
  }
  if (clients.length === 0) {
    return { exitCode: 2, output: `No clients given. ${installHelp()}` };
  }
  const home = opts.homeDir ?? os.homedir();
  const url = opts.url ?? daemonMcpUrl();

  let exitCode = 0;
  for (const client of clients) {
    const spec = CLIENT_SPECS[client];
    const filePath = spec.configPath(home);
    if (args.status) {
      const st = spec.kind === "json" ? readJsonStatus(filePath, client) : readTomlStatus(filePath, spec.serverKey);
      lines.push(
        `${client}: ${st.installed ? `installed (${st.detail})` : `not installed (${st.detail})`} — ${filePath}`,
      );
      continue;
    }
    if (args.remove) {
      if (!fs.existsSync(filePath)) {
        lines.push(`${client}: no config file at ${filePath}; nothing to remove.`);
        continue;
      }
      if (args.dryRun) {
        const st = spec.kind === "json" ? readJsonStatus(filePath, client) : readTomlStatus(filePath, spec.serverKey);
        lines.push(`${client}: [dry-run] would remove entry (${st.detail}) from ${filePath}`);
        continue;
      }
      try {
        if (spec.kind === "json") {
          const raw = fs.readFileSync(filePath, "utf8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (!removeJsonEntry(parsed, spec.serverKey)) {
            lines.push(`${client}: entry not present in ${filePath}; unchanged.`);
            continue;
          }
          const backup = backupOnce(filePath);
          writeJson(filePath, raw, parsed);
          lines.push(`${client}: removed entry from ${filePath}${backup ? ` (backup ${backup})` : ""}`);
        } else {
          const raw = fs.readFileSync(filePath, "utf8");
          const { text, changed } = removeTomlEntry(raw, spec.serverKey);
          if (!changed) {
            lines.push(`${client}: section not present in ${filePath}; unchanged.`);
            continue;
          }
          const backup = backupOnce(filePath);
          fs.writeFileSync(filePath, text);
          lines.push(`${client}: removed section from ${filePath}${backup ? ` (backup ${backup})` : ""}`);
        }
      } catch (err) {
        exitCode = 1;
        lines.push(`${client}: FAILED to edit ${filePath}: ${(err as Error).message}`);
      }
      continue;
    }
    // install / upsert
    const current = spec.kind === "json" ? readJsonStatus(filePath, client) : readTomlStatus(filePath, spec.serverKey);
    const legacyKeys =
      spec.kind === "json" ? findLegacyJsonKeys(filePath) : findLegacyTomlKeys(filePath);
    if (current.installed && current.url === url && legacyKeys.length === 0) {
      lines.push(`${client}: already installed (${current.detail}) — ${filePath}`);
      continue;
    }
    if (args.dryRun) {
      lines.push(
        `${client}: [dry-run] would write url ${url} to ${filePath} (${current.detail}` +
          `${legacyKeys.length > 0 ? `; would remove legacy: ${legacyKeys.join(", ")}` : ""})`,
      );
      continue;
    }
    try {
      if (spec.kind === "json") {
        let raw: string;
        let parsed: Record<string, unknown>;
        if (fs.existsSync(filePath)) {
          raw = fs.readFileSync(filePath, "utf8");
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } else {
          raw = "";
          parsed = {};
        }
        const { created } = upsertJsonEntry(parsed, client, url);
        const removedLegacy = legacyKeys.filter((k) => removeJsonEntry(parsed, k));
        if (fs.existsSync(filePath)) {
          const backup = backupOnce(filePath);
          if (backup) lines.push(`${client}: backup ${backup}`);
        } else {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        writeJson(filePath, raw, parsed);
        lines.push(
          `${client}: ${created ? "added" : "updated"} entry in ${filePath} → ${url}.` +
            `${removedLegacy.length > 0 ? ` Removed legacy: ${removedLegacy.join(", ")}.` : ""} ${spec.restartStep}`,
        );
      } else {
        const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
        const upserted = upsertTomlEntry(raw, spec.serverKey, url);
        let text = upserted.text;
        const removedLegacy: string[] = [];
        for (const legacy of legacyKeys) {
          const removed = removeTomlEntry(text, legacy);
          if (removed.changed) {
            text = removed.text;
            removedLegacy.push(legacy);
          }
        }
        if (fs.existsSync(filePath)) {
          const backup = backupOnce(filePath);
          if (backup) lines.push(`${client}: backup ${backup}`);
        } else {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        fs.writeFileSync(filePath, text);
        lines.push(
          `${client}: ${upserted.created ? "added" : "updated"} [mcp_servers.${spec.serverKey}] in ${filePath} → ${url}.` +
            `${removedLegacy.length > 0 ? ` Removed legacy: ${removedLegacy.join(", ")}.` : ""} ${spec.restartStep}`,
        );
      }
    } catch (err) {
      exitCode = 1;
      lines.push(`${client}: FAILED to edit ${filePath}: ${(err as Error).message}`);
    }
  }
  return { exitCode, output: lines.join("\n") + "\n" };
}

function writeJson(filePath: string, raw: string, parsed: Record<string, unknown>): void {
  const trailingNewline = raw === "" || raw.endsWith("\n");
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + (trailingNewline ? "\n" : ""));
}

export function installHelp(): string {
  return [
    "Usage: apple-debug-mcp install --client <claude-code,codex,muse,all> [--dry-run] [--status] [--remove]",
    "",
    "Writes Streamable-HTTP URL entries (user scope) into each client's config.",
    "Idempotent; backs up every edited file to <config>.bak-sim-mcp first.",
  ].join("\n") + "\n";
}
