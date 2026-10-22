import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Axe } from "../src/axe.js";
import { ExecError, Runner } from "../src/exec.js";
import { Llmdb } from "../src/llmdb.js";
import { Orchestrator } from "../src/orchestrator.js";
import { GO_IOS_INSTALL_HINT } from "../src/realdevices.js";
import type { PoolDevice, RealDevices } from "../src/realdevices.js";
import { RealUiDriver } from "../src/realui.js";
import { createMcpServer } from "../src/server.js";
import { ServeSim } from "../src/servesim.js";
import { SimApps } from "../src/simapps.js";
import { SimLog } from "../src/simlog.js";
import { FleetOps, SimDevice, Simslim, SlimStatus } from "../src/simslim.js";
import { Store } from "../src/store.js";
import type { UiDriver } from "../src/uidriver.js";
import { XCTrace } from "../src/xctrace.js";

/** Minimal bytes satisfying the PNG magic check (8-byte signature + payload). */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function stubRunner(handler: (bin: string, args: string[]) => { stdout: string; stderr: string }): Runner & {
  calls: { bin: string; args: string[] }[];
} {
  const calls: { bin: string; args: string[] }[] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push({ bin, args: [...args] });
    return handler(bin, args);
  }) as Runner & { calls: { bin: string; args: string[] }[] };
  run.calls = calls;
  return run;
}

/** Fake `ios` that materializes a PNG at the --output=<file> path, like the real CLI. */
function iosShotRunner(opts: { stdout?: string } = {}): Runner & { calls: { bin: string; args: string[] }[] } {
  return stubRunner((bin, args) => {
    if (bin === "ios" && args[0] === "--version") return { stdout: "go-ios local-build\n", stderr: "" };
    const out = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
    if (bin === "ios" && args[0] === "screenshot" && out) fs.writeFileSync(out, PNG_BYTES);
    return { stdout: opts.stdout ?? '{"level":"INFO","msg":"File saved successfully"}', stderr: "" };
  });
}

/** Fake `axe` that materializes a PNG at the --output <file> path, like the real CLI. */
function axeShotRunner(): Runner & { calls: { bin: string; args: string[] }[] } {
  return stubRunner((bin, args) => {
    const flag = args.indexOf("--output");
    if (bin === "axe" && args[0] === "screenshot" && flag !== -1 && args[flag + 1]) {
      fs.writeFileSync(args[flag + 1]!, PNG_BYTES);
    }
    return { stdout: "", stderr: "" };
  });
}

/**
 * Canned `ios ui source` output: JSON-RPC envelope around a DeviceKit
 * XCUIElement tree (measured live 2026-10-22: {id,jsonrpc,result:{children,
 * rect, type}}; nodes carry type/label/name/rawIdentifier/value/rect).
 */
const DK_SOURCE = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  result: {
    type: "XCUIElementTypeAny",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    children: [
      {
        type: "XCUIElementTypeApplication", label: "DemoApp", name: "DemoApp",
        rect: { x: 0, y: 0, width: 440, height: 956 },
        children: [
          {
            type: "XCUIElementTypeButton", label: "OK", name: "OK", rawIdentifier: "ok-btn",
            rect: { x: 10, y: 20, width: 100, height: 44 },
            children: [],
          },
          {
            type: "XCUIElementTypeStaticText", label: "Hello", name: "Hello", value: "greeting",
            rect: { x: 10, y: 80, width: 200, height: 22 },
          },
        ],
      },
      {
        type: "XCUIElementTypeStatusBar",
        rect: { x: 0, y: 0, width: 440, height: 54 },
        children: [],
      },
    ],
  },
});

/** Canned `ios ui tap` output (measured live 2026-10-22). */
const DK_TAP = '{"id":1,"jsonrpc":"2.0","result":{"success":true}}';

/**
 * Canned `ios ui type` / `swipe` / `button` outputs. Shape mirrors the
 * live tap envelope (`{"id","jsonrpc","result"}`); success envelopes
 * resolve trimmed, while envelopes with a non-null `error` member reject
 * (exit-0 fake-ok is a live-measured failure mode, see the envelope
 * tests). Live-verified 2026-10-22: empty `--text=` fails
 * `--text is required`; the CLI fromX swipe shape fails DeviceKit
 * `-32602 Invalid parameters` (the runner wants x1/y1/x2/y2).
 */
const DK_TYPE = '{"id":1,"jsonrpc":"2.0","result":{"success":true}}';
const DK_SWIPE = '{"id":1,"jsonrpc":"2.0","result":{"success":true}}';
const DK_BUTTON = '{"id":1,"jsonrpc":"2.0","result":{"success":true}}';

/** Canned `axe describe-ui` output (sim path, byte-identity reference). */
const AX_FULL = JSON.stringify([
  {
    AXLabel: "SimApp", AXUniqueId: null, type: "Application",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        AXLabel: "Go", AXUniqueId: "go-btn", type: "Button",
        frame: { x: 5, y: 5, width: 50, height: 30 }, children: [],
      },
    ],
  },
]);

/** Fake `ios` covering screenshot + `ui source`/`tap`/`type`/`swipe`/`button`, like the real CLI. */
function iosUiRunner(opts: { source?: string; tap?: string; type?: string; swipe?: string; button?: string } = {}): Runner & { calls: { bin: string; args: string[] }[] } {
  return stubRunner((bin, args) => {
    if (bin === "ios" && args[0] === "--version") return { stdout: "go-ios local-build\n", stderr: "" };
    if (bin === "ios" && args[0] === "ui" && args[1] === "source") {
      return { stdout: opts.source ?? DK_SOURCE, stderr: "" };
    }
    if (bin === "ios" && args[0] === "ui" && args[1] === "tap") {
      return { stdout: opts.tap ?? DK_TAP, stderr: "" };
    }
    if (bin === "ios" && args[0] === "ui" && args[1] === "type") {
      return { stdout: opts.type ?? DK_TYPE, stderr: "" };
    }
    if (bin === "ios" && args[0] === "ui" && args[1] === "api" && args.includes("--rpc-method=device.io.swipe")) {
      return { stdout: opts.swipe ?? DK_SWIPE, stderr: "" };
    }
    if (bin === "ios" && args[0] === "ui" && args[1] === "button") {
      return { stdout: opts.button ?? DK_BUTTON, stderr: "" };
    }
    const out = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
    if (bin === "ios" && args[0] === "screenshot" && out) fs.writeFileSync(out, PNG_BYTES);
    return { stdout: '{"level":"INFO","msg":"File saved successfully"}', stderr: "" };
  });
}

