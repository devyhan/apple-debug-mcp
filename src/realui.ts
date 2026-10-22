import fs from "node:fs";
import { ExecError, Runner, defaultRunner } from "./exec.js";
import { GO_IOS_INSTALL_HINT } from "./realdevices.js";
import type { BatchOptions, GestureOptions, SwipeOptions, TapTarget, UiDriver } from "./uidriver.js";

/**
 * Error detail for the WDA-gated ui verbs (everything except screenshot):
 * measured 2026-10-22, `ios ui status` fails `dial 127.0.0.1:12004:
 * connection refused` without a running WDA server, so every `ios ui *`
 * verb needs download → sign → install → `ios runwda` → local port 12004
 * before it can work.
 */
export const REAL_UI_WDA_DETAIL =
  "every `ios ui *` verb needs a running WebDriverAgent session first " +
  "(measured: `ios ui status` fails `dial 127.0.0.1:12004: connection refused` without one; " +
  "bring-up is download → sign → install → `ios runwda` → local port 12004)";

/** PNG file signature (first 8 bytes of every genuine PNG). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

function uiP2(verb: string): Error {
  return new Error(
    `${verb} does not support real-device leases yet: real-device support lands in P2 (${REAL_UI_WDA_DETAIL}).`,
  );
}

/** Missing-binary errors get an install hint; failures keep the backend text verbatim. */
function screenshotError(iosBin: string, udid: string, err: unknown): Error {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return new Error(
      `${msg}. go-ios (\`ios\`) is not installed; install with: ${GO_IOS_INSTALL_HINT} (or set IOS_BIN). ` +
        `For iOS 17+ devices also run: sudo ios tunnel start`,
    );
  }
  // Fallback for non-ExecError spawn failures: match ONLY launcher-level
  // signals, never `.*not found` (mirrors the go-ios seam in realdevices.ts).
  const escapedBin = iosBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`spawn ${escapedBin} ENOENT|${escapedBin}: command not found`, "i").test(msg)) {
    return new Error(
      `${msg}. go-ios (\`ios\`) is not installed; install with: ${GO_IOS_INSTALL_HINT} (or set IOS_BIN). ` +
        `For iOS 17+ devices also run: sudo ios tunnel start`,
    );
  }
  return new Error(
    `${msg} (ios screenshot on device ${udid}; is the device visible to devicectl but unreachable via go-ios? ` +
      `check pairing/trust and run 'sudo ios tunnel start' for iOS 17+)`,
  );
}

/**
 * Screenshot-only UiDriver for real devices: `ios screenshot` is WDA-less
 * (measured 2026-10-22 on a paired iPhone 16 Pro Max: exit 0, genuine
 * 1320x2868 PNG, `{"msg":"File saved successfully"}`), so it is wired
 * today while the WDA-gated verbs stay precise P2 throws.
 *
 * Contract mirrors `Axe.screenshot`: write a PNG file to `output` and
 * resolve the same path. The file is verified (exists + PNG magic bytes)
 * after capture; a missing/non-PNG result fails with the backend text
 * verbatim, never a missing-binary claim.
 */
export class RealUiDriver implements UiDriver {
  private readonly run: Runner;
  private readonly iosBin: string;
  private readonly execTimeoutMs: number;

  constructor(opts: { runner?: Runner; iosBin?: string; execTimeoutMs?: number } = {}) {
    this.run = opts.runner ?? defaultRunner;
    this.iosBin = opts.iosBin ?? "ios";
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  /** Probe for boot/doctor: resolves with the ios version, rejects when unusable. */
  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.iosBin, ["--version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async screenshot(udid: string, output: string): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    if (output.trim().length === 0) throw new Error("Invalid output (expected a non-empty string)");
    let stdout = "";
    let stderr = "";
    try {
      ({ stdout, stderr } = await this.run(
        this.iosBin,
        ["screenshot", `--udid=${udid}`, `--output=${output}`],
        { timeoutMs: this.execTimeoutMs },
      ));
    } catch (err) {
      throw screenshotError(this.iosBin, udid, err);
    }
    const backend = [stdout.trim(), stderr.trim()].filter((s) => s.length > 0).join("\n") || "(empty)";
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(output);
    } catch {
      throw new Error(
        `ios screenshot on device ${udid} produced no file at ${output} (backend output: ${backend})`,
      );
    }
    if (!isPng(bytes)) {
      throw new Error(
        `ios screenshot on device ${udid} did not produce a PNG at ${output} (backend output: ${backend})`,
      );
    }
    return output;
  }

  async describeUi(_udid: string, _point?: { x: number; y: number }): Promise<string> {
    throw uiP2("ui_describe");
  }

  async tap(_udid: string, _target: TapTarget): Promise<string> {
    throw uiP2("ui_tap");
  }

  async typeText(_udid: string, _text: string): Promise<string> {
    throw uiP2("ui_type");
  }

  async swipe(
    _udid: string,
    _from: { x: number; y: number },
    _to: { x: number; y: number },
    _opts?: SwipeOptions,
  ): Promise<string> {
    throw uiP2("ui_swipe");
  }

  async gesture(_udid: string, _preset: string, _opts?: GestureOptions): Promise<string> {
    throw uiP2("ui_gesture");
  }

  async button(_udid: string, _button: string, _duration?: number): Promise<string> {
    throw uiP2("ui_button");
  }

  async batch(_udid: string, _steps: string[], _opts?: BatchOptions): Promise<string> {
    throw uiP2("ui_batch");
  }
}
