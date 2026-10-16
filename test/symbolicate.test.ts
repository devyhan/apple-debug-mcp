import { describe, expect, it } from "vitest";
import { ExecOptions, Runner } from "../src/exec.js";
import { Symbolicator } from "../src/symbolicate.js";

interface Call {
  bin: string;
  args: string[];
  opts?: ExecOptions;
}

function stubRunner(handler: (bin: string, args: string[]) => string = () => ""): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bin: string, args: string[], opts?: ExecOptions) => {
    calls.push({ bin, args, opts });
    return { stdout: handler(bin, args), stderr: "" };
  }) as Runner & { calls: Call[] };
  run.calls = calls;
  return run;
}

describe("Symbolicator wrapper", () => {
  it("symbolicates pcs against a binary and returns per-address lines", async () => {
    const run = stubRunner(() => "main (in DebugApp) (main.swift:12)\nfoo() (in DebugApp) (util.swift:3)\n");
    const sym = new Symbolicator({ runner: run });
    const res = await sym.symbolicate(["0x100234567", "0x1002345ab"], { binary: "/tmp/DebugApp" });
    expect(run.calls[0]).toMatchObject({ bin: "atos", args: ["-o", "/tmp/DebugApp", "0x100234567", "0x1002345ab"] });
    expect(res).toMatchObject({
      binary: "/tmp/DebugApp",
      addresses: ["0x100234567", "0x1002345ab"],
      symbols: ["main (in DebugApp) (main.swift:12)", "foo() (in DebugApp) (util.swift:3)"],
    });
  });

  it("threads arch and load address flags", async () => {
    const run = stubRunner(() => "x\n");
    await new Symbolicator({ runner: run }).symbolicate(["0x1000"], {
      binary: "/tmp/App",
      arch: "arm64",
      loadAddr: "0x100000000",
    });
    expect(run.calls[0]?.args).toEqual(["-o", "/tmp/App", "-arch", "arm64", "-l", "0x100000000", "0x1000"]);
  });

  it("requires a binary (live-pid mode is not exposed)", async () => {
    const run = stubRunner(() => "");
    const sym = new Symbolicator({ runner: run });
    await expect(sym.symbolicate(["0x1000"])).rejects.toThrow(/binary/);
    await expect(sym.symbolicate(["0x1000"], { binary: "  " })).rejects.toThrow(/binary/);
    expect(run.calls).toHaveLength(0);
  });

  it("rejects empty, oversized, and malformed pc lists", async () => {
    const run = stubRunner(() => "");
    const sym = new Symbolicator({ runner: run });
    await expect(sym.symbolicate([])).rejects.toThrow(/pcs/);
    await expect(sym.symbolicate(["0x1000", "xyz-nope"], { binary: "/bin/ls" })).rejects.toThrow(/pc/);
    await expect(sym.symbolicate([""], { binary: "/bin/ls" })).rejects.toThrow(/pc/);
    await expect(sym.symbolicate(new Array(101).fill("0x1"), { binary: "/bin/ls" })).rejects.toThrow(/too many pcs/i);
    await expect(sym.symbolicate(["0x1000"], { binary: "/bin/ls", arch: "  " })).rejects.toThrow(/arch/);
    await expect(sym.symbolicate(["0x1000"], { binary: "/bin/ls", loadAddr: "nope" })).rejects.toThrow(/load_addr/);
    expect(run.calls).toHaveLength(0);
  });

  it("checks availability via -h", async () => {
    const run = stubRunner(() => "Usage: atos [-p pid] ...\n");
    await expect(new Symbolicator({ runner: run }).checkAvailable()).resolves.toBe("Usage: atos [-p pid] ...");
    expect(run.calls[0]?.args).toEqual(["-h"]);
  });
});
