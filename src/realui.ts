import fs from "node:fs";
import { ExecError, Runner, defaultRunner } from "./exec.js";
import { GO_IOS_INSTALL_HINT } from "./realdevices.js";
import type { BatchOptions, GestureOptions, SwipeOptions, TapTarget, UiDriver } from "./uidriver.js";

/**
 * Bring-up prerequisite for the REMAINING WDA-gated ui verbs (type, swipe,
 * gesture, button, batch): every `ios ui *` verb needs a running
 * DeviceKit/WebDriverAgent session first. Measured 2026-10-22: `ios ui
 * status` fails `dial 127.0.0.1:12004: connection refused` without one;
 * bring-up is download → sign → install → `ios ui run devicekit` → local
 * port 12004. A live session also backs the now-wired describe+tap verbs.
 */
export const REAL_UI_WDA_DETAIL =
  "the remaining `ios ui *` verbs need a running DeviceKit/WebDriverAgent session first " +
  "(bring-up, measured 2026-10-22: download → sign → install → `ios ui run devicekit` → local port 12004; " +
  "without one `ios ui status` fails `dial 127.0.0.1:12004: connection refused`)";

/**
 * Precise limit for selector taps on real hardware: `ios ui tap` takes
 * coordinates only (`--x=<x> --y=<y>`; go-ios 1.3.2 exposes no selector
 * flags — verified in the binary usage text), so id/label/value taps cannot
 * be resolved by the CLI. Deliberately NOT faked via a describe-lookup: run
 * ui_describe first and tap the element's frame center instead.
 */
export const REAL_UI_TAP_SELECTOR_DETAIL =
  "`ios ui tap` takes coordinates only (--x=<x> --y=<y>; measured go-ios 1.3.2, no selector flags), " +
  "so id/label/value taps cannot be resolved on a real-device lease — run ui_describe first and tap the element's frame center";

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
function realUiError(iosBin: string, verb: string, udid: string, err: unknown): Error {
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
    `${msg} (ios ${verb} on device ${udid}; is the device visible to devicectl but unreachable via go-ios? ` +
      `check pairing/trust and run 'sudo ios tunnel start' for iOS 17+)`,
  );
}