/** Fake `axe` covering screenshot + describe-ui + tap + type + swipe + button + batch. */
function axeUiRunner(): Runner & { calls: { bin: string; args: string[] }[] } {
  return stubRunner((bin, args) => {
    if (bin === "axe" && args[0] === "describe-ui") return { stdout: AX_FULL, stderr: "" };
    if (bin === "axe" && args[0] === "tap") return { stdout: "tapped label=Go\n", stderr: "" };
    if (bin === "axe" && args[0] === "type") return { stdout: "typed\n", stderr: "" };
    if (bin === "axe" && args[0] === "swipe") return { stdout: "swiped\n", stderr: "" };
    if (bin === "axe" && args[0] === "button") return { stdout: "pressed\n", stderr: "" };
    if (bin === "axe" && args[0] === "batch") return { stdout: "batched\n", stderr: "" };
    if (bin === "axe" && args[0] === "gesture") return { stdout: "gestured\n", stderr: "" };
    const flag = args.indexOf("--output");
    if (bin === "axe" && args[0] === "screenshot" && flag !== -1 && args[flag + 1]) {
      fs.writeFileSync(args[flag + 1]!, PNG_BYTES);
    }
    return { stdout: "", stderr: "" };
  });
}

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-realui-")), name);
}

describe("RealUiDriver", () => {
  it("satisfies UiDriver and captures via ios screenshot", async () => {
    const run = iosShotRunner();
    const driver: UiDriver = new RealUiDriver({ runner: run });
    const out = tmpFile("shot.png");
    await expect(driver.screenshot("R1", out)).resolves.toBe(out);
    expect(run.calls).toEqual([{ bin: "ios", args: ["screenshot", "--udid=R1", `--output=${out}`] }]);
    expect(fs.readFileSync(out)).toEqual(PNG_BYTES);
  });

  it("checkAvailable probes ios --version", async () => {
    const run = iosShotRunner();
    await expect(new RealUiDriver({ runner: run }).checkAvailable()).resolves.toBe("go-ios local-build");
    expect(run.calls).toEqual([{ bin: "ios", args: ["--version"] }]);
  });

  it("validates udid and output without spawning", async () => {
    const run = iosShotRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.screenshot("", tmpFile("a.png"))).rejects.toThrow(/Invalid udid/);
    await expect(driver.screenshot("  ", tmpFile("b.png"))).rejects.toThrow(/Invalid udid/);
    await expect(driver.screenshot("R1", "")).rejects.toThrow(/Invalid output/);
    await expect(driver.screenshot("R1", "  ")).rejects.toThrow(/Invalid output/);
    expect(run.calls).toHaveLength(0);
  });

  it("fails with backend text verbatim when no file appears (never a missing-binary claim)", async () => {
    const run = stubRunner(() => ({ stdout: '{"level":"INFO","msg":"nothing written"}', stderr: "" }));
    const out = tmpFile("missing.png");
    const err = await new RealUiDriver({ runner: run }).screenshot("R1", out).catch((e: Error) => e);
    expect(String(err.message)).toContain("nothing written");
    expect(String(err.message)).toContain(out);
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("fails when the file is not a PNG (magic bytes)", async () => {
    const run = stubRunner((bin, args) => {
      const file = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
      if (file) fs.writeFileSync(file, "this is not a png");
      return { stdout: '{"level":"INFO","msg":"File saved successfully"}', stderr: "" };
    });
    const err = await new RealUiDriver({ runner: run }).screenshot("R1", tmpFile("fake.png")).catch((e: Error) => e);
    expect(String(err.message)).toMatch(/did not produce a PNG/);
    expect(String(err.message)).toContain("File saved successfully");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["screenshot"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(new RealUiDriver({ runner: run }).screenshot("R1", tmpFile("x.png"))).rejects.toThrow(
      GO_IOS_INSTALL_HINT,
    );
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["screenshot"], 1, "", '{"level":"ERROR","msg":"device locked"}');
    });
    const err = await new RealUiDriver({ runner: run }).screenshot("R1", tmpFile("x.png")).catch((e: Error) => e);
    expect(String(err.message)).toContain("device locked");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("no longer throws P2 stubs: type/swipe/button/batch are wired, gesture is a precise limit", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.typeText("R1", "hi")).resolves.toBe(DK_TYPE);
    await expect(driver.swipe("R1", { x: 0, y: 0 }, { x: 1, y: 1 })).resolves.toBe(DK_SWIPE);
    await expect(driver.button("R1", "home")).resolves.toBe(DK_BUTTON);
    await expect(driver.batch("R1", ["type 'hi'"])).resolves.toContain("success");
    await expect(driver.gesture("R1", "scroll-up")).rejects.toThrow(/no.*CLI equivalent|not supported/i);
  });
});

