import { Runner, defaultRunner } from "./exec.js";

export interface TapTarget {
  x?: number;
  y?: number;
  id?: string;
  label?: string;
  value?: string;
  elementType?: string;
  preDelay?: number;
  postDelay?: number;
  waitTimeout?: number;
  pollInterval?: number;
}

export interface SwipeOptions {
  duration?: number;
  delta?: number;
  preDelay?: number;
  postDelay?: number;
}

export interface GestureOptions {
  screenWidth?: number;
  screenHeight?: number;
  duration?: number;
  delta?: number;
}

export interface BatchOptions {
  continueOnError?: boolean;
  waitTimeout?: number;
  pollInterval?: number;
  verbose?: boolean;
}

const STEP_COMMANDS = new Set([
  "tap",
  "swipe",
  "gesture",
  "touch",
  "type",
  "button",
  "key",
  "key-sequence",
  "key-combo",
  "sleep",
]);

export class Axe {
  private readonly bin: string;
  private readonly run: Runner;
  private readonly execTimeoutMs: number;

  constructor(opts: { bin?: string; runner?: Runner; execTimeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "axe";
    this.run = opts.runner ?? defaultRunner;
    this.execTimeoutMs = opts.execTimeoutMs ?? 60_000;
  }

  async checkAvailable(): Promise<string> {
    const { stdout } = await this.run(this.bin, ["--version"], { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async describeUi(udid: string, point?: { x: number; y: number }): Promise<string> {
    const args = ["describe-ui", "--udid", udid];
    if (point) args.push("--point", `${point.x},${point.y}`);
    const { stdout } = await this.run(this.bin, args, {
      timeoutMs: this.execTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }

  async tap(udid: string, target: TapTarget): Promise<string> {
    const args = ["tap", "--udid", udid];
    if (target.x !== undefined && target.y !== undefined) {
      args.push("-x", String(target.x), "-y", String(target.y));
    } else {
      if (target.id !== undefined) args.push("--id", target.id);
      if (target.label !== undefined) args.push("--label", target.label);
      if (target.value !== undefined) args.push("--value", target.value);
    }
    if (target.elementType !== undefined) args.push("--element-type", target.elementType);
    if (target.preDelay !== undefined) args.push("--pre-delay", String(target.preDelay));
    if (target.postDelay !== undefined) args.push("--post-delay", String(target.postDelay));
    if (target.waitTimeout !== undefined) args.push("--wait-timeout", String(target.waitTimeout));
    if (target.pollInterval !== undefined) args.push("--poll-interval", String(target.pollInterval));
    const { stdout } = await this.run(this.bin, args, {
      timeoutMs: this.execTimeoutMs + (target.waitTimeout ?? 0) * 1000,
    });
    return stdout.trim();
  }

  /** Typed via stdin to avoid shell-quoting issues entirely (execFile has no shell anyway). */
  async typeText(udid: string, text: string): Promise<string> {
    const { stdout } = await this.run(this.bin, ["type", "--stdin", "--udid", udid], {
      timeoutMs: this.execTimeoutMs,
      stdin: text,
    });
    return stdout.trim();
  }

  async swipe(
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts: SwipeOptions = {},
  ): Promise<string> {
    const args = [
      "swipe",
      "--udid",
      udid,
      "--start-x",
      String(from.x),
      "--start-y",
      String(from.y),
      "--end-x",
      String(to.x),
      "--end-y",
      String(to.y),
    ];
    if (opts.duration !== undefined) args.push("--duration", String(opts.duration));
    if (opts.delta !== undefined) args.push("--delta", String(opts.delta));
    if (opts.preDelay !== undefined) args.push("--pre-delay", String(opts.preDelay));
    if (opts.postDelay !== undefined) args.push("--post-delay", String(opts.postDelay));
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async gesture(udid: string, preset: string, opts: GestureOptions = {}): Promise<string> {
    const args = ["gesture", preset, "--udid", udid];
    if (opts.screenWidth !== undefined) args.push("--screen-width", String(opts.screenWidth));
    if (opts.screenHeight !== undefined) args.push("--screen-height", String(opts.screenHeight));
    if (opts.duration !== undefined) args.push("--duration", String(opts.duration));
    if (opts.delta !== undefined) args.push("--delta", String(opts.delta));
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async button(udid: string, button: string, duration?: number): Promise<string> {
    const args = ["button", button, "--udid", udid];
    if (duration !== undefined) args.push("--duration", String(duration));
    const { stdout } = await this.run(this.bin, args, { timeoutMs: this.execTimeoutMs });
    return stdout.trim();
  }

  async screenshot(udid: string, output: string): Promise<string> {
    await this.run(this.bin, ["screenshot", "--udid", udid, "--output", output], {
      timeoutMs: this.execTimeoutMs,
    });
    return output;
  }

  async batch(udid: string, steps: string[], opts: BatchOptions = {}): Promise<string> {
    if (steps.length === 0) throw new Error("batch requires at least one step");
    for (const step of steps) {
      const head = step.trim().split(/\s+/)[0] ?? "";
      if (!STEP_COMMANDS.has(head)) {
        throw new Error(`Unsupported batch step: ${JSON.stringify(step)} (must start with ${[...STEP_COMMANDS].join(", ")})`);
      }
    }
    const args = ["batch", "--udid", udid];
    for (const step of steps) args.push("--step", step);
    if (opts.continueOnError) args.push("--continue-on-error");
    if (opts.waitTimeout !== undefined) args.push("--wait-timeout", String(opts.waitTimeout));
    if (opts.pollInterval !== undefined) args.push("--poll-interval", String(opts.pollInterval));
    if (opts.verbose) args.push("--verbose");
    const { stdout } = await this.run(this.bin, args, {
      timeoutMs: this.execTimeoutMs + (opts.waitTimeout ?? 0) * 1000 * steps.length,
    });
    return stdout.trim();
  }
}
