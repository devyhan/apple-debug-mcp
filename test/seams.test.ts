import { describe, expect, it } from "vitest";
import type { AppOps } from "../src/appops.js";
import { Axe, type TapTarget } from "../src/axe.js";
import type { Runner } from "../src/exec.js";
import { type LaunchResult, SimApps } from "../src/simapps.js";
import type { UiDriver } from "../src/uidriver.js";

function stubRunner(stdout = ""): Runner & { calls: { bin: string; args: string[] }[] } {
  const calls: { bin: string; args: string[] }[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { stdout, stderr: "" };
  }) as Runner & { calls: { bin: string; args: string[] }[] };
  run.calls = calls;
  return run;
}

describe("driver seams", () => {
  it("Axe satisfies UiDriver and routes through it", async () => {
    const run = stubRunner("ok");
    const driver: UiDriver = new Axe({ runner: run });
    await driver.button("U1", "home");
    expect(run.calls[0]?.args).toEqual(["button", "home", "--udid", "U1"]);
  });

  it("SimApps satisfies AppOps and routes through it", async () => {
    const run = stubRunner("com.example.App: 4242");
    const apps: AppOps = new SimApps({ runner: run });
    const result = await apps.launch("U1", "com.example.App");
    expect(result.pid).toBe(4242);
    expect(run.calls[0]?.args).toEqual(["simctl", "launch", "U1", "com.example.App"]);
  });

  it("axe.ts and simapps.ts still re-export the moved types", () => {
    // Compile-time proof: these annotations resolve through the re-exports.
    const target: TapTarget = { label: "OK" };
    const result: LaunchResult = { pid: 1, output: "x" };
    expect(target.label).toBe("OK");
    expect(result.pid).toBe(1);
  });
});
