import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecError, Runner } from "../src/exec.js";
import { RealDeviceApps, RealDevices, mapDevicectlDevice, parseFsyncTreeTopLevel } from "../src/realdevices.js";

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
  devicectlRaw?: (args: string[]) => { stdout: string; stderr: string };
  ios?: (args: string[]) => { stdout: string; stderr: string };
}): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args: [...args] });
    if (bin === "xcrun" && args[0] === "devicectl") {
      if (args[1] === "--version") return { stdout: "devicectl 518.33\n", stderr: "" };
      if (!args.includes("-j")) {
        if (!opts.devicectlRaw) throw new Error(`unexpected non-JSON devicectl call: ${args.join(" ")}`);
        return opts.devicectlRaw(args);
      }
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
      transport: "usb",
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

  it("maps transportType wired to usb (tunnelState disconnected does NOT mean wifi)", () => {
    // Observed live: USB-attached iPhone reports tunnelState "disconnected"
    // with transportType "wired". Bearer comes ONLY from transportType.
    const row = mapDevicectlDevice({
      identifier: "core-1",
      deviceProperties: { name: "USB Phone", osVersionNumber: "27.0.1", developerModeStatus: "enabled" },
      hardwareProperties: { udid: "USB-UDID", platform: "iOS" },
      connectionProperties: { pairingState: "paired", tunnelState: "disconnected", transportType: "wired" },
    });
    expect(row).toMatchObject({ state: "available", transport: "usb", trust: { paired: true, developerMode: "enabled" } });
  });

  it("leaves transport undefined when transportType is absent", () => {
    const row = mapDevicectlDevice({
      identifier: "core-2",
      hardwareProperties: { udid: "U2" },
      connectionProperties: { pairingState: "paired", tunnelState: "disconnected" },
    });
    expect(row).toMatchObject({ state: "available" });
    expect(row!.transport).toBeUndefined();
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

  it("kill of a non-running app keeps the device error, never the install hint (live: process not found)", async () => {
    const run = stubRunner({
      ios: () => {
        throw new ExecError("ios", ["kill", "com.example.App", "--udid=R1"], 1, "", "process not found");
      },
    });
    const err = await new RealDeviceApps({ runner: run }).terminate("R1", "com.example.App").catch((e) => e);
    expect(String(err?.message ?? err)).toContain("process not found");
    expect(String(err?.message ?? err)).not.toContain("is not installed");
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

  it("openUrl opens http(s) via devicectl Safari launch with --payload-url", async () => {
    const run = stubRunner({ devicectlRaw: () => ({ stdout: "", stderr: "" }) });
    const apps = new RealDeviceApps({ runner: run });
    await apps.openUrl("R1", "https://www.apple.com");
    await apps.openUrl("R1", "http://x.test/a?b=c");
    expect(run.calls).toEqual([
      { bin: "xcrun", args: ["devicectl", "device", "process", "launch", "--device", "R1", "--payload-url", "https://www.apple.com", "com.apple.mobilesafari"] },
      { bin: "xcrun", args: ["devicectl", "device", "process", "launch", "--device", "R1", "--payload-url", "http://x.test/a?b=c", "com.apple.mobilesafari"] },
    ]);
  });

  it("openUrl rejects blank udid / invalid url without spawning", async () => {
    const run = stubRunner({});
    const apps = new RealDeviceApps({ runner: run });
    await expect(apps.openUrl("", "https://x.test")).rejects.toThrow(/udid/i);
    await expect(apps.openUrl("R1", "  ")).rejects.toThrow(/url/i);
    await expect(apps.openUrl("R1", "not-a-url")).rejects.toThrow(/scheme/i);
    expect(run.calls).toHaveLength(0);
  });

  it("openUrl refuses non-http(s) schemes with a precise P2 (no stock-handler dispatch)", async () => {
    const run = stubRunner({});
    const apps = new RealDeviceApps({ runner: run });
    await expect(apps.openUrl("R1", "myapp://open")).rejects.toThrow(/P2.*stock-handler/s);
    await expect(apps.openUrl("R1", "tel:+15550001111")).rejects.toThrow(/P2/);
    expect(run.calls).toHaveLength(0);
  });

  it("openUrl device failures keep device text + pairing checklist, never a missing-binary claim", async () => {
    const fail = (stderr: string) =>
      stubRunner({
        devicectlRaw: () => {
          throw new ExecError("xcrun", ["devicectl"], 1, "", stderr);
        },
      });
    const paired = await new RealDeviceApps({ runner: fail("device not paired") })
      .openUrl("R1", "https://x.test").catch((e) => e as Error);
    expect(paired.message).toMatch(/paired.*Checklist/s);
    const other = await new RealDeviceApps({ runner: fail("some device failure") })
      .openUrl("R1", "https://x.test").catch((e) => e as Error);
    expect(other.message).toContain("some device failure");
    expect(other.message).not.toContain("is not installed");
  });

  it("openUrl without Xcode names devicectl install steps", async () => {
    const run = stubRunner({
      devicectlRaw: () => {
        throw new ExecError("xcrun", ["devicectl"], "ENOENT", "", "spawn xcrun ENOENT");
      },
    });
    await expect(new RealDeviceApps({ runner: run }).openUrl("R1", "https://x.test")).rejects.toThrow(
      /devicectl is not installed/,
    );
  });

  it("clearCache validates inputs without spawning, then maps fsync denials to the precise measured P2", async () => {
    const run = stubRunner({});
    const apps = new RealDeviceApps({ runner: run });
    await expect(apps.clearCache("R1", "")).rejects.toThrow(/bundle_id/i);
    await expect(apps.clearCache("", "com.example.App")).rejects.toThrow(/udid/i);
    await expect(
      apps.clearCache("R1", "com.example.App", { plistKeys: [{ plist: "Library/Preferences/x.plist", keys: [] }] }),
    ).rejects.toThrow(/keys must be a non-empty array/);
    expect(run.calls).toHaveLength(0);

    // Each measured denial form → the SAME precise P2, never a
    // missing-binary claim, and no rm spawned (probe-before-delete).
    const denials = [
      "ContainerLookupErrorDomain ErrorCode:3",
      "VendContainer denied (InstallationLookupFailed): Full container access requires an app installed with a developer profile",
      "CoreDevice.ActionError error 3",
    ];
    for (const denial of denials) {
      const denied = stubRunner({
        ios: (args) => {
          if (args[0] === "kill") return { stdout: "", stderr: "" };
          throw new ExecError("ios", args, 1, "", denial);
        },
      });
      const err = await new RealDeviceApps({ runner: denied }).clearCache("R1", "com.example.App").catch((e) => e as Error);
      expect(err.message).toMatch(/P2/);
      expect(err.message).toMatch(/container-delete/);
      expect(err.message).toMatch(/developer.profile/);
      expect(err.message).toMatch(/ContainerLookupErrorDomain/);
      expect(err.message).not.toContain("is not installed");
      expect(denied.calls.filter((c) => c.args[1] === "rm")).toHaveLength(0);
    }
  });

  it("clearCache clears Caches via fsync tree + per-entry rm on dev-profile installs", async () => {
    const tree = "Library/Caches\n|-AdMob\n|-Assets/\n|  |-nested.txt\n|-probe.txt\n";
    const run = stubRunner({
      ios: (args) => {
        if (args[0] === "kill") return { stdout: "", stderr: "" };
        if (args[0] === "fsync" && args[1] === "tree") return { stdout: tree, stderr: "" };
        if (args[0] === "fsync" && args[1] === "rm") return { stdout: "", stderr: "" };
        throw new Error(`unexpected ios call: ${args.join(" ")}`);
      },
    });
    const r = await new RealDeviceApps({ runner: run }).clearCache("R1", "com.example.App");
    expect(run.calls[0]).toEqual({ bin: "ios", args: ["kill", "com.example.App", "--udid=R1"] });
    expect(run.calls[1]).toEqual({
      bin: "ios",
      args: ["fsync", "tree", "--app=com.example.App", "--udid=R1", "--path=Library/Caches"],
    });
    expect(run.calls.filter((c) => c.args[1] === "rm")).toEqual([
      { bin: "ios", args: ["fsync", "rm", "--r", "--app=com.example.App", "--udid=R1", "--path=Library/Caches/AdMob"] },
      { bin: "ios", args: ["fsync", "rm", "--r", "--app=com.example.App", "--udid=R1", "--path=Library/Caches/Assets"] },
      { bin: "ios", args: ["fsync", "rm", "--r", "--app=com.example.App", "--udid=R1", "--path=Library/Caches/probe.txt"] },
    ]);
    expect(r).toMatchObject({
      container: "ios-fsync://R1/com.example.App",
      cachesDir: "ios-fsync://R1/com.example.App/Library/Caches",
      deletedCount: 3,
      terminated: true,
      errors: [],
      plistKeysRemoved: [],
    });
    expect(r.deleted).toEqual([
      "ios-fsync://R1/com.example.App/Library/Caches/AdMob",
      "ios-fsync://R1/com.example.App/Library/Caches/Assets",
      "ios-fsync://R1/com.example.App/Library/Caches/probe.txt",
    ]);
  });

  it("clearCache tolerates terminate failure and per-entry rm failure (fail-soft)", async () => {
    const tree = "Library/Caches\n|-a\n|-b\n";
    const run = stubRunner({
      ios: (args) => {
        if (args[0] === "kill") throw new ExecError("ios", args, 1, "", "process not found");
        if (args[0] === "fsync" && args[1] === "tree") return { stdout: tree, stderr: "" };
        if (args[0] === "fsync" && args[1] === "rm") {
          if (args.includes("--path=Library/Caches/a")) throw new ExecError("ios", args, 1, "", "afc write denied for a");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected ios call: ${args.join(" ")}`);
      },
    });
    const r = await new RealDeviceApps({ runner: run }).clearCache("R1", "com.example.App");
    expect(r.terminated).toBe(false);
    expect(r.deletedCount).toBe(1);
    expect(r.deleted).toEqual(["ios-fsync://R1/com.example.App/Library/Caches/b"]);
    expect(r.errors.join("\n")).toMatch(/terminate.*process not found/s);
    expect(r.errors.join("\n")).toMatch(/delete a/);
  });

  it("clearCache treats a missing Caches dir (ObjectNotFound) as empty, with no deletes", async () => {
    const run = stubRunner({
      ios: (args) => {
        if (args[0] === "kill") return { stdout: "", stderr: "" };
        throw new ExecError(
          "ios",
          args,
          1,
          "",
          '{"level":"ERROR","msg":"fsync: tree view failed","err":"error listing afc dir: afc error code: 8 (ObjectNotFound)"}',
        );
      },
    });
    const r = await new RealDeviceApps({ runner: run }).clearCache("R1", "com.example.App");
    expect(r.deleted).toEqual([]);
    expect(r.deletedCount).toBe(0);
    expect(r.terminated).toBe(true);
    expect(run.calls.filter((c) => c.args[1] === "rm")).toHaveLength(0);
  });

  it("clearCache refuses plist_keys on real devices without spawning", async () => {
    const run = stubRunner({ ios: () => ({ stdout: "", stderr: "" }) });
    const err = await new RealDeviceApps({ runner: run })
      .clearCache("R1", "com.example.App", { plistKeys: [{ plist: "Library/Preferences/com.example.App.plist", keys: ["k"] }] })
      .catch((e) => e as Error);
    expect(err.message).toMatch(/plist_keys.*not supported.*fsync/s);
    expect(run.calls).toHaveLength(0);
  });

  it("clearCache maps an rm-time denial to P2 instead of partial-delete + ok", async () => {
    const tree = "Library/Caches\n|-a\n|-b\n";
    const run = stubRunner({
      ios: (args) => {
        if (args[0] === "kill") return { stdout: "", stderr: "" };
        if (args[0] === "fsync" && args[1] === "tree") return { stdout: tree, stderr: "" };
        throw new ExecError("ios", args, 1, "", "ContainerLookupErrorDomain ErrorCode:3");
      },
    });
    await expect(new RealDeviceApps({ runner: run }).clearCache("R1", "com.example.App")).rejects.toThrow(
      /P2.*container-delete/s,
    );
  });

  it("clearCache keeps the install hint when ios is genuinely missing (probe ENOENT)", async () => {
    const run = stubRunner({
      ios: () => {
        throw new ExecError("ios", ["fsync"], "ENOENT", "", "spawn ios ENOENT");
      },
    });
    const err = await new RealDeviceApps({ runner: run }).clearCache("R1", "com.example.App").catch((e) => e as Error);
    expect(err.message).toMatch(/not installed.*npm install -g go-ios/s);
    expect(err.message).not.toMatch(/P2/);
  });

  it("clearCache refuses escaping tree entries without spawning rm for them", async () => {
    const tree = "Library/Caches\n|-ok\n|-../evil\n|-a/b\n";
    const run = stubRunner({
      ios: (args) => {
        if (args[0] === "kill") return { stdout: "", stderr: "" };
        if (args[0] === "fsync" && args[1] === "tree") return { stdout: tree, stderr: "" };
        if (args[0] === "fsync" && args[1] === "rm") return { stdout: "", stderr: "" };
        throw new Error(`unexpected ios call: ${args.join(" ")}`);
      },
    });
    const r = await new RealDeviceApps({ runner: run }).clearCache("R1", "com.example.App");
    expect(r.deleted).toEqual(["ios-fsync://R1/com.example.App/Library/Caches/ok"]);
    expect(r.errors.join("\n")).toMatch(/refused to delete outside Caches/);
    expect(run.calls.filter((c) => c.args[1] === "rm")).toHaveLength(1);
  });

  it("checkAvailable resolves with the ios version", async () => {
    await expect(new RealDeviceApps({ runner: stubRunner({}) }).checkAvailable()).resolves.toContain("go-ios");
  });
});

describe("parseFsyncTreeTopLevel", () => {
  it("returns sorted depth-0 entries, skipping nested lines and the root", () => {
    const out = "Library/Caches\n|-probe.txt\n|  |-nested.txt\n|  |  |  |-probe.txt\n|-AdMob\n";
    expect(parseFsyncTreeTopLevel(out)).toEqual(["AdMob", "probe.txt"]);
  });

  it("strips a trailing dir slash and skips blank lines", () => {
    expect(parseFsyncTreeTopLevel("Library/Caches\n\n|-Assets/\n")).toEqual(["Assets"]);
  });

  it("returns [] for empty output", () => {
    expect(parseFsyncTreeTopLevel("")).toEqual([]);
    expect(parseFsyncTreeTopLevel("Library/Caches\n")).toEqual([]);
  });

  it("keeps the shallowest depth of real --path=Library/Caches output (depth 2, no depth-0 lines)", () => {
    // Verbatim head of `ios fsync tree --path=Library/Caches` on a paired
    // iPhone 16 Pro Max (go-ios 1.3.2); shallowest entries sit at depth 2.
    const out = [
      "|  |  |-AdMob/",
      "|  |  |  |-crash_reporting/",
      "|  |  |  |  |-symbol_table.txt",
      "|  |  |-AdViewer/",
      "|  |  |-Assets/",
      "|  |  |-CBPrefetchCacheFolder/",
    ].join("\n");
    expect(parseFsyncTreeTopLevel(out)).toEqual(["AdMob", "AdViewer", "Assets", "CBPrefetchCacheFolder"]);
  });

  it("ignores non-tree noise lines", () => {
    const out = '{"level":"INFO","msg":"x"}\n|  |  |-AdMob/\nnot a tree line\n';
    expect(parseFsyncTreeTopLevel(out)).toEqual(["AdMob"]);
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

  it("lists apps with --include-all-apps (default view omits App Store apps)", async () => {
    // Observed live: without the flag only 25 developer apps return, so the
    // join misses every App Store process (KakaoTalk, Toss, …).
    const run = joinRunner();
    await new RealDeviceApps({ runner: run }).listRunning("R1");
    const apps = run.calls.filter((c) => c.args.includes("apps"));
    expect(apps).toHaveLength(1);
    expect(apps[0]!.args).toContain("--include-all-apps");
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
