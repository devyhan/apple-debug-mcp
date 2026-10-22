import type { CacheClearOptions, CacheClearResult } from "./appcache.js";

export interface LaunchResult {
  /** PID printed by `simctl launch` ("<bundle>: <pid>"). -1 when unparseable. */
  pid: number;
  /** Raw stdout of `simctl launch`. */
  output: string;
}

/**
 * App-lifecycle driver seam: the full `SimApps` public surface,
 * method-for-method. `SimApps implements AppOps` (simctl); P1 adds the
 * real-device `RealDeviceApps` implementer (go-ios + devicectl join).
 */
export interface AppOps {
  openUrl(udid: string, url: string): Promise<void>;
  install(udid: string, appPath: string): Promise<void>;
  uninstall(udid: string, bundleId: string): Promise<void>;
  launch(udid: string, bundleId: string, argv?: string[]): Promise<LaunchResult>;
  terminate(udid: string, bundleId: string): Promise<void>;
  clearCache(udid: string, bundleId: string, opts?: CacheClearOptions): Promise<CacheClearResult>;
  listRunning(udid: string): Promise<Set<string>>;
}
