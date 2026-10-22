import net from "node:net";
import { ExecError, Runner, defaultRunner, parseJson } from "./exec.js";

export const ORIENTATIONS = ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const CA_DEBUG_OPTIONS = ["blended", "copies", "misaligned", "offscreen", "slow-animations"] as const;
export type CaDebugOption = (typeof CA_DEBUG_OPTIONS)[number];

export const ON_OFF = ["on", "off"] as const;
export type OnOff = (typeof ON_OFF)[number];

export const CAMERA_SOURCES = ["placeholder", "webcam", "file"] as const;
export type CameraSource = (typeof CAMERA_SOURCES)[number];

export const CAMERA_MIRROR_MODES = ["auto", "on", "off"] as const;
export type CameraMirrorMode = (typeof CAMERA_MIRROR_MODES)[number];

/** Default first port scanned for per-lease streams (avoids daemon :3100 and serve-sim :3100/:3200). */
export const DEFAULT_STREAM_PORT_BASE = 3220;
/** How many consecutive ports to probe upward from the base before giving up. */
export const MAX_PORT_SCAN = 100;

export interface StreamInfo {
  url: string;
  port: number;
}

export interface StreamStatus {
  running: boolean;
  url?: string;
  port?: number;
  pid?: number;
}

/** Exactly one feed source for `camera <bundle-id>` (default: placeholder). */
export interface CameraStartOptions {
  source?: string;
  /** Image/video path. Required with source "file", rejected otherwise. */
  file?: string;
  /** Webcam name from --list-webcams. Only with source "webcam" (default camera when omitted). */
  webcam?: string;
}

/**
 * Parsed `camera status` output. `source`/`mirror` carry the helper's live
 * feed state (observed: placeholder|webcam|image|video|none,
 * unset|auto|on|off) and are absent when idle.
 */
export interface CameraStatus {
  udid?: string;
  alive: boolean;
  source?: string;
  mirror?: string;
  helperPid?: number;
  bundleIds?: string[];
  error?: string;
}

export interface WebcamDevice {
  id: string;
  name: string;
}

/** Minimal streaming surface the orchestrator needs (implemented by ServeSim, faked in tests). */
export interface StreamOps {
  startStream(udid: string, opts?: { portBase?: number }): Promise<StreamInfo>;
  stopStream(udid: string): Promise<void>;
}

function assertOrientation(value: string): asserts value is Orientation {
  if (!(ORIENTATIONS as readonly string[]).includes(value)) {
    throw new Error(`Invalid orientation ${JSON.stringify(value)} (expected ${ORIENTATIONS.join("|")})`);
  }
}

function assertCaDebugOption(value: string): asserts value is CaDebugOption {
  if (!(CA_DEBUG_OPTIONS as readonly string[]).includes(value)) {
    throw new Error(`Invalid ca-debug option ${JSON.stringify(value)} (expected ${CA_DEBUG_OPTIONS.join("|")})`);
  }
}

function assertOnOff(value: string): asserts value is OnOff {
  if (value !== "on" && value !== "off") {
    throw new Error(`Invalid ca-debug state ${JSON.stringify(value)} (expected on|off)`);
  }
}

function assertCameraSource(value: string): asserts value is CameraSource {
  if (!(CAMERA_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`Invalid camera source ${JSON.stringify(value)} (expected ${CAMERA_SOURCES.join("|")})`);
  }
}

function assertCameraMirrorMode(value: string): asserts value is CameraMirrorMode {
  if (!(CAMERA_MIRROR_MODES as readonly string[]).includes(value)) {
    throw new Error(`Invalid camera mirror mode ${JSON.stringify(value)} (expected ${CAMERA_MIRROR_MODES.join("|")})`);
  }
}

/** Shared file-arg check for start/switch: required iff source is "file". */
function assertCameraFileArg(source: string, file: string | undefined): void {
  if (source === "file" && file === undefined) {
    throw new Error(`Camera source "file" requires a file path.`);
  }
  if (source !== "file" && file !== undefined) {
    throw new Error(`Camera file is only valid with source "file" (got ${JSON.stringify(source)}).`);
  }
}

/**
 * Thin wrapper over the serve-sim CLI for device extras (rotation, CoreAnimation
 * debug flags, memory warnings, synthetic camera) and MJPEG streaming.
 * One-shot subcommands require a running server, so each command transparently
 * spawns a detached helper (`serve-sim --detach <udid> --port <scanned-free>`)
 * on the first "No serve-sim server running" failure and retries once. The
 * --port is load-bearing: without it serve-sim binds :3100 and SIGKILLs
 * whatever occupies that port — potentially our own daemon. Camera commands
 * manage their own simcam helper and never use that retry path.
 * Empirically: subcommands select the device with `-d/--device`; `--detach` and
 * `--kill` take the device positionally; success output is empty with exit 0
 * (except camera start/switch/mirror/stop, which print human-readable text —
 * serve-sim 0.1.48 ignores -q for camera — and camera status/--list-webcams,
 * which print JSON/TSV).
 */
