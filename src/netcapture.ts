import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner, defaultRunner } from "./exec.js";
import { type MitmChild, type SpawnFn } from "./netproxy.js";

/** tcpdump binary (ships with macOS; needs root to capture). */
export const DEFAULT_TCPDUMP_BIN = "tcpdump";
/** Default -s snaplen: headers + a protocol peek, small pcaps. */
export const DEFAULT_CAPTURE_SNAPLEN = 256;
export const MIN_CAPTURE_SNAPLEN = 64;
export const MAX_CAPTURE_SNAPLEN = 65535;
export const MAX_CAPTURE_FILTER_LEN = 256;
export const MAX_CAPTURE_FLOWS = 50;
/** How long to wait for tcpdump to settle (bad filters exit at once). */
const CAPTURE_READY_WAIT_MS = 1000;
/** SIGINT grace before falling back to terminate/kill. */
const CAPTURE_STOP_GRACE_MS = 3000;
/** SIGTERM grace inside forceStop before SIGKILL + grandchild pkill. */
const FORCE_STOP_GRACE_MS = 2000;

/** Escape a literal string for embedding in a pkill -f ERE pattern. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class CaptureBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureBusyError";
  }
}

export interface CaptureFlowSummary {
  proto: "tcp" | "udp";
  /** First-seen "from" endpoint, "host.port". */
  from: string;
  /** First-seen "to" endpoint, "host.port". */
  to: string;
  fromPackets: number;
  fromBytes: number;
  toPackets: number;
  toBytes: number;
}

export interface CaptureSummary {
  packets: number;
  bytes: number;
  flows: CaptureFlowSummary[];
  /** Flows beyond MAX_CAPTURE_FLOWS, still counted in the totals. */
  truncatedFlows: number;
}

export interface CaptureStatus {
  running: boolean;
  pid?: number;
  leaseId?: string;
  sessionId?: string;
  udid?: string;
  interface?: string;
  filter?: string;
  pcapPath?: string;
  startedAt?: string;
  /** Bytes written to the pcap so far (absent if unreadable). */
  bytesWritten?: number;
}

export interface NetCaptureOptions {
  bin?: string;
  runner?: Runner;
  spawnFn?: SpawnFn;
  stateDir?: string;
}

export interface CaptureStartSpec {
  sessionId?: string;
  udid?: string;
  filter?: string;
  snaplen?: number;
  /** Capture interface; default: the default-route interface. */
  interface?: string;
}

export interface CaptureStopResult {
  stopped: boolean;
  pcapPath?: string;
  summary?: CaptureSummary;
}

export interface CaptureOps {
  checkAvailable(): Promise<string>;
  startCapture(leaseId: string, spec: CaptureStartSpec): Promise<{ pid: number; pcapPath: string }>;
  stopCapture(leaseId: string, opts?: { summarize?: boolean }): Promise<CaptureStopResult>;
  captureStatus(): CaptureStatus;
  /** Unconditional best-effort stop for daemon shutdown (never throws, never rejects holders). */
  forceStop(): Promise<{ stopped: boolean }>;
}

/**
 * Validate a user-supplied BPF filter: tcpdump filters go to the child as a
 * single argv element (no shell), but the grammar is still allowlisted so a
 * typo cannot smuggle tcpdump file/flag syntax into the capture command.
 */
export function validateCaptureFilter(filter: string | undefined): string | undefined {
  if (filter === undefined) return undefined;
  const trimmed = filter.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_CAPTURE_FILTER_LEN) {
    throw new Error(`Capture filter is too long (${trimmed.length} > ${MAX_CAPTURE_FILTER_LEN} chars)`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(
      `Capture filter must not start with '-': ${JSON.stringify(trimmed.slice(0, 40))} would be parsed as tcpdump flags`,
    );
  }
  if (!/^[A-Za-z0-9_.()[\]:<>=!&|/+ -]+$/.test(trimmed)) {
    throw new Error(
      `Capture filter uses characters outside the BPF allowlist: ${JSON.stringify(trimmed.slice(0, 80))}. ` +
        "Allowed: letters, digits, spaces and _ . ( ) [ ] : < > = ! & | / + -",
    );
  }
  return trimmed;
}

export function validateCaptureInterface(iface: string | undefined): string | undefined {
  if (iface === undefined) return undefined;
  const trimmed = iface.trim();
  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    throw new Error(`Capture interface must be alphanumeric (e.g. en0), got: ${JSON.stringify(iface.slice(0, 40))}`);
  }
  return trimmed;
}

