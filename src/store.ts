import fs from "node:fs";
import path from "node:path";

/**
 * Tool-agnostic session identity. Any client (Orca, Claude Code, TMA, scripts)
 * passes its own `sessionId` plus a free-form `client` label; the server never
 * assumes a particular harness.
 */
export interface Requirements {
  udid?: string;
  /** Case-insensitive substring match on device name, e.g. "iPhone 17 Pro". */
  device?: string;
  /** Prefix match on OS version, e.g. "26" or "26.5". */
  osVersion?: string;
  /** Exact match on platform, e.g. "iOS". */
  platform?: string;
}

export interface Lease {
  leaseId: string;
  udid: string;
  sessionId: string;
  client: string;
  task?: string;
  createdAt: number;
  lastHeartbeat: number;
  ttlMs: number;
  /** Live MJPEG stream URL (serve-sim helper), present only when streaming. */
  streamUrl?: string;
  streamPort?: number;
  /** Active llmdb debug session id, present only while debug-attached. */
  debugSessionId?: string;
  /**
   * Contamination overlay (in-memory only, never persisted meaningfully):
   * foreign app activity was detected on the leased sim. Views fill these
   * from the orchestrator's per-lease state; absent means uncontended.
   */
  contended?: boolean;
  contendedSince?: number | null;
}

export type TicketStatus = "waiting" | "assigned" | "cancelled";

export interface Ticket {
  ticketId: string;
  sessionId: string;
  client: string;
  task?: string;
  requirements: Requirements;
  autoBoot: boolean;
  slim: boolean;
  createdAt: number;
  status: TicketStatus;
  assignedLeaseId?: string;
  assignedUdid?: string;
  /** Auto-start a live stream when this ticket is dispatched. */
  stream?: boolean;
}

export interface StoreState {
  seq: number;
  leases: Lease[];
  /** Terminal tickets (assigned/cancelled) are pruned; only waiting ones persist. */
  tickets: Ticket[];
}

function emptyState(): StoreState {
  return { seq: 0, leases: [], tickets: [] };
}

export function nextId(prefix: string, seq: number): string {
  return `${prefix}_${seq}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * JSON-file-backed state with atomic writes and a promise-chain mutex so
 * concurrent HTTP requests mutate serially.
 */
export class Store {
  private readonly file: string;
  private state: StoreState;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(file: string, state: StoreState) {
    this.file = file;
    this.state = state;
  }

  static load(file: string): Store {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      return new Store(file, {
        seq: typeof parsed.seq === "number" ? parsed.seq : 0,
        leases: Array.isArray(parsed.leases) ? parsed.leases : [],
        tickets: Array.isArray(parsed.tickets)
          ? parsed.tickets.filter((t) => t.status === "waiting" || t.status === "assigned")
          : [],
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[store] Failed to load ${file}, starting fresh: ${(err as Error).message}`);
      }
      return new Store(file, emptyState());
    }
  }

  /** Run fn exclusively; persists afterwards when fn returns true. */
  async mutate<T>(fn: (state: StoreState) => T | { value: T; dirty: boolean }): Promise<T> {
    const task = this.chain.then(() => {
      const out = fn(this.state);
      const value = typeof out === "object" && out !== null && "dirty" in out
        ? (out as { value: T; dirty: boolean }).value
        : (out as T);
      const dirty = typeof out === "object" && out !== null && "dirty" in out
        ? (out as { value: T; dirty: boolean }).dirty
        : true;
      if (dirty) this.save();
      return value;
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  async read<T>(fn: (state: StoreState) => T): Promise<T> {
    const task = this.chain.then(() => fn(this.state));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
