import { Runner, defaultRunner } from "./exec.js";

export interface LaunchResult {
  /** PID printed by `simctl launch` ("<bundle>: <pid>"). -1 when unparseable. */
  pid: number;
  /** Raw stdout of `simctl launch`. */
  output: string;
}

function assertUdid(udid: string): void {
  if (udid.trim().length === 0) throw new Error("Invalid udid (expected a non-empty string)");
}

function assertBundleId(bundleId: string): void {
  if (bundleId.trim().length === 0) throw new Error("Invalid bundle_id (expected a non-empty string)");
}

function assertUrl(url: string): void {
  if (url.trim().length === 0) throw new Error("Invalid url (expected a non-empty string)");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url.trim())) {
    throw new Error(`Invalid url ${JSON.stringify(url)} (expected a scheme, e.g. "https://…")`);
  }
}

function assertAppPath(appPath: string): void {
  if (appPath.trim().length === 0) throw new Error("Invalid app_path (expected a non-empty string)");
}

/**
 * App lifecycle on a simulator via `xcrun simctl` (openurl, install,
 * uninstall, launch, terminate). System-tool only: no new npm dependency.
 */
export class SimApps {
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { runner?: Runner; execTimeoutMs?: number } = {}) {
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  /** Open a URL on the simulator (stock handler, e.g. Safari for https:). */
  async openUrl(udid: string, url: string): Promise<void> {
    assertUdid(udid);
    assertUrl(url);
    await this.run("xcrun", ["simctl", "openurl", udid, url], { timeoutMs: this.execTimeoutMs });
  }

  /** Install an .app bundle at appPath onto the simulator. */
  async install(udid: string, appPath: string): Promise<void> {
    assertUdid(udid);
    assertAppPath(appPath);
    await this.run("xcrun", ["simctl", "install", udid, appPath], { timeoutMs: this.execTimeoutMs });
  }

  /** Remove the app with bundleId from the simulator. */
  async uninstall(udid: string, bundleId: string): Promise<void> {
    assertUdid(udid);
    assertBundleId(bundleId);
    await this.run("xcrun", ["simctl", "uninstall", udid, bundleId], { timeoutMs: this.execTimeoutMs });
  }

  /**
   * Launch bundleId, passing argv through. Resolves with the pid simctl
   * prints ("<bundle>: <pid>"); pid is -1 when the output is unparseable.
   */
  async launch(udid: string, bundleId: string, argv: string[] = []): Promise<LaunchResult> {
    assertUdid(udid);
    assertBundleId(bundleId);
    const { stdout } = await this.run("xcrun", ["simctl", "launch", udid, bundleId, ...argv], {
      timeoutMs: this.execTimeoutMs,
    });
    const output = stdout.trim();
    const match = /:\s*(\d+)\s*$/.exec(output);
    return { pid: match ? Number(match[1]) : -1, output };
  }

  /** Terminate bundleId on the simulator. */
  async terminate(udid: string, bundleId: string): Promise<void> {
    assertUdid(udid);
    assertBundleId(bundleId);
    await this.run("xcrun", ["simctl", "terminate", udid, bundleId], { timeoutMs: this.execTimeoutMs });
  }

  /**
   * Bundle ids of apps currently running on the simulator, via
   * `simctl spawn <udid> launchctl list` (UIKitApplication:<bundle> labels).
   * Garbage lines are ignored; empty output yields an empty set.
   */
  async listRunning(udid: string): Promise<Set<string>> {
    assertUdid(udid);
    const { stdout } = await this.run("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
      timeoutMs: this.execTimeoutMs,
    });
    const running = new Set<string>();
    for (const line of stdout.split("\n")) {
      const match = /UIKitApplication:([A-Za-z0-9._-]+)/.exec(line);
      if (match?.[1]) running.add(match[1]);
    }
    return running;
  }
}
