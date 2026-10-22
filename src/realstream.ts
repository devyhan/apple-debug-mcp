import { spawn as nodeSpawn } from "node:child_process";
import http from "node:http";
import { isPortFree } from "./servesim.js";
import type { StreamInfo, StreamOps } from "./servesim.js";

/**
 * go-ios hardcodes its MJPEG bind (measured 2026-10-22, go-ios 1.3.2:
 * `--port=18923` is silently ignored, the server always listens on :3333).
 * One port ⇒ one stream per host: this backend is single-flight by design.
 */
export const REAL_STREAM_PORT = 3333;
export const REAL_STREAM_URL = `http://127.0.0.1:${REAL_STREAM_PORT}/`;

/** Minimal child surface RealStreamer needs (node's ChildProcess satisfies it via defaultSpawn). */
export interface StreamChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  /** Set (and exitCode left null) when the child dies from a signal — the normal SIGTERM case. */
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  readonly stderr?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
}

export interface RealStreamerOpts {
  iosBin?: string;
  spawn?: (bin: string, args: string[]) => StreamChild;
  isPortFree?: (port: number) => Promise<boolean>;
  httpStatus?: (url: string, timeoutMs: number) => Promise<number>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  killGraceMs?: number;
  /** Post-SIGKILL wait before declaring the child unstoppable. Default 1_000. */
  killForceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * StreamOps over `ios screenshot --stream` (supervised child, not detached).
 *
 * Single-flight: at most one real-device stream per host. A second udid gets
 * a precise busy error naming the holder; a foreign :3333 occupant gets a
 * precise error with an lsof hint instead of a cryptic bind failure. Reuse
 * revalidates HTTP liveness so a half-dead server is respawned, and every
 * failed start clears state so the next call retries instead of reporting
 * busy. stopStream/stopAll are idempotent; stopAll never throws (shutdown).
 */
export class RealStreamer implements StreamOps {
  private readonly iosBin: string;
  private readonly spawnFn: (bin: string, args: string[]) => StreamChild;
  private readonly isPortFreeFn: (port: number) => Promise<boolean>;
  private readonly httpStatusFn: (url: string, timeoutMs: number) => Promise<number>;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly killGraceMs: number;
  private readonly killForceMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private child?: StreamChild;
  private ownedUdid?: string;

  constructor(opts: RealStreamerOpts = {}) {
    this.iosBin = opts.iosBin ?? "ios";
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.isPortFreeFn = opts.isPortFree ?? isPortFree;
    this.httpStatusFn = opts.httpStatus ?? defaultHttpStatus;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.readyPollMs = opts.readyPollMs ?? 250;
    this.killGraceMs = opts.killGraceMs ?? 2_000;
    this.killForceMs = opts.killForceMs ?? 1_000;
    this.sleepFn = opts.sleep ?? defaultSleep;
  }

  async startStream(udid: string, opts: { portBase?: number } = {}): Promise<StreamInfo> {
    // portBase is meaningless here (hardcoded :3333); accepted for StreamOps conformance.
    void opts;
    if (this.child && this.ownedUdid === udid && !isDead(this.child)) {
      if (await this.isServing()) return { url: REAL_STREAM_URL, port: REAL_STREAM_PORT };
      this.clearTracked(); // Half-dead server: fall through to a fresh spawn.
    }
    if (this.child && !isDead(this.child) && this.ownedUdid !== undefined && this.ownedUdid !== udid) {
      throw new Error(
        `Real-device screen streaming is single-flight (go-ios binds hardcoded :${REAL_STREAM_PORT}): ` +
        `already streaming ${this.ownedUdid}; stop that lease's stream first.`,
      );
    }
    this.clearTracked(); // Reap dead state: a stale record never blocks a fresh start.
    if (!(await this.isPortFreeFn(REAL_STREAM_PORT))) {
      throw new Error(
        `Real-device screen streaming needs :${REAL_STREAM_PORT} but the port is already in use ` +
        `by another process (not owned by this daemon); free it first ` +
        `(identify with: lsof -i :${REAL_STREAM_PORT}).`,
      );
    }
    const child = this.spawnFn(this.iosBin, ["screenshot", "--stream", `--udid=${udid}`]);
    let tail = "";
    const stderr = child.stderr;
    if (stderr) {
      stderr.on("data", (chunk) => {
        tail = `${tail}${String(chunk)}`.slice(-400);
      });
    }
    try {
      await this.waitReady(child, udid, () => tail.trim());
    } catch (err) {
      this.clearTracked();
      throw err;
    }
    this.child = child;
    this.ownedUdid = udid;
    return { url: REAL_STREAM_URL, port: REAL_STREAM_PORT };
  }