describe("RealUiDriver.describeUi", () => {
  it("captures via ios ui source and normalizes DeviceKit JSON-RPC to AX JSON", async () => {
    const run = iosUiRunner();
    const out = await new RealUiDriver({ runner: run }).describeUi("R1");
    expect(run.calls).toEqual([{ bin: "ios", args: ["ui", "source", "--udid=R1"] }]);
    const roots = JSON.parse(out) as Record<string, unknown>[];
    // Synthetic XCUIElementTypeAny wrapper is unwrapped; two roots remain.
    expect(roots).toHaveLength(2);
    const app = roots[0]!;
    expect(app["type"]).toBe("Application");
    expect(app["AXLabel"]).toBe("DemoApp");
    expect(app["AXUniqueId"]).toBe("DemoApp");
    expect(app["frame"]).toEqual({ x: 0, y: 0, width: 440, height: 956 });
    const kids = app["children"] as Record<string, unknown>[];
    expect(kids).toHaveLength(2);
    expect(kids[0]).toMatchObject({
      AXLabel: "OK", AXUniqueId: "ok-btn", type: "Button",
      frame: { x: 10, y: 20, width: 100, height: 44 },
    });
    expect(kids[1]).toMatchObject({ AXLabel: "Hello", type: "StaticText", AXValue: "greeting" });
    expect(roots[1]).toMatchObject({ type: "StatusBar" });
    expect(JSON.stringify(roots)).not.toContain("XCUIElementType");
  });

  it("emits output the shared compactor accepts (compact + maxDepth)", async () => {
    const { compactAxText } = await import("../src/ax-prune.js");
    const run = iosUiRunner();
    const out = await new RealUiDriver({ runner: run }).describeUi("R1");
    const full = compactAxText(out);
    expect(full.kept).toBe(4); // Application + Button + StaticText + StatusBar
    expect(full.dropped).toBe(0);
    const depth0 = compactAxText(out, { maxDepth: 0 });
    expect(depth0.kept).toBe(2);
    expect(depth0.dropped).toBe(2);
    expect(JSON.parse(depth0.text).map((n: { type: string }) => n.type).sort()).toEqual(
      ["Application", "StatusBar"],
    );
  });

  it("keeps a non-Any result root as a single-element array", async () => {
    const source = JSON.stringify({
      id: 1, jsonrpc: "2.0",
      result: {
        type: "XCUIElementTypeApplication", label: "Solo",
        rect: { x: 0, y: 0, width: 100, height: 100 }, children: [],
      },
    });
    const run = iosUiRunner({ source });
    const roots = JSON.parse(await new RealUiDriver({ runner: run }).describeUi("R1")) as unknown[];
    expect(roots).toHaveLength(1);
  });

  it("prefers the tight element over deep full-screen wrappers (smallest-area hit-test)", async () => {
    // Live-grounded shape: a depth-3 full-screen Other chain in one subtree
    // must lose to a shallower tight StaticText in another (measured
    // 2026-10-22: depth-9 440x956 Other vs depth-4 clock text).
    const deep = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { type: "XCUIElementTypeOther", rect: { x: 0, y: 0, width: 440, height: 956 }, children: [] }
        : {
            type: "XCUIElementTypeOther", rect: { x: 0, y: 0, width: 440, height: 956 },
            children: [deep(depth - 1)],
          };
    const source = JSON.stringify({
      id: 1, jsonrpc: "2.0",
      result: {
        type: "XCUIElementTypeAny", rect: { x: 0, y: 0, width: 0, height: 0 },
        children: [
          {
            type: "XCUIElementTypeApplication", label: "App",
            rect: { x: 0, y: 0, width: 440, height: 956 }, children: [deep(3)],
          },
          {
            type: "XCUIElementTypeStatusBar", rect: { x: 0, y: 0, width: 440, height: 54 },
            children: [
              {
                type: "XCUIElementTypeStaticText", label: "16:32", name: "16:32",
                rect: { x: 50, y: 22, width: 48, height: 21 },
              },
            ],
          },
        ],
      },
    });
    const run = iosUiRunner({ source });
    const hit = JSON.parse(
      await new RealUiDriver({ runner: run }).describeUi("R1", { x: 74, y: 33 }),
    ) as Record<string, unknown>;
    expect(hit).toMatchObject({ AXLabel: "16:32", type: "StaticText" });
  });

  it("answers point queries with the smallest-area containing element (local hit-test)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    const hit = JSON.parse(await driver.describeUi("R1", { x: 50, y: 40 })) as Record<string, unknown>;
    expect(Array.isArray(hit)).toBe(false);
    expect(hit).toMatchObject({ AXLabel: "OK", type: "Button" });
    // Inside the app but outside every child → the app itself.
    const app = JSON.parse(await driver.describeUi("R1", { x: 400, y: 900 })) as Record<string, unknown>;
    expect(app).toMatchObject({ AXLabel: "DemoApp", type: "Application" });
  });

  it("fails a point miss with a precise error (never an empty payload)", async () => {
    const run = iosUiRunner();
    await expect(new RealUiDriver({ runner: run }).describeUi("R1", { x: 9999, y: 9999 })).rejects.toThrow(
      /no element at \(9999, 9999\)/,
    );
  });

  it("validates udid without spawning", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.describeUi("")).rejects.toThrow(/Invalid udid/);
    await expect(driver.describeUi("  ")).rejects.toThrow(/Invalid udid/);
    expect(run.calls).toHaveLength(0);
  });

  it("fails with backend text verbatim on unparseable source (never a missing-binary claim)", async () => {
    const run = iosUiRunner({ source: "not json{{{ backend-marker-xyz" });
    const err = await new RealUiDriver({ runner: run }).describeUi("R1").catch((e: Error) => e);
    expect(String(err.message)).toContain("backend-marker-xyz");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("fails verbatim when the JSON-RPC result is missing", async () => {
    const run = iosUiRunner({ source: '{"id":1,"jsonrpc":"2.0"}' });
    const err = await new RealUiDriver({ runner: run }).describeUi("R1").catch((e: Error) => e);
    expect(String(err.message)).toMatch(/missing result/);
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "source"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(new RealUiDriver({ runner: run }).describeUi("R1")).rejects.toThrow(GO_IOS_INSTALL_HINT);
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "source"], 1, "", '{"level":"ERROR","msg":"device locked"}');
    });
    const err = await new RealUiDriver({ runner: run }).describeUi("R1").catch((e: Error) => e);
    expect(String(err.message)).toContain("device locked");
    expect(String(err.message)).not.toMatch(/not installed/);
  });
});

