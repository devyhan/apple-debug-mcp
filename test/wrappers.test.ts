import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Axe } from "../src/axe.js";
import { ExecError, Runner } from "../src/exec.js";
import { Simslim } from "../src/simslim.js";
import { Store } from "../src/store.js";

function stubRunner(responses: Record<string, string> = {}): Runner & { calls: { bin: string; args: string[] }[] } {
  const calls: { bin: string; args: string[] }[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    const key = `${bin} ${args[0] ?? ""}`;
    if (key in responses) return { stdout: responses[key]!, stderr: "" };
    return { stdout: "", stderr: "" };
  }) as Runner & { calls: { bin: string; args: string[] }[] };
  run.calls = calls;
  return run;
}

describe("Simslim wrapper", () => {
  it("parses list --json", async () => {
    const run = stubRunner({
      "simslim list": JSON.stringify([{ udid: "U1", name: "iPhone 17", state: "Shutdown", platform: "iOS", osVersion: "26.5" }]),
    });
    const simslim = new Simslim({ runner: run });
    const devices = await simslim.list();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ udid: "U1", state: "Shutdown" });
    expect(run.calls[0]?.args).toEqual(["list", "--json"]);
  });

  it("returns null status for a shutdown sim", async () => {
    const run: Runner = async () => {
      throw new ExecError("simslim", ["status"], 1, "", "simulator must be booted to read its state (it is Shutdown)");
    };
    const simslim = new Simslim({ runner: run });
    await expect(simslim.slimStatus("U1")).resolves.toBeNull();
  });

  it("parses the real status --json shape", async () => {
    const run = stubRunner({
      "simslim status": JSON.stringify({ managedDisabled: 168, managedTotal: 168, booted: true, persistent: true }),
    });
    const simslim = new Simslim({ runner: run });
    const status = await simslim.slimStatus("U1");
    expect(status).toMatchObject({ slim: true, managedDisabled: 168, managedTotal: 168, persistent: true });
  });

  it("builds slimOn args", async () => {
    const run = stubRunner();
    const simslim = new Simslim({ runner: run });
    await simslim.slimOn("U1", { except: "store,web", noReboot: true });
    expect(run.calls[0]).toMatchObject({ bin: "simslim", args: ["on", "U1", "--except", "store,web", "--no-reboot"] });
  });
});

describe("Axe wrapper", () => {
  it("builds tap with label targeting", async () => {
    const run = stubRunner();
    const axe = new Axe({ runner: run });
    await axe.tap("U1", { label: "Sign In", waitTimeout: 5 });
    expect(run.calls[0]?.args).toEqual(["tap", "--udid", "U1", "--label", "Sign In", "--wait-timeout", "5"]);
  });

  it("types via stdin", async () => {
    let seen: { bin: string; args: string[]; stdin?: string } | null = null;
    const run: Runner = async (bin, args, opts) => {
      seen = { bin, args, stdin: opts?.stdin };
      return { stdout: "", stderr: "" };
    };
    const axe = new Axe({ runner: run });
    await axe.typeText("U1", "hello world");
    expect(seen).toMatchObject({ bin: "axe", args: ["type", "--stdin", "--udid", "U1"], stdin: "hello world" });
  });

  it("rejects unsupported batch steps", async () => {
    const axe = new Axe({ runner: stubRunner() });
    await expect(axe.batch("U1", ["screenshot --output x.png"])).rejects.toThrow(/unsupported batch step/i);
  });

  it("passes repeated --step flags", async () => {
    const run = stubRunner();
    const axe = new Axe({ runner: run });
    await axe.batch("U1", ["tap --label OK", "sleep 1"], { continueOnError: true });
    expect(run.calls[0]?.args).toEqual([
      "batch", "--udid", "U1", "--step", "tap --label OK", "--step", "sleep 1", "--continue-on-error",
    ]);
  });
});

describe("Store", () => {
  it("persists leases and waiting tickets across reloads", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-store-")), "state.json");
    const store = Store.load(file);
    await store.mutate((s) => {
      s.seq = 7;
      s.leases.push({
        leaseId: "lease_1", udid: "U1", sessionId: "s", client: "orca",
        createdAt: 1, lastHeartbeat: 1, ttlMs: 1000, deviceKind: "sim",
      });
      s.tickets.push({
        ticketId: "ticket_2", sessionId: "s2", client: "tma", requirements: {},
        autoBoot: true, slim: true, createdAt: 2, status: "waiting",
      });
      return { value: undefined, dirty: true };
    });
    const reloaded = Store.load(file);
    const leases = await reloaded.read((s) => s.leases);
    const tickets = await reloaded.read((s) => s.tickets);
    expect(leases).toHaveLength(1);
    expect(tickets).toHaveLength(1);
    expect(await reloaded.read((s) => s.seq)).toBe(7);
  });

  it("starts fresh on a missing file", () => {
    const store = Store.load(path.join(os.tmpdir(), `sim-mcp-missing-${Date.now()}`, "state.json"));
    expect(store).toBeDefined();
  });
});
