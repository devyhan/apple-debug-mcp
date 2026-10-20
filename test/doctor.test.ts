import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatDoctorReport, runDoctor } from "../src/doctor.js";
import { Runner } from "../src/exec.js";

/** Stub runner keyed by "bin args...": value = stdout, or Error to throw. */
function stubRunner(map: Record<string, string | Error>): Runner {
  return (async (bin: string, args: string[]) => {
    const key = `${bin} ${args.join(" ")}`;
    const val = map[key] ?? map[bin];
    if (val instanceof Error) throw val;
    if (typeof val === "string") return { stdout: val, stderr: "" };
    throw new Error(`unexpected call: ${key}`);
  }) as Runner;
}

const ALL_OK: Record<string, string> = {
  "xcrun simctl list devices": "devices…",
  "simslim version": "simslim 1.2.3",
  "axe --version": "axe 0.1.0",
  "serve-sim --version": "serve-sim 2.0.0",
  "llmdb --version": "llmdb 3.0.0",
  "mitmdump --version": "mitmdump 11",
  "tcpdump --version": "tcpdump version 4.99.1",
  "launchctl list": "not used",
};

function loadedLaunchctl(): Record<string, string> {
  return { ...ALL_OK, "launchctl list com.apple-debug-mcp": '{\n"Label" = "com.apple-debug-mcp";\n}' };
}

function tmpHome(withPlist: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-doctor-"));
  if (withPlist) {
    const dir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "com.apple-debug-mcp.plist"), "<plist/>");
  }
  return home;
}

describe("doctor (stubbed runner)", () => {
  it("passes everything when the environment is healthy", async () => {
    const checks = await runDoctor({
      runner: stubRunner(loadedLaunchctl()),
      homeDir: tmpHome(true),
      fetchHealth: async () => ({ ok: true, version: "0.1.0" }),
    });
    expect(checks.every((c) => c.status === "pass")).toBe(true);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["tcpdump"]!.status).toBe("pass");
    expect(byName["tcpdump"]!.detail).toMatch(/tcpdump version/);
    const { exitCode, text } = formatDoctorReport(checks);
    expect(exitCode).toBe(0);
    expect(text).toMatch(/all checks passed/);
  });

  it("fails required checks with exact fix commands", async () => {
    const fail = new Error("command not found");
    const checks = await runDoctor({
      runner: stubRunner({
        ...loadedLaunchctl(),
        "xcrun simctl list devices": fail,
        "simslim version": fail,
        "axe --version": fail,
      }),
      homeDir: tmpHome(true),
      fetchHealth: async () => ({ ok: true, version: "0.1.0" }),
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["xcode/sim-runtime"]!.status).toBe("fail");
    expect(byName["xcode/sim-runtime"]!.fix).toMatch(/xcode-select/);
    expect(byName["simslim"]!.status).toBe("fail");
    expect(byName["simslim"]!.fix).toMatch(/brew install mobai-app\/tap\/simslim/);
    expect(byName["axe"]!.status).toBe("fail");
    expect(byName["axe"]!.fix).toMatch(/brew install cameroncooke\/axe\/axe/);
    const { exitCode, text } = formatDoctorReport(checks);
    expect(exitCode).toBe(1);
    expect(text).toMatch(/3 check\(s\) failed/);
  });

  it("warns (never fails) on missing optional binaries", async () => {
    const fail = new Error("command not found");
    const checks = await runDoctor({
      runner: stubRunner({
        ...loadedLaunchctl(),
        "serve-sim --version": fail,
        "llmdb --version": fail,
        "mitmdump --version": fail,
        "tcpdump --version": fail,
      }),
      homeDir: tmpHome(true),
      fetchHealth: async () => ({ ok: true, version: "0.1.0" }),
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["serve-sim"]!.status).toBe("warn");
    expect(byName["serve-sim"]!.fix).toMatch(/npm install -g serve-sim/);
    expect(byName["llmdb"]!.fix).toMatch(/brew install alexmx\/tools\/llmdb/);
    expect(byName["mitmdump"]!.fix).toMatch(/brew install mitmproxy/);
    expect(byName["tcpdump"]!.status).toBe("warn");
    expect(byName["tcpdump"]!.fix).toMatch(/TCPDUMP_BIN/);
    expect(formatDoctorReport(checks).exitCode).toBe(0);
  });

  it("fails launchd + daemon checks with exact fix commands when down", async () => {
    const checks = await runDoctor({
      runner: stubRunner({ ...ALL_OK, "launchctl list com.apple-debug-mcp": new Error("no such service") }),
      homeDir: tmpHome(false),
      fetchHealth: async () => ({ ok: false }),
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["launchd"]!.status).toBe("fail");
    expect(byName["launchd"]!.fix).toMatch(/launchd create/);
    const daemon = checks.find((c) => c.name.startsWith("daemon :"))!;
    expect(daemon.status).toBe("fail");
    expect(daemon.fix).toMatch(/launchd/);
    expect(formatDoctorReport(checks).exitCode).toBe(1);
  });

  it("distinguishes present-but-unloaded plist", async () => {
    const checks = await runDoctor({
      runner: stubRunner({ ...ALL_OK, "launchctl list com.apple-debug-mcp": new Error("no such service") }),
      homeDir: tmpHome(true),
      fetchHealth: async () => ({ ok: true }),
    });
    const launchd = checks.find((c) => c.name === "launchd")!;
    expect(launchd.status).toBe("fail");
    expect(launchd.detail).toMatch(/not loaded/);
    expect(launchd.fix).toMatch(/launchctl load/);
  });
});