describe("RealUiDriver.tap", () => {
  it("taps via ios ui tap with x/y and returns the backend text trimmed", async () => {
    const run = iosUiRunner();
    const out = await new RealUiDriver({ runner: run }).tap("R1", { x: 74, y: 33 });
    expect(run.calls).toEqual([{ bin: "ios", args: ["ui", "tap", "--x=74", "--y=33", "--udid=R1"] }]);
    expect(out).toBe(DK_TAP);
  });

  it("requires x/y: selector taps fail with a precise coordinates-only error (no spawn)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    for (const target of [{ label: "OK" }, { id: "ok" }, { value: "v" }, {}, { x: 1 }, { y: 2 }]) {
      await expect(driver.tap("R1", target)).rejects.toThrow(/coordinates only/);
    }
    expect(run.calls).toHaveLength(0);
  });

  it("lets coords win over selectors (axe precedence)", async () => {
    const run = iosUiRunner();
    await new RealUiDriver({ runner: run }).tap("R1", { x: 1, y: 2, label: "OK", id: "ok" });
    expect(run.calls).toEqual([{ bin: "ios", args: ["ui", "tap", "--x=1", "--y=2", "--udid=R1"] }]);
  });

  it("validates udid and finite x/y without spawning", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.tap("", { x: 1, y: 2 })).rejects.toThrow(/Invalid udid/);
    await expect(driver.tap("R1", { x: NaN, y: 2 })).rejects.toThrow(/Invalid x/);
    await expect(driver.tap("R1", { x: 1, y: Number.POSITIVE_INFINITY })).rejects.toThrow(/Invalid y/);
    expect(run.calls).toHaveLength(0);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "tap"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(new RealUiDriver({ runner: run }).tap("R1", { x: 1, y: 2 })).rejects.toThrow(
      GO_IOS_INSTALL_HINT,
    );
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "tap"], 1, "", '{"level":"ERROR","msg":"tap outside screen"}');
    });
    const err = await new RealUiDriver({ runner: run }).tap("R1", { x: 1, y: 2 }).catch((e: Error) => e);
    expect(String(err.message)).toContain("tap outside screen");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("rejects exit-0 error envelopes loudly with verbatim text (never fake-ok)", async () => {
    const run = iosUiRunner({ tap: '{"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid parameters"}}' });
    const err = await new RealUiDriver({ runner: run }).tap("R1", { x: 1, y: 2 }).catch((e: Error) => e);
    expect(String(err.message)).toContain("-32602");
    expect(String(err.message)).toContain("R1");
    expect(String(err.message)).not.toMatch(/not installed/);
  });
});

describe("RealUiDriver.typeText", () => {
  it("types via ios ui type with --text and returns the backend text trimmed", async () => {
    const run = iosUiRunner();
    const out = await new RealUiDriver({ runner: run }).typeText("R1", "hello world");
    expect(run.calls).toEqual([{ bin: "ios", args: ["ui", "type", "--text=hello world", "--udid=R1"] }]);
    expect(out).toBe(DK_TYPE);
  });

  it("validates udid and non-empty text without spawning", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.typeText("", "hi")).rejects.toThrow(/Invalid udid/);
    await expect(driver.typeText("  ", "hi")).rejects.toThrow(/Invalid udid/);
    await expect(driver.typeText("R1", "")).rejects.toThrow(/Invalid text/);
    expect(run.calls).toHaveLength(0);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "type"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(new RealUiDriver({ runner: run }).typeText("R1", "hi")).rejects.toThrow(
      GO_IOS_INSTALL_HINT,
    );
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "type"], 1, "", '{"level":"ERROR","msg":"no focused field"}');
    });
    const err = await new RealUiDriver({ runner: run }).typeText("R1", "hi").catch((e: Error) => e);
    expect(String(err.message)).toContain("no focused field");
    expect(String(err.message)).not.toMatch(/not installed/);
  });
});

describe("RealUiDriver.swipe", () => {
  it("swipes via ios ui api device.io.swipe with x1/y1/x2/y2 (the runner rejects the CLI fromX shape)", async () => {
    const run = iosUiRunner();
    const out = await new RealUiDriver({ runner: run }).swipe("R1", { x: 10, y: 20 }, { x: 30, y: 40 });
    expect(run.calls).toEqual([{
      bin: "ios",
      args: ["ui", "api", "--rpc-method=device.io.swipe", '--params={"x1":10,"y1":20,"x2":30,"y2":40}', "--udid=R1"],
    }]);
    expect(out).toBe(DK_SWIPE);
  });

  it("maps duration into the rpc params, omitting it when undefined", async () => {
    const run = iosUiRunner();
    await new RealUiDriver({ runner: run }).swipe("R1", { x: 10, y: 20 }, { x: 30, y: 40 }, { duration: 1.5 });
    expect(run.calls).toEqual([{
      bin: "ios",
      args: ["ui", "api", "--rpc-method=device.io.swipe", '--params={"x1":10,"y1":20,"x2":30,"y2":40,"duration":1.5}', "--udid=R1"],
    }]);
  });

  it("ignores delta/preDelay/postDelay (tap-modifier precedent, documented limits)", async () => {
    const run = iosUiRunner();
    await new RealUiDriver({ runner: run }).swipe(
      "R1", { x: 10, y: 20 }, { x: 30, y: 40 }, { duration: 1, delta: 5, preDelay: 0.5, postDelay: 0.5 },
    );
    expect(run.calls[0]?.args).not.toContain("--delta=5");
    expect(run.calls).toHaveLength(1);
  });

  it("validates udid and finite coords/duration without spawning", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.swipe("", { x: 1, y: 2 }, { x: 3, y: 4 })).rejects.toThrow(/Invalid udid/);
    await expect(driver.swipe("R1", { x: NaN, y: 2 }, { x: 3, y: 4 })).rejects.toThrow(/Invalid from/);
    await expect(driver.swipe("R1", { x: 1, y: 2 }, { x: 3, y: Number.POSITIVE_INFINITY })).rejects.toThrow(/Invalid to/);
    await expect(
      driver.swipe("R1", { x: 1, y: 2 }, { x: 3, y: 4 }, { duration: NaN }),
    ).rejects.toThrow(/Invalid duration/);
    expect(run.calls).toHaveLength(0);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "api"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(
      new RealUiDriver({ runner: run }).swipe("R1", { x: 1, y: 2 }, { x: 3, y: 4 }),
    ).rejects.toThrow(GO_IOS_INSTALL_HINT);
  });

  it("rejects exit-0 error envelopes loudly with verbatim text (never fake-ok)", async () => {
    const envelope = '{"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid parameters"}}';
    const run = iosUiRunner({ swipe: envelope });
    const err = await new RealUiDriver({ runner: run })
      .swipe("R1", { x: 1, y: 2 }, { x: 3, y: 4 })
      .catch((e: Error) => e);
    expect(String(err.message)).toContain("-32602");
    expect(String(err.message)).toContain("R1");
    expect(String(err.message)).not.toMatch(/not installed/);
  });

  it("resolves null-error and non-JSON output trimmed (no false positives)", async () => {
    const runNull = iosUiRunner({ swipe: '{"id":1,"jsonrpc":"2.0","result":{"success":true},"error":null}' });
    await expect(
      new RealUiDriver({ runner: runNull }).swipe("R1", { x: 1, y: 2 }, { x: 3, y: 4 }),
    ).resolves.toContain('"success":true');
    const runPlain = iosUiRunner({ swipe: "  ok-plain\n" });
    await expect(
      new RealUiDriver({ runner: runPlain }).swipe("R1", { x: 1, y: 2 }, { x: 3, y: 4 }),
    ).resolves.toBe("ok-plain");
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "api"], 1, "", '{"error":{"code":-32602,"msg":"Invalid parameters"}}');
    });
    const err = await new RealUiDriver({ runner: run })
      .swipe("R1", { x: 1, y: 2 }, { x: 3, y: 4 })
      .catch((e: Error) => e);
    expect(String(err.message)).toContain("Invalid parameters");
    expect(String(err.message)).not.toMatch(/not installed/);
  });
});