export class ServeSim {
  private readonly bin: string;
  private readonly run: Runner;
  private readonly execTimeoutMs: number;
  private readonly portBase: number;
  private readonly helpers = new Map<string, number>();

  constructor(opts: { bin?: string; runner?: Runner; execTimeoutMs?: number; portBase?: number } = {}) {
    this.bin = opts.bin ?? "serve-sim";
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
    this.portBase = opts.portBase ?? DEFAULT_STREAM_PORT_BASE;
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.bin, ["--version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async rotate(udid: string, orientation: string): Promise<void> {
    assertOrientation(orientation);
    await this.withHelper(udid, ["rotate", "-d", udid, orientation]);
  }

  async caDebug(udid: string, option: string, state: string): Promise<void> {
    assertCaDebugOption(option);
    assertOnOff(state);
    await this.withHelper(udid, ["ca-debug", "-d", udid, option, state]);
  }

  async memoryWarning(udid: string): Promise<void> {
    await this.withHelper(udid, ["memory-warning", "-d", udid]);
  }

  /**
   * Launch bundleId on udid with a synthetic camera feed injected (relaunches
   * the app; needs a debuggable get-task-allow build). Default source is an
   * animated placeholder. Success output is human-readable text, so nothing
   * is parsed — use status() to read back state.
   */
  async start(udid: string, bundleId: string, opts: CameraStartOptions = {}): Promise<void> {
    const source = opts.source ?? "placeholder";
    assertCameraSource(source);
    const file = opts.file;
    const webcam = opts.webcam;
    assertCameraFileArg(source, file);
    if (file !== undefined && webcam !== undefined) {
      throw new Error("Pick one camera source: file or webcam, not both.");
    }
    if (source !== "webcam" && webcam !== undefined) {
      throw new Error(`Camera webcam name is only valid with source "webcam" (got ${JSON.stringify(source)}).`);
    }
    const args = ["camera", bundleId, "-d", udid];
    if (source === "file") args.push("--file", file as string);
    else if (source === "webcam") args.push(...(webcam === undefined ? ["--webcam"] : ["--webcam", webcam]));
    await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
  }

  /**
   * Hot-swap the live feed without relaunching the app. Fails when no camera
   * helper is running for udid (start one with start() first).
   */
  async switchSource(udid: string, source: string, file?: string): Promise<void> {
    assertCameraSource(source);
    assertCameraFileArg(source, file);
    const args = ["camera", "switch", source];
    if (source === "file") args.push(file as string);
    args.push("-d", udid);
    await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
  }

  /** Set preview mirroring for udid's camera feed (data buffers never auto-mirror). */
  async mirror(udid: string, mode: string): Promise<void> {
    assertCameraMirrorMode(mode);
    await this.run(this.bin, ["camera", "mirror", mode, "-d", udid], { timeoutMs: this.execTimeoutMs });
  }

  /**
   * Read the camera helper state for udid. Exit 0 either way: `{alive:false}`
   * when idle (no helper — the normal "no camera" state), full
   * `{alive:true, source, mirror, helperPid, bundleIds}` when streaming.
   */
  async status(udid: string): Promise<CameraStatus> {
    const { stdout } = await this.run(this.bin, ["camera", "status", "-d", udid], {
      timeoutMs: this.execTimeoutMs,
    });
    const info = extractJsonObject<Record<string, unknown>>(stdout, `serve-sim camera status ${udid}`);
    if (typeof info["alive"] !== "boolean") {
      throw new Error(
        `Failed to parse serve-sim camera status ${udid} as JSON: missing boolean "alive"\n${stdout.slice(0, 500)}`,
      );
    }
    const status: CameraStatus = { alive: info["alive"] };
    if (typeof info["udid"] === "string") status.udid = info["udid"];
    if (typeof info["source"] === "string") status.source = info["source"];
    if (typeof info["mirror"] === "string") status.mirror = info["mirror"];
    if (typeof info["helperPid"] === "number") status.helperPid = info["helperPid"];
    if (Array.isArray(info["bundleIds"]) && info["bundleIds"].every((b): b is string => typeof b === "string")) {
      status.bundleIds = info["bundleIds"];
    }
    if (typeof info["error"] === "string") status.error = info["error"];
    return status;
  }

  /**
   * Stop udid's camera helper (also terminates injected apps). Idempotent:
   * exit 0 with human-readable text even when idle.
   */
  async stop(udid: string): Promise<void> {
    await this.run(this.bin, ["camera", "--stop-webcam", "-d", udid], { timeoutMs: this.execTimeoutMs });
  }

  /** List host webcams (`id\tname` lines) for --webcam values. */
  async listWebcams(): Promise<WebcamDevice[]> {
    const { stdout } = await this.run(this.bin, ["camera", "--list-webcams"], { timeoutMs: this.execTimeoutMs });
    const devices: WebcamDevice[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tab = trimmed.indexOf("\t");
      if (tab === -1) devices.push({ id: trimmed, name: "" });
      else devices.push({ id: trimmed.slice(0, tab), name: trimmed.slice(tab + 1).trim() });
    }
    return devices;
  }

  /** Pids of helpers this instance spawned, keyed by udid (0 when unknown). */
  helperPids(): ReadonlyMap<string, number> {
    return this.helpers;
  }

  /** Spawn a detached helper for udid unless one is already tracked. Returns its pid (0 when unknown). */
  async ensureHelper(udid: string): Promise<number> {
    const known = this.helpers.get(udid);
    if (known !== undefined) return known;
    // Never detach without --port: serve-sim would bind :3100 and SIGKILL its occupant (possibly us).
    const port = await findFreePort(this.portBase);
    await this.run(this.bin, ["--detach", udid, "--port", String(port)], { timeoutMs: this.execTimeoutMs });
    let pid = 0;
    try {
      const { stdout } = await this.run(this.bin, ["--list", udid], { timeoutMs: this.execTimeoutMs });
      const info = parseJson<{ pid?: unknown }>(stdout, "serve-sim --list");
      if (typeof info.pid === "number") pid = info.pid;
    } catch {
      // --detach succeeded; pid tracking is best-effort.
    }
    this.helpers.set(udid, pid);
    return pid;
  }

  /** Stop the helper for udid, or every stream when udid is omitted. */
  async kill(udid?: string): Promise<void> {
    await this.run(this.bin, udid ? ["--kill", udid] : ["--kill"], { timeoutMs: this.execTimeoutMs });
    if (udid) this.helpers.delete(udid);
    else this.helpers.clear();
  }

  /**
   * Start (or reuse) a detached serve-sim helper for udid and return its MJPEG
   * stream URL. Idempotent: when a helper is already running for the udid its
   * existing URL is returned without spawning. Binds a scanned-free port from
   * portBase upward — never serve-sim's default :3100, which would collide with
   * (and SIGKILL!) our own daemon. Empirically `--detach` kills whatever
   * occupies its port instead of scanning, so the scan here is load-bearing.
   */
  async startStream(udid: string, opts: { portBase?: number } = {}): Promise<StreamInfo> {
    const existing = await this.streamStatus(udid);
    if (existing.running && existing.url !== undefined && existing.port !== undefined) {
      return { url: existing.url, port: existing.port };
    }
    const portBase = opts.portBase ?? this.portBase;
    const port = await findFreePort(portBase);
    const { stdout } = await this.run(this.bin, ["--detach", udid, "--port", String(port)], {
      timeoutMs: this.execTimeoutMs,
    });
    const info = extractJsonObject<Record<string, unknown>>(stdout, `serve-sim --detach ${udid}`);
    const actualPort = typeof info["port"] === "number" ? info["port"] : port;
    if (typeof info["pid"] === "number") this.helpers.set(udid, info["pid"]);
    else this.helpers.set(udid, 0);
    if (typeof info["streamUrl"] === "string") {
      return { url: info["streamUrl"], port: actualPort };
    }
    // Detach succeeded but carried no URL (unexpected shape): ask --list.
    const status = await this.streamStatus(udid);
    if (status.running && status.url !== undefined && status.port !== undefined) {
      return { url: status.url, port: status.port };
    }
    // Last resort: the conventional helper route on the port we requested.
    return { url: `http://127.0.0.1:${actualPort}/helper/${udid}/stream.mjpeg`, port: actualPort };
  }

  /** Stop the stream helper for udid. Idempotent: `--kill` exits 0 even when idle. */
  async stopStream(udid: string): Promise<void> {
    await this.kill(udid);
  }

  /** Free/busy probe for udid via `serve-sim --list <udid>` (exit 0 either way). */
  async streamStatus(udid: string): Promise<StreamStatus> {
    const { stdout } = await this.run(this.bin, ["--list", udid], { timeoutMs: this.execTimeoutMs });
    const info = extractJsonObject<Record<string, unknown>>(stdout, `serve-sim --list ${udid}`);
    if (info["running"] !== true) return { running: false };
    const status: StreamStatus = { running: true };
    if (typeof info["streamUrl"] === "string") status.url = info["streamUrl"];
    if (typeof info["port"] === "number") status.port = info["port"];
    if (typeof info["pid"] === "number") status.pid = info["pid"];
    return status;
  }

  private async withHelper(udid: string, args: string[]): Promise<void> {
    try {
      await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
      return;
    } catch (err) {
      if (!isNoServerError(err)) throw err;
    }
    await this.ensureHelper(udid);
    await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
  }
}

function isNoServerError(err: unknown): boolean {
  return err instanceof ExecError && /no serve-sim server running/i.test(`${err.stdout}\n${err.stderr}`);
}

/**
 * Parse serve-sim's JSON out of stdout that may carry human-readable prefix
 * lines (empirically `--detach` console.logs "Port N busy, killing listener
 * pid(s): …" to stdout before its JSON object).
 */
export function extractJsonObject<T>(text: string, what: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Failed to parse ${what} as JSON: no object found\n${text.slice(0, 500)}`);
  }
  return parseJson<T>(text.slice(start, end + 1), what);
}

/** First port in [base, base+MAX_PORT_SCAN) that binds on 127.0.0.1. */
export async function findFreePort(base: number, maxAttempts = MAX_PORT_SCAN): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = base + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${base}-${base + maxAttempts - 1}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
