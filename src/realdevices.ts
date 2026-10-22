import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CacheClearOptions, CacheClearResult } from "./appcache.js";
import type { AppOps, LaunchResult } from "./appops.js";
import type { DeviceTransport } from "./devicekind.js";
import { ExecError, Runner, defaultRunner } from "./exec.js";

/** Install command for go-ios, confirmed from the go-ios README (npm distribution). */
export const GO_IOS_INSTALL_HINT = "npm install -g go-ios";

/** Error detail for the two app verbs with no real-device CLI transport (P2). */
export const APP_REAL_NO_TRANSPORT_DETAIL =
  "no CLI transport exists for open-url/cache-clear (neither devicectl nor go-ios provides one)";

function assertUdid(udid: string): void {
  if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
}

function assertBundleId(bundleId: string): void {
  if (bundleId.trim().length === 0) throw new Error("Invalid bundle_id (expected a non-empty string)");
}

function assertAppPath(appPath: string): void {
  if (appPath.trim().length === 0) throw new Error("Invalid app_path (expected a non-empty string)");
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

/**
 * App lifecycle on a real device: go-ios (`ios`) backend for
 * install/uninstall/launch/terminate, devicectl join for listRunning.
 * Argv confirmed against go-ios main-branch source (`ios install
 * --path=<p>`, `ios uninstall <bundleID>`, `ios launch <bundleID>
 * [--arg=<a>]…`, `ios kill <bundleID>…`, global `--udid=<udid>`).
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

  async openUrl(_udid: string, _url: string): Promise<void> {
    throw new Error(`app_open_url does not support real-device leases yet: real-device support lands in P2 (${APP_REAL_NO_TRANSPORT_DETAIL}).`);
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

  async clearCache(_udid: string, _bundleId: string, _opts: CacheClearOptions = {}): Promise<CacheClearResult> {
    throw new Error(`app_cache_clear does not support real-device leases yet: real-device support lands in P2 (${APP_REAL_NO_TRANSPORT_DETAIL}).`);
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