describe("RealUiDriver.gesture", () => {
  it("fails every preset with a precise no-CLI-equivalent error (zero spawns)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    for (const preset of [
      "scroll-up", "scroll-down", "scroll-left", "scroll-right",
      "swipe-from-left-edge", "swipe-from-right-edge", "swipe-from-top-edge", "swipe-from-bottom-edge",
    ]) {
      const err = await driver.gesture("R1", preset).catch((e: Error) => e);
      expect(String(err.message)).toContain(preset);
      expect(String(err.message)).toMatch(/no.*CLI equivalent|not supported/i);
      expect(String(err.message)).toMatch(/ui_swipe|swipe/i);
    }
    expect(run.calls).toHaveLength(0);
  });

  it("validates udid without spawning", async () => {
    const run = iosUiRunner();
    await expect(new RealUiDriver({ runner: run }).gesture("", "scroll-up")).rejects.toThrow(/Invalid udid/);
    expect(run.calls).toHaveLength(0);
  });
});

describe("RealUiDriver.button", () => {
  it.each(["home", "lock", "volumeUp", "volumeDown"])(
    "presses %s via ios ui button with the name positional",
    async (button) => {
      const run = iosUiRunner();
      const out = await new RealUiDriver({ runner: run }).button("R1", button);
      expect(run.calls).toEqual([{ bin: "ios", args: ["ui", "button", button, "--udid=R1"] }]);
      expect(out).toBe(DK_BUTTON);
    },
  );

  it("fails siri/side-button/apple-pay/unknown with a precise unsupported error (zero spawns)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    for (const button of ["siri", "side-button", "apple-pay", "frobnicate"]) {
      const err = await driver.button("R1", button).catch((e: Error) => e);
      expect(String(err.message)).toContain(button);
      expect(String(err.message)).toMatch(/not supported|no.*equivalent/i);
    }
    expect(run.calls).toHaveLength(0);
  });

  it("fails a hold duration with a precise error (no --duration flag; never faked as a tap)", async () => {
    const run = iosUiRunner();
    await expect(new RealUiDriver({ runner: run }).button("R1", "home", 2)).rejects.toThrow(/duration/i);
    expect(run.calls).toHaveLength(0);
  });

  it("validates udid without spawning", async () => {
    const run = iosUiRunner();
    await expect(new RealUiDriver({ runner: run }).button("", "home")).rejects.toThrow(/Invalid udid/);
    expect(run.calls).toHaveLength(0);
  });

  it("names the install hint only on ENOENT", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "button"], "ENOENT", "", "spawn ios ENOENT");
    });
    await expect(new RealUiDriver({ runner: run }).button("R1", "home")).rejects.toThrow(
      GO_IOS_INSTALL_HINT,
    );
  });

  it("keeps device failures verbatim (never reframed as a missing binary)", async () => {
    const run = stubRunner(() => {
      throw new ExecError("ios", ["ui", "button"], 1, "", '{"error":{"code":-32602,"msg":"Invalid parameters"}}');
    });
    const err = await new RealUiDriver({ runner: run }).button("R1", "home").catch((e: Error) => e);
    expect(String(err.message)).toContain("Invalid parameters");
    expect(String(err.message)).not.toMatch(/not installed/);
  });
});

