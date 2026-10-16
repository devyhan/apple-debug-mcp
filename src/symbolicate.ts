import { Runner, defaultRunner } from "./exec.js";

export const DEFAULT_ATOS_BIN = "atos";
export const MAX_SYMBOLICATE_PCS = 100;

/** Loose hex address shape (atos accepts `0x…` or a bare hex offset). */
const PC_RE = /^(0x)?[0-9a-fA-F]+$/;

export interface SymbolicateOptions {
  /** Mach-O binary (or dSYM) the addresses belong to. Required: atos needs `-o` (live-pid mode is not exposed). */
  binary?: string;
  /** Slice for universal binaries, e.g. "arm64". Omit for thin binaries. */
  arch?: string;
  /** Image load address for ASLR'd addresses, e.g. "0x100000000". */
  loadAddr?: string;
}

export interface SymbolicateResult {
  binary: string;
  addresses: string[];
  /** One symbolicated line per address, in input order. */
  symbols: string[];
  raw: string;
}

function assertPcs(pcs: string[]): void {
  if (!Array.isArray(pcs) || pcs.length === 0) {
    throw new Error("Invalid pcs (expected a non-empty array of hex addresses)");
  }
  if (pcs.length > MAX_SYMBOLICATE_PCS) {
    throw new Error(`Too many pcs (${pcs.length}; max ${MAX_SYMBOLICATE_PCS})`);
  }
  for (const pc of pcs) {
    if (typeof pc !== "string" || !PC_RE.test(pc.trim())) {
      throw new Error(`Invalid pc ${JSON.stringify(pc)} (expected a hex address like "0x100234567")`);
    }
  }
}

/**
 * Thin wrapper over `atos(1)` for crash/log symbolication.
 *
 * Host-local and read-only: it shells out to atos against a binary path and
 * touches no simulator, so callers gate it on an optional lease (for action
 * logging) rather than a udid+force pair. Argv shape follows `atos -h`:
 * `atos -o <binary> [-arch <arch>] [-l <loadAddr>] <pc...>`.
 */
export class Symbolicator {
  private readonly bin: string;
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { bin?: string; runner?: Runner; execTimeoutMs?: number } = {}) {
    this.bin = opts.bin ?? DEFAULT_ATOS_BIN;
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.bin, ["-h"], { timeoutMs: this.execTimeoutMs });
    return stdout.split("\n")[0]?.trim() ?? "atos";
  }

  async symbolicate(pcs: string[], opts: SymbolicateOptions = {}): Promise<SymbolicateResult> {
    assertPcs(pcs);
    const { binary, arch, loadAddr } = opts;
    if (binary === undefined || binary.trim().length === 0) {
      throw new Error("Invalid binary (symbolicate needs a binary path: atos -o <binary>; live-pid mode is not exposed)");
    }
    const args = ["-o", binary];
    if (arch !== undefined) {
      if (arch.trim().length === 0) throw new Error("Invalid arch (expected a non-empty string, e.g. \"arm64\")");
      args.push("-arch", arch);
    }
    if (loadAddr !== undefined) {
      if (!PC_RE.test(loadAddr.trim())) {
        throw new Error(`Invalid load_addr ${JSON.stringify(loadAddr)} (expected a hex address like "0x100000000")`);
      }
      args.push("-l", loadAddr);
    }
    args.push(...pcs);
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    const raw = stdout.trim();
    return { binary, addresses: [...pcs], symbols: raw.length === 0 ? [] : raw.split("\n"), raw };
  }
}