export function validateCaptureSnaplen(snaplen: number | undefined): number {
  const value = snaplen ?? DEFAULT_CAPTURE_SNAPLEN;
  if (!Number.isInteger(value) || value < MIN_CAPTURE_SNAPLEN || value > MAX_CAPTURE_SNAPLEN) {
    throw new Error(`snaplen must be an integer ${MIN_CAPTURE_SNAPLEN}..${MAX_CAPTURE_SNAPLEN}, got: ${snaplen}`);
  }
  return value;
}

/** Parse the egress interface out of `route -n get default` output. */
export function parseDefaultRouteInterface(output: string): string | undefined {
  const match = output.match(/^\s*interface:\s*([A-Za-z0-9]+)\s*$/m);
  return match?.[1];
}

/**
 * Parse `tcpdump -n -r` (full, never `-q`) output into per-flow packet/byte
 * counts. Handles TCP (`Flags [...]`, `length N`, absent = 0) and UDP
 * (`UDP, length N`) lines; ARP and anything else is skipped. The `-q` short
 * form (`tcp 25`, no Flags/length) is deliberately NOT used: it is unparsable
 * here. The first packet of a pair fixes from/to; later same-pair packets
 * attribute to the matching side, and a new pair starts a new flow.
 */
export function parseTcpdumpFlows(text: string): CaptureSummary {
  const flows = new Map<string, CaptureFlowSummary>();
  let packets = 0;
  let bytes = 0;
  for (const line of text.split("\n")) {
    const dir = line.match(/\bIP6?\s+(\S+)\s+>\s+(\S+):/);
    if (!dir) continue;
    const from = dir[1];
    const to = dir[2];
    if (from === undefined || to === undefined) continue;
    const proto: "tcp" | "udp" | undefined = /\bUDP\b/.test(line) ? "udp" : /\bFlags\b/.test(line) ? "tcp" : undefined;
    if (!proto) continue;
    const lengthMatch = line.match(/length (\d+)/);
    const length = lengthMatch ? Number(lengthMatch[1]) : 0;
    packets += 1;
    bytes += length;
    const key = `${proto}|${from}|${to}`;
    const reverse = `${proto}|${to}|${from}`;
    let flow = flows.get(key);
    if (flow) {
      flow.fromPackets += 1;
      flow.fromBytes += length;
    } else if (flows.get(reverse)) {
      const rev = flows.get(reverse)!;
      rev.toPackets += 1;
      rev.toBytes += length;
    } else {
      flow = { proto, from, to, fromPackets: 1, fromBytes: length, toPackets: 0, toBytes: 0 };
      flows.set(key, flow);
    }
  }
  const sorted = [...flows.values()].sort(
    (a, b) => b.fromBytes + b.toBytes - (a.fromBytes + a.toBytes),
  );
  return {
    packets,
    bytes,
    flows: sorted.slice(0, MAX_CAPTURE_FLOWS),
    truncatedFlows: Math.max(0, sorted.length - MAX_CAPTURE_FLOWS),
  };
}

