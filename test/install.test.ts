import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_SPECS,
  installCommand,
  parseClientList,
  readTomlStatus,
  removeTomlEntry,
  upsertTomlEntry,
} from "../src/install.js";

const URL = "http://127.0.0.1:3100/mcp";
const KEY = "sim-orchestration"; // codex/muse server key

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-install-"));
}

describe("parseClientList", () => {
  it("parses lists, dedupes, and expands all", () => {
    expect(parseClientList("codex,muse")).toEqual({ clients: ["codex", "muse"], unknown: [] });
    expect(parseClientList("codex,codex")).toEqual({ clients: ["codex"], unknown: [] });
    expect(parseClientList("all")).toEqual({ clients: ["claude-code", "codex", "muse"], unknown: [] });
  });

  it("collects unknown clients without guessing", () => {
    expect(parseClientList("codex,vscode")).toEqual({ clients: ["codex"], unknown: ["vscode"] });
  });
});

describe("toml merge", () => {
  it("appends a new section to an existing file", () => {
    const { text, changed, created } = upsertTomlEntry('model = "x"\n', KEY, URL);
    expect(changed).toBe(true);
    expect(created).toBe(true);
    expect(text).toContain('model = "x"');
    expect(text).toContain(`[mcp_servers.${KEY}]\nurl = "${URL}"`);
  });

  it("is idempotent when the url already matches", () => {
    const once = upsertTomlEntry("", KEY, URL).text;
    const twice = upsertTomlEntry(once, KEY, URL);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });

  it("updates only the url line inside our section", () => {
    const before = `[mcp_servers.other]\nurl = "https://x"\n\n[mcp_servers.${KEY}]\nurl = "http://old/mcp"\n\n[tui]\nok = true\n`;
    const { text, changed, created } = upsertTomlEntry(before, KEY, URL);
    expect(changed).toBe(true);
    expect(created).toBe(false);
    expect(text).toContain('[mcp_servers.other]\nurl = "https://x"');
    expect(text).toContain(`url = "${URL}"`);
    expect(text).not.toContain("http://old/mcp");
    expect(text).toContain("[tui]\nok = true");
  });

  it("inserts a url line when our section lacks one", () => {
    const { text, changed } = upsertTomlEntry(`[mcp_servers.${KEY}]\n# comment\n`, KEY, URL);
    expect(changed).toBe(true);
    expect(text).toContain(`url = "${URL}"`);
    expect(text).toContain("# comment");
  });

  it("removes our section plus dotted children, nothing else", () => {
    const before = `[mcp_servers.other]\nurl = "https://x"\n\n[mcp_servers.${KEY}]\nurl = "${URL}"\n\n[mcp_servers.${KEY}.tools.foo]\napproval = true\n\n[tui]\nok = true\n`;
    const { text, changed } = removeTomlEntry(before, KEY);
    expect(changed).toBe(true);
    expect(text).toContain('[mcp_servers.other]\nurl = "https://x"');
    expect(text).toContain("[tui]\nok = true");
    expect(text).not.toContain(KEY);
  });

  it("remove is a no-op when the section is missing", () => {
    expect(removeTomlEntry("[tui]\n", KEY).changed).toBe(false);
  });

  it("reads status", () => {
    const dir = tmpHome();
    const file = path.join(dir, "config.toml");
    expect(readTomlStatus(file, KEY).installed).toBe(false);
    fs.writeFileSync(file, upsertTomlEntry("", KEY, URL).text);
    expect(readTomlStatus(file, KEY)).toMatchObject({ installed: true, url: URL });
  });
});

describe("install command (temp HOME fixtures)", () => {
  it("installs JSON clients idempotently with backup", async () => {
    const home = tmpHome();
    const first = await installCommand({ clientsRaw: "claude-code,muse" }, { homeDir: home, url: URL });
    expect(first.exitCode).toBe(0);
    for (const client of ["claude-code", "muse"] as const) {
      const file = CLIENT_SPECS[client].configPath(home);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
      expect((parsed["mcpServers"]![CLIENT_SPECS[client].serverKey] as Record<string, string>)["url"]).toBe(URL);
    }
    // Per-client keys match the established convention.
    const claudeFile = CLIENT_SPECS["claude-code"].configPath(home);
    expect(Object.keys(JSON.parse(fs.readFileSync(claudeFile, "utf8"))["mcpServers"])).toContain(
      "sim-orchestration-mcp",
    );
    // Second run: idempotent, no edits.
    const second = await installCommand({ clientsRaw: "all" }, { homeDir: home, url: URL });
    expect(second.output).toMatch(/already installed/);
    expect(second.output).toContain("[mcp_servers.sim-orchestration]");
    // Backup preserves the pre-edit content on the next real edit.
    const before = fs.readFileSync(claudeFile, "utf8");
    await installCommand({ clientsRaw: "claude-code", remove: true }, { homeDir: home, url: URL });
    expect(fs.existsSync(`${claudeFile}.bak-sim-mcp`)).toBe(true);
    expect(fs.readFileSync(`${claudeFile}.bak-sim-mcp`, "utf8")).toBe(before);
  });

  it("preserves unrelated JSON keys and extra entry keys", async () => {
    const home = tmpHome();
    const file = CLIENT_SPECS["muse"].configPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ other: 1, mcpServers: { [KEY]: { type: "streamable-http", url: "http://old/mcp", mode: "optional" } } }),
    );
    const res = await installCommand({ clientsRaw: "muse" }, { homeDir: home, url: URL });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    expect(parsed["other"]).toBe(1);
    expect(parsed["mcpServers"][KEY]).toMatchObject({ url: URL, mode: "optional" });
  });

  it("installs codex TOML preserving the rest of the file", async () => {
    const home = tmpHome();
    const file = CLIENT_SPECS["codex"].configPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt"\n\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n');
    const res = await installCommand({ clientsRaw: "codex" }, { homeDir: home, url: URL });
    expect(res.exitCode).toBe(0);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('model = "gpt"');
    expect(text).toContain('[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"');
    expect(text).toContain(`[mcp_servers.${KEY}]\nurl = "${URL}"`);
    expect(res.output).toMatch(/Restart Codex/);
  });

  it("dry-run writes nothing", async () => {
    const home = tmpHome();
    const res = await installCommand({ clientsRaw: "all", dryRun: true }, { homeDir: home, url: URL });
    expect(res.exitCode).toBe(0);
    expect(res.output).toMatch(/dry-run/);
    expect(fs.existsSync(CLIENT_SPECS["codex"].configPath(home))).toBe(false);
    expect(fs.existsSync(CLIENT_SPECS["claude-code"].configPath(home))).toBe(false);
  });

  it("status reports per-client state without writing", async () => {
    const home = tmpHome();
    const before = await installCommand({ clientsRaw: "codex", status: true }, { homeDir: home, url: URL });
    expect(before.output).toMatch(/codex: not installed/);
    await installCommand({ clientsRaw: "codex" }, { homeDir: home, url: URL });
    const after = await installCommand({ clientsRaw: "codex", status: true }, { homeDir: home, url: URL });
    expect(after.output).toMatch(/codex: installed/);
  });

  it("rejects unknown clients and changes nothing", async () => {
    const home = tmpHome();
    const res = await installCommand({ clientsRaw: "vscode" }, { homeDir: home, url: URL });
    expect(res.exitCode).toBe(2);
    expect(res.output).toMatch(/Unsupported client\(s\): vscode/);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
