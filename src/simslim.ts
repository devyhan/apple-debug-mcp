import { ExecError, Runner, defaultRunner, parseJson } from "./exec.js";

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  platform?: string;
  osVersion?: string;
  set?: string;
  managedTotal?: number;
  [key: string]: unknown;
}

/** View of `simslim status --json`: {managedDisabled, managedTotal, booted, persistent}. */
export interface SlimStatus {
  /** True when every managed daemon is disabled. Partial (--except) profiles report counts instead. */
  slim: boolean;
  managedDisabled: number;
  managedTotal: number;
  persistent: boolean | null;
  raw: unknown;
}

export interface TopEntry {
  udid?: string;
  name?: string;
  bytes?: number;
  [key: string]: unknown;
}

export interface TopSnapshot {
  sims: TopEntry[] | null;
  totalBytes: number;
  raw: unknown;
}

export interface SlimOptions {
  except?: string;
  keep?: string;
  profile?: string;
  noReboot?: boolean;
  preserveBootState?: boolean;
  timeoutMs?: number;
}

/** Minimal fleet surface the orchestrator needs (implemented by Simslim, faked in tests). */
export interface FleetOps {
  list(): Promise<SimDevice[]>;
  boot(udid: string): Promise<void>;
  slimStatus(udid: string): Promise<SlimStatus | null>;
  slimNoReboot(udid: string, opts?: SlimOptions): Promise<void>;
}

function isBooted(d: SimDevice): boolean {
  return d.state.toLowerCase() === "booted";
}

export class Simslim implements FleetOps {
  private readonly bin: string;
  private readonly run: Runner;
  private readonly execTimeoutMs: number;
  private readonly bootTimeoutMs: number;

  constructor(opts: { bin?: string; runner?: Runner; execTimeoutMs?: number; bootTimeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "simslim";
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 10 * 60_000;
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.bin, ["version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async list(): Promise<SimDevice[]> {
    const { stdout } = await this.run(this.bin, ["list", "--json"], {
      timeoutMs: this.execTimeoutMs,
    });
    return parseJson<SimDevice[]>(stdout, "simslim list");
  }

  async listBooted(): Promise<SimDevice[]> {
    return (await this.list()).filter(isBooted);
  }

  async boot(udid: string): Promise<void> {
    await this.run(this.bin, ["boot", udid, "--json"], { timeoutMs: this.bootTimeoutMs });
  }

  async shutdown(udid: string): Promise<void> {
    await this.run(this.bin, ["shutdown", udid, "--json"], { timeoutMs: this.execTimeoutMs });
  }

  async slimOn(udid: string, opts: SlimOptions = {}): Promise<void> {
    const args = ["on", udid];
    if (opts.profile) args.push("--profile", opts.profile);
    if (opts.except) args.push("--except", opts.except);
    if (opts.keep) args.push("--keep", opts.keep);
    if (opts.noReboot) args.push("--no-reboot");
    if (opts.preserveBootState) args.push("--preserve-boot-state");
    await this.run(this.bin, args, { timeoutMs: opts.timeoutMs ?? this.bootTimeoutMs });
  }

  async slimOff(udid: string, preserveBootState = false): Promise<void> {
    const args = ["off", udid];
    if (preserveBootState) args.push("--preserve-boot-state");
    await this.run(this.bin, args, { timeoutMs: this.bootTimeoutMs });
  }

  /** null when the simulator is not booted (status requires a booted sim). */
  async slimStatus(udid: string): Promise<SlimStatus | null> {
    try {
      const { stdout } = await this.run(this.bin, ["status", udid, "--json"], {
        timeoutMs: this.execTimeoutMs,
      });
      const raw = parseJson<Record<string, unknown>>(stdout, "simslim status");
      const disabled = typeof raw["managedDisabled"] === "number" ? raw["managedDisabled"] : 0;
      const total = typeof raw["managedTotal"] === "number" ? raw["managedTotal"] : 0;
      return {
        slim: total > 0 && disabled >= total,
        managedDisabled: disabled,
        managedTotal: total,
        persistent: typeof raw["persistent"] === "boolean" ? (raw["persistent"] as boolean) : null,
        raw,
      };
    } catch (err) {
      if (err instanceof ExecError && /must be booted/i.test(err.stderr + err.stdout)) return null;
      throw err;
    }
  }

  async slimNoReboot(udid: string, opts: SlimOptions = {}): Promise<void> {
    await this.slimOn(udid, { ...opts, noReboot: true });
  }

  async top(): Promise<TopSnapshot> {
    const { stdout } = await this.run(this.bin, ["top", "--json"], {
      timeoutMs: this.execTimeoutMs,
    });
    const raw = parseJson<{ sims?: TopEntry[] | null; totalBytes?: number }>(stdout, "simslim top");
    return { sims: raw.sims ?? null, totalBytes: raw.totalBytes ?? 0, raw };
  }

  async measure(udid: string): Promise<string> {
    const { stdout } = await this.run(this.bin, ["measure", udid], {
      timeoutMs: this.execTimeoutMs,
    });
    return stdout.trim();
  }
}
