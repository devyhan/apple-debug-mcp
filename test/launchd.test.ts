import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Runner } from "../src/exec.js";
import {
  LAUNCHD_LABEL,
  LEGACY_LAUNCHD_LABEL,
  MANAGED_MARKER,
  countLeases,
  diffPlists,
  isManagedPlist,
  launchdCreate,
  launchdRestart,
  launchdStatus,
  legacyPlistPath,
  parsePlistEnv,
  plistPath,
  renderPlist,
  resolveDaemonPath,
} from "../src/launchd.js";

function plistOpts() {
  return {
    nodePath: "/usr/local/bin/node",
    daemonPath: "/repo/dist/index.js",
    workdir: "/repo",
    pathDirs: ["/home/u/.npm-global/bin", "/opt/homebrew/bin"],
    port: 3100,
    host: "127.0.0.1",
    logPath: "/home/u/.apple-debug-mcp/daemon.log",
  };
}

describe("renderPlist", () => {
  it("renders label, node+dist args, env, keepalive, and one log path", () => {
    const text = renderPlist(plistOpts());
    expect(text).toContain(LAUNCHD_LABEL);
    expect(text).toContain("/usr/local/bin/node");
    expect(text).toContain("/repo/dist/index.js");
    expect(text).toContain("SIM_MCP_PORT</key>\n    <string>3100</string>");
    expect(text).toContain("/home/u/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    const logHits = text.split("/home/u/.apple-debug-mcp/daemon.log").length - 1;
    expect(logHits).toBe(2); // StandardOutPath + StandardErrorPath, same file
    expect(text).toContain(MANAGED_MARKER);
  });

  it("uses a bare bin path (no node wrapper) for the npm-global entry", () => {
    const text = renderPlist({ ...plistOpts(), daemonPath: "/home/u/.npm-global/bin/apple-debug-mcp" });
    expect(text).not.toContain("/usr/local/bin/node");
    expect(text).toContain("/home/u/.npm-global/bin/apple-debug-mcp");
  });

  it("escapes XML metacharacters in paths", () => {
    const text = renderPlist({ ...plistOpts(), workdir: "/a&b<c>" });
    expect(text).toContain("/a&amp;b&lt;c&gt;");
  });
});

describe("isManagedPlist / diffPlists / parsePlistEnv", () => {
  it("detects the managed marker", () => {
    expect(isManagedPlist(renderPlist(plistOpts()))).toBe(true);
    expect(isManagedPlist("<plist>hand edited</plist>")).toBe(false);
  });

  it("diffs line-wise with -/+ prefixes", () => {
    const diff = diffPlists("a\nb\nc", "a\nB\nc");
    expect(diff).toContain("- b");
    expect(diff).toContain("+ B");
    expect(diffPlists("same\n", "same\n")).toEqual([]);
  });

  it("parses port/host/PATH from an existing plist", () => {
    const env = parsePlistEnv(renderPlist({ ...plistOpts(), port: 3210, host: "0.0.0.0" }));
    expect(env).toMatchObject({ port: 3210, host: "0.0.0.0" });
    expect(env.pathValue).toContain("/opt/homebrew/bin");
    expect(parsePlistEnv("<plist/>")).toEqual({});
  });
});

describe("resolveDaemonPath", () => {
  it("prefers the npm-global bin when present", () => {
    const res = resolveDaemonPath({
      homeDir: "/home/u",
      exists: (p) => p === "/home/u/.npm-global/bin/apple-debug-mcp",
    });
    expect(res.daemonPath).toBe("/home/u/.npm-global/bin/apple-debug-mcp");
    expect(res.fallbackWarning).toBeUndefined();
  });

  it("falls back to dist with a loud warning", () => {
    const res = resolveDaemonPath({ homeDir: "/home/u", distPath: "/repo/dist/index.js", exists: () => false });
    expect(res.daemonPath).toBe("/repo/dist/index.js");
    expect(res.fallbackWarning).toMatch(/WARNING/);
    expect(res.fallbackWarning).toMatch(/npm install -g/);
  });

  it("honors an explicit override", () => {
    const res = resolveDaemonPath({ envDaemonPath: "/custom/daemon.js", exists: () => true });
    expect(res.daemonPath).toBe("/custom/daemon.js");
  });
});

describe("countLeases", () => {
  it("counts leases, tolerates missing/garbage state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-lease-"));
    const state = path.join(dir, "state.json");
    expect(countLeases(state)).toBe(0);
    fs.writeFileSync(state, JSON.stringify({ seq: 1, leases: [{ leaseId: "a" }, { leaseId: "b" }] }));
    expect(countLeases(state)).toBe(2);
    fs.writeFileSync(state, "not json");
    expect(countLeases(state)).toBe(0);
  });
});