describe("RealUiDriver.batch", () => {
  it("fans out tap/type/swipe/button/sleep steps per-step via the wired verbs", async () => {
    const run = iosUiRunner();
    const out = await new RealUiDriver({ runner: run }).batch("R1", [
      "tap -x 74 -y 33",
      "type 'hi'",
      "swipe --start-x 10 --start-y 20 --end-x 30 --end-y 40 --duration 1",
      "button home",
      "sleep 0.01",
    ]);
    expect(run.calls).toEqual([
      { bin: "ios", args: ["ui", "tap", "--x=74", "--y=33", "--udid=R1"] },
      { bin: "ios", args: ["ui", "type", "--text=hi", "--udid=R1"] },
      { bin: "ios", args: ["ui", "api", "--rpc-method=device.io.swipe", '--params={"x1":10,"y1":20,"x2":30,"y2":40,"duration":1}', "--udid=R1"] },
      { bin: "ios", args: ["ui", "button", "home", "--udid=R1"] },
    ]);
    expect(out).toContain("success");
    expect(out).toContain("slept 0.01s");
  });

  it("rejects screenshot and unknown heads like Axe (zero spawns)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.batch("R1", ["screenshot --output x.png"])).rejects.toThrow(/unsupported batch step/i);
    await expect(driver.batch("R1", ["frobnicate now"])).rejects.toThrow(/unsupported batch step/i);
    await expect(driver.batch("R1", [""])).rejects.toThrow(/unsupported batch step/i);
    // A bad head anywhere poisons the whole batch before anything spawns.
    await expect(driver.batch("R1", ["tap -x 1 -y 2", "screenshot x"])).rejects.toThrow(/unsupported batch step/i);
    expect(run.calls).toHaveLength(0);
  });

  it("fails gesture/touch/key steps with precise unsupported errors (zero spawns)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.batch("R1", ["gesture scroll-up"])).rejects.toThrow(/scroll-up/);
    await expect(driver.batch("R1", ["touch --x 1 --y 2 --down --up"])).rejects.toThrow(/touch/i);
    await expect(driver.batch("R1", ["key a"])).rejects.toThrow(/key/i);
    await expect(driver.batch("R1", ["key-sequence a b"])).rejects.toThrow(/key/i);
    await expect(driver.batch("R1", ["key-combo cmd c"])).rejects.toThrow(/key/i);
    expect(run.calls).toHaveLength(0);
  });

  it("mirrors per-verb limits inside steps (selector taps, button holds, bad sleep)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.batch("R1", ["tap --label OK"])).rejects.toThrow(/coordinates only/);
    await expect(driver.batch("R1", ["button home --duration 2"])).rejects.toThrow(/duration/i);
    await expect(driver.batch("R1", ["button siri"])).rejects.toThrow(/siri/);
    await expect(driver.batch("R1", ["sleep banana"])).rejects.toThrow(/sleep/i);
    await expect(driver.batch("R1", ["type"])).rejects.toThrow(/Invalid text/);
    expect(run.calls).toHaveLength(0);
  });

  it("requires at least one step and a valid udid (zero spawns)", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await expect(driver.batch("R1", [])).rejects.toThrow(/at least one step/);
    await expect(driver.batch("", ["tap -x 1 -y 2"])).rejects.toThrow(/Invalid udid/);
    expect(run.calls).toHaveLength(0);
  });

  it("stops at the first runtime failure by default", async () => {
    const run = stubRunner((bin, args) => {
      if (args[1] === "type") throw new ExecError(bin, args, 1, "", "no focused field");
      return { stdout: '{"result":{"success":true}}', stderr: "" };
    });
    const err = await new RealUiDriver({ runner: run })
      .batch("R1", ["tap -x 1 -y 2", "type 'hi'", "button home"])
      .catch((e: Error) => e);
    expect(String(err.message)).toContain("no focused field");
    expect(run.calls.map((c) => c.args[1])).toEqual(["tap", "type"]);
  });

  it("continues past runtime failures with continueOnError and accounts each one", async () => {
    const run = stubRunner((bin, args) => {
      if (args[1] === "type") throw new ExecError(bin, args, 1, "", "no focused field");
      return { stdout: '{"result":{"success":true}}', stderr: "" };
    });
    const out = await new RealUiDriver({ runner: run }).batch(
      "R1",
      ["tap -x 1 -y 2", "type 'hi'", "button home"],
      { continueOnError: true },
    );
    expect(run.calls.map((c) => c.args[1])).toEqual(["tap", "type", "button"]);
    expect(out).toContain("step 2 (type) failed");
    expect(out).toContain("no focused field");
  });

  it("ignores waitTimeout/pollInterval/verbose (tap-modifier precedent)", async () => {
    const run = iosUiRunner();
    await new RealUiDriver({ runner: run }).batch(
      "R1", ["tap -x 1 -y 2"], { waitTimeout: 5, pollInterval: 1, verbose: true },
    );
    expect(run.calls).toHaveLength(1);
  });

  it("parses quoted and backslash-escaped step args", async () => {
    const run = iosUiRunner();
    const driver = new RealUiDriver({ runner: run });
    await driver.batch("R1", ['type "hello world"']);
    expect(run.calls[0]?.args).toContain("--text=hello world");
    await driver.batch("R1", ["type hello\\ world"]);
    expect(run.calls[1]?.args).toContain("--text=hello world");
    // Coords win over selectors in steps too (axe precedence).
    await driver.batch("R1", ["tap -x 1 -y 2 --label OK"]);
    expect(run.calls[2]?.args).toEqual(["ui", "tap", "--x=1", "--y=2", "--udid=R1"]);
  });
});

class FakeFleet implements FleetOps {
  constructor(private readonly devs: SimDevice[]) {}
  async list(): Promise<SimDevice[]> {
    return this.devs.map((d) => ({ ...d }));
  }
  async boot(): Promise<void> {}
  async slimStatus(): Promise<SlimStatus | null> {
    return null;
  }
  async slimNoReboot(): Promise<void> {}
}

class FakeRealFleet implements Pick<RealDevices, "list"> {
  constructor(private readonly devs: PoolDevice[]) {}
  async list(): Promise<PoolDevice[]> {
    return this.devs.map((d) => ({ ...d, trust: { ...d.trust } }));
  }
}

function realDev(): PoolDevice {
  return {
    udid: "R1", name: "Test iPhone", state: "available", platform: "iOS", osVersion: "26.1",
    kind: "real", transport: "wifi", trust: { paired: true, developerMode: "enabled" }, coredeviceId: "core-R1",
  };
}

