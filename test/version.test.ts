import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __resetVersionCache, getGitSha, getServerInfo, getVersion, readPackageVersion } from "../src/version.js";

describe("version", () => {
  it("reads the version from package.json (single source)", () => {
    __resetVersionCache();
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(getVersion()).toBe(pkg.version);
  });

  it("readPackageVersion rejects a package.json without a version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-ver-"));
    const pkg = path.join(dir, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ name: "x" }));
    expect(() => readPackageVersion(pkg)).toThrow(/version/);
  });

  it("getServerInfo carries name + version and an optional git sha", () => {
    __resetVersionCache();
    const info = getServerInfo();
    expect(info.name).toBe("sim-orchestration-mcp");
    expect(info.version).toBe(getVersion());
    const sha = getGitSha();
    if (sha === undefined) {
      expect(info.gitSha).toBeUndefined();
    } else {
      expect(info.gitSha).toMatch(/^[0-9a-f]+$/);
    }
  });
});
