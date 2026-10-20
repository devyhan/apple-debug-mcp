import fs from "node:fs";
import path from "node:path";
import { Runner, defaultRunner } from "./exec.js";

export const DEFAULT_ATOS_BIN = "atos";
export const DEFAULT_LIPO_BIN = "lipo";
export const MAX_SYMBOLICATE_PCS = 100;

/** Loose hex address shape (atos accepts `0x…` or a bare hex offset). */
const PC_RE = /^(0x)?[0-9a-fA-F]+$/;

const LIPO_FAT_RE = /architectures in the fat file:.*:\s*(.+)$/i;
const IMAGES_LINE_RE = /^\s*(0x[0-9a-fA-F]+)\s*-\s*0x[0-9a-fA-F]+\s*(.*)$/;

export interface SymbolicateOptions {
  /** Mach-O binary (or dSYM) the addresses belong to. Required: atos needs `-o` (live-pid mode is not exposed). */
  binary?: string;
  /** Slice for universal binaries, e.g. "arm64". Omit to auto-detect via `lipo -info`. */
  arch?: string;
  /** Image load address for ASLR'd addresses, e.g. "0x100000000". Omit with `images` to auto-derive it. */
  loadAddr?: string;
  /** Crash-log "Binary Images" text: auto-derive loadAddr when loadAddr is omitted. */
  images?: string;
  /** Explicit dSYM bundle (or DWARF file); overrides sibling auto-find. */
  dsym?: string;
}

export interface SymbolicateResult {
  /** Effective atos -o target (the binary, or its dSYM's DWARF file). */
  binary: string;
  addresses: string[];
  /** One symbolicated line per address, in input order. */
  symbols: string[];
  raw: string;
  /** dSYM bundle path when a dSYM supplied the atos -o target. */
  dsym?: string;
  /** Effective -arch passed to atos (explicit or auto-detected). */
  arch?: string;
  /** Effective -l passed to atos (explicit or auto-detected). */
  loadAddr?: string;
}

/** Auto-found dSYM: the bundle plus the DWARF object file inside (the atos -o target). */
export interface FoundDsym {
  dsym: string;
  dwarf: string;
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
 * Parse `lipo -info` stdout into arch names; null for thin binaries
 * ("Non-fat file ... is architecture: X") or unparseable output.
 */
export function parseLipoArchs(stdout: string): string[] | null {
  const m = LIPO_FAT_RE.exec(stdout.trim());
  if (!m?.[1]) return null;
  const archs = m[1].split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return archs.length > 0 ? archs : null;
}

/** Preferred atos -arch for a fat binary: the host family first, else the first listed. */
export function pickPreferredArch(archs: string[]): string | null {
  if (archs.length === 0) return null;
  const wants = process.arch === "arm64" ? ["arm64", "arm64e"] : ["x86_64", "x86-64", "i386"];
  for (const want of wants) {
    const hit = archs.find((a) => a.toLowerCase() === want);
    if (hit) return hit;
  }
  return archs[0] ?? null;
}

/**
 * Resolve a dSYM bundle (or DWARF file, or directory) to its DWARF object
 * file; null when none exists. Never throws.
 */
export function resolveDwarfFile(candidate: string): string | null {
  try {
    const st = fs.statSync(candidate);
    if (st.isFile()) return candidate;
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(candidate, "Contents", "Resources", "DWARF"));
  } catch {
    return null;
  }
  for (const entry of entries.filter((e) => e !== ".DS_Store").sort()) {
    const full = path.join(candidate, "Contents", "Resources", "DWARF", entry);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // Skip unreadable entries.
    }
  }
  return null;
}

/**
 * Auto-find a sibling dSYM for a binary: `<binary>.dSYM`, then `<app>.dSYM`
 * when the binary lives inside Foo.app (standard Xcode layout). Returns the
 * bundle plus its DWARF file, or null. Never throws.
 */
export function findDsymDwarf(binary: string): FoundDsym | null {
  const candidates = [`${binary}.dSYM`];
  const appIdx = binary.indexOf(".app/");
  if (appIdx !== -1) candidates.push(`${binary.slice(0, appIdx + 4)}.dSYM`);
  for (const dsym of candidates) {
    const dwarf = resolveDwarfFile(dsym);
    if (dwarf) return { dsym, dwarf };
  }
  return null;
}

/**
 * Auto-detect the image load address from crash-log "Binary Images" text:
 * the base of the first `0xBASE - 0xEND ...` line, preferring a line that
 * mentions nameHint (usually the binary basename). With a hint, only a
 * hint-matching line counts; without one, the first line wins. Null when
 * nothing parses.
 */
export function parseLoadAddr(imagesText: string, nameHint?: string): string | null {
  let first: string | null = null;
  const hint = nameHint?.trim().toLowerCase();
  for (const line of imagesText.split("\n")) {
    const m = IMAGES_LINE_RE.exec(line);
    if (!m?.[1]) continue;
    if (first === null) first = m[1];
    if (hint && (m[2] ?? "").toLowerCase().includes(hint)) return m[1];
  }
  return hint ? null : first;
}

/**
 * Thin wrapper over `atos(1)` for crash/log symbolication.
 *
 * Host-local and read-only: it shells out to atos against a binary path and
 * touches no simulator, so callers gate it on an optional lease (for action
 * logging) rather than a udid+force pair. Argv shape follows `atos -h`:
 * `atos -o <binary> [-arch <arch>] [-l <loadAddr>] <pc...>`.
 *
 * Auto-detection (all best-effort, explicit options always win): -arch via
 * `lipo -info` for fat binaries, the atos target via sibling-dSYM auto-find,
 * and -l from crash-log Binary Images text passed as `images`.
 */
