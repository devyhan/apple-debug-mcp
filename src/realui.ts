import fs from "node:fs";
import { ExecError, Runner, defaultRunner } from "./exec.js";
import { GO_IOS_INSTALL_HINT } from "./realdevices.js";
import type { BatchOptions, GestureOptions, SwipeOptions, TapTarget, UiDriver } from "./uidriver.js";

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

/**
 * Precise limit for gesture presets on real hardware: go-ios 1.3.2 has no
 * `ui gesture` verb (usage lists download|status|api|tap|swipe|longpress|
 * type|button|screenshot|source|size|orientation|app|stream|raw — grounded
 * in the binary usage text), the DeviceKit `device.io.gesture` RPC reachable
 * only via raw `ui api` takes ungrounded params (no preset strings in the
 * 0.0.18 runner binary), and the Axe preset→coordinates formulas are
 * unknown — so presets cannot be rebuilt over `ios ui swipe` without
 * diverging from sim behavior. Deliberately NOT faked via a guessed swipe.
 */
export const REAL_UI_GESTURE_DETAIL =
  "go-ios 1.3.2 has no `ui gesture` verb and the Axe preset→coordinates formulas are unknown, " +
  "so gesture presets have no real-device CLI equivalent — use ui_swipe with explicit coordinates instead " +
  "(`ios ui size` reports the live screen geometry; measured 440x956@3x on 2026-10-22)";

/**
 * DeviceKit `device.io.button` values, grounded in the 0.0.18 runner binary
 * (`strings` over devicekit-iosUITests: exactly {home, lock, volumeUp,
 * volumeDown}; no siri/side-button/apple-pay). go-ios passes `<button>`
 * through verbatim, so anything outside this set fails here with zero
 * spawns instead of a backend `-32602 Invalid parameters`.
 */
export const REAL_UI_BUTTONS = ["home", "lock", "volumeUp", "volumeDown"] as const;
export type RealUiButton = (typeof REAL_UI_BUTTONS)[number];

function isRealUiButton(value: string): value is RealUiButton {
  return (REAL_UI_BUTTONS as readonly string[]).includes(value);
}

/** `ios ui button` takes the name positional only — no `--duration` flag (binary usage text). */
export const REAL_UI_BUTTON_DURATION_DETAIL =
  "`ios ui button <button>` takes the name positional only (measured go-ios 1.3.2, no --duration flag), " +
  "so a hold duration cannot be performed on a real-device lease — and is refused rather than faked as a tap";

/** Batch step heads, mirroring `Axe` exactly (screenshot stays rejected). */
const REAL_BATCH_HEADS = new Set([
  "tap", "swipe", "gesture", "touch", "type", "button", "key", "key-sequence", "key-combo", "sleep",
]);

function unsupportedBatchStep(step: string): Error {
  return new Error(
    `Unsupported batch step: ${JSON.stringify(step)} (must start with ${[...REAL_BATCH_HEADS].join(", ")})`,
  );
}

/**
 * Minimal shell-ish lexer for AXe batch fragments: single/double quotes
 * group, backslash escapes the next char (covers `tap --label Sign\\ In`
 * and `type 'hello'`). Returns tokens with quoting removed.
 */
function lexBatchStep(step: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  const push = (): void => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < step.length; i++) {
    const ch = step[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < step.length) cur += step[++i]!;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < step.length) {
      cur += step[++i]!;
      started = true;
    } else if (ch === " " || ch === "\t") {
      push();
    } else {
      cur += ch;
      started = true;
    }
  }
  push();
  return tokens;
}

interface BatchFlagSet {
  positionals: string[];
  flags: Map<string, string | null>;
}

