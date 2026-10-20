import { describe, expect, it } from "vitest";
import { parseJson, Runner } from "../src/exec.js";
import { Llmdb } from "../src/llmdb.js";
import { MAX_STARTUP_GRACE_SEC, XCTrace } from "../src/xctrace.js";

const ok: Runner = async () => ({ stdout: "", stderr: "" });

describe("input-hardening", () => {
  it("clamps startupGraceSec to its upper bound", async () => {
    let timeoutMs = 0;
    const run: Runner = async (_b, _a, opts) => {
      timeoutMs = opts?.timeoutMs ?? 0;
      return { stdout: "", stderr: "" };
    };
    const trace = new XCTrace({ runner: run, exists: () => true });
    await trace.record("U1", "/tmp/x.trace", { startupGraceSec: 9999 });
    expect(MAX_STARTUP_GRACE_SEC).toBe(600);
    expect(timeoutMs).toBe((5 + 600) * 1000);
    await trace.record("U1", "/tmp/x.trace", { startupGraceSec: 10 });
    expect(timeoutMs).toBe((5 + 10) * 1000);
  });

  it("fails when the trace output file is missing post-run", async () => {
    const missing = new XCTrace({ runner: ok, exists: () => false });
    await expect(missing.record("U1", "/tmp/x.trace")).rejects.toThrow(/output not found/);
    const present = new XCTrace({ runner: ok, exists: () => true });
    await expect(present.record("U1", "/tmp/x.trace")).resolves.toMatchObject({ path: "/tmp/x.trace" });
  });

  it("parseJson tolerates log prefixes before { or [", () => {
    expect(parseJson('Port 1 busy, killing pid(s): 2\n{"port": 1}', "x")).toMatchObject({ port: 1 });
    expect(parseJson<unknown[]>('noise\n[1,2]', "x")).toEqual([1, 2]);
    expect(parseJson('{"a":1}', "x")).toMatchObject({ a: 1 });
    expect(() => parseJson("no json here", "x")).toThrow(/Failed to parse x/);
  });

  it("stop() requires a session id", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_b, args) => {
      calls.push(args);
      return { stdout: "{}", stderr: "" };
    };
    const lldmdb = new Llmdb({ runner: run });
    await expect((lldmdb.stop as (id?: string) => Promise<unknown>)(undefined)).rejects.toThrow(/session_id/);
    await expect(lldmdb.stop("  ")).rejects.toThrow(/session_id/);
    expect(calls).toHaveLength(0);
    await lldmdb.stop("sess-1");
    expect(calls).toEqual([["stop", "--session", "sess-1"]]);
  });
});