export class Symbolicator {
  private readonly bin: string;
  private readonly lipoBin: string;
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { bin?: string; lipoBin?: string; runner?: Runner; execTimeoutMs?: number } = {}) {
    this.bin = opts.bin ?? DEFAULT_ATOS_BIN;
    this.lipoBin = opts.lipoBin ?? DEFAULT_LIPO_BIN;
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  async checkAvailable(): Promise<string> {
    try {
      const { stdout } = await this.run(this.bin, ["-h"], { timeoutMs: this.execTimeoutMs });
      return stdout.split("\n")[0]?.trim() ?? "atos";
    } catch (err) {
      throw missingHint(this.bin, err);
    }
  }

  /**
   * Best-effort -arch for fat binaries via `lipo -info`; null for thin,
   * missing, or unreadable files. Never throws (and never spawns for paths
   * that are not regular files).
   */
  async detectArch(target: string): Promise<string | null> {
    try {
      if (!fs.statSync(target).isFile()) return null;
    } catch {
      return null;
    }
    try {
      const { stdout } = await this.run(this.lipoBin, ["-info", target], { timeoutMs: this.execTimeoutMs });
      return pickPreferredArch(parseLipoArchs(stdout) ?? []);
    } catch {
      return null;
    }
  }

  async symbolicate(pcs: string[], opts: SymbolicateOptions = {}): Promise<SymbolicateResult> {
    assertPcs(pcs);
    const { binary, arch, loadAddr, images, dsym } = opts;
    if (binary === undefined || binary.trim().length === 0) {
      throw new Error("Invalid binary (symbolicate needs a binary path: atos -o <binary>; live-pid mode is not exposed)");
    }
    // Validate every explicit option before spawning anything (detection never precedes a validation error).
    if (arch !== undefined && arch.trim().length === 0) {
      throw new Error("Invalid arch (expected a non-empty string, e.g. \"arm64\")");
    }
    if (loadAddr !== undefined && !PC_RE.test(loadAddr.trim())) {
      throw new Error(`Invalid load_addr ${JSON.stringify(loadAddr)} (expected a hex address like "0x100000000")`);
    }
    if (dsym !== undefined && dsym.trim().length === 0) {
      throw new Error("Invalid dsym (expected a dSYM bundle or DWARF file path)");
    }
    // Resolve the atos -o target: explicit dSYM > binary-is-dSYM > sibling auto-find > binary as-is.
    let target = binary;
    let dsymBundle: string | undefined;
    if (dsym !== undefined) {
      const dwarf = resolveDwarfFile(dsym);
      if (!dwarf) throw new Error(`Invalid dsym ${JSON.stringify(dsym)} (no DWARF object found inside)`);
      target = dwarf;
      dsymBundle = dsym;
    } else if (binary.endsWith(".dSYM")) {
      const dwarf = resolveDwarfFile(binary);
      if (dwarf) {
        target = dwarf;
        dsymBundle = binary;
      }
    } else {
      const found = findDsymDwarf(binary);
      if (found) {
        target = found.dwarf;
        dsymBundle = found.dsym;
      }
    }
    let effArch: string | undefined;
    if (arch !== undefined) {
      if (arch.trim().length === 0) throw new Error("Invalid arch (expected a non-empty string, e.g. \"arm64\")");
      effArch = arch;
    } else {
      effArch = (await this.detectArch(target)) ?? undefined;
    }
    let effLoad: string | undefined;
    if (loadAddr !== undefined) {
      if (!PC_RE.test(loadAddr.trim())) {
        throw new Error(`Invalid load_addr ${JSON.stringify(loadAddr)} (expected a hex address like "0x100000000")`);
      }
      effLoad = loadAddr;
    } else if (images !== undefined) {
      effLoad = parseLoadAddr(images, path.basename(binary)) ?? undefined;
    }
    const args = ["-o", target];
    if (effArch !== undefined) args.push("-arch", effArch);
    if (effLoad !== undefined) args.push("-l", effLoad);
    args.push(...pcs);
    let stdout: string;
    let stderr = "";
    try {
      ({ stdout, stderr } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs }));
    } catch (err) {
      if (isEnoent(err)) throw missingHint(this.bin, err);
      throw new Error(`atos failed (${pcs.length} pcs): ${execDetail(err)}`, { cause: err });
    }
    const raw = stdout.trim();
    const symbols = raw.length === 0 ? [] : raw.split("\n");
    if (symbols.length !== pcs.length)
      throw new Error(`atos lines ${symbols.length}!=${pcs.length}: ${stderr.trim() || raw || "(empty)"}`);
    return {
      binary: target,
      addresses: [...pcs],
      symbols,
      raw,
      ...(dsymBundle !== undefined ? { dsym: dsymBundle } : {}),
      ...(effArch !== undefined ? { arch: effArch } : {}),
      ...(effLoad !== undefined ? { loadAddr: effLoad } : {}),
    };
  }
}

const isEnoent = (e: unknown): boolean =>
  (e as { code?: unknown })?.code === "ENOENT" || /ENOENT/.test((e as Error)?.message ?? "");
/** ENOENT becomes an install hint; any other error passes through unchanged. */
const missingHint = (bin: string, e: unknown): unknown =>
  isEnoent(e) ? new Error(`atos not found ("${bin}"): run xcode-select --install`, { cause: e }) : e;
const execDetail = (e: unknown): string =>
  (e as { stderr?: string })?.stderr?.trim() || (e as Error)?.message?.trim() || String(e);