interface DeviceKitRect {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

interface DeviceKitNode {
  type?: unknown;
  label?: unknown;
  name?: unknown;
  rawIdentifier?: unknown;
  value?: unknown;
  rect?: DeviceKitRect;
  children?: unknown;
}

/** AX-JSON node: the keys compactAxText/eval-baseline read (AXLabel/AXUniqueId/type/frame/children). */
export interface AxNode {
  AXLabel?: string;
  AXUniqueId?: string;
  type?: string;
  frame?: { x: number; y: number; width: number; height: number };
  AXValue?: string;
  children?: AxNode[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stripElementPrefix(type: string): string {
  return type.startsWith("XCUIElementType") ? type.slice("XCUIElementType".length) : type;
}

function mapNode(raw: unknown): AxNode {
  const rec = asRecord(raw);
  if (rec === null) return {};
  const node: AxNode = {};
  const label = asNonEmpty(rec["label"]);
  // rawIdentifier is the stable element id; name usually echoes the label.
  const id = asNonEmpty(rec["rawIdentifier"]) ?? asNonEmpty(rec["name"]);
  const type = asNonEmpty(rec["type"]);
  if (label !== undefined) node.AXLabel = label;
  if (id !== undefined) node.AXUniqueId = id;
  // Strip XCUIElementType* so types match the AXe vocabulary (Button,
  // StaticText, Application, …) that compactAxText/interactive-first expect.
  if (type !== undefined) node.type = stripElementPrefix(type);
  const rect = asRecord(rec["rect"]);
  if (rect !== null) {
    const x = asFinite(rect["x"]);
    const y = asFinite(rect["y"]);
    const width = asFinite(rect["width"]);
    const height = asFinite(rect["height"]);
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      node.frame = { x, y, width, height };
    }
  }
  const value = rec["value"];
  if (typeof value === "string" && value.length > 0) node.AXValue = value;
  else if (typeof value === "number" || typeof value === "boolean") node.AXValue = String(value);
  if (Array.isArray(rec["children"])) {
    const kids = (rec["children"] as unknown[]).map(mapNode);
    if (kids.length > 0) node.children = kids;
  }
  return node;
}

function contains(node: AxNode, point: { x: number; y: number }): boolean {
  const f = node.frame;
  return (
    f !== undefined &&
    point.x >= f.x &&
    point.x <= f.x + f.width &&
    point.y >= f.y &&
    point.y <= f.y + f.height
  );
}

/**
 * Smallest-area node containing the point (ties → deepest, then first);
 * null on a miss. Smallest-area, not deepest: live dumps nest full-screen
 * `Other` wrappers 9 deep, which a deepest-wins rule prefers over the
 * tight element actually under the point (measured 2026-10-22: the
 * status-bar clock StaticText at depth 4 lost to a depth-9 440x956 Other).
 */
function hitTest(roots: AxNode[], point: { x: number; y: number }): AxNode | null {
  let best: AxNode | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  let bestDepth = -1;
  const visit = (node: AxNode, depth: number): void => {
    if (contains(node, point)) {
      const f = node.frame!;
      const area = f.width * f.height;
      if (area < bestArea || (area === bestArea && depth > bestDepth)) {
        best = node;
        bestArea = area;
        bestDepth = depth;
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return best;
}

/**
 * Normalize one `ios ui source` stdout blob to AX JSON text: unwrap the
 * JSON-RPC envelope (`{result: {children, rect, type}}`, measured live
 * 2026-10-22, ~35KB), map each DeviceKit node to AX keys
 * (label→AXLabel, rawIdentifier|name→AXUniqueId, type prefix-stripped,
 * rect→frame, value→AXValue), and unwrap the synthetic zero-rect
 * `XCUIElementTypeAny` result root so the app + status-bar subtrees are the
 * roots (a non-Any root stays a single-element array). With `point`, return
 * the single smallest-area containing element instead (object, not array).
 *
 * Pure: no network, no subprocess. Throws carry the backend text verbatim
 * (capped) and never claim a missing binary.
 */
export function normalizeDeviceKitSource(
  stdout: string,
  udid: string,
  point?: { x: number; y: number },
): string {
  const backend = stdout.trim().slice(0, 2000) || "(empty)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`ios ui source on device ${udid} returned unparseable JSON (backend output: ${backend})`);
  }
  const result = asRecord(parsed)?.["result"];
  const resultRec = asRecord(result);
  if (resultRec === null) {
    throw new Error(`ios ui source on device ${udid} returned JSON with a missing result (backend output: ${backend})`);
  }
  const root = mapNode(resultRec);
  // The result root is a synthetic container (zero rect, no identity) on
  // live dumps; unwrap exactly that shape, keep everything else faithful.
  const synthetic =
    resultRec["type"] === "XCUIElementTypeAny" && root.children !== undefined && root.children.length > 0;
  const roots: AxNode[] = synthetic ? root.children! : [root];
  if (point !== undefined) {
    const hit = hitTest(roots, point);
    if (hit === null) {
      throw new Error(`ui_describe found no element at (${point.x}, ${point.y}) on device ${udid}`);
    }
    return JSON.stringify(hit);
  }
  return JSON.stringify(roots);
}

/**
 * UiDriver for real devices over go-ios: `screenshot` is WDA-less
 * (measured 2026-10-22 on a paired iPhone 16 Pro Max: exit 0, genuine
 * 1320x2868 PNG, `{"msg":"File saved successfully"}`), while
 * `describeUi` (`ios ui source` → AX-normalized) and `tap`
 * (`ios ui tap --x --y`) need the running DeviceKit session
 * (`ios ui run devicekit` → local port 12004). The remaining verbs stay
 * precise P2 throws.
 *
 * Contract mirrors `Axe`: `describeUi` resolves AX JSON text the shared
 * compactor accepts (array, or a single object for point queries), `tap`
 * resolves the backend text trimmed. Device errors keep the backend text
 * verbatim and never claim a missing binary unless the spawn is ENOENT.
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
      throw realUiError(this.iosBin, "screenshot", udid, err);
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

  async describeUi(udid: string, point?: { x: number; y: number }): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    let stdout: string;
    try {
      ({ stdout } = await this.run(this.iosBin, ["ui", "source", `--udid=${udid}`], {
        timeoutMs: this.execTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (err) {
      throw realUiError(this.iosBin, "ui source", udid, err);
    }
    return normalizeDeviceKitSource(stdout, udid, point);
  }

  async tap(udid: string, target: TapTarget): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    const { x, y } = target;
    if (x === undefined || y === undefined) {
      throw new Error(`ui_tap on a real-device lease ${udid} takes coordinates only (${REAL_UI_TAP_SELECTOR_DETAIL}).`);
    }
    if (!Number.isFinite(x)) throw new Error(`Invalid x ${JSON.stringify(x)} (expected a finite number)`);
    if (!Number.isFinite(y)) throw new Error(`Invalid y ${JSON.stringify(y)} (expected a finite number)`);
    // Coords win over id/label/value, matching Axe.tap precedence; timing
    // modifiers (pre/postDelay, waitTimeout, pollInterval) and elementType
    // have no `ios ui tap` equivalent and are documented limits (§10).
    let stdout: string;
    try {
      ({ stdout } = await this.run(
        this.iosBin,
        ["ui", "tap", `--x=${x}`, `--y=${y}`, `--udid=${udid}`],
        { timeoutMs: this.execTimeoutMs },
      ));
    } catch (err) {
      throw realUiError(this.iosBin, "ui tap", udid, err);
    }
    return stdout.trim();
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
