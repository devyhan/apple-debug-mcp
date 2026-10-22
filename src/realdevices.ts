import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPlistTargetShape } from "./appcache.js";
import type { CacheClearOptions, CacheClearResult } from "./appcache.js";
import type { AppOps, LaunchResult } from "./appops.js";
import type { DeviceTransport } from "./devicekind.js";
import { ExecError, Runner, defaultRunner } from "./exec.js";

/** Install command for go-ios, confirmed from the go-ios README (npm distribution). */
export const GO_IOS_INSTALL_HINT = "npm install -g go-ios";

/** Safari bundle id (verified live: `devicectl device info apps` lists Safari as this). */
const SAFARI_BUNDLE_ID = "com.apple.mobilesafari";

/**
 * Error detail for non-http(s) open-url on real hardware (P2): no
 * stock-handler dispatch CLI exists. Measured: `devicectl device process
 * launch --help` (518.33) documents `--payload-url` but requires an
 * explicit target bundle, so only http(s) via Safari is wired; go-ios
 * 1.3.2 has no openurl verb (only Remote-Automation-gated
 * `webinspector launch <url>`).
 */
export const APP_OPEN_URL_NON_HTTP_DETAIL =
  "no stock-handler open-url transport on real hardware (devicectl process launch --payload-url needs an explicit target bundle — only http(s) via Safari is wired; go-ios has no openurl verb, only Remote-Automation-gated webinspector launch)";

/**
 * Error detail for cache-clear on real hardware (P2): no container-delete
 * transport for THIS app. Measured live on a paired iPhone 16 Pro Max:
 * `ios fsync tree` on an App Store app → VendContainer denied
 * (InstallationLookupFailed — "Full container access requires an app
 * installed with a developer profile") or ContainerLookupErrorDomain/3,
 * while a full fsync mkdir/push/tree/rm roundtrip SUCCEEDS on a
 * developer-profile-installed app. `devicectl device copy` is to/from
 * only (no delete). Uninstall+reinstall would wipe Documents and log
 * out, violating the no-logout contract.
 */
export const APP_CACHE_CLEAR_NO_TRANSPORT_DETAIL =
  "no container-delete transport for this app (measured on a paired iPhone: ios fsync tree → ContainerLookupErrorDomain/3 or VendContainer denied unless the app was installed with a developer profile — a full fsync mkdir/push/tree/rm roundtrip succeeds on dev-profile installs; devicectl copy has no delete; uninstall+reinstall would wipe Documents and log out)";

function assertUdid(udid: string): void {
  if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
}

function assertBundleId(bundleId: string): void {
  if (bundleId.trim().length === 0) throw new Error("Invalid bundle_id (expected a non-empty string)");
}

function assertAppPath(appPath: string): void {
  if (appPath.trim().length === 0) throw new Error("Invalid app_path (expected a non-empty string)");
}

function assertUrl(url: string): void {
  if (url.trim().length === 0) throw new Error("Invalid url (expected a non-empty string)");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url.trim())) {
    throw new Error(`Invalid url ${JSON.stringify(url)} (expected a scheme, e.g. "https://…")`);
  }
}

/**
 * One real (physical) device as listed by `xcrun devicectl list devices`.
 * `udid` is the lockdown udid (`hardwareProperties.udid`) — the same namespace
 * go-ios `ios --udid` and `xctrace --device` use.
 */
export interface PoolDevice {
  /** Lockdown udid (`hardwareProperties.udid`), e.g. `00008110-…`. */
  udid: string;
  name: string;
  /** "available" when acquirable, else "unavailable" (shown, not acquirable). */
  state: string;
  platform?: string;
  osVersion?: string;
  kind: "real";
  /**
   * Bearer from connectionProperties.transportType ("wired" ⇒ usb).
   * tunnelState does NOT encode the bearer (a USB-attached iPhone reports
   * tunnelState "disconnected"). Absent/unknown values map to undefined.
   */
  transport?: DeviceTransport;
  trust: { paired: boolean; developerMode: string | null };
  /** CoreDevice `identifier`: escape hatch for `devicectl --device` if the udid form ever fails. */
  coredeviceId: string;
}

