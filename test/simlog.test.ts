import { describe, expect, it } from "vitest";
import { BoundedResult } from "../src/exec.js";
import { BoundedRunner, SimLog, escapePredicateValue, validatePredicate } from "../src/simlog.js";

function stubBounded(result: Partial<BoundedResult> = {}): BoundedRunner & {
  calls: { bin: string; args: string[]; timeoutMs: number; maxChars?: number; keep?: string }[];
} {
  const calls: { bin: string; args: string[]; timeoutMs: number; maxChars?: number; keep?: string }[] = [];
  const run = (async (bin: string, args: string[], opts: { timeoutMs: number; maxChars?: number; keep?: string }) => {
    calls.push({ bin, args, timeoutMs: opts.timeoutMs, maxChars: opts.maxChars, keep: opts.keep });
    return { stdout: "", truncated: false, timedOut: false, ...result };
  }) as BoundedRunner & {
    calls: { bin: string; args: string[]; timeoutMs: number; maxChars?: number; keep?: string }[];
  };
  run.calls = calls;
  return run;
}

describe("SimLog", () => {
  it("streams via simctl spawn with predicate and timeout", async () => {
    const run = stubBounded({ stdout: "line\n", timedOut: true });
    const res = await new SimLog({ runner: run }).stream("U1", {
      predicate: 'process == "SpringBoard"',
      timeoutSec: 5,
      maxChars: 1000,
    });
    expect(run.calls[0]).toMatchObject({
      bin: "xcrun",
      args: [
        "simctl",
        "spawn",
        "U1",
        "log",
        "stream",
        "--style",
        "compact",
        "--level",
        "default",
        "--predicate",
        'process == "SpringBoard"',
      ],
      timeoutMs: 5000,
      maxChars: 1000,
    });
    expect(res).toMatchObject({ stdout: "line\n", timedOut: true, truncated: false });
  });

  it("streams without predicate by default", async () => {
    const run = stubBounded();
    await new SimLog({ runner: run }).stream("U1");
    expect(run.calls[0]?.args).toEqual([
      "simctl",
      "spawn",
      "U1",
      "log",
      "stream",
      "--style",
      "compact",
      "--level",
      "default",
    ]);
    expect(run.calls[0]?.timeoutMs).toBe(10_000);
  });

  it("rejects timeoutSec outside (0, 60]", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await expect(log.stream("U1", { timeoutSec: 61 })).rejects.toThrow(/timeoutSec/i);
    await expect(log.stream("U1", { timeoutSec: 0 })).rejects.toThrow(/timeoutSec/i);
    await expect(log.stream("U1", { timeoutSec: -1 })).rejects.toThrow(/timeoutSec/i);
    expect(run.calls).toHaveLength(0);
  });

  it("shows history with --last and predicate", async () => {
    const run = stubBounded({ stdout: "old\n" });
    const res = await new SimLog({ runner: run }).show("U1", {
      last: "30s",
      predicate: 'process == "geod"',
    });
    expect(run.calls[0]).toMatchObject({
      bin: "xcrun",
      args: ["simctl", "spawn", "U1", "log", "show", "--style", "compact", "--last", "30s", "--predicate", 'process == "geod"'],
    });
    expect(res).toMatchObject({ stdout: "old\n", timedOut: false });
  });

  it("defaults show to the last minute", async () => {
    const run = stubBounded();
    await new SimLog({ runner: run }).show("U1");
    expect(run.calls[0]?.args).toContain("--last");
    expect(run.calls[0]?.args).toContain("1m");
  });

  it("rejects malformed --last windows", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    for (const last of ["5x", "m", "1d", "", "1 m", "--last", "1.5m"]) {
      await expect(log.show("U1", { last })).rejects.toThrow(/invalid last/i);
    }
    for (const last of ["5s", "10m", "2h"]) {
      await log.show("U1", { last });
    }
    expect(run.calls).toHaveLength(3);
  });

  it("relays truncation flags from the bounded runner", async () => {
    const run = stubBounded({ stdout: "cut…[truncated]", truncated: true, timedOut: false });
    const res = await new SimLog({ runner: run }).show("U1", { last: "2h", maxChars: 10 });
    expect(res).toMatchObject({ truncated: true, timedOut: false });
    expect(run.calls[0]?.maxChars).toBe(10);
  });

  it("passes keep:tail to the bounded runner for stream and show", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await log.stream("U1");
    await log.show("U1");
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.keep).toBe("tail");
    expect(run.calls[1]?.keep).toBe("tail");
  });

  it("streams with --level info and debug", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await log.stream("U1", { level: "info" });
    await log.stream("U1", { level: "debug" });
    expect(run.calls[0]?.args).toContain("--level");
    expect(run.calls[0]?.args).toEqual(
      expect.arrayContaining(["--level", "info"]),
    );
    expect(run.calls[1]?.args).toEqual(expect.arrayContaining(["--level", "debug"]));
  });

  it("rejects invalid stream levels", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    for (const level of ["verbose", "INFO", "", "default "] as never[]) {
      await expect(log.stream("U1", { level })).rejects.toThrow(/invalid level/i);
    }
    expect(run.calls).toHaveLength(0);
  });

  it("shows with --info, --debug and --signpost", async () => {
    const run = stubBounded();
    await new SimLog({ runner: run }).show("U1", { info: true, debug: true, signpost: true });
    expect(run.calls[0]?.args).toEqual([
      "simctl",
      "spawn",
      "U1",
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      "1m",
      "--info",
      "--debug",
      "--signpost",
    ]);
  });

  it("omits show verbosity flags when false or unset", async () => {
    const run = stubBounded();
    await new SimLog({ runner: run }).show("U1", { info: false, debug: false });
    expect(run.calls[0]?.args).not.toContain("--info");
    expect(run.calls[0]?.args).not.toContain("--debug");
    expect(run.calls[0]?.args).not.toContain("--signpost");
  });

  it("rejects empty predicates naming the problem", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await expect(log.stream("U1", { predicate: "" })).rejects.toThrow(/non-empty/i);
    await expect(log.show("U1", { predicate: "   " })).rejects.toThrow(/non-empty/i);
    expect(run.calls).toHaveLength(0);
  });

  it("rejects predicates with unbalanced double-quotes", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await expect(log.stream("U1", { predicate: 'process == "Foo' })).rejects.toThrow(/double-quote/i);
    await expect(log.show("U1", { predicate: 'process == Foo"' })).rejects.toThrow(/double-quote/i);
    expect(run.calls).toHaveLength(0);
    expect(() => validatePredicate('a == "b')).toThrow(/double-quote/i);
  });

  it("rejects predicates with unbalanced parentheses", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await expect(log.stream("U1", { predicate: '(process == "x"' })).rejects.toThrow(/parentheses/i);
    await expect(log.show("U1", { predicate: 'process == "x"))' })).rejects.toThrow(/parentheses/i);
    expect(run.calls).toHaveLength(0);
    expect(() => validatePredicate("((a)")).toThrow(/parentheses/i);
  });

  it("accepts parens inside quoted strings", async () => {
    const run = stubBounded();
    await new SimLog({ runner: run }).stream("U1", { predicate: 'process == "My(App)"' });
    expect(run.calls).toHaveLength(1);
    expect(() => validatePredicate('(a == "x") AND (b == "y(z)")')).not.toThrow();
  });

  it("escapes quotes and backslashes in predicate values", () => {
    expect(escapePredicateValue("plain")).toBe("plain");
    expect(escapePredicateValue('My"App')).toBe('My\\"App');
    expect(escapePredicateValue("a\\b")).toBe("a\\\\b");
    expect(escapePredicateValue('a\\"b')).toBe('a\\\\\\"b');
  });

  it("builds a process predicate for stream and show", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await log.stream("U1", { process: "MyApp" });
    await log.show("U1", { process: "geod" });
    expect(run.calls[0]?.args).toEqual(expect.arrayContaining(["--predicate", 'process == "MyApp"']));
    expect(run.calls[1]?.args).toEqual(expect.arrayContaining(["--predicate", 'process == "geod"']));
  });

  it("escapes the process name inside the built predicate", async () => {
    const run = stubBounded();
    await new SimLog({ runner: run }).show("U1", { process: 'My"App' });
    expect(run.calls[0]?.args).toEqual(expect.arrayContaining(["--predicate", 'process == "My\\"App"']));
  });

  it("ANDs process with an explicit predicate", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await log.stream("U1", { process: "MyApp", predicate: 'eventType == "log"' });
    await log.show("U1", { predicate: 'messageType == "error"', process: "geod" });
    expect(run.calls[0]?.args).toEqual(
      expect.arrayContaining(["--predicate", 'process == "MyApp" AND eventType == "log"']),
    );
    expect(run.calls[1]?.args).toEqual(
      expect.arrayContaining(["--predicate", 'process == "geod" AND messageType == "error"']),
    );
  });

  it("rejects empty process names", async () => {
    const run = stubBounded();
    const log = new SimLog({ runner: run });
    await expect(log.stream("U1", { process: "" })).rejects.toThrow(/process/i);
    await expect(log.show("U1", { process: "  " })).rejects.toThrow(/process/i);
    expect(run.calls).toHaveLength(0);
  });
});
