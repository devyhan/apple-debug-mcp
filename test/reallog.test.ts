import { describe, expect, it } from "vitest";
import { BoundedOptions, BoundedResult } from "../src/exec.js";
import type { LogOps } from "../src/logops.js";
import { RealSyslog } from "../src/realsyslog.js";
import { BoundedRunner, SimLog } from "../src/simlog.js";

function stubBounded(handler: (bin: string, args: string[]) => BoundedResult): BoundedRunner & {
  calls: { bin: string; args: string[]; opts: BoundedOptions }[];
} {
  const calls: { bin: string; args: string[]; opts: BoundedOptions }[] = [];
  const run = (async (bin: string, args: string[], opts: BoundedOptions) => {
    calls.push({ bin, args, opts });
    return handler(bin, args);
  }) as BoundedRunner & { calls: { bin: string; args: string[]; opts: BoundedOptions }[] };
  run.calls = calls;
  return run;
}

const LINES = [
  '{"app":"Maps","msg":"route started"}',
  '{"app":"Prefs","msg":"opened"}',
  '{"app":"Maps","msg":"route done"}',
].join("\n");

describe("LogOps seam", () => {
  it("SimLog satisfies LogOps and routes through it", async () => {
    const run = stubBounded(() => ({ stdout: "log-body", truncated: false, timedOut: true }));
    const log: LogOps = new SimLog({ runner: run });
    const r = await log.stream("U1", { timeoutSec: 5 });
    expect(r.stdout).toBe("log-body");
    expect(run.calls[0]?.bin).toBe("xcrun");
  });

  it("RealSyslog satisfies LogOps", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const log: LogOps = new RealSyslog({ runner: run });
    const r = await log.stream("R1", { timeoutSec: 5 });
    expect(r.stdout).toBe(LINES);
    expect(r.timedOut).toBe(true);
  });
});

describe("RealSyslog.stream", () => {
  it("relays ios syslog with the same timeout/maxChars/tail semantics", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const r = await new RealSyslog({ runner: run }).stream("R1", { timeoutSec: 7, maxChars: 500 });
    expect(run.calls[0]).toMatchObject({
      bin: "ios",
      args: ["syslog", "--udid=R1"],
      opts: { timeoutMs: 7000, maxChars: 500, keep: "tail" },
    });
    expect(r).toMatchObject({ stdout: LINES, truncated: false, timedOut: true });
  });

  it("filters by process substring", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const r = await new RealSyslog({ runner: run }).stream("R1", { process: "Prefs" });
    expect(r.stdout).toBe('{"app":"Prefs","msg":"opened"}');
  });

  it("extracts process == clauses as substring filters", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const r = await new RealSyslog({ runner: run }).stream("R1", { predicate: 'process == "Maps"' });
    expect(r.stdout).toBe('{"app":"Maps","msg":"route started"}\n{"app":"Maps","msg":"route done"}');
  });

  it("treats other predicates as full-text regex, with literal fallback", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const log = new RealSyslog({ runner: run });
    const re = await log.stream("R1", { predicate: "route (started|done)" });
    expect(re.stdout.split("\n")).toHaveLength(2);
    const lit = await log.stream("R1", { predicate: '{"app":"Prefs"' });
    expect(lit.stdout).toBe('{"app":"Prefs","msg":"opened"}');
    const invalidRe = await log.stream("R1", { predicate: "route (started" });
    expect(invalidRe.stdout).toBe(""); // invalid regex ⇒ literal substring, no line contains it
  });

  it("rejects non-default levels, accepts an explicit default no-op", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const log = new RealSyslog({ runner: run });
    await expect(log.stream("R1", { level: "info" })).rejects.toThrow(/level "info" is not supported on real devices/);
    await expect(log.stream("R1", { level: "debug" })).rejects.toThrow(/no level filter/);
    await expect(log.stream("R1", { level: "default" })).resolves.toMatchObject({ timedOut: true });
    expect(run.calls).toHaveLength(1); // rejections never spawn
  });

  it("tail-truncates filtered output past maxChars", async () => {
    const run = stubBounded(() => ({ stdout: LINES, truncated: false, timedOut: true }));
    const r = await new RealSyslog({ runner: run }).stream("R1", { maxChars: 10 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeGreaterThan(10); // marker + last 10 chars
    expect(r.stdout.endsWith(LINES.slice(-10))).toBe(true);
  });

  it("preserves the runner truncated flag when filtering keeps everything", async () => {
    const run = stubBounded(() => ({ stdout: "abc", truncated: true, timedOut: false }));
    const r = await new RealSyslog({ runner: run }).stream("R1", {});
    expect(r).toMatchObject({ stdout: "abc", truncated: true, timedOut: false });
  });

  it("validates udid and timeoutSec without spawning", async () => {
    const run = stubBounded(() => ({ stdout: "", truncated: false, timedOut: true }));
    const log = new RealSyslog({ runner: run });
    await expect(log.stream("  ", {})).rejects.toThrow(/udid/i);
    await expect(log.stream("R1", { timeoutSec: 0 })).rejects.toThrow(/timeoutSec/);
    await expect(log.stream("R1", { timeoutSec: 61 })).rejects.toThrow(/timeoutSec/);
    expect(run.calls).toHaveLength(0);
  });
});

describe("RealSyslog.show", () => {
  it("fails with stream-instead guidance (live-only relay)", async () => {
    const run = stubBounded(() => ({ stdout: "", truncated: false, timedOut: false }));
    await expect(new RealSyslog({ runner: run }).show("R1", { last: "5m" })).rejects.toThrow(
      /live-only.*sim_log_stream/s,
    );
    expect(run.calls).toHaveLength(0);
  });
});
