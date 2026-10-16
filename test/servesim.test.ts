import { describe, expect, it } from "vitest";
import { ExecError, Runner } from "../src/exec.js";
import { ServeSim } from "../src/servesim.js";

function stubRunner(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }): Runner & {
  calls: { bin: string; args: string[] }[];
} {
  const calls: { bin: string; args: string[] }[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return handler(bin, args);
  }) as Runner & { calls: { bin: string; args: string[] }[] };
  run.calls = calls;
  return run;
}

const NO_SERVER = new ExecError(
  "serve-sim",
  ["rotate"],
  1,
  "",
  "No serve-sim server running. Run `serve-sim` first.",
);

describe("ServeSim", () => {
  it("reports the version from checkAvailable", async () => {
    const run = stubRunner(() => ({ stdout: "0.1.48\n", stderr: "" }));
    await expect(new ServeSim({ runner: run }).checkAvailable()).resolves.toBe("0.1.48");
    expect(run.calls[0]?.args).toEqual(["--version"]);
  });

  it("rotates with -d device selection", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    await new ServeSim({ runner: run }).rotate("U1", "landscape_left");
    expect(run.calls[0]).toMatchObject({ bin: "serve-sim", args: ["rotate", "-d", "U1", "landscape_left"] });
  });

  it("rejects invalid orientations without spawning", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const sim = new ServeSim({ runner: run });
    await expect(sim.rotate("U1", "sideways")).rejects.toThrow(/invalid orientation/i);
    await expect(sim.rotate("U1", "landscape")).rejects.toThrow(/invalid orientation/i);
    expect(run.calls).toHaveLength(0);
  });

  it("toggles ca-debug flags with on/off state", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    await new ServeSim({ runner: run }).caDebug("U1", "offscreen", "on");
    expect(run.calls[0]?.args).toEqual(["ca-debug", "-d", "U1", "offscreen", "on"]);
  });

  it("rejects invalid ca-debug options and states", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    const sim = new ServeSim({ runner: run });
    await expect(sim.caDebug("U1", "everything", "on")).rejects.toThrow(/invalid ca-debug option/i);
    await expect(sim.caDebug("U1", "blended", "enable")).rejects.toThrow(/invalid ca-debug state/i);
    expect(run.calls).toHaveLength(0);
  });

  it("sends memory warnings with -d device selection", async () => {
    const run = stubRunner(() => ({ stdout: "", stderr: "" }));
    await new ServeSim({ runner: run }).memoryWarning("U1");
    expect(run.calls[0]?.args).toEqual(["memory-warning", "-d", "U1"]);
  });

  it("spawns a helper and retries once when no server is running", async () => {
    let attempts = 0;
    const run = stubRunner((_bin, args) => {
      if (args[0] === "rotate") {
        attempts += 1;
        if (attempts === 1) throw NO_SERVER;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "--detach") return { stdout: `{"port":3100,"device":"U1"}`, stderr: "" };
      if (args[0] === "--list") return { stdout: `{"running":true,"device":"U1","pid":1234}`, stderr: "" };
      throw new Error(`unexpected args ${args.join(" ")}`);
    });
    await new ServeSim({ runner: run, portBase: 45500 }).rotate("U1", "portrait");
    expect(run.calls.map((c) => c.args[0])).toEqual(["rotate", "--detach", "--list", "rotate"]);
    // Regression: detach MUST carry --port (bare --detach binds :3100 and SIGKILLs its occupant).
    const detach = run.calls[1]?.args ?? [];
    expect(detach.slice(0, 3)).toEqual(["--detach", "U1", "--port"]);
    expect(Number(detach[3])).toBeGreaterThanOrEqual(45500);
  });

  it("tracks helper pids per udid and reuses them", async () => {
    const run = stubRunner((_bin, args) => {
      if (args[0] === "--detach") return { stdout: `{"port":3100}`, stderr: "" };
      if (args[0] === "--list") return { stdout: `{"running":true,"pid":4321}`, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const sim = new ServeSim({ runner: run });
    await expect(sim.ensureHelper("U1")).resolves.toBe(4321);
    await expect(sim.ensureHelper("U1")).resolves.toBe(4321);
    expect(run.calls.filter((c) => c.args[0] === "--detach")).toHaveLength(1);
    expect(sim.helperPids().get("U1")).toBe(4321);
  });

  it("does not retry errors other than no-server", async () => {
    const run = stubRunner(() => {
      throw new ExecError("serve-sim", ["rotate"], 1, "", "boom");
    });
    await expect(new ServeSim({ runner: run }).rotate("U1", "portrait")).rejects.toThrow(/boom/);
    expect(run.calls).toHaveLength(1);
  });

  it("kills per-device and forgets the helper", async () => {
    const run = stubRunner((_bin, args) => {
      if (args[0] === "--detach") return { stdout: `{"port":3100}`, stderr: "" };
      if (args[0] === "--list") return { stdout: `{"running":true,"pid":9}`, stderr: "" };
      return { stdout: `{"disconnected":true}`, stderr: "" };
    });
    const sim = new ServeSim({ runner: run });
    await sim.ensureHelper("U1");
    await sim.kill("U1");
    expect(run.calls.at(-1)?.args).toEqual(["--kill", "U1"]);
    expect(sim.helperPids().has("U1")).toBe(false);
  });

  it("kills all streams when no udid is given", async () => {
    const run = stubRunner(() => ({ stdout: `{"killed":2}`, stderr: "" }));
    await new ServeSim({ runner: run }).kill();
    expect(run.calls[0]?.args).toEqual(["--kill"]);
  });
});
