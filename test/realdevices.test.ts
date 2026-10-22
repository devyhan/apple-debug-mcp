import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecError, Runner } from "../src/exec.js";
import { RealDeviceApps, RealDevices, mapDevicectlDevice } from "../src/realdevices.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

interface Call {
  bin: string;
  args: string[];
}

/**
 * Fake `xcrun devicectl` (file-only JSON: writes the mapped fixture to the
 * `-j` path, like the real CLI) + fake `ios`. devicectl and ios handlers are
 * per-test; anything else throws.
 */
function stubRunner(opts: {
  devicectl?: (args: string[]) => string;
  ios?: (args: string[]) => { stdout: string; stderr: string };
}): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args: [...args] });
    if (bin === "xcrun" && args[0] === "devicectl") {
      if (args[1] === "--version") return { stdout: "devicectl 518.33\n", stderr: "" };
      const file = args[args.indexOf("-j") + 1]!;
      fs.writeFileSync(file, opts.devicectl!(args));
      return { stdout: "", stderr: "" };
    }
    if (bin === "ios") {
      if (args[0] === "--version") return { stdout: "go-ios local-build\n", stderr: "" };
      return opts.ios!(args);
    }
    throw new Error(`unexpected call: ${bin} ${args.join(" ")}`);
  }) as Runner & { calls: Call[] };
  run.calls = calls;
  return run;
}

const LIST_JSON = fixture("devicectl-list.json");

function listRunner(): Runner & { calls: Call[] } {
  return stubRunner({ devicectl: () => LIST_JSON });
}

describe("RealDevices inventory", () => {
  it("maps devicectl JSON to PoolDevice rows with lockdown udids", async () => {
    const devices = await new RealDevices({ runner: listRunner() }).list();
    expect(devices).toHaveLength(3);
    const byUdid = Object.fromEntries(devices.map((d) => [d.udid, d]));
    const avail = byUdid["00008140-000555603453001C"]!;
    expect(avail).toMatchObject({
      name: "iPhone 16 Pro Max",
      state: "available",
      platform: "iOS",
      osVersion: "27.0.1",
      kind: "real",
      transport: "wifi",
      trust: { paired: true, developerMode: "enabled" },
    });
    expect(avail.coredeviceId).toBe("000A1FED-73CC-57FF-9285-339181AB988E");
    expect(byUdid["00008110-000529EE1406401E"]!.state).toBe("unavailable");
    expect(byUdid["00008006-0000A8101AEB002E"]).toMatchObject({ state: "unavailable", platform: "watchOS" });
  });

  it("drops entries without a lockdown udid (unaddressable)", () => {
    expect(mapDevicectlDevice({ identifier: "x", hardwareProperties: {} })).toBeNull();
    expect(mapDevicectlDevice({ hardwareProperties: { udid: "U1" } })).toBeNull();
  });

  it("skips null/non-object entries instead of failing the whole inventory", async () => {
    type Entry = Parameters<typeof mapDevicectlDevice>[0];
    expect(mapDevicectlDevice(null as unknown as Entry)).toBeNull();
    expect(mapDevicectlDevice("x" as unknown as Entry)).toBeNull();
    const run = stubRunner({
      devicectl: () => JSON.stringify({ result: { devices: [null, { identifier: "c1", hardwareProperties: { udid: "U1" } }] } }),
    });
    const devices = await new RealDevices({ runner: run }).list();
    expect(devices.map((d) => d.udid)).toEqual(["U1"]);
  });

  it("list() rejects when result.devices[] is missing", async () => {
    const run = stubRunner({ devicectl: () => JSON.stringify({ result: {} }) });
    await expect(new RealDevices({ runner: run }).list()).rejects.toThrow(/unexpected JSON.*devices/);
  });

  it("maps connected tunnel state to usb transport", () => {
    const row = mapDevicectlDevice({
      identifier: "core-1",
      deviceProperties: { name: "USB Phone", osVersionNumber: "26.1", developerModeStatus: "enabled" },
      hardwareProperties: { udid: "USB-UDID", platform: "iOS" },
      connectionProperties: { pairingState: "paired", tunnelState: "connected" },
    });
    expect(row).toMatchObject({ state: "available", transport: "usb", trust: { paired: true, developerMode: "enabled" } });
  });

  it("checkAvailable resolves with the devicectl version", async () => {
    await expect(new RealDevices({ runner: listRunner() }).checkAvailable()).resolves.toContain("518.33");
  });

  it("list failures name xcrun devicectl, with a pairing checklist on trust errors", async () => {
    const fail = (stderr: string) =>
      stubRunner({
        devicectl: () => {
          throw new ExecError("xcrun", ["devicectl"], 1, "", stderr);
        },
      });
    await expect(new RealDevices({ runner: fail("device not paired") }).list()).rejects.toThrow(/paired.*Checklist/s);
    await expect(new RealDevices({ runner: fail("weird failure") }).list()).rejects.toThrow(/weird failure/);
  });
});

