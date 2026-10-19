import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_STATE_DIR_NAME,
  STATE_DIR_NAME,
  legacyStateDir,
  migrateLegacyStateDir,
  stateDir,
} from "../src/migrate.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "apple-debug-migrate-"));
}

describe("migrateLegacyStateDir (temp HOME fixtures)", () => {
  it("moves the legacy state dir to the new path, preserving contents", () => {
    const home = tmpHome();
    const from = legacyStateDir(home);
    fs.mkdirSync(from, { recursive: true });
    fs.writeFileSync(path.join(from, "state.json"), JSON.stringify({ seq: 1, leases: [] }));
    const logs: string[] = [];
    const res = migrateLegacyStateDir(home, (m) => logs.push(m));
    expect(res).toMatchObject({ migrated: true, from, to: stateDir(home) });
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(path.join(stateDir(home), "state.json"), "utf8")).toContain('"seq":1');
    expect(logs.join("\n")).toContain(from);
    expect(logs.join("\n")).toContain(stateDir(home));
  });

  it("does nothing when the new dir already exists (legacy left alone)", () => {
    const home = tmpHome();
    fs.mkdirSync(stateDir(home), { recursive: true });
    fs.writeFileSync(path.join(stateDir(home), "state.json"), "new");
    fs.mkdirSync(legacyStateDir(home), { recursive: true });
    fs.writeFileSync(path.join(legacyStateDir(home), "state.json"), "legacy");
    const logs: string[] = [];
    expect(migrateLegacyStateDir(home, (m) => logs.push(m))).toEqual({ migrated: false });
    expect(fs.readFileSync(path.join(stateDir(home), "state.json"), "utf8")).toBe("new");
    expect(fs.existsSync(legacyStateDir(home))).toBe(true);
    expect(logs).toEqual([]);
  });

  it("does nothing when no legacy dir exists", () => {
    const home = tmpHome();
    const logs: string[] = [];
    expect(migrateLegacyStateDir(home, (m) => logs.push(m))).toEqual({ migrated: false });
    expect(fs.existsSync(stateDir(home))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("ignores a legacy path that is not a directory", () => {
    const home = tmpHome();
    fs.writeFileSync(legacyStateDir(home), "not a dir");
    expect(migrateLegacyStateDir(home, () => {})).toEqual({ migrated: false });
    expect(fs.existsSync(stateDir(home))).toBe(false);
  });

  it("uses the expected dir names", () => {
    expect(STATE_DIR_NAME).toBe(".apple-debug-mcp");
    expect(LEGACY_STATE_DIR_NAME).toBe(".sim-orchestration-mcp");
  });
});