  async stopStream(udid: string): Promise<void> {
    const child = this.child;
    if (!child || this.ownedUdid !== udid) return;
    try {
      await this.terminate(child, udid);
    } finally {
      this.clearTracked();
    }
  }

  /** Kill the tracked helper if any. Never throws (daemon shutdown path). */
  async stopAll(): Promise<void> {
    try {
      if (this.child && this.ownedUdid) await this.terminate(this.child, this.ownedUdid);
    } catch {
      // Shutdown must not fail: the port hint on next start covers a survivor.
    } finally {
      this.clearTracked();
    }
  }

  private clearTracked(): void {
    this.child = undefined;
    this.ownedUdid = undefined;
  }

  private async isServing(): Promise<boolean> {
    try {
      const code = await this.httpStatusFn(REAL_STREAM_URL, 2_000);
      return code >= 200 && code < 300;
    } catch {
      return false;
    }
  }

  /** Poll for HTTP 200; fail fast with the helper's stderr when it exits. */
  private async waitReady(child: StreamChild, udid: string, stderrTail: () => string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      if (isDead(child)) {
        const tail = stderrTail();
        const reason = child.exitCode !== null
          ? `helper exited with code ${child.exitCode}`
          : `helper died on ${child.signalCode}`;
        throw new Error(`Real-device stream failed to start for ${udid}: ${tail || reason}`);
      }
      try {
        const code = await this.httpStatusFn(REAL_STREAM_URL, 2_000);
        if (code >= 200 && code < 300) return;
      } catch {
        // Not ready yet; the exit check above turns a dead helper into a fast error.
      }
      if (Date.now() >= deadline) break;
      await this.sleepFn(this.readyPollMs);
    }
    try {
      await this.terminate(child, udid);
    } catch {
      // Fall through to the timeout error: it already says the helper was stopped.
    }
    throw new Error(
      `Real-device stream for ${udid} did not answer on :${REAL_STREAM_PORT} ` +
      `within ${this.readyTimeoutMs}ms; the helper was stopped.`,
    );
  }

  /** SIGTERM with a grace window, then SIGKILL. Throws when the child survives both. */
  private async terminate(child: StreamChild, udid: string): Promise<void> {
    if (isDead(child)) return;
    const attempt = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // Died mid-kill; the liveness re-check below decides.
      }
    };
    attempt("SIGTERM");
    const termDeadline = Date.now() + this.killGraceMs;
    while (!isDead(child) && Date.now() < termDeadline) await this.sleepFn(50);
    if (isDead(child)) return;
    attempt("SIGKILL");
    const killDeadline = Date.now() + this.killForceMs;
    while (!isDead(child) && Date.now() < killDeadline) await this.sleepFn(50);
    if (!isDead(child)) {
      throw new Error(
        `Real-device stream for ${udid} did not stop (helper ignored SIGKILL); ` +
        `port :${REAL_STREAM_PORT} may still be held.`,
      );
    }
  }
}

/**
 * A node child killed by a signal reports exitCode null + signalCode set
 * (measured: SIGTERM ⇒ EXIT event null/SIGTERM, exitCode stays null) — so
 * liveness must consult BOTH fields. Checking exitCode alone spins through
 * the grace windows and falsely reports "ignored SIGKILL".
 */
function isDead(child: StreamChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function defaultSpawn(bin: string, args: string[]): StreamChild {
  const child = nodeSpawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  return {
    pid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => child.kill(signal),
    stderr: child.stderr,
  };
}

/** GET the URL and resolve with the status once headers arrive (body destroyed: MJPEG never ends). */
function defaultHttpStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const code = res.statusCode ?? 0;
      res.destroy();
      resolve(code);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GET ${url} timed out after ${timeoutMs}ms`));
    });
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
