import { execFile, spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  stdin?: string;
  maxBuffer?: number;
}

export class ExecError extends Error {
  readonly code?: number | string;
  readonly stdout: string;
  readonly stderr: string;

  constructor(bin: string, args: string[], code: unknown, stdout: string, stderr: string) {
    super(`${bin} ${args.join(" ")} failed (code ${String(code)}): ${stderr.trim() || stdout.trim()}`);
    this.name = "ExecError";
    this.code = typeof code === "number" || typeof code === "string" ? code : undefined;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Injectable process runner so unit tests can stub the CLIs. */
export type Runner = (bin: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const defaultRunner: Runner = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts?.timeoutMs ?? 60_000,
        maxBuffer: opts?.maxBuffer ?? 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          reject(new ExecError(bin, args, code, String(stdout ?? ""), String(stderr ?? "")));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (opts?.stdin !== undefined && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });

export interface BoundedResult {
  /** Captured stdout, cut at maxChars with a marker when truncated. */
  stdout: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Which end of stdout to keep when output exceeds maxChars. */
export type TruncationKeep = "head" | "tail";

export interface BoundedOptions {
  timeoutMs: number;
  maxChars?: number;
  /** Truncation direction. Defaults to "tail" (newest log output survives). */
  keep?: TruncationKeep;
}

export const DEFAULT_BOUND_MAX_CHARS = 20_000;
export const TRUNCATION_MARKER = "\n…[truncated]";

/** Prefix marker for tail truncation; names how many head chars were dropped. */
export function tailTruncationMarker(droppedChars: number): string {
  return `…[truncated ${droppedChars} chars]\n`;
}

/**
 * Run a command with a hard wall-clock bound, collecting stdout only (stderr
 * is discarded: `log stream` writes noise there). Resolves on natural exit AND
 * on timeout (after SIGKILL) — never rejects for a timeout. Rejects only when
 * the process cannot be spawned. Keeps running until exit/timeout even after
 * maxChars is reached, so `timedOut` stays meaningful for streams.
 *
 * Truncation keeps the tail (last maxChars, prefixed with a marker naming the
 * dropped head chars) by default; pass keep:"head" for the legacy first-maxChars
 * behavior with a suffix marker.
 */
export function runBounded(bin: string, args: string[], opts: BoundedOptions): Promise<BoundedResult> {
  const maxChars = opts.maxChars ?? DEFAULT_BOUND_MAX_CHARS;
  const keep = opts.keep ?? "tail";
  return new Promise((resolve, reject) => {
    let out = "";
    let totalChars = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // A killed child can orphan grandchildren that keep the pipe open (e.g.
      // `sh -c 'echo hi; sleep 30'`); drop our read end so `close` still fires.
      child.stdout?.destroy();
    }, Math.max(0, opts.timeoutMs));
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (keep === "head") {
        if (out.length >= maxChars) {
          truncated = true;
          return;
        }
        out += text;
        if (out.length > maxChars) {
          out = out.slice(0, maxChars);
          truncated = true;
        }
        return;
      }
      // Tail: keep the buffer bounded at maxChars; totalChars feeds the marker.
      totalChars += text.length;
      out += text;
      if (out.length > maxChars) out = out.slice(out.length - maxChars);
      truncated = totalChars > maxChars;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!truncated) {
        resolve({ stdout: out, truncated, timedOut });
      } else if (keep === "head") {
        resolve({ stdout: out + TRUNCATION_MARKER, truncated, timedOut });
      } else {
        resolve({ stdout: tailTruncationMarker(totalChars - out.length) + out, truncated, timedOut });
      }
    });
  });
}

export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`Failed to parse ${what} as JSON: ${(cause as Error).message}\n${text.slice(0, 500)}`);
  }
}