/** Split tokens into positionals and `--flag [value]` / `--flag=value` / `-x value` forms. */
function splitBatchFlags(tokens: string[]): BatchFlagSet {
  const positionals: string[] = [];
  const flags = new Map<string, string | null>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    const eq = tok.startsWith("-") ? tok.indexOf("=") : -1;
    if (eq !== -1) {
      flags.set(tok.slice(0, eq), tok.slice(eq + 1));
    } else if (tok.startsWith("--") && tok.length > 2) {
      const next = tokens[i + 1];
      if (next !== undefined && (!next.startsWith("-") || Number.isFinite(Number(next)))) {
        flags.set(tok, next);
        i++;
      } else {
        flags.set(tok, null);
      }
    } else if (/^-[a-zA-Z]$/.test(tok)) {
      const next = tokens[i + 1];
      if (next !== undefined && (!next.startsWith("-") || Number.isFinite(Number(next)))) {
        flags.set(tok, next);
        i++;
      } else {
        flags.set(tok, null);
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function batchFlagNumber(flags: Map<string, string | null>, names: string[]): number | undefined {
  for (const name of names) {
    if (!flags.has(name)) continue;
    const raw = flags.get(name);
    if (raw === null || raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid ${name} ${JSON.stringify(raw)} in batch step (expected a finite number)`);
    }
    return n;
  }
  return undefined;
}

function batchHasAnyFlag(flags: Map<string, string | null>, names: string[]): boolean {
  return names.some((n) => flags.has(n));
}

/** One statically-validated batch step: zero-spawn planning, execution later. */
type PlannedBatchStep =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; fromX: number; fromY: number; toX: number; toY: number; duration?: number }
  | { kind: "type"; text: string }
  | { kind: "button"; button: RealUiButton }
  | { kind: "sleep"; seconds: number };

function planBatchStep(step: string, udid: string): PlannedBatchStep {
  const tokens = lexBatchStep(step);
  const head = tokens[0] ?? "";
  if (!REAL_BATCH_HEADS.has(head)) throw unsupportedBatchStep(step);
  const { positionals, flags } = splitBatchFlags(tokens.slice(1));
  switch (head) {
    case "tap": {
      const x = batchFlagNumber(flags, ["-x", "--x"]);
      const y = batchFlagNumber(flags, ["-y", "--y"]);
      if (x === undefined || y === undefined) {
        throw new Error(`ui_batch tap step on a real-device lease ${udid} takes coordinates only (${REAL_UI_TAP_SELECTOR_DETAIL}).`);
      }
      return { kind: "tap", x, y };
    }
    case "swipe": {
      const fromX = batchFlagNumber(flags, ["--start-x"]);
      const fromY = batchFlagNumber(flags, ["--start-y"]);
      const toX = batchFlagNumber(flags, ["--end-x"]);
      const toY = batchFlagNumber(flags, ["--end-y"]);
      if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
        throw new Error(
          `ui_batch swipe step on a real-device lease ${udid} needs --start-x/--start-y/--end-x/--end-y (got ${JSON.stringify(step)}).`,
        );
      }
      const duration = batchFlagNumber(flags, ["--duration"]);
      return { kind: "swipe", fromX, fromY, toX, toY, ...(duration !== undefined ? { duration } : {}) };
    }
    case "type": {
      const text = positionals.join(" ");
      if (text.length === 0) throw new Error("Invalid text (expected a non-empty string)");
      return { kind: "type", text };
    }
    case "button": {
      const name = positionals[0];
      if (name === undefined || name.length === 0) {
        throw new Error(`ui_batch button step on a real-device lease ${udid} needs a button name (got ${JSON.stringify(step)}).`);
      }
      if (batchHasAnyFlag(flags, ["--duration"])) {
        throw new Error(`ui_batch button step on a real-device lease ${udid} takes no duration (${REAL_UI_BUTTON_DURATION_DETAIL}).`);
      }
      if (!isRealUiButton(name)) {
        throw new Error(
          `ui_button ${JSON.stringify(name)} is not supported on a real-device lease ${udid}: ` +
          `DeviceKit accepts ${REAL_UI_BUTTONS.join(", ")} only (grounded in the 0.0.18 runner binary).`,
        );
      }
      return { kind: "button", button: name };
    }
    case "sleep": {
      if (positionals.length !== 1) {
        throw new Error(`ui_batch sleep step takes exactly one <seconds> arg (got ${JSON.stringify(step)}).`);
      }
      const seconds = Number(positionals[0]);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`Invalid sleep ${JSON.stringify(positionals[0])} in batch step (expected seconds >= 0).`);
      }
      return { kind: "sleep", seconds };
    }
    case "gesture": {
      const preset = positionals[0] ?? "(missing preset)";
      throw new Error(`ui_gesture preset ${JSON.stringify(preset)} is not supported on a real-device lease ${udid} (${REAL_UI_GESTURE_DETAIL}).`);
    }
    case "touch":
      throw new Error(
        `ui_batch touch step is not supported on a real-device lease ${udid}: no go-ios CLI equivalent ` +
        "(`ios ui longpress` covers hold-at-point only — lone touch-down/up pairing cannot be expressed).",
      );
    case "key":
    case "key-sequence":
    case "key-combo":
      throw new Error(
        `ui_batch ${head} step is not supported on a real-device lease ${udid}: no go-ios CLI equivalent ` +
        "(go-ios 1.3.2 has no keyboard/key-injection ui verb).",
      );
    default:
      throw unsupportedBatchStep(step);
  }
}

/** PNG file signature (first 8 bytes of every genuine PNG). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
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
 * `describeUi` (`ios ui source` → AX-normalized), `tap`, `typeText`,
 * `swipe`, `button`, and the per-step `batch` fan-out need the running
 * DeviceKit session (`ios ui run devicekit` → local port 12004).
 * `gesture` presets stay a precise unsupported error (no CLI equivalent).
 *
 * Contract mirrors `Axe`: `describeUi` resolves AX JSON text the shared
 * compactor accepts (array, or a single object for point queries), the
 * action verbs resolve the backend text trimmed — except exit-0
 * JSON-RPC error envelopes, which reject loudly (a resolved `-32602`
 * would fake-ok a failed device action; measured live on swipe).
 * Device errors keep the backend text verbatim and never claim a
 * missing binary unless the spawn is ENOENT.
 */
/**
 * Resolve an action verb's exit-0 stdout — loudly. The DeviceKit backend
 * reports RPC failures as exit-0 JSON-RPC error envelopes (measured live:
 * swipe `-32602 Invalid parameters` with identical stdout shape to
 * success); resolving them as success strings would fake-ok a failed
 * device action. A parsed envelope with a non-null `error` member throws
 * with the backend text verbatim (no diagnosis — refusals, a down
 * session, and backend defects all keep their own text). Non-JSON
 * output and `error: null` resolve trimmed: unknown shapes are never
 * reframed. Never throws on unparseable input.
 */
function resolveUiAction(verb: string, udid: string, stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
    if (typeof parsed === "object" && parsed !== null && (parsed as { error?: unknown }).error != null) {
      throw new Error(`ios ${verb} on device ${udid} failed: ${trimmed}`);
    }
  }
  return trimmed;
}

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
    return resolveUiAction("ui tap", udid, stdout);
  }

  async typeText(udid: string, text: string): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    if (text.length === 0) throw new Error("Invalid text (expected a non-empty string)");
    let stdout: string;
    try {
      ({ stdout } = await this.run(
        this.iosBin,
        ["ui", "type", `--text=${text}`, `--udid=${udid}`],
        { timeoutMs: this.execTimeoutMs },
      ));
    } catch (err) {
      throw realUiError(this.iosBin, "ui type", udid, err);
    }
    return resolveUiAction("ui type", udid, stdout);
  }

  async swipe(
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: SwipeOptions,
  ): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) {
      throw new Error(`Invalid from ${JSON.stringify(from)} (expected finite x/y numbers)`);
    }
    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) {
      throw new Error(`Invalid to ${JSON.stringify(to)} (expected finite x/y numbers)`);
    }
    const duration = opts?.duration;
    if (duration !== undefined && !Number.isFinite(duration)) {
      throw new Error(`Invalid duration ${JSON.stringify(duration)} (expected a finite number)`);
    }
    // delta (touch-point spacing) and pre/postDelay (client pacing) change
    // WHEN/granularity, never WHAT the device does — ignored on real leases
    // per the §10 tap-modifier precedent, documented in §11.
    //
    // The swipe goes through `ui api`, NOT `ui swipe`: go-ios 1.3.2 sends
    // {fromX,fromY,toX,toY} (cmd_ui.go) but the DeviceKit runner rejects
    // that shape with -32602 and accepts {x1,y1,x2,y2} (measured live:
    // fromX → -32602 on every variant, x1 → success + real page move).
    const params: { x1: number; y1: number; x2: number; y2: number; duration?: number } = {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
    };
    if (duration !== undefined) params.duration = duration;
    const args = [
      "ui", "api", "--rpc-method=device.io.swipe", `--params=${JSON.stringify(params)}`,
      `--udid=${udid}`,
    ];
    let stdout: string;
    try {
      ({ stdout } = await this.run(this.iosBin, args, { timeoutMs: this.execTimeoutMs }));
    } catch (err) {
      throw realUiError(this.iosBin, "ui swipe", udid, err);
    }
    return resolveUiAction("ui swipe", udid, stdout);
  }

  async gesture(udid: string, preset: string, _opts?: GestureOptions): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    throw new Error(`ui_gesture preset ${JSON.stringify(preset)} is not supported on a real-device lease ${udid} (${REAL_UI_GESTURE_DETAIL}).`);
  }

  async button(udid: string, button: string, duration?: number): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    if (duration !== undefined) {
      // A hold is a different device action than a press — ignoring it
      // would fake a hold as a tap, so it is refused (zero spawns).
      throw new Error(`ui_button hold duration=${duration} is not supported on a real-device lease ${udid} (${REAL_UI_BUTTON_DURATION_DETAIL}).`);
    }
    if (!isRealUiButton(button)) {
      throw new Error(
        `ui_button ${JSON.stringify(button)} is not supported on a real-device lease ${udid}: ` +
        `DeviceKit accepts ${REAL_UI_BUTTONS.join(", ")} only (grounded in the 0.0.18 runner binary).`,
      );
    }
    let stdout: string;
    try {
      ({ stdout } = await this.run(
        this.iosBin,
        ["ui", "button", button, `--udid=${udid}`],
        { timeoutMs: this.execTimeoutMs },
      ));
    } catch (err) {
      throw realUiError(this.iosBin, "ui button", udid, err);
    }
    return resolveUiAction("ui button", udid, stdout);
  }

  async batch(udid: string, steps: string[], opts?: BatchOptions): Promise<string> {
    if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
    if (steps.length === 0) throw new Error("batch requires at least one step");
    // Plan every step before anything spawns: a malformed or unsupported
    // step anywhere fails the whole batch with zero device interaction.
    const planned = steps.map((step) => planBatchStep(step, udid));
    // waitTimeout/pollInterval/verbose are selector-polling/HID plumbing
    // with no real-device meaning (no selector resolution) — ignored per
    // the §10 precedent; continueOnError is honored in-process below.
    const lines: string[] = [];
    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]!;
      const head = lexBatchStep(steps[i]!)[0] ?? "";
      try {
        switch (step.kind) {
          case "tap":
            lines.push(await this.tap(udid, { x: step.x, y: step.y }));
            break;
          case "swipe":
            lines.push(await this.swipe(
              udid, { x: step.fromX, y: step.fromY }, { x: step.toX, y: step.toY },
              step.duration !== undefined ? { duration: step.duration } : undefined,
            ));
            break;
          case "type":
            lines.push(await this.typeText(udid, step.text));
            break;
          case "button":
            lines.push(await this.button(udid, step.button));
            break;
          case "sleep":
            await new Promise((resolve) => setTimeout(resolve, step.seconds * 1000));
            lines.push(`slept ${step.seconds}s`);
            break;
        }
      } catch (err) {
        if (opts?.continueOnError !== true) throw err;
        lines.push(`step ${i + 1} (${head}) failed: ${(err as Error).message}`);
      }
    }
    return lines.join("\n");
  }
}