const defaultSpawn: SpawnFn = (bin, args) => spawn(bin, args, { stdio: "ignore" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ActiveCapture {
  leaseId: string;
  sessionId?: string;
  udid?: string;
  child: MitmChild;
  pid: number;
  iface: string;
  filter?: string;
  pcapPath: string;
  startedAt: string;
}

export class NetCapture implements CaptureOps {
  private readonly bin: string;
  private readonly runner: Runner;
  private readonly spawnFn: SpawnFn;
  private readonly stateDir: string;
  private active?: ActiveCapture;

  constructor(opts: NetCaptureOptions = {}) {
    this.bin = opts.bin ?? DEFAULT_TCPDUMP_BIN;
    this.runner = opts.runner ?? defaultRunner;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.stateDir = opts.stateDir ?? path.join(os.tmpdir(), "apple-debug-mcp-netcapture");
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.runner(this.bin, ["--version"], { timeoutMs: 10_000 });
    return stdout.trim();
  }

  captureStatus(): CaptureStatus {
    if (!this.active) return { running: false };
    const { child: _child, iface, ...rest } = this.active;
    void _child;
    const status: CaptureStatus = { running: true, interface: iface, ...rest };
    try {
      status.bytesWritten = fs.statSync(this.active.pcapPath).size;
    } catch {
      // pcap not written yet (or sudo failed silently); leave absent.
    }
    return status;
  }

  private pcapPathFor(leaseId: string): string {
    const safe = leaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.stateDir, `capture-${safe}.pcap`);
  }

  private async defaultInterface(): Promise<string> {
    const { stdout } = await this.runner("route", ["-n", "get", "default"], { timeoutMs: 10_000 });
    const iface = parseDefaultRouteInterface(stdout);
    if (!iface) throw new Error("Could not determine the default-route interface (parse `route -n get default` failed); pass interface explicitly");
    return iface;
  }

  async startCapture(leaseId: string, spec: CaptureStartSpec): Promise<{ pid: number; pcapPath: string }> {
    if (this.active) {
      if (this.active.leaseId !== leaseId) {
        throw new CaptureBusyError(`Packet capture is already running for lease ${this.active.leaseId}; stop it first`);
      }
      return { pid: this.active.pid, pcapPath: this.active.pcapPath };
    }
    const filter = validateCaptureFilter(spec.filter);
    const snaplen = validateCaptureSnaplen(spec.snaplen);
    const iface = validateCaptureInterface(spec.interface) ?? (await this.defaultInterface());
    fs.mkdirSync(this.stateDir, { recursive: true });
    const pcapPath = this.pcapPathFor(leaseId);
    try {
      fs.unlinkSync(pcapPath);
    } catch {
      // No previous capture; ignore.
    }
    const args = ["-n", this.bin, "-i", iface, "-s", String(snaplen), "-w", pcapPath];
    if (filter !== undefined) args.push(filter);
    const child = this.spawnFn("sudo", args, {});
    if (child.pid === undefined) {
      child.kill("SIGKILL");
      throw new Error("Failed to spawn tcpdump (no pid)");
    }
    // Bad filters/flags make tcpdump exit at once: surface that instead of a
    // zombie "running" capture.
    await sleep(CAPTURE_READY_WAIT_MS);
    if (child.exitCode !== null) {
      const code = child.exitCode;
      this.spawnKillQuiet(child);
      throw new Error(
        `tcpdump exited immediately (code ${code}). ` +
          "Most likely sudo refused: capturing needs passwordless sudo for tcpdump; add e.g. " +
          "`%admin ALL=(ALL) NOPASSWD: /usr/sbin/tcpdump` via `sudo visudo`. " +
          (filter !== undefined ? `If sudo is already provisioned, the filter may be invalid: ${JSON.stringify(filter)}.` : ""),
      );
    }
    this.active = {
      leaseId,
      sessionId: spec.sessionId,
      udid: spec.udid,
      child,
      pid: child.pid,
      iface,
      filter,
      pcapPath,
      startedAt: new Date().toISOString(),
    };
    return { pid: child.pid, pcapPath };
  }

  async stopCapture(leaseId: string, opts?: { summarize?: boolean }): Promise<CaptureStopResult> {
    if (!this.active) return { stopped: false };
    if (this.active.leaseId !== leaseId) {
      throw new CaptureBusyError(`Packet capture is running for lease ${this.active.leaseId}, not ${leaseId}`);
    }
    const { child, pcapPath } = this.active;
    // SIGINT first so tcpdump flushes and finalizes the pcap.
    try {
      child.kill("SIGINT");
    } catch {
      // Already gone; fall through to summary.
    }
    const exited = await this.waitForExit(child, CAPTURE_STOP_GRACE_MS);
    if (!exited) this.spawnKillQuiet(child);
    // Cleared only after the child is gone (or the kill fallback is armed):
    // a concurrent start during the stop window must see "busy", not run a
    // second root tcpdump beside the dying one.
    this.active = undefined;
    if (opts?.summarize === false || !fs.existsSync(pcapPath)) {
      return { stopped: true, pcapPath };
    }
    try {
      const { stdout } = await this.runner(this.bin, ["-n", "-r", pcapPath], { timeoutMs: 30_000 });
      return { stopped: true, pcapPath, summary: parseTcpdumpFlows(stdout) };
    } catch (err) {
      // Reading back is best-effort (e.g. a root-owned pcap we cannot read):
      // the pcap stays on disk for manual read.
      console.error(`[netcapture] Failed to summarize ${pcapPath}: ${(err as Error).message}`);
      return { stopped: true, pcapPath };
    }
  }

  async forceStop(): Promise<{ stopped: boolean }> {
    const active = this.active;
    if (!active) return { stopped: false };
    this.active = undefined;
    try {
      if (active.child.exitCode === null) active.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    // Awaited (shutdown awaits forceStop), so no exit race: SIGTERM gets a
    // grace window before escalation.
    const exited = await this.waitForExit(active.child, FORCE_STOP_GRACE_MS);
    if (!exited) {
      // The child is the sudo wrapper: SIGKILL it, then best-effort pkill the
      // root tcpdump grandchild it may orphan, matched by our exact pcap path
      // (a bare pkill pattern could hit unrelated captures).
      try {
        active.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      try {
        await this.runner("sudo", ["-n", "pkill", "-f", `tcpdump.*-w ${escapeRegExp(active.pcapPath)}`], {
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort: pkill exits 1 on no match, sudo may be gone at shutdown.
      }
    }
    return { stopped: true };
  }

  private waitForExit(child: MitmChild, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);
      child.once("exit", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  private spawnKillQuiet(child: MitmChild): void {
    try {
      if (child.exitCode === null) child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 2000).unref?.();
  }
}