describe("launchd commands (stubbed runner)", () => {
  function tmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-home-"));
  }

  /**
   * Stub runner: launchctl list fails (= not loaded) unless told otherwise.
   * Pass a label list to load only those labels (for legacy-handoff tests).
   */
  function stubRunner(loaded: boolean | string[] = false): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    const run = (async (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      if (bin === "launchctl" && args[0] === "list") {
        const label = args[1] ?? "";
        const isLoaded = Array.isArray(loaded) ? loaded.includes(label) : loaded;
        if (!isLoaded) throw new Error("Could not find service");
        return { stdout: `{\n"Label" = "${label}";\n"PID" = 123;\n}`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as Runner & { calls: string[][] };
    run.calls = calls;
    return run;
  }

  it("create writes a managed plist and loads it", async () => {
    const home = tmpHome();
    const runner = stubRunner(false);
    const res = await launchdCreate(
      { port: 3210 },
      { runner, homeDir: home, exists: () => false, distPath: path.join(home, "repo", "dist", "index.js") },
    );
    expect(res.exitCode).toBe(0);
    const plist = plistPath(home);
    expect(fs.existsSync(plist)).toBe(true);
    const text = fs.readFileSync(plist, "utf8");
    expect(isManagedPlist(text)).toBe(true);
    expect(parsePlistEnv(text).port).toBe(3210);
    expect(runner.calls).toContainEqual(["launchctl", "load", plist]);
    expect(res.output).toMatch(/WARNING/); // dist fallback warning is loud
  });

  it("create preserves the existing port across regen", async () => {
    const home = tmpHome();
    const runner = stubRunner(false);
    await launchdCreate({ port: 3220 }, { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" });
    const res = await launchdCreate({}, { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" });
    expect(res.exitCode).toBe(0);
    expect(parsePlistEnv(fs.readFileSync(plistPath(home), "utf8")).port).toBe(3220);
  });

  it("create refuses to overwrite a hand-edited plist without --force", async () => {
    const home = tmpHome();
    const plist = plistPath(home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<plist>hand-edited, no marker</plist>");
    const res = await launchdCreate({}, { runner: stubRunner(false), homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" });
    expect(res.exitCode).toBe(2);
    expect(res.output).toMatch(/hand-edited/);
    expect(res.output).toMatch(/--force/);
    expect(fs.readFileSync(plist, "utf8")).toContain("hand-edited");
    const forced = await launchdCreate({ force: true }, { runner: stubRunner(false), homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" });
    expect(forced.exitCode).toBe(0);
    expect(isManagedPlist(fs.readFileSync(plist, "utf8"))).toBe(true);
  });

  it("restart refuses when leases are held unless --force", async () => {
    const home = tmpHome();
    const runner = stubRunner([LAUNCHD_LABEL]);
    await launchdCreate({}, { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" });
    const state = path.join(home, ".apple-debug-mcp", "state.json");
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ seq: 1, leases: [{ leaseId: "lease_1" }] }));
    const refused = await launchdRestart({ stateFile: state }, { runner, homeDir: home });
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toMatch(/1 active lease/);
    expect(refused.output).toMatch(/--force/);
    const forced = await launchdRestart({ force: true, stateFile: state }, { runner, homeDir: home });
    expect(forced.exitCode).toBe(0);
    expect(runner.calls).toContainEqual(["launchctl", "unload", plistPath(home)]);
    expect(runner.calls).toContainEqual(["launchctl", "load", plistPath(home)]);
  });

  it("create refuses while the legacy job is loaded (guided handoff, never auto-unloads)", async () => {
    const home = tmpHome();
    const runner = stubRunner([LEGACY_LAUNCHD_LABEL]);
    const res = await launchdCreate(
      {},
      { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" },
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain(LEGACY_LAUNCHD_LABEL);
    expect(res.output).toContain("never unloads it automatically");
    expect(res.output).toContain("launchctl remove com.sim-orchestration-mcp");
    expect(res.output).toContain("apple-debug-mcp launchd create");
    expect(fs.existsSync(plistPath(home))).toBe(false);
    expect(runner.calls.filter(([bin, sub]) => bin === "launchctl" && sub !== "list")).toEqual([]);
  });

  it("create refuses while a legacy plist file exists, even with --force", async () => {
    const home = tmpHome();
    const legacyPlist = legacyPlistPath(home);
    fs.mkdirSync(path.dirname(legacyPlist), { recursive: true });
    fs.writeFileSync(legacyPlist, "<plist>legacy</plist>");
    for (const force of [false, true]) {
      const runner = stubRunner(false);
      const res = await launchdCreate(
        { force },
        { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" },
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.output).toContain(`rm ${legacyPlist}`);
      expect(fs.existsSync(plistPath(home))).toBe(false);
      expect(runner.calls.filter(([bin, sub]) => bin === "launchctl" && sub !== "list")).toEqual([]);
    }
    // Guided handoff completes once the operator removes the legacy plist.
    fs.rmSync(legacyPlist);
    const runner = stubRunner(false);
    const res = await launchdCreate(
      {},
      { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" },
    );
    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(plistPath(home))).toBe(true);
  });

  it("create prints unload + rm when the legacy job is loaded from its plist", async () => {
    const home = tmpHome();
    const legacyPlist = legacyPlistPath(home);
    fs.mkdirSync(path.dirname(legacyPlist), { recursive: true });
    fs.writeFileSync(legacyPlist, "<plist>legacy</plist>");
    const runner = stubRunner([LEGACY_LAUNCHD_LABEL]);
    const res = await launchdCreate(
      {},
      { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" },
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain(`launchctl unload ${legacyPlist}`);
    expect(res.output).toContain(`rm ${legacyPlist}`);
  });

  it("status reports plist + loaded + /health version", async () => {
    const home = tmpHome();
    const runner = stubRunner([LAUNCHD_LABEL]);
    await launchdCreate({}, { runner, homeDir: home, exists: () => false, distPath: "/repo/dist/index.js" });
    const res = await launchdStatus(
      { port: 3100 },
      { runner, homeDir: home, fetchHealth: async () => ({ ok: true, version: "0.1.0" }) },
    );
    expect(res.output).toMatch(/plist: .*present/);
    expect(res.output).toMatch(/loaded: yes/);
    expect(res.output).toMatch(/reachable.*0\.1\.0/);
    const down = await launchdStatus({ port: 3100 }, { runner, homeDir: home, fetchHealth: async () => ({ ok: false }) });
    expect(down.output).toMatch(/unreachable/);
  });
});