interface DevicectlDeviceJson {
  identifier?: unknown;
  deviceProperties?: {
    name?: unknown;
    osVersionNumber?: unknown;
    developerModeStatus?: unknown;
  };
  hardwareProperties?: {
    udid?: unknown;
    platform?: unknown;
  };
  connectionProperties?: {
    pairingState?: unknown;
    tunnelState?: unknown;
    transportType?: unknown;
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Map one devicectl JSON device to a PoolDevice; null when unaddressable (no lockdown udid). */
export function mapDevicectlDevice(device: DevicectlDeviceJson): PoolDevice | null {
  if (typeof device !== "object" || device === null) return null;
  const udid = str(device.hardwareProperties?.udid);
  const coredeviceId = str(device.identifier);
  if (!udid || !coredeviceId) return null;
  const tunnelState = str(device.connectionProperties?.tunnelState) ?? "unavailable";
  const platform = str(device.hardwareProperties?.platform);
  const osVersion = str(device.deviceProperties?.osVersionNumber);
  const transport: DeviceTransport | undefined =
    str(device.connectionProperties?.transportType) === "wired" ? "usb" : undefined;
  return {
    udid,
    name: str(device.deviceProperties?.name) ?? udid,
    state: tunnelState === "unavailable" ? "unavailable" : "available",
    ...(platform !== undefined ? { platform } : {}),
    ...(osVersion !== undefined ? { osVersion } : {}),
    kind: "real",
    ...(transport !== undefined ? { transport } : {}),
    trust: {
      paired: device.connectionProperties?.pairingState === "paired",
      developerMode: str(device.deviceProperties?.developerModeStatus) ?? null,
    },
    coredeviceId,
  };
}

/**
 * Run a devicectl subcommand with file-only JSON (`-j <tmpfile> -q`, the only
 * stable programmatic interface per `devicectl --help`) and parse the file.
 * The tmp dir is removed best-effort; concurrent calls never share a path.
 */
async function runDevicectlJson(run: Runner, args: string[], execTimeoutMs: number): Promise<unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-devicectl-"));
  const file = path.join(dir, "out.json");
  try {
    await run("xcrun", ["devicectl", ...args, "-j", file, "-q"], { timeoutMs: execTimeoutMs });
  } catch (err) {
    throw devicectlError(args, err);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`xcrun devicectl ${args.join(" ")} returned unparseable JSON: ${(err as Error).message}`);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function devicectlError(args: string[], err: unknown): Error {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return new Error(`${msg}. Xcode's devicectl is not installed; install Xcode + accept the license (xcode-select --install)`);
  }
  if (/pair|trust|developer.?mode|not.?paired|unauthorized/i.test(msg)) {
    return new Error(
      `${msg}. Checklist: device paired (pairingState "paired"), host trusted (tap Trust on the device), ` +
        `Developer Mode on (required since iOS 16), device reachable — see pool_status`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/**
 * Real-device inventory provider, devicectl-backed. Deliberately NOT FleetOps:
 * boot/slim have no hardware meaning, so the orchestrator holds this narrow
 * provider beside the sim fleet and branches on deviceKind.
 */
export class RealDevices {
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { runner?: Runner; execTimeoutMs?: number } = {}) {
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  /** Probe for boot/doctor: resolves with the devicectl version, rejects when unusable. */
  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run("xcrun", ["devicectl", "--version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  /** Every known device (available and unavailable), mapped to PoolDevice rows. */
  async list(): Promise<PoolDevice[]> {
    const parsed = await runDevicectlJson(this.run, ["list", "devices"], this.execTimeoutMs);
    const devices = (parsed as { result?: { devices?: unknown } })?.result?.devices;
    if (!Array.isArray(devices)) {
      throw new Error("xcrun devicectl list devices returned unexpected JSON (missing result.devices[])");
    }
    const mapped: PoolDevice[] = [];
    for (const device of devices) {
      const row = mapDevicectlDevice(device as DevicectlDeviceJson);
      if (row) mapped.push(row);
    }
    return mapped;
  }
}

/** Extract the `<UUID>` container segment shared by process executables and app urls. */
function containerUuid(p: string): string | null {
  const match = /Bundle\/Application\/([0-9A-Fa-f-]{36})\//.exec(p);
  return match?.[1]?.toUpperCase() ?? null;
}

interface DevicectlProcessesJson {
  result?: { runningProcesses?: { executable?: unknown; processIdentifier?: unknown }[] };
}

interface DevicectlAppsJson {
  result?: { apps?: { bundleIdentifier?: unknown; url?: unknown }[] };
}

/** Fail-soft error bound for real-device cache clears (mirrors the sim path). */
const MAX_REAL_CACHE_ERRORS = 20;

/** `ios fsync` denial forms measured live (all mean "no container access for this app"). */
function isFsyncDenied(msg: string): boolean {
  return /ContainerLookupErrorDomain|VendContainer|InstallationLookupFailed|developer.profile|ActionError/i.test(msg);
}

/**
 * Missing-path form (NOT a denial): `afc error code: 8 (ObjectNotFound)`,
 * measured verbatim from `ios fsync tree` on a removed path.
 */
function isFsyncNotFound(msg: string): boolean {
  return /ObjectNotFound|afc error code:\s*8\b/i.test(msg);
}

function realCacheClearP2(): Error {
  return new Error(
    `app_cache_clear is denied for this app on a real-device lease: real-device support lands in P2 (${APP_CACHE_CLEAR_NO_TRANSPORT_DETAIL}).`,
  );
}

/**
 * Top-level entry names from `ios fsync tree` output. Measured format
 * (go-ios 1.3.2): each entry is prefixed by `"|  "` per depth level plus
 * `"|-"` — but the shallowest depth is NOT 0: `tree
 * --path=Library/Caches` on a paired iPhone emits `"|  |  |-AdMob/"`
 * (depth 2) as its shallowest lines, with zero depth-0 lines. So depth is
 * counted per line and only the minimum-depth names are kept; anything
 * else (root line, JSON noise, blanks) never matches. A trailing `/` dir
 * marker is stripped. Sorted for deterministic deletes.
 */
export function parseFsyncTreeTopLevel(output: string): string[] {
  const found: { depth: number; name: string }[] = [];
  for (const raw of output.split("\n")) {
    const match = /^((?:\|  )*)\|-(.+)$/.exec(raw.replace(/\r$/, ""));
    if (!match) continue;
    const name = match[2]!.replace(/\s+$/, "").replace(/\/+$/, "");
    if (name.length === 0) continue;
    found.push({ depth: match[1]!.length / 3, name });
  }
  if (found.length === 0) return [];
  const min = Math.min(...found.map((f) => f.depth));
  return found
    .filter((f) => f.depth === min)
    .map((f) => f.name)
    .sort();
}

/**
 * App lifecycle on a real device: go-ios (`ios`) backend for
 * install/uninstall/launch/terminate, devicectl for openUrl (http(s) via
 * Safari `--payload-url`) and the listRunning join. Argv confirmed against
 * go-ios main-branch source (`ios install --path=<p>`, `ios uninstall
 * <bundleID>`, `ios launch <bundleID> [--arg=<a>]…`, `ios kill
 * <bundleID>…`, global `--udid=<udid>`).
 */
export class RealDeviceApps implements AppOps {
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

  /**
   * Open an http(s) URL in Safari via `devicectl device process launch
   * --payload-url` (default --activate foregrounds it, like simctl
   * openurl). Non-http(s) schemes stay P2: hardware has no stock-handler
   * dispatch CLI. Argv from `devicectl device process launch --help`
   * (518.33); live-verified 2026-10-22 on a paired iPhone 16 Pro Max
   * (openUrl https://www.apple.com → devicectl success, Safari running).
   */
  async openUrl(udid: string, url: string): Promise<void> {
    assertUdid(udid);
    assertUrl(url);
    if (!/^https?:/i.test(url.trim())) {
      throw new Error(`app_open_url does not support real-device leases yet for non-http(s) URLs: real-device support lands in P2 (${APP_OPEN_URL_NON_HTTP_DETAIL}).`);
    }
    // Options precede the bundle positional: trailing positionals are app
    // argv, which would swallow a --payload-url placed after the bundle.
    const args = ["device", "process", "launch", "--device", udid, "--payload-url", url, SAFARI_BUNDLE_ID];
    try {
      await this.run("xcrun", ["devicectl", ...args], { timeoutMs: this.execTimeoutMs });
    } catch (err) {
      throw devicectlError(args, err);
    }
  }

  async install(udid: string, appPath: string): Promise<void> {
    assertUdid(udid);
    assertAppPath(appPath);
    await this.ios(["install", `--path=${appPath}`, `--udid=${udid}`], "install", udid);
  }

  async uninstall(udid: string, bundleId: string): Promise<void> {
    assertUdid(udid);
    assertBundleId(bundleId);
    await this.ios(["uninstall", bundleId, `--udid=${udid}`], "uninstall", udid);
  }

  /**
   * Launch bundleId, passing argv as `--arg=<a>` flags. Resolves with the pid
   * go-ios logs (`pid=<n>`); pid is -1 when the output is unparseable.
   */
  async launch(udid: string, bundleId: string, argv: string[] = []): Promise<LaunchResult> {
    assertUdid(udid);
    assertBundleId(bundleId);
    const { stdout, stderr } = await this.ios(
      ["launch", bundleId, ...argv.map((a) => `--arg=${a}`), `--udid=${udid}`],
      "launch",
      udid,
    );
    const match = /\bpid["=:\s]+\"?(\d+)/i.exec(`${stdout}\n${stderr}`);
    const output = stdout.trim() !== "" ? stdout.trim() : stderr.trim();
    return { pid: match?.[1] ? Number(match[1]) : -1, output };
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    assertUdid(udid);
    assertBundleId(bundleId);
    await this.ios(["kill", bundleId, `--udid=${udid}`], "terminate", udid);
  }

  /**
   * Attempt-with-precise-fallback cache clear (measured 2026-10-22 on a
   * paired iPhone 16 Pro Max): developer-profile-installed apps get a
   * real clear via `ios fsync` — tolerant `kill`, then a `tree` probe of
   * `Library/Caches`, then per-entry `rm --r`. Container-denied apps
   * (App Store installs) fall back to the precise P2 without deleting
   * anything. `plist_keys` is refused: fsync has file pull/push/rm/tree/
   * mkdir only, with no plist read-modify-write.
   *
   * `container`/`cachesDir`/`deleted` are DEVICE-side
   * `ios-fsync://<udid>/<bundle>/…` paths — deliberately not
   * host-absolute, so callers never feed them to host fs ops (sim
   * results ARE host-absolute). Documents/Keychain are never touched.
   */
  async clearCache(udid: string, bundleId: string, opts: CacheClearOptions = {}): Promise<CacheClearResult> {
    assertUdid(udid);
    assertBundleId(bundleId);
    const plistTargets = opts.plistKeys ?? [];
    for (const t of plistTargets) assertPlistTargetShape(t);
    if (plistTargets.length > 0) {
      throw new Error(
        "app_cache_clear plist_keys is not supported on real-device leases: `ios fsync` offers file " +
          "pull/push/rm/tree/mkdir only, with no plist read-modify-write (measured on go-ios 1.3.2) — " +
          "re-run without plist_keys to clear Caches; nothing was deleted.",
      );
    }

    const errors: string[] = [];
    const pushError = (m: string): void => {
      if (errors.length < MAX_REAL_CACHE_ERRORS) errors.push(m.slice(0, 300));
    };
    const base = `ios-fsync://${udid}/${bundleId}`;
    const appFlag = `--app=${bundleId}`;
    const udidFlag = `--udid=${udid}`;

    // 1. Terminate first (tolerant: a non-running app is the common case).
    // Raw runner (not this.ios): kill failures are fail-soft notes, and
    // raw errors keep their device text for the classifiers below.
    let terminated = true;
    try {
      await this.run(this.iosBin, ["kill", bundleId, udidFlag], { timeoutMs: this.execTimeoutMs });
    } catch (err) {
      terminated = false;
      pushError(`terminate: ${(err as Error).message}`);
    }

    // 2. Probe Caches readability BEFORE any delete, so the P2 fallback
    // is side-effect-free. A missing Caches dir is an empty clear.
    let treeOut: string;
    try {
      const { stdout, stderr } = await this.run(
        this.iosBin,
        ["fsync", "tree", appFlag, udidFlag, "--path=Library/Caches"],
        { timeoutMs: this.execTimeoutMs },
      );
      treeOut = `${stdout}\n${stderr}`;
    } catch (err) {
      const msg = (err as Error).message;
      if (isFsyncDenied(msg)) throw realCacheClearP2();
      if (isFsyncNotFound(msg)) {
        return {
          container: base,
          cachesDir: `${base}/Library/Caches`,
          deleted: [],
          deletedCount: 0,
          plistKeysRemoved: [],
          terminated,
          errors,
        };
      }
      throw iosError(this.iosBin, "cache-clear probe", udid, err);
    }

    // 3. Per-entry `rm --r` (fail-soft like the sim path). A denial
    // mid-run throws P2 — never partial-delete + ok.
    const entries = parseFsyncTreeTopLevel(treeOut);
    if (entries.length === 0 && /[|+]/.test(treeOut)) {
      pushError("fsync tree output had no parseable top-level entries; nothing deleted");
    }
    const deleted: string[] = [];
    for (const entry of entries) {
      if (entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) {
        pushError(`refused to delete outside Caches: ${entry}`);
        continue;
      }
      const rel = `Library/Caches/${entry}`;
      try {
        await this.run(this.iosBin, ["fsync", "rm", "--r", appFlag, udidFlag, `--path=${rel}`], {
          timeoutMs: this.execTimeoutMs,
        });
        deleted.push(`${base}/${rel}`);
      } catch (err) {
        const msg = (err as Error).message;
        if (isFsyncDenied(msg)) throw realCacheClearP2();
        pushError(`delete ${entry}: ${msg}`);
      }
    }

    return {
      container: base,
      cachesDir: `${base}/Library/Caches`,
      deleted,
      deletedCount: deleted.length,
      plistKeysRemoved: [],
      terminated,
      errors,
    };
  }

  /**
   * Bundle ids of apps currently running on the device, by joining devicectl
   * `processes` (executable container UUIDs) against `apps` (bundle urls).
   * Unmapped executables (system daemons, unlisted containers) are skipped,
   * mirroring SimApps.listRunning's garbage-line tolerance. Never throws:
   * empty/both-fail yields an empty set (contamination detection fail-softs).
   */
  async listRunning(udid: string): Promise<Set<string>> {
    assertUdid(udid);
    try {
      const [processesJson, appsJson] = await Promise.all([
        runDevicectlJson(this.run, ["device", "info", "processes", "--device", udid], this.execTimeoutMs),
        // --include-all-apps: the default view lists developer apps only, which
        // misses every App Store process in the join (observed live).
        runDevicectlJson(this.run, ["device", "info", "apps", "--include-all-apps", "--device", udid], this.execTimeoutMs),
      ]);
      const byUuid = new Map<string, string>();
      const apps = (appsJson as DevicectlAppsJson)?.result?.apps;
      if (Array.isArray(apps)) {
        for (const app of apps) {
          const bundleId = str(app.bundleIdentifier);
          const url = str(app.url);
          if (!bundleId || !url) continue;
          const uuid = containerUuid(url);
          if (uuid) byUuid.set(uuid, bundleId);
        }
      }
      const running = new Set<string>();
      const processes = (processesJson as DevicectlProcessesJson)?.result?.runningProcesses;
      if (Array.isArray(processes)) {
        for (const proc of processes) {
          const executable = str(proc.executable);
          if (!executable) continue;
          const uuid = containerUuid(executable);
          const bundleId = uuid ? byUuid.get(uuid) : undefined;
          if (bundleId) running.add(bundleId);
        }
      }
      return running;
    } catch {
      return new Set();
    }
  }

  private async ios(args: string[], verb: string, udid: string): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.run(this.iosBin, args, { timeoutMs: this.execTimeoutMs });
    } catch (err) {
      throw iosError(this.iosBin, verb, udid, err);
    }
  }
}

/** Missing-binary errors get an install hint; failures name the go-ios/devicectl seam. */
function iosError(iosBin: string, verb: string, udid: string, err: unknown): Error {
  const msg = (err as Error).message;
  if (err instanceof ExecError && err.code === "ENOENT") {
    return new Error(
      `${msg}. go-ios (\`ios\`) is not installed; install with: ${GO_IOS_INSTALL_HINT} (or set IOS_BIN). ` +
        `For iOS 17+ devices also run: sudo ios tunnel start`,
    );
  }
  // Fallback for non-ExecError spawn failures: match ONLY launcher-level
  // signals. Never `.*not found`: device errors like `process not found`
  // (kill of a non-running app, measured live) must keep their own text.
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