async function makeShotClient(opts: {
  withRealUi?: boolean;
  axeRun?: Runner & { calls: { bin: string; args: string[] }[] };
  iosRun?: Runner & { calls: { bin: string; args: string[] }[] };
} = {}) {
  const withRealUi = opts.withRealUi ?? true;
  const axeRun = opts.axeRun ?? axeShotRunner();
  const iosRun = opts.iosRun ?? iosShotRunner();
  const noop = stubRunner(() => ({ stdout: "", stderr: "" }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-shotdisp-")), "state.json");
  const orch = new Orchestrator(
    new FakeFleet([
      { udid: "U1", name: "iPhone 17 Pro", state: "Booted", platform: "iOS", osVersion: "26.5", set: "default" },
    ]),
    Store.load(file),
    { defaultTtlMs: 60_000, realFleet: new FakeRealFleet([realDev()]) },
  );
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-shots-"));
  const server = createMcpServer({
    orchestrator: orch,
    simslim: new Simslim({ runner: noop }),
    axe: new Axe({ runner: axeRun }),
    serveSim: new ServeSim({ runner: noop }),
    simLog: new SimLog({ runner: async () => ({ stdout: "", truncated: false, timedOut: true }) }),
    simApps: new SimApps({ runner: noop }),
    xctrace: new XCTrace({ runner: noop, exists: () => true }),
    lldmdb: new Llmdb({ runner: noop }),
    screenshotDir,
    ...(withRealUi ? { realUi: new RealUiDriver({ runner: iosRun }) } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const simLease = await orch.acquire({ sessionId: "s1", slim: false, autoBoot: false });
  if (!simLease.ok || simLease.queued) throw new Error("expected a sim lease");
  const realLease = await orch.acquire({ sessionId: "s1", requirements: { deviceKind: "real" } });
  if (!realLease.ok || realLease.queued) throw new Error("expected a real lease");
  return {
    client, orch, axeRun, iosRun, screenshotDir,
    simLeaseId: simLease.lease.leaseId, realLeaseId: realLease.lease.leaseId,
  };
}

describe("ui_screenshot dispatch by lease kind", () => {
  it("routes real leases to the go-ios backend with the sim ok shape", async () => {
    const { client, orch, axeRun, iosRun, screenshotDir, realLeaseId } = await makeShotClient();
    const result = await client.callTool({ name: "ui_screenshot", arguments: { lease_id: realLeaseId } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "R1" });
    expect(String(json["path"])).toContain(screenshotDir);
    expect(axeRun.calls).toHaveLength(0); // no sim cross-talk
    expect(iosRun.calls).toHaveLength(1);
    expect(iosRun.calls[0]?.bin).toBe("ios");
    expect(iosRun.calls[0]?.args.slice(0, 2)).toEqual(["screenshot", "--udid=R1"]);
    const image = result.content.find((c) => c.type === "image") as
      | { type: "image"; data: string; mimeType: string }
      | undefined;
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(PNG_BYTES.toString("base64"));
    const actions = orch.leaseActions(realLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain("ui_screenshot screenshot R1-");
  });

  it("keeps the sim path byte-identical (axe argv + ok shape)", async () => {
    const { client, axeRun, iosRun, simLeaseId } = await makeShotClient();
    const result = await client.callTool({ name: "ui_screenshot", arguments: { lease_id: simLeaseId } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "U1" });
    expect(iosRun.calls).toHaveLength(0);
    expect(axeRun.calls).toHaveLength(1);
    expect(axeRun.calls[0]?.bin).toBe("axe");
    expect(axeRun.calls[0]?.args.slice(0, 3)).toEqual(["screenshot", "--udid", "U1"]);
    expect(axeRun.calls[0]?.args[3]).toBe("--output");
    expect(axeRun.calls[0]?.args[4]).toBe(String(json["path"]));
  });

  it("fails real screenshots with a missing-transport error when realUi is absent", async () => {
    const { client, realLeaseId } = await makeShotClient({ withRealUi: false });
    const result = await client.callTool({ name: "ui_screenshot", arguments: { lease_id: realLeaseId } });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text");
    expect((text as { text: string }).text).toContain("go-ios UI transport");
  });

  it("no longer gates type/swipe/button/batch P2 on real leases (gesture stays a precise limit)", async () => {
    const { client, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    for (const [name, args] of [
      ["ui_type", { lease_id: realLeaseId, text: "hi" }],
      ["ui_swipe", { lease_id: realLeaseId, start_x: 1, start_y: 2, end_x: 3, end_y: 4 }],
      ["ui_button", { lease_id: realLeaseId, button: "home" }],
      ["ui_batch", { lease_id: realLeaseId, steps: ["tap -x 1 -y 2"] }],
    ] as const) {
      const result = await client.callTool({ name, arguments: { ...args } });
      expect(result.isError, name).not.toBe(true);
    }
    const gesture = await client.callTool({
      name: "ui_gesture", arguments: { lease_id: realLeaseId, preset: "scroll-up" },
    });
    expect(gesture.isError).toBe(true);
    const text = gesture.content.find((c) => c.type === "text");
    expect((text as { text: string }).text).toContain("scroll-up");
  });
});

describe("ui_describe/ui_tap dispatch by lease kind", () => {
  it("routes real ui_describe to ios ui source with an AX-normalized payload", async () => {
    const { client, orch, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_describe", arguments: { lease_id: realLeaseId } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "R1", format: "full", truncated: false });
    const roots = JSON.parse(String(json["ui"])) as Record<string, unknown>[];
    expect(roots).toHaveLength(2);
    expect(roots[0]).toMatchObject({ AXLabel: "DemoApp", type: "Application" });
    expect(axeRun.calls).toHaveLength(0); // no sim cross-talk
    expect(iosRun.calls).toEqual([{ bin: "ios", args: ["ui", "source", "--udid=R1"] }]);
    const actions = orch.leaseActions(realLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain("ui_describe describe full hierarchy");
  });

  it("keeps the sim ui_describe path byte-identical (axe argv + ok shape)", async () => {
    const { client, axeRun, iosRun, simLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_describe", arguments: { lease_id: simLeaseId } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "U1", ui: AX_FULL, format: "full", truncated: false });
    expect(iosRun.calls).toHaveLength(0);
    expect(axeRun.calls).toEqual([{ bin: "axe", args: ["describe-ui", "--udid", "U1"] }]);
  });

  it("prunes real ui_describe via the shared compactor (format=compact + max_depth)", async () => {
    const { client, realLeaseId } = await makeShotClient({ axeRun: axeUiRunner(), iosRun: iosUiRunner() });
    const result = await client.callTool({
      name: "ui_describe", arguments: { lease_id: realLeaseId, format: "compact", max_depth: 0 },
    });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, format: "compact", kept: 2 });
  });

  it("routes real ui_tap with coords to ios ui tap", async () => {
    const { client, orch, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_tap", arguments: { lease_id: realLeaseId, x: 74, y: 33 } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "R1" });
    expect(String(json["output"])).toContain('"success":true');
    expect(axeRun.calls).toHaveLength(0);
    expect(iosRun.calls).toEqual([{ bin: "ios", args: ["ui", "tap", "--x=74", "--y=33", "--udid=R1"] }]);
    const actions = orch.leaseActions(realLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain("ui_tap tap (74,33)");
  });

  it("keeps the sim ui_tap path byte-identical (axe argv + ok shape)", async () => {
    const { client, axeRun, iosRun, simLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_tap", arguments: { lease_id: simLeaseId, label: "Go" } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "U1", output: "tapped label=Go" });
    expect(iosRun.calls).toHaveLength(0);
    expect(axeRun.calls).toEqual([{ bin: "axe", args: ["tap", "--udid", "U1", "--label", "Go"] }]);
  });

  it("fails real selector taps with the precise coordinates-only error", async () => {
    const { client, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_tap", arguments: { lease_id: realLeaseId, label: "OK" } });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text");
    expect((text as { text: string }).text).toContain("coordinates only");
    expect(iosRun.calls).toHaveLength(0);
  });

  it("fails real describe/tap with a missing-transport error when realUi is absent", async () => {
    const { client, realLeaseId } = await makeShotClient({ withRealUi: false });
    const calls = [
      { name: "ui_describe", args: { lease_id: realLeaseId } },
      { name: "ui_tap", args: { lease_id: realLeaseId, x: 1, y: 2 } },
    ] as const;
    for (const { name, args } of calls) {
      const result = await client.callTool({ name, arguments: { ...args } });
      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text");
      expect((text as { text: string }).text).toContain("go-ios UI transport");
    }
  });
});

describe("ui_type/ui_swipe/ui_gesture/ui_button/ui_batch dispatch by lease kind", () => {
  it("routes real ui_type to ios ui type", async () => {
    const { client, orch, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_type", arguments: { lease_id: realLeaseId, text: "hi" } });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === "text");
    const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, udid: "R1" });
    expect(axeRun.calls).toHaveLength(0);
    expect(iosRun.calls).toEqual([{ bin: "ios", args: ["ui", "type", "--text=hi", "--udid=R1"] }]);
    const actions = orch.leaseActions(realLeaseId).map((a) => `${a.tool} ${a.summary}`);
    expect(actions.join("\n")).toContain('ui_type type "hi"');
  });

  it("routes real ui_swipe to ios ui swipe with duration", async () => {
    const { client, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({
      name: "ui_swipe",
      arguments: { lease_id: realLeaseId, start_x: 10, start_y: 20, end_x: 30, end_y: 40, duration: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(axeRun.calls).toHaveLength(0);
    expect(iosRun.calls).toEqual([{
      bin: "ios",
      args: ["ui", "api", "--rpc-method=device.io.swipe", '--params={"x1":10,"y1":20,"x2":30,"y2":40,"duration":1}', "--udid=R1"],
    }]);
  });

  it("routes real ui_button to ios ui button", async () => {
    const { client, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({ name: "ui_button", arguments: { lease_id: realLeaseId, button: "home" } });
    expect(result.isError).not.toBe(true);
    expect(axeRun.calls).toHaveLength(0);
    expect(iosRun.calls).toEqual([{ bin: "ios", args: ["ui", "button", "home", "--udid=R1"] }]);
  });

  it("routes real ui_batch per-step through the wired verbs", async () => {
    const { client, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({
      name: "ui_batch", arguments: { lease_id: realLeaseId, steps: ["tap -x 1 -y 2", "sleep 0.01"] },
    });
    expect(result.isError).not.toBe(true);
    expect(axeRun.calls).toHaveLength(0);
    expect(iosRun.calls).toEqual([{ bin: "ios", args: ["ui", "tap", "--x=1", "--y=2", "--udid=R1"] }]);
  });

  it("fails real ui_gesture with the precise per-preset error (zero spawns)", async () => {
    const { client, axeRun, iosRun, realLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const result = await client.callTool({
      name: "ui_gesture", arguments: { lease_id: realLeaseId, preset: "scroll-up" },
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text");
    expect((text as { text: string }).text).toContain("scroll-up");
    expect(axeRun.calls).toHaveLength(0);
    expect(iosRun.calls).toHaveLength(0);
  });

  it("keeps the sim paths byte-identical (axe argv + ok shape)", async () => {
    const { client, axeRun, iosRun, simLeaseId } = await makeShotClient({
      axeRun: axeUiRunner(), iosRun: iosUiRunner(),
    });
    const calls = [
      { name: "ui_type", args: { lease_id: simLeaseId, text: "hi" }, argv: ["type", "--stdin", "--udid", "U1"] },
      {
        name: "ui_swipe",
        args: { lease_id: simLeaseId, start_x: 1, start_y: 2, end_x: 3, end_y: 4, duration: 1 },
        argv: ["swipe", "--udid", "U1", "--start-x", "1", "--start-y", "2", "--end-x", "3", "--end-y", "4", "--duration", "1"],
      },
      { name: "ui_gesture", args: { lease_id: simLeaseId, preset: "scroll-up" }, argv: ["gesture", "scroll-up", "--udid", "U1"] },
      { name: "ui_button", args: { lease_id: simLeaseId, button: "home" }, argv: ["button", "home", "--udid", "U1"] },
      {
        name: "ui_batch",
        args: { lease_id: simLeaseId, steps: ["tap -x 1 -y 2"] },
        argv: ["batch", "--udid", "U1", "--step", "tap -x 1 -y 2"],
      },
    ] as const;
    for (const { name, args, argv } of calls) {
      const before = axeRun.calls.length;
      const result = await client.callTool({ name, arguments: { ...args } });
      expect(result.isError, name).not.toBe(true);
      const text = result.content.find((c) => c.type === "text");
      const json = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
      expect(json).toMatchObject({ ok: true, udid: "U1" });
      expect(axeRun.calls.slice(before)).toEqual([{ bin: "axe", args: [...argv] }]);
    }
    expect(iosRun.calls).toHaveLength(0);
  });

  it("fails all five with a missing-transport error when realUi is absent", async () => {
    const { client, realLeaseId } = await makeShotClient({ withRealUi: false });
    const calls = [
      { name: "ui_type", args: { lease_id: realLeaseId, text: "hi" } },
      { name: "ui_swipe", args: { lease_id: realLeaseId, start_x: 1, start_y: 2, end_x: 3, end_y: 4 } },
      { name: "ui_gesture", args: { lease_id: realLeaseId, preset: "scroll-up" } },
      { name: "ui_button", args: { lease_id: realLeaseId, button: "home" } },
      { name: "ui_batch", args: { lease_id: realLeaseId, steps: ["tap -x 1 -y 2"] } },
    ] as const;
    for (const { name, args } of calls) {
      const result = await client.callTool({ name, arguments: { ...args } });
      expect(result.isError, name).toBe(true);
      const text = result.content.find((c) => c.type === "text");
      expect((text as { text: string }).text).toContain("go-ios UI transport");
    }
  });
});