describe("RealDeviceApps", () => {
  it("install/uninstall/terminate shell out to ios with --udid last", async () => {
    const run = stubRunner({ ios: () => ({ stdout: "", stderr: "" }) });
    const apps = new RealDeviceApps({ runner: run });
    await apps.install("R1", "/tmp/MyApp.app");
    await apps.uninstall("R1", "com.example.App");
    await apps.terminate("R1", "com.example.App");
    expect(run.calls).toEqual([
      { bin: "ios", args: ["install", "--path=/tmp/MyApp.app", "--udid=R1"] },
      { bin: "ios", args: ["uninstall", "com.example.App", "--udid=R1"] },
      { bin: "ios", args: ["kill", "com.example.App", "--udid=R1"] },
    ]);
  });

  it("launch passes argv as --arg flags and parses the logged pid", async () => {
    const run = stubRunner({ ios: () => ({ stdout: "", stderr: 'time=now level=INFO msg="Process launched" pid=4242' }) });
    const res = await new RealDeviceApps({ runner: run }).launch("R1", "com.example.App", ["-a", "x"]);
    expect(run.calls[0]).toEqual({ bin: "ios", args: ["launch", "com.example.App", "--arg=-a", "--arg=x", "--udid=R1"] });
    expect(res.pid).toBe(4242);
  });

  it("launch reports pid -1 when ios output is unparseable", async () => {
    const run = stubRunner({ ios: () => ({ stdout: "launched-ish", stderr: "" }) });
    const res = await new RealDeviceApps({ runner: run }).launch("R1", "com.example.App");
    expect(res).toMatchObject({ pid: -1, output: "launched-ish" });
  });

  it("rejects blank inputs without spawning", async () => {
    const run = stubRunner({ ios: () => ({ stdout: "", stderr: "" }) });
    const apps = new RealDeviceApps({ runner: run });
    await expect(apps.install("R1", "  ")).rejects.toThrow(/app_path/i);
    await expect(apps.uninstall("R1", "")).rejects.toThrow(/bundle_id/i);
    await expect(apps.launch("", "com.example.App")).rejects.toThrow(/udid/i);
    await expect(apps.terminate("R1", " ")).rejects.toThrow(/bundle_id/i);
    expect(run.calls).toHaveLength(0);
  });

  it("missing ios binary fails with install steps (never a guessed brew formula)", async () => {
    const run = stubRunner({
      ios: () => {
        throw new ExecError("ios", ["install"], "ENOENT", "", "spawn ios ENOENT");
      },
    });
    await expect(new RealDeviceApps({ runner: run }).install("R1", "/tmp/A.app")).rejects.toThrow(
      /npm install -g go-ios.*IOS_BIN.*sudo ios tunnel start/s,
    );
  });

  it("ios failures name the devicectl/go-ios seam checklist", async () => {
    const run = stubRunner({
      ios: () => {
        throw new ExecError("ios", ["launch"], 1, "", "tunnel unavailable");
      },
    });
    await expect(new RealDeviceApps({ runner: run }).launch("R1", "com.example.App")).rejects.toThrow(
      /visible to devicectl but unreachable via go-ios/,
    );
  });

  it("openUrl/clearCache stay P2 with the no-transport detail", async () => {
    const apps = new RealDeviceApps({ runner: stubRunner({}) });
    await expect(apps.openUrl("R1", "https://x.test")).rejects.toThrow(/P2.*no CLI transport/s);
    await expect(apps.clearCache("R1", "com.example.App")).rejects.toThrow(/P2.*no CLI transport/s);
  });

  it("checkAvailable resolves with the ios version", async () => {
    await expect(new RealDeviceApps({ runner: stubRunner({}) }).checkAvailable()).resolves.toContain("go-ios");
  });
});

describe("RealDeviceApps.listRunning (devicectl join)", () => {
  function joinRunner(): Runner & { calls: Call[] } {
    return stubRunner({
      devicectl: (args) =>
        args.includes("processes") ? fixture("devicectl-processes.json") : fixture("devicectl-apps.json"),
    });
  }

  it("joins process container UUIDs against app urls", async () => {
    const running = await new RealDeviceApps({ runner: joinRunner() }).listRunning("R1");
    expect([...running]).toEqual(["com.fixture.running-app"]);
  });

  it("passes --device <lockdown-udid> to both devicectl calls", async () => {
    const run = joinRunner();
    await new RealDeviceApps({ runner: run }).listRunning("R1");
    const infos = run.calls.filter((c) => c.args.includes("info"));
    expect(infos).toHaveLength(2);
    for (const c of infos) expect(c.args).toContain("R1");
  });

  it("never throws: devicectl failure yields an empty set", async () => {
    const run = stubRunner({
      devicectl: () => {
        throw new Error("tunnel down");
      },
    });
    await expect(new RealDeviceApps({ runner: run }).listRunning("R1")).resolves.toEqual(new Set());
  });
});
