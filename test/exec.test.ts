import { describe, expect, it } from "vitest";
import { TRUNCATION_MARKER, runBounded, tailTruncationMarker } from "../src/exec.js";

describe("runBounded", () => {
  it("resolves stdout on natural exit", async () => {
    const res = await runBounded("echo", ["hello"], { timeoutMs: 5000 });
    expect(res).toMatchObject({ stdout: "hello\n", truncated: false, timedOut: false });
  });

  it("truncates to the head past maxChars with a suffix marker", async () => {
    const res = await runBounded("echo", ["0123456789abcdef"], { timeoutMs: 5000, maxChars: 8, keep: "head" });
    expect(res.truncated).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe("01234567" + TRUNCATION_MARKER);
  });

  it("defaults to tail truncation keeping the last maxChars", async () => {
    const res = await runBounded("sh", ["-c", "printf 0123456789abcdef"], { timeoutMs: 5000, maxChars: 8 });
    expect(res.truncated).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe(tailTruncationMarker(8) + "89abcdef");
  });

  it("keeps the tail with an explicit keep and names dropped head chars", async () => {
    const res = await runBounded("sh", ["-c", "printf 0123456789abcdef"], {
      timeoutMs: 5000,
      maxChars: 4,
      keep: "tail",
    });
    expect(res.truncated).toBe(true);
    expect(res.stdout).toBe("…[truncated 12 chars]\n" + "cdef");
    expect(tailTruncationMarker(12)).toBe("…[truncated 12 chars]\n");
  });

  it("leaves short output untouched in either mode", async () => {
    for (const keep of ["head", "tail"] as const) {
      const res = await runBounded("sh", ["-c", "printf abc"], { timeoutMs: 5000, maxChars: 8, keep });
      expect(res).toMatchObject({ stdout: "abc", truncated: false, timedOut: false });
    }
  });

  it("resolves (never rejects) on timeout", async () => {
    const start = Date.now();
    const res = await runBounded("sleep", ["30"], { timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(res).toMatchObject({ truncated: false, timedOut: true });
  });

  it("keeps partial output captured before the timeout", async () => {
    const res = await runBounded("sh", ["-c", "echo hello; sleep 30"], { timeoutMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(res.stdout).toContain("hello");
  });

  it("rejects when the binary cannot be spawned", async () => {
    await expect(runBounded("definitely-not-a-real-binary-xyz", [], { timeoutMs: 1000 })).rejects.toThrow();
  });
});
