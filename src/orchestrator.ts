import { AppOps } from "./appops.js";
import { deviceKindOf, isRealLease } from "./devicekind.js";
import type { DeviceKind } from "./devicekind.js";
import { DebugOps } from "./llmdb.js";
import { CaptureOps, CaptureStartSpec, CaptureStatus, CaptureStopResult } from "./netcapture.js";
import { AssertFlowResult, AssertFlowSpec, NetProxyRule, NetProxyStatus, ProxyOps } from "./netproxy.js";
import { DEFAULT_STREAM_PORT_BASE, StreamOps } from "./servesim.js";
import type { PoolDevice, RealDevices } from "./realdevices.js";
import { FleetOps, SimDevice } from "./simslim.js";
import { appendAcquire, appendBoot } from "./boottelemetry.js";
import type { BootEvent } from "./boottelemetry.js";
import { Lease, Requirements, Store, Ticket, nextId } from "./store.js";
import { scrubText, scrubUdid, traceHook } from "./trace.js";

export class LeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseError";
  }
}

/** Tiny async mutex: serializes acquire/release/dispatch so two callers never grab one sim. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => undefined);
    return task;
  }
}

export interface AcquireInput {
  sessionId: string;
  client?: string;
  task?: string;
  requirements?: Requirements;
  queue?: boolean;
  autoBoot?: boolean;
  slim?: boolean;
  slimExcept?: string;
  ttlMs?: number;
  /** Start a live MJPEG stream for the lease (opt-in, default false). */
  stream?: boolean;
}

export type AcquireResult =
  | { ok: true; queued: false; lease: Lease; warnings?: string[] }
  | { ok: true; queued: true; ticket: Ticket; position: number; note?: string }
  | { ok: false; reason: string };

export interface DispatchAssignment {
  ticketId: string;
  sessionId: string;
  leaseId: string;
  udid: string;
  /** Stream URL when the ticket asked for one and it started. */
  streamUrl?: string;
  /** Why the requested stream did not start (lease is still valid). */
  streamError?: string;
}

export interface ReleaseResult {
  released: string;
  expiredSwept: string[];
  dispatched: DispatchAssignment[];
}

export interface PoolSimulator extends SimDevice {
  slim: boolean | null;
  slimDetail: { managedDisabled: number; managedTotal: number } | null;
  ramBytes: number | null;
  lease: Pick<Lease, "leaseId" | "sessionId" | "client" | "task" | "streamUrl" | "streamPort" | "contended" | "contendedSince"> | null;
}

/** pool_status row for a real device: inventory + lease overlay (slim/ram have no hardware meaning). */
export interface PoolDeviceView extends PoolDevice {
  slim: null;
  slimDetail: null;
  ramBytes: null;
  lease: Pick<Lease, "leaseId" | "sessionId" | "client" | "task" | "streamUrl" | "streamPort" | "contended" | "contendedSince"> | null;
}

/**
 * Bundles running that the lease neither inherited (baseline) nor launched
 * itself. `com.apple.*` system bundles are ignored — launchctl output cannot
 * attribute them to a lease, so flagging them would false-positive on stock
 * daemons (documented limitation: a foreign com.apple.* launch goes unseen).
 */
export function findForeignApps(running: Set<string>, baseline: Set<string>, launched: Set<string>): string[] {
  return [...running]
    .filter((b) => !b.startsWith("com.apple.") && !baseline.has(b) && !launched.has(b))
    .sort();
}

/** LW0 boot telemetry: classify a slim step outcome for the BOOT/ACQUIRE lines. */
type SlimClass = BootEvent["slim"];

function classifySlim(status: { slim: boolean; managedDisabled: number } | null): SlimClass {
  if (!status) return "unknown";
  if (status.slim) return "slim";
  if (status.managedDisabled > 0) return "partial";
  return "stock";
}

/** LW0: scrub a boot error for the BOOT line (UDIDs hashed, secrets redacted, 200-char cap). Total by construction: never throws, even on non-Error rejections. */
function scrubBootErr(err: unknown): string {
  try {
    return scrubText(err instanceof Error ? err.message : String(err)).slice(0, 200);
  } catch {
    return "unknown boot error";
  }
}

/** Per-lease contamination (lease-interference) tracking, in-memory only. */
interface ContaminationState {
  /** Apps already running when the lease started (not the lease's doing). */
  baseline: Set<string>;
  /** Bundles this lease launched via app_launch and has not terminated. */
  launched: Set<string>;
  contended: boolean;
  contendedSince: number | null;
  lastCheck: number;
}

function matches(dev: SimDevice, req: Requirements): boolean {
  if ((req.deviceKind ?? "sim") !== "sim") return false;
  if (req.udid && dev.udid !== req.udid) return false;
  if (req.device && !dev.name.toLowerCase().includes(req.device.toLowerCase())) return false;
  if (req.osVersion && !(dev.osVersion ?? "").startsWith(req.osVersion)) return false;
  if (req.platform && (dev.platform ?? "").toLowerCase() !== req.platform.toLowerCase()) return false;
  return true;
}

/** Real-fleet match: same udid/device/osVersion/platform semantics plus transport + availability. */
function matchesReal(dev: PoolDevice, req: Requirements): boolean {
  if ((req.deviceKind ?? "sim") !== "real") return false;
  if (dev.state !== "available") return false;
  if (req.udid && dev.udid !== req.udid) return false;
  if (req.device && !dev.name.toLowerCase().includes(req.device.toLowerCase())) return false;
  if (req.osVersion && !(dev.osVersion ?? "").startsWith(req.osVersion)) return false;
  if (req.platform && (dev.platform ?? "").toLowerCase() !== req.platform.toLowerCase()) return false;
  if (req.transport && dev.transport !== req.transport) return false;
  return true;
}

function isBooted(d: SimDevice): boolean {
  return d.state.toLowerCase() === "booted";
}

function isExpired(lease: Lease, now: number): boolean {
  return now - lease.lastHeartbeat > lease.ttlMs;
}

const ASSIGNED_RETENTION_MS = 60 * 60 * 1000;

export interface LeaseAction {
  t: number;
  tool: string;
  summary: string;
}

const MAX_ACTIONS_PER_LEASE = 100;

export class Orchestrator {
  private readonly fleet: FleetOps;
  private readonly store: Store;
  private readonly mutex = new Mutex();
  private readonly defaultTtlMs: number;
  private readonly maxSims: number;
  private readonly streamer?: StreamOps;
  private readonly realStreamer?: StreamOps;
  private readonly streamPortBase: number;
  private readonly debugger?: DebugOps;
  private readonly netProxy?: ProxyOps;
  private readonly netCapture?: CaptureOps;
  private readonly apps?: Pick<AppOps, "listRunning">;
  private readonly realFleet?: Pick<RealDevices, "list">;
  private readonly realApps?: Pick<AppOps, "listRunning">;
  private readonly contaminationCheck: boolean;
  private readonly contaminationCheckMinIntervalMs: number;
  private readonly traceDir?: string;
  private readonly actions = new Map<string, LeaseAction[]>();
  private readonly contamination = new Map<string, ContaminationState>();

  constructor(
    fleet: FleetOps,
    store: Store,
    opts: {
      defaultTtlMs: number;
      maxSims?: number;
      streamer?: StreamOps;
      /** Real-device MJPEG backend (single-flight go-ios). Absent ⇒ real stream_start fails fast. */
      realStreamer?: StreamOps;
      streamPortBase?: number;
      debugger?: DebugOps;
      proxy?: ProxyOps;
      capture?: CaptureOps;
      apps?: Pick<AppOps, "listRunning">;
      /** Real-device inventory provider (devicectl-backed). Absent ⇒ real acquire fails. */
      realFleet?: Pick<RealDevices, "list">;
      /** Real-device listRunning (devicectl join) for contamination baselines. */
      realApps?: Pick<AppOps, "listRunning">;
      contaminationCheck?: boolean;
      contaminationCheckMinIntervalMs?: number;
      traceDir?: string;
    },
  ) {
    this.fleet = fleet;
    this.store = store;
    this.defaultTtlMs = opts.defaultTtlMs;
    this.maxSims = opts.maxSims ?? 0;
    this.streamer = opts.streamer;
    this.realStreamer = opts.realStreamer;
    this.streamPortBase = opts.streamPortBase ?? DEFAULT_STREAM_PORT_BASE;
    this.debugger = opts.debugger;
    this.netProxy = opts.proxy;
    this.netCapture = opts.capture;
    this.apps = opts.apps;
    this.realFleet = opts.realFleet;
    this.realApps = opts.realApps;
    this.contaminationCheck = opts.contaminationCheck ?? true;
    this.contaminationCheckMinIntervalMs = opts.contaminationCheckMinIntervalMs ?? 30_000;
    this.traceDir = opts.traceDir;
  }

  // ---------- state views (read-only, never mutate) ----------

  async poolStatus(): Promise<{
    simulators: PoolSimulator[];
    counts: { total: number; booted: number; leased: number; free: number };
    queue: { waiting: number };
    devices: PoolDeviceView[];
    countsReal: { total: number; available: number; leased: number };
    /** Present only when the real fleet was probed and failed; the sim view stays intact. */
    realError?: string;
  }> {
    const [devices, leases, tickets] = await Promise.all([
      this.fleet.list(),
      this.store.read((s) => s.leases),
      this.store.read((s) => s.tickets.filter((t) => t.status === "waiting")),
    ]);
    let realDevices: PoolDevice[] = [];
    let realError: string | undefined;
    if (this.realFleet) {
      try {
        realDevices = await this.realFleet.list();
      } catch (err) {
        realError = (err as Error).message;
      }
    }
    const byUdid = new Map(leases.map((l) => [l.udid, l]));
    const now = Date.now();

    const slimEntries = await Promise.all(
      devices.map(async (d) => {
        if (!isBooted(d)) return [d.udid, null] as const;
        try {
          return [d.udid, await this.fleet.slimStatus(d.udid)] as const;
        } catch {
          return [d.udid, null] as const;
        }
      }),
    );
    const slimByUdid = new Map(slimEntries);

    const simulators: PoolSimulator[] = devices.map((d) => {
      const lease = byUdid.get(d.udid);
      const slimStatus = slimByUdid.get(d.udid) ?? null;
      return {
        ...d,
        slim: slimStatus?.slim ?? null,
        slimDetail: slimStatus
          ? { managedDisabled: slimStatus.managedDisabled, managedTotal: slimStatus.managedTotal }
          : null,
        ramBytes: null, // reserved: fill via `simslim top --json` if per-sim RAM is needed
        lease: lease && !isExpired(lease, now)
          ? {
            leaseId: lease.leaseId,
            sessionId: lease.sessionId,
            client: lease.client,
            task: lease.task,
            streamUrl: lease.streamUrl,
            streamPort: lease.streamPort,
            contended: this.contamination.get(lease.leaseId)?.contended ?? false,
            contendedSince: this.contamination.get(lease.leaseId)?.contendedSince ?? null,
          }
          : null,
      };
    });
    const booted = devices.filter(isBooted).length;
    const leased = simulators.filter((s) => s.lease !== null).length;
    const deviceRows: PoolDeviceView[] = realDevices.map((d) => {
      const lease = byUdid.get(d.udid);
      return {
        ...d,
        slim: null,
        slimDetail: null,
        ramBytes: null,
        lease: lease && !isExpired(lease, now)
          ? {
            leaseId: lease.leaseId,
            sessionId: lease.sessionId,
            client: lease.client,
            task: lease.task,
            streamUrl: lease.streamUrl,
            streamPort: lease.streamPort,
            contended: this.contamination.get(lease.leaseId)?.contended ?? false,
            contendedSince: this.contamination.get(lease.leaseId)?.contendedSince ?? null,
          }
          : null,
      };
    });
    const availableReal = realDevices.filter((d) => d.state === "available").length;
    const leasedReal = deviceRows.filter((s) => s.lease !== null).length;
    return {
      simulators,
      counts: { total: devices.length, booted, leased, free: booted - leased },
      queue: { waiting: tickets.length },
      devices: deviceRows,
      countsReal: { total: realDevices.length, available: availableReal, leased: leasedReal },
      ...(realError !== undefined ? { realError } : {}),
    };
  }

  async leasesList(): Promise<{ leases: (Lease & { expired: boolean })[] }> {
    const now = Date.now();
    const leases = await this.store.read((s) => s.leases);
    return {
      leases: leases.map((l) => ({
        ...l,
        expired: isExpired(l, now),
        contended: this.contamination.get(l.leaseId)?.contended ?? false,
        contendedSince: this.contamination.get(l.leaseId)?.contendedSince ?? null,
      })),
    };
  }

  async sessionsList(): Promise<{
    sessions: {
      sessionId: string;
      clients: string[];
      leases: Lease[];
      tickets: Ticket[];
    }[];
  }> {
    const [leases, tickets] = await Promise.all([
      this.store.read((s) => s.leases),
      this.store.read((s) => s.tickets),
    ]);
    const groups = new Map<string, { clients: Set<string>; leases: Lease[]; tickets: Ticket[] }>();
    const group = (sessionId: string) => {
      let g = groups.get(sessionId);
      if (!g) {
        g = { clients: new Set(), leases: [], tickets: [] };
        groups.set(sessionId, g);
      }
      return g;
    };
    for (const l of leases) {
      const g = group(l.sessionId);
      g.clients.add(l.client);
      g.leases.push(l);
    }
    for (const t of tickets) {
      const g = group(t.sessionId);
      g.clients.add(t.client);
      g.tickets.push(t);
    }
    return {
      sessions: [...groups.entries()].map(([sessionId, g]) => ({
        sessionId,
        clients: [...g.clients],
        leases: g.leases,
        tickets: g.tickets,
      })),
    };
  }

  async queueStatus(ticketId?: string): Promise<{
    waiting: (Ticket & { position: number })[];
    ticket?: Ticket & { position: number | null };
  }> {
    const tickets = await this.store.read((s) =>
      s.tickets.filter((t) => t.status === "waiting").sort((a, b) => a.createdAt - b.createdAt),
    );
    const waiting = tickets.map((t, i) => ({ ...t, position: i + 1 }));
    if (!ticketId) return { waiting };
    const found = await this.store.read((s) => s.tickets.find((t) => t.ticketId === ticketId));
    if (!found) throw new LeaseError(`Unknown ticket ${ticketId}`);
    const position = found.status === "waiting"
      ? waiting.find((w) => w.ticketId === ticketId)?.position ?? null
      : null;
    return { waiting, ticket: { ...found, position } };
  }

  // ---------- acquire / release / dispatch ----------

  acquire(input: AcquireInput): Promise<AcquireResult> {
    return this.mutex.run(async () => {
      if (!input.sessionId) return { ok: false, reason: "sessionId is required" };
      const t0 = Date.now(); // LW0 outer clock: acquire-entry -> outcome.
      const req = input.requirements ?? {};
      const queue = input.queue ?? true;
      const autoBoot = input.autoBoot ?? true;
      const slim = input.slim ?? true;
      const client = input.client?.trim() || "unknown";

      const expiredSwept = await this.sweepLocked();
      const warnings = expiredSwept.map((id) => `Swept expired lease ${id}`);

      if ((req.deviceKind ?? "sim") === "real") {
        if (!this.realFleet) {
          return {
            ok: false,
            reason: "kind=real acquisition needs the real-device inventory transport (devicectl), which is unavailable in this embedding.",
          };
        }
        let realDevices: PoolDevice[];
        try {
          realDevices = await this.realFleet.list();
        } catch (err) {
          const reason = `Real-device inventory failed: ${(err as Error).message}`;
          if (!queue) return { ok: false, reason };
          const { ticket, position } = await this.createTicket(input, client, req, false, false);
          return { ok: true, queued: true, ticket, position, note: reason };
        }
        const leases = await this.store.read((s) => s.leases);
        const held = new Set(leases.map((l) => l.udid));
        const free = realDevices
          .filter((d) => !held.has(d.udid) && matchesReal(d, req))
          .sort((a, b) => a.udid.localeCompare(b.udid));
        if (free.length > 0) {
          const target = free[0]!;
          const lease = await this.createLease(target.udid, input, client);
          await this.captureBaseline(lease.leaseId, target.udid, "real");
          await this.maybeStartStream(lease, input.stream === true, warnings);
          return { ok: true, queued: false, lease, warnings: warnings.length ? warnings : undefined };
        }
        if (!queue) {
          return {
            ok: false,
            reason: "No matching real device is free and queue=false (see pool_status devices[]; checklist: paired, trusted, Developer Mode on, reachable)",
          };
        }
        const { ticket, position } = await this.createTicket(input, client, req, false, false);
        return { ok: true, queued: true, ticket, position };
      }

      const devices = await this.fleet.list();
      const leases = await this.store.read((s) => s.leases);
      const held = new Set(leases.map((l) => l.udid));

      // 1) Free booted sim, deterministic order.
      const free = devices
        .filter((d) => isBooted(d) && !held.has(d.udid) && matches(d, req))
        .sort((a, b) => a.udid.localeCompare(b.udid));
      if (free.length > 0) {
        const target = free[0]!;
        let slimMs = -1;
        if (slim) {
          const res = await this.trySlim(target.udid, input.slimExcept);
          if (res.warn) warnings.push(res.warn);
          slimMs = res.slimMs;
        }
        const lease = await this.createLease(target.udid, input, client);
        const baselineMs = await this.captureBaselineTimed(lease.leaseId, target.udid);
        await this.maybeStartStream(lease, input.stream === true, warnings);
        const now = Date.now();
        appendAcquire({ t: now, kind: "acquire", outcome: "HIT", leaseId: lease.leaseId, waitMs: now - t0, bootMs: -1, slimMs, baselineMs, via: "acquire" });
        return { ok: true, queued: false, lease, warnings: warnings.length ? warnings : undefined };
      }

      // 2) Boot a matching shutdown sim.
      if (autoBoot) {
        const bootedCount = devices.filter(isBooted).length;
        if (this.maxSims > 0 && bootedCount >= this.maxSims) {
          // Fall through to queue: at capacity.
        } else {
          const bootable = devices
            .filter((d) => !isBooted(d) && !held.has(d.udid) && matches(d, req))
            .sort((a, b) => a.udid.localeCompare(b.udid));
          if (bootable.length > 0) {
            const target = bootable[0]!;
            const bootT0 = Date.now();
            try {
              await this.fleet.boot(target.udid);
            } catch (err) {
              appendBoot({ t: Date.now(), kind: "boot", ok: false, udidHash: scrubUdid(target.udid), deviceName: target.name, osVersion: target.osVersion ?? "unknown", platform: target.platform ?? "unknown", coldWarm: "cold", slim: "unknown", slimMs: -1, bootMs: Date.now() - bootT0, readyMs: -1, err: scrubBootErr(err) });
              const reason = `Boot of ${target.udid} failed: ${(err as Error).message}`;
              if (!queue) return { ok: false, reason };
              const { ticket, position } = await this.createTicket(input, client, req, autoBoot, slim);
              const queuedNow = Date.now();
              appendAcquire({ t: queuedNow, kind: "acquire", outcome: "QUEUE", ticketId: ticket.ticketId, waitMs: queuedNow - t0, bootMs: -1, slimMs: -1, baselineMs: -1, via: "acquire" });
              return { ok: true, queued: true, ticket, position, note: reason };
            }
            const bootMs = Date.now() - bootT0;
            let slimMs = -1;
            let slimClass: SlimClass = "unknown";
            if (slim) {
              const res = await this.trySlim(target.udid, input.slimExcept);
              if (res.warn) warnings.push(res.warn);
              slimMs = res.slimMs;
              slimClass = res.slim;
            }
            appendBoot({ t: Date.now(), kind: "boot", ok: true, udidHash: scrubUdid(target.udid), deviceName: target.name, osVersion: target.osVersion ?? "unknown", platform: target.platform ?? "unknown", coldWarm: "cold", slim: slimClass, slimMs, bootMs, readyMs: -1 });
            const lease = await this.createLease(target.udid, input, client);
            const baselineMs = await this.captureBaselineTimed(lease.leaseId, target.udid);
            await this.maybeStartStream(lease, input.stream === true, warnings);
            const now = Date.now();
            appendAcquire({ t: now, kind: "acquire", outcome: "MISS", leaseId: lease.leaseId, waitMs: now - t0, bootMs, slimMs, baselineMs, via: "acquire" });
            return { ok: true, queued: false, lease, warnings: warnings.length ? warnings : undefined };
          }
        }
      }

      // 3) Queue.
      if (!queue) return { ok: false, reason: "No matching simulator is free and queue=false" };
      const { ticket, position } = await this.createTicket(input, client, req, autoBoot, slim);
      const queuedNow = Date.now();
      appendAcquire({ t: queuedNow, kind: "acquire", outcome: "QUEUE", ticketId: ticket.ticketId, waitMs: queuedNow - t0, bootMs: -1, slimMs: -1, baselineMs: -1, via: "acquire" });
      return { ok: true, queued: true, ticket, position };
    });
  }

  release(leaseId: string, sessionId: string, opts: { force?: boolean } = {}): Promise<ReleaseResult> {
    return this.mutex.run(async () => {
      const expiredSwept = await this.sweepLocked();
      const removed = await this.store.mutate((s) => {
        const idx = s.leases.findIndex((l) => l.leaseId === leaseId);
        if (idx === -1) throw new LeaseError(`Unknown lease ${leaseId}`);
        const lease = s.leases[idx]!;
        if (!opts.force && lease.sessionId !== sessionId) {
          throw new LeaseError(`Lease ${leaseId} is held by session ${lease.sessionId}, not ${sessionId}`);
        }
        s.leases.splice(idx, 1);
        return { value: lease, dirty: true };
      });
      // Stop BEFORE dispatch: a waiter reusing this sim may start its own stream.
      await this.stopStreamQuiet(removed.udid, deviceKindOf(removed));
      await this.stopDebugQuiet(removed.debugSessionId);
      await this.stopProxyQuiet(removed.leaseId);
      await this.stopCaptureQuiet(removed.leaseId);
      const dispatched = await this.dispatchLocked();
      this.actions.delete(leaseId);
      this.contamination.delete(leaseId);
      return { released: leaseId, expiredSwept, dispatched };
    });
  }

  cancelTicket(ticketId: string, sessionId: string): Promise<{ cancelled: string }> {
    return this.mutex.run(async () => {
      await this.store.mutate((s) => {
        const idx = s.tickets.findIndex((t) => t.ticketId === ticketId);
        if (idx === -1) throw new LeaseError(`Unknown ticket ${ticketId}`);
        const ticket = s.tickets[idx]!;
        if (ticket.sessionId !== sessionId) {
          throw new LeaseError(`Ticket ${ticketId} belongs to session ${ticket.sessionId}, not ${sessionId}`);
        }
        if (ticket.status !== "waiting") {
          throw new LeaseError(`Ticket ${ticketId} is already ${ticket.status}`);
        }
        s.tickets.splice(idx, 1);
        return { value: undefined, dirty: true };
      });
      return { cancelled: ticketId };
    });
  }

  heartbeat(leaseId: string, sessionId: string): Promise<Lease> {
    return this.mutex.run(async () =>
      this.store.mutate((s) => {
        const lease = s.leases.find((l) => l.leaseId === leaseId);
        if (!lease) throw new LeaseError(`Unknown lease ${leaseId}`);
        if (lease.sessionId !== sessionId) {
          throw new LeaseError(`Lease ${leaseId} is held by session ${lease.sessionId}, not ${sessionId}`);
        }
        lease.lastHeartbeat = Date.now();
        return { value: { ...lease }, dirty: true };
      }),
    );
  }

  /** Drop expired leases, prune old assignments, then auto-dispatch the queue. */
  sweepStale(): Promise<{ swept: string[]; dispatched: DispatchAssignment[] }> {
    return this.mutex.run(async () => {
      const swept = await this.sweepLocked();
      const dispatched = await this.dispatchLocked();
      return { swept, dispatched };
    });
  }

  /**
   * Validate a lease for gated operations. Releases it (and dispatches) when it
   * expired or its simulator is no longer booted, then throws.
   */
  async resolveLease(leaseId: string): Promise<Lease> {
    const lease = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
    if (!lease) throw new LeaseError(`Unknown lease ${leaseId}`);
    if (isExpired(lease, Date.now())) {
      await this.mutex.run(async () => {
        await this.store.mutate((s) => {
          s.leases = s.leases.filter((l) => l.leaseId !== leaseId);
          return { value: undefined, dirty: true };
        });
        await this.stopStreamQuiet(lease.udid, deviceKindOf(lease));
        await this.stopDebugQuiet(lease.debugSessionId);
        await this.stopProxyQuiet(leaseId);
        await this.stopCaptureQuiet(leaseId);
        await this.dispatchLocked();
      });
      this.actions.delete(leaseId);
      this.contamination.delete(leaseId);
      throw new LeaseError(`Lease ${leaseId} expired and was released`);
    }
    if (isRealLease(lease)) {
      if (this.realFleet) {
        let present = false;
        try {
          const realDevices = await this.realFleet.list();
          present = realDevices.some((d) => d.udid === lease.udid && d.state === "available");
        } catch {
          present = true; // Inventory failure means unknown, not gone: keep the lease.
        }
        if (!present) {
          await this.mutex.run(async () => {
            await this.store.mutate((s) => {
              s.leases = s.leases.filter((l) => l.leaseId !== leaseId);
              return { value: undefined, dirty: true };
            });
            await this.stopDebugQuiet(lease.debugSessionId);
            await this.stopProxyQuiet(leaseId);
            await this.stopCaptureQuiet(leaseId);
            await this.dispatchLocked();
          });
          this.actions.delete(leaseId);
          this.contamination.delete(leaseId);
          throw new LeaseError(`Real device ${lease.udid} is no longer available; lease ${leaseId} was released`);
        }
      }
      await this.checkContamination(lease);
      return lease;
    }
    const devices = await this.fleet.list();
    const dev = devices.find((d) => d.udid === lease.udid);
    if (!dev || !isBooted(dev)) {
      await this.mutex.run(async () => {
        await this.store.mutate((s) => {
          s.leases = s.leases.filter((l) => l.leaseId !== leaseId);
          return { value: undefined, dirty: true };
        });
        await this.stopStreamQuiet(lease.udid, deviceKindOf(lease));
        await this.stopDebugQuiet(lease.debugSessionId);
        await this.stopProxyQuiet(leaseId);
        await this.stopCaptureQuiet(leaseId);
        await this.dispatchLocked();
      });
      this.actions.delete(leaseId);
      this.contamination.delete(leaseId);
      throw new LeaseError(`Simulator ${lease.udid} is no longer booted; lease ${leaseId} was released`);
    }
    await this.checkContamination(lease);
    return lease;
  }

  leaseForUdid(udid: string): Promise<Lease | null> {
    return this.store.read((s) => s.leases.find((l) => l.udid === udid) ?? null);
  }

  /** Read-only lease lookup by id (no validation, no eviction); null when unknown. */
  leaseById(leaseId: string): Promise<Lease | null> {
    return this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId) ?? null);
  }

  // ---------- per-lease action ring (in-memory, last 100) ----------

  /** Append a one-line action summary; no-op when the lease is unknown. */
  async logAction(leaseId: string, tool: string, summary: string, extra?: unknown): Promise<void> {
    const known = await this.store.read((s) => s.leases.some((l) => l.leaseId === leaseId));
    if (!known) return;
    let ring = this.actions.get(leaseId);
    if (!ring) {
      ring = [];
      this.actions.set(leaseId, ring);
    }
    ring.push({ t: Date.now(), tool, summary });
    if (ring.length > MAX_ACTIONS_PER_LEASE) ring.splice(0, ring.length - MAX_ACTIONS_PER_LEASE);
    traceHook({ leaseId, tool, summary, t: Date.now(), extra }, this.traceDir);
  }

  /** Newest-last action history for a lease (empty when unknown), capped at `limit`. */
  leaseActions(leaseId: string, limit?: number): LeaseAction[] {
    const ring = this.actions.get(leaseId) ?? [];
    if (limit === undefined) return [...ring];
    return ring.slice(Math.max(0, ring.length - Math.max(1, Math.floor(limit))));
  }

  // ---------- contamination (lease-interference) detection, in-memory ----------

  /**
   * Contamination flag for a lease (uncontended when unknown). Detection only:
   * nothing is blocked or thrown — see docs/security.md.
   */
  contaminationStatus(leaseId: string): { contended: boolean; contendedSince: number | null } {
    const state = this.contamination.get(leaseId);
    return { contended: state?.contended ?? false, contendedSince: state?.contendedSince ?? null };
  }

  /** Record a bundle this lease launched (app_launch); it is never foreign. */
  markAppLaunched(leaseId: string, bundleId: string): void {
    this.ensureContamination(leaseId).launched.add(bundleId);
  }

  /** Forget a bundle this lease terminated (app_terminate). */
  markAppTerminated(leaseId: string, bundleId: string): void {
    this.contamination.get(leaseId)?.launched.delete(bundleId);
  }

  private ensureContamination(leaseId: string): ContaminationState {
    let state = this.contamination.get(leaseId);
    if (!state) {
      state = { baseline: new Set(), launched: new Set(), contended: false, contendedSince: null, lastCheck: 0 };
      this.contamination.set(leaseId, state);
    }
    return state;
  }

  /**
   * Snapshot the apps already running on a fresh lease's sim. Best-effort and
   * async: runs AFTER lease creation (never inside a sync mutate), and a
   * failed snapshot leaves an empty baseline plus an action note — the acquire
   * still succeeds.
   */
  /** Backend for contamination snapshots, selected by lease kind (sim vs real). */
  private appsFor(kind: DeviceKind): Pick<AppOps, "listRunning"> | undefined {
    return kind === "real" ? this.realApps : this.apps;
  }

  /** captureBaseline plus its wall time, for the ACQUIRE baselineMs field. */
  private async captureBaselineTimed(leaseId: string, udid: string, kind: DeviceKind = "sim"): Promise<number> {
    const t0 = Date.now();
    await this.captureBaseline(leaseId, udid, kind);
    return Date.now() - t0;
  }

  private async captureBaseline(leaseId: string, udid: string, kind: DeviceKind = "sim"): Promise<void> {
    const state = this.ensureContamination(leaseId);
    const apps = this.appsFor(kind);
    if (!this.contaminationCheck || !apps) return;
    try {
      state.baseline = await apps.listRunning(udid);
      state.lastCheck = Date.now();
    } catch (err) {
      state.baseline = new Set();
      await this.logAction(leaseId, "contamination", `baseline snapshot failed, using empty baseline: ${(err as Error).message}`);
    }
  }

  /**
   * One throttled contamination check for a held lease. Never throws: a failed
   * spawn means unknown (not contended) and is skipped silently. On the first
   * foreign bundle the lease flips contended and logs ONE `EXTERNAL` action
   * entry (transition only, never per-check spam).
   */
  private async checkContamination(lease: Lease): Promise<void> {
    try {
      const apps = this.appsFor(deviceKindOf(lease));
      if (!this.contaminationCheck || !apps) return;
      const state = this.contamination.get(lease.leaseId);
      if (!state) return;
      if (Date.now() - state.lastCheck < this.contaminationCheckMinIntervalMs) return;
      let running: Set<string>;
      try {
        running = await apps.listRunning(lease.udid);
      } catch {
        return; // Unknown, not contended.
      }
      state.lastCheck = Date.now();
      const foreign = findForeignApps(running, state.baseline, state.launched);
      if (foreign.length > 0 && !state.contended) {
        state.contended = true;
        state.contendedSince = Date.now();
        await this.logAction(lease.leaseId, "EXTERNAL", `foreign app activity detected: ${foreign.join(", ")}`);
      }
    } catch {
      // Detection must never break the gated operation it rides along with.
    }
  }

  // ---------- internals (caller must hold the mutex) ----------

  private async sweepLocked(): Promise<string[]> {
    const now = Date.now();
    const sweptStreams: { udid: string; kind: DeviceKind }[] = [];
    const sweptDebugSessions: (string | undefined)[] = [];
    const sweptLeaseIds: string[] = [];
    const swept = await this.store.mutate((s) => {
      const ids: string[] = [];
      s.leases = s.leases.filter((l) => {
        if (isExpired(l, now)) {
          ids.push(l.leaseId);
          sweptStreams.push({ udid: l.udid, kind: deviceKindOf(l) });
          sweptDebugSessions.push(l.debugSessionId);
          sweptLeaseIds.push(l.leaseId);
          return false;
        }
        return true;
      });
      s.tickets = s.tickets.filter(
        (t) => t.status === "waiting" || now - t.createdAt < ASSIGNED_RETENTION_MS,
      );
      for (const id of ids) {
        this.actions.delete(id);
        this.contamination.delete(id);
      }
      return { value: ids, dirty: ids.length > 0 };
    });
    // Callers dispatch after sweeping, so stopping here never kills a new lease's stream.
    for (const { udid, kind } of sweptStreams) await this.stopStreamQuiet(udid, kind);
    for (const sessionId of sweptDebugSessions) await this.stopDebugQuiet(sessionId);
    for (const leaseId of sweptLeaseIds) await this.stopProxyQuiet(leaseId);
    for (const leaseId of sweptLeaseIds) await this.stopCaptureQuiet(leaseId);
    // Periodic contamination check over surviving held leases (post-mutate: spawns).
    const survivors = await this.store.read((s) => s.leases.filter((l) => !isExpired(l, Date.now())));
    for (const lease of survivors) await this.checkContamination(lease);
    return swept;
  }

  /**
   * Assign waiting tickets (oldest first) to free matching sims, booting when
   * the ticket allows it; real tickets resolve against one real-fleet snapshot
   * (no boot/slim arm). Runs after every release/sweep so freed capacity is
   * handed to the queue automatically.
   */
  private async dispatchLocked(): Promise<DispatchAssignment[]> {
    const assigned: DispatchAssignment[] = [];
    const waiting = await this.store.read((s) =>
      s.tickets.filter((t) => t.status === "waiting").sort((a, b) => a.createdAt - b.createdAt),
    );
    if (waiting.length === 0) return assigned;

    const devices = await this.fleet.list();
    const leases = await this.store.read((s) => s.leases);
    const held = new Set(leases.map((l) => l.udid));
    const bootedUdids = new Set(devices.filter(isBooted).map((d) => d.udid));
    let bootedCount = bootedUdids.size;
    let realSnapshot: PoolDevice[] | null = null;
    const realList = async (): Promise<PoolDevice[]> => {
      if (realSnapshot === null) {
        realSnapshot = this.realFleet ? await this.realFleet.list().catch(() => []) : [];
      }
      return realSnapshot;
    };

    for (const ticket of waiting) {
      if ((ticket.requirements.deviceKind ?? "sim") === "real") {
        const target = (await realList())
          .filter((d) => !held.has(d.udid) && matchesReal(d, ticket.requirements))
          .sort((a, b) => a.udid.localeCompare(b.udid))[0];
        if (!target) continue;
        held.add(target.udid);
        const leaseId = await this.createDispatchedLease(target.udid, ticket);
        const assignment: DispatchAssignment = {
          ticketId: ticket.ticketId,
          sessionId: ticket.sessionId,
          leaseId,
          udid: target.udid,
        };
        await this.captureBaseline(leaseId, target.udid, "real");
        if (ticket.stream === true) {
          await this.startDispatchedStream(leaseId, target.udid, assignment, "real");
        }
        assigned.push(assignment);
        continue;
      }
      const free = devices
        .filter((d) => bootedUdids.has(d.udid) && !held.has(d.udid) && matches(d, ticket.requirements))
        .sort((a, b) => a.udid.localeCompare(b.udid));
      let target = free[0];
      let dispatchBooted = false;
      let dispatchBootMs = -1;
      let dispatchSlimMs = -1;

      if (!target && ticket.autoBoot && (this.maxSims === 0 || bootedCount < this.maxSims)) {
        const bootable = devices
          .filter((d) => !bootedUdids.has(d.udid) && !held.has(d.udid) && matches(d, ticket.requirements))
          .sort((a, b) => a.udid.localeCompare(b.udid));
        const candidate = bootable[0];
        if (candidate) {
          const bootT0 = Date.now();
          try {
            await this.fleet.boot(candidate.udid);
          } catch (err) {
            appendBoot({ t: Date.now(), kind: "boot", ok: false, udidHash: scrubUdid(candidate.udid), deviceName: candidate.name, osVersion: candidate.osVersion ?? "unknown", platform: candidate.platform ?? "unknown", coldWarm: "cold", slim: "unknown", slimMs: -1, bootMs: Date.now() - bootT0, readyMs: -1, err: scrubBootErr(err) });
            break; // Likely systemic; leave the rest waiting for the next trigger.
          }
          dispatchBootMs = Date.now() - bootT0;
          bootedUdids.add(candidate.udid);
          bootedCount += 1;
          let slimClass: SlimClass = "unknown";
          if (ticket.slim) {
            const res = await this.trySlim(candidate.udid);
            dispatchSlimMs = res.slimMs;
            slimClass = res.slim;
          }
          appendBoot({ t: Date.now(), kind: "boot", ok: true, udidHash: scrubUdid(candidate.udid), deviceName: candidate.name, osVersion: candidate.osVersion ?? "unknown", platform: candidate.platform ?? "unknown", coldWarm: "cold", slim: slimClass, slimMs: dispatchSlimMs, bootMs: dispatchBootMs, readyMs: -1 });
          dispatchBooted = true;
          target = candidate;
        }
      }

      if (!target) continue;
      held.add(target.udid);
      const leaseId = await this.createDispatchedLease(target.udid, ticket);
      const assignment: DispatchAssignment = {
        ticketId: ticket.ticketId,
        sessionId: ticket.sessionId,
        leaseId,
        udid: target.udid,
      };
      const baselineMs = await this.captureBaselineTimed(leaseId, target.udid);
      const now = Date.now();
      appendAcquire({ t: now, kind: "acquire", outcome: dispatchBooted ? "MISS" : "HIT", leaseId, waitMs: now - ticket.createdAt, bootMs: dispatchBootMs, slimMs: dispatchSlimMs, baselineMs, via: "dispatch" });
      if (ticket.stream === true) await this.startDispatchedStream(leaseId, target.udid, assignment, "sim");
      assigned.push(assignment);
    }
    return assigned;
  }

  /** Lease + ticket-assignment bookkeeping shared by the sim and real dispatch arms. */
  private async createDispatchedLease(udid: string, ticket: Ticket): Promise<string> {
    return this.store.mutate((s) => {
      s.seq += 1;
      const lease: Lease = {
        leaseId: nextId("lease", s.seq),
        udid,
        sessionId: ticket.sessionId,
        client: ticket.client,
        task: ticket.task,
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),
        ttlMs: this.defaultTtlMs,
        deviceKind: ticket.requirements.deviceKind ?? "sim",
        ...(ticket.requirements.transport !== undefined ? { transport: ticket.requirements.transport } : {}),
      };
      s.leases.push(lease);
      const rec = s.tickets.find((t) => t.ticketId === ticket.ticketId);
      if (rec) {
        rec.status = "assigned";
        rec.assignedLeaseId = lease.leaseId;
        rec.assignedUdid = udid;
      }
      return { value: lease.leaseId, dirty: true };
    });
  }

  private async createLease(udid: string, input: AcquireInput, client: string): Promise<Lease> {
    return this.store.mutate((s) => {
      s.seq += 1;
      const lease: Lease = {
        leaseId: nextId("lease", s.seq),
        udid,
        sessionId: input.sessionId,
        client,
        task: input.task,
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),
        ttlMs: input.ttlMs ?? this.defaultTtlMs,
        deviceKind: input.requirements?.deviceKind ?? "sim",
        ...(input.requirements?.transport !== undefined ? { transport: input.requirements.transport } : {}),
      };
      s.leases.push(lease);
      return { value: { ...lease }, dirty: true };
    });
  }

  private async createTicket(
    input: AcquireInput,
    client: string,
    req: Requirements,
    autoBoot: boolean,
    slim: boolean,
  ): Promise<{ ticket: Ticket; position: number }> {
    return this.store.mutate((s) => {
      s.seq += 1;
      const ticket: Ticket = {
        ticketId: nextId("ticket", s.seq),
        sessionId: input.sessionId,
        client,
        task: input.task,
        requirements: req,
        autoBoot,
        slim,
        createdAt: Date.now(),
        status: "waiting",
        ...(input.stream === true ? { stream: true as const } : {}),
      };
      s.tickets.push(ticket);
      const position = s.tickets.filter((t) => t.status === "waiting").length;
      return { value: { ticket: { ...ticket }, position }, dirty: true };
    });
  }

  // ---------- per-lease live streams ----------

  /**
   * Start (or reuse) the live stream for a lease and persist its URL on the
   * lease record. Idempotent: a running stream's URL is returned as-is.
   */
  startLeaseStream(leaseId: string): Promise<{ lease: Lease; url: string; port: number }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      const streamer = this.streamerFor(deviceKindOf(found));
      const { url, port } = await streamer.startStream(found.udid, { portBase: this.streamPortBase });
      const lease = await this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === leaseId);
        if (!rec) throw new LeaseError(`Unknown lease ${leaseId}`);
        rec.streamUrl = url;
        rec.streamPort = port;
        return { value: { ...rec }, dirty: true };
      });
      return { lease, url, port };
    });
  }

  /**
   * Stop the live stream for a lease and clear its URL. Idempotent: stopping
   * twice (or with no stream running) succeeds, reporting stopped=false.
   */
  stopLeaseStream(leaseId: string): Promise<{ lease: Lease; stopped: boolean }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      const hadStream = found.streamUrl !== undefined;
      const streamer = deviceKindOf(found) === "real" ? this.realStreamer : this.streamer;
      if (streamer) await streamer.stopStream(found.udid);
      const lease = await this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === leaseId);
        if (!rec) throw new LeaseError(`Unknown lease ${leaseId}`);
        delete rec.streamUrl;
        delete rec.streamPort;
        return { value: { ...rec }, dirty: true };
      });
      return { lease, stopped: hadStream };
    });
  }

  /** Kind-routed streamer for explicit starts; throws when the arm is unconfigured. */
  private streamerFor(kind: DeviceKind): StreamOps {
    const streamer = kind === "real" ? this.realStreamer : this.streamer;
    if (!streamer) {
      throw new LeaseError(
        kind === "real"
          ? "Live streaming is unavailable: no real streamer is configured"
          : "Live streaming is unavailable: no streamer is configured",
      );
    }
    return streamer;
  }

  /** Start the requested stream for a fresh acquire; failures become warnings, never errors. */
  private async maybeStartStream(lease: Lease, wantStream: boolean, warnings: string[]): Promise<void> {
    if (!wantStream) return;
    const kind = deviceKindOf(lease);
    const streamer = kind === "real" ? this.realStreamer : this.streamer;
    if (!streamer) {
      warnings.push(
        kind === "real"
          ? "Stream requested but no real streamer is configured; continuing without a live stream"
          : "Stream requested but no streamer is configured; continuing without a live stream",
      );
      return;
    }
    try {
      const { url, port } = await streamer.startStream(lease.udid, { portBase: this.streamPortBase });
      lease.streamUrl = url;
      lease.streamPort = port;
      await this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === lease.leaseId);
        if (rec) {
          rec.streamUrl = url;
          rec.streamPort = port;
        }
        return { value: undefined, dirty: true };
      });
    } catch (err) {
      warnings.push(`Live stream failed to start, continuing without one: ${(err as Error).message}`);
    }
  }

  /** Start the requested stream for a dispatched ticket; failures land on the assignment. */
  private async startDispatchedStream(
    leaseId: string,
    udid: string,
    assignment: DispatchAssignment,
    kind: DeviceKind,
  ): Promise<void> {
    const streamer = kind === "real" ? this.realStreamer : this.streamer;
    if (!streamer) {
      assignment.streamError = kind === "real" ? "no real streamer is configured" : "no streamer is configured";
      return;
    }
    try {
      const { url, port } = await streamer.startStream(udid, { portBase: this.streamPortBase });
      assignment.streamUrl = url;
      await this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === leaseId);
        if (rec) {
          rec.streamUrl = url;
          rec.streamPort = port;
        }
        return { value: undefined, dirty: true };
      });
    } catch (err) {
      assignment.streamError = (err as Error).message;
    }
  }

  /** Best-effort stream teardown for release/sweep/expire paths; never throws. */
  private async stopStreamQuiet(udid: string, kind: DeviceKind): Promise<void> {
    const streamer = kind === "real" ? this.realStreamer : this.streamer;
    if (!streamer) return;
    try {
      await streamer.stopStream(udid);
    } catch (err) {
      console.error(`[orchestrator] Failed to stop stream for ${udid}: ${(err as Error).message}`);
    }
  }

  // ---------- per-lease debug sessions ----------

  /**
   * Record an llmdb session id against a lease (one session per lease; a
   * re-attach replaces the previous id). Returns the replaced id, if any, so
   * the caller can best-effort stop it.
   */
  setDebugSession(leaseId: string, sessionId: string): Promise<string | null> {
    return this.mutex.run(async () =>
      this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === leaseId);
        if (!rec) throw new LeaseError(`Unknown lease ${leaseId}`);
        const previous = rec.debugSessionId ?? null;
        rec.debugSessionId = sessionId;
        return { value: previous, dirty: true };
      }),
    );
  }

  /**
   * Clear the recorded debug session for a lease. Returns the cleared id, if
   * any. Bookkeeping only — the caller stops the llmdb session itself.
   */
  clearDebugSession(leaseId: string): Promise<string | null> {
    return this.mutex.run(async () =>
      this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === leaseId);
        if (!rec) throw new LeaseError(`Unknown lease ${leaseId}`);
        const previous = rec.debugSessionId ?? null;
        delete rec.debugSessionId;
        return { value: previous, dirty: previous !== null };
      }),
    );
  }

  /**
   * Best-effort timeout cleanup for one lease's debug session: stops the
   * recorded llmdb session via the shared stopDebugQuiet path and clears the
   * bookkeeping, so a timed-out cont/wait/interrupt never leaks a wedged
   * session. Never throws: unknown leases, missing sessions, id mismatches,
   * and a missing debugger report stopped=false and keep the record (nothing
   * is cleared that was not stopped).
   */
  autoStopDebugSession(leaseId: string, sessionId?: string): Promise<{ stopped: boolean; sessionId: string | null }> {
    return this.mutex.run(async () => {
      const recorded = await this.store.read(
        (s) => s.leases.find((l) => l.leaseId === leaseId)?.debugSessionId ?? null,
      );
      if (recorded === null) return { stopped: false, sessionId: null };
      if (sessionId !== undefined && sessionId !== recorded) {
        return { stopped: false, sessionId: recorded };
      }
      if (!this.debugger) return { stopped: false, sessionId: recorded };
      await this.stopDebugQuiet(recorded);
      await this.store.mutate((s) => {
        const rec = s.leases.find((l) => l.leaseId === leaseId);
        if (rec && rec.debugSessionId === recorded) delete rec.debugSessionId;
        return { value: undefined, dirty: true };
      });
      return { stopped: true, sessionId: recorded };
    });
  }

  /** Best-effort debug detach for release/sweep/expire paths; never throws. */
  private async stopDebugQuiet(sessionId: string | undefined): Promise<void> {
    if (!sessionId || !this.debugger) return;
    try {
      await this.debugger.stop(sessionId);
    } catch (err) {
      console.error(`[orchestrator] Failed to stop debug session ${sessionId}: ${(err as Error).message}`);
    }
  }

  // ---------- per-lease network proxy (mitm; the host proxy is global) ----------

  /**
   * Start HTTPS interception for a lease: install the mitm CA in the leased
   * sim, start mitmdump on a scanned port, and point the host proxy at it.
   * Idempotent for the holding lease; a different lease gets a ProxyBusyError
   * naming the holding session (one holder at a time — the host proxy is global).
   */
  startLeaseProxy(
    leaseId: string,
    rules: NetProxyRule[],
    opts?: { blockQuic?: boolean },
  ): Promise<{ lease: Lease; port: number; pid?: number; quicBlocked: boolean }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netProxy) throw new LeaseError("Network proxy is unavailable: no proxy is configured");
      const { port, pid } = await this.netProxy.startProxy(found.udid, { leaseId, sessionId: found.sessionId }, rules, opts);
      // Report ACTUAL state, not the request echo: a holding lease's re-start
      // is idempotent and ignores new opts.
      return { lease: found, port, pid, quicBlocked: this.netProxy.proxyStatus().quicBlocked === true };
    });
  }

  /**
   * Replace the rewrite rules of the running proxy. Only the holding lease
   * may set rules; anything else gets a ProxyBusyError naming the holder.
   */
  setLeaseProxyRules(leaseId: string, rules: NetProxyRule[]): Promise<{ lease: Lease }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netProxy) throw new LeaseError("Network proxy is unavailable: no proxy is configured");
      await this.netProxy.setProxyRules(leaseId, rules);
      return { lease: found };
    });
  }

  /**
   * Stop the proxy and restore the host proxy snapshot. Idempotent: stopping
   * twice (or with no proxy running) succeeds, reporting stopped=false.
   * Only the holding lease may stop — anything else gets a ProxyBusyError
   * naming the holder.
   */
  stopLeaseProxy(leaseId: string): Promise<{ lease: Lease; stopped: boolean; flowLogPath?: string }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netProxy) return { lease: found, stopped: false };
      const { stopped, flowLogPath } = await this.netProxy.stopProxy(leaseId);
      return { lease: found, stopped, ...(flowLogPath !== undefined ? { flowLogPath } : {}) };
    });
  }

  startLeaseCapture(leaseId: string, spec: CaptureStartSpec): Promise<{ lease: Lease; pid: number; pcapPath: string }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netCapture) throw new LeaseError("Packet capture is unavailable: no capture is configured");
      const { pid, pcapPath } = await this.netCapture.startCapture(leaseId, { ...spec, sessionId: found.sessionId, udid: found.udid });
      return { lease: found, pid, pcapPath };
    });
  }

  stopLeaseCapture(leaseId: string): Promise<{ lease: Lease } & CaptureStopResult> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netCapture) return { lease: found, stopped: false };
      const result = await this.netCapture.stopCapture(leaseId);
      return { lease: found, ...result };
    });
  }

  leaseCaptureStatus(leaseId: string): Promise<{ lease: Lease } & CaptureStatus> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netCapture) return { lease: found, running: false };
      return { lease: found, ...this.netCapture.captureStatus() };
    });
  }

  /**
   * Poll the holding proxy's flow log for matching requests. Only the
   * holding lease may assert; anything else gets a ProxyBusyError (or the
   * not-running error) naming the holder.
   */
  assertLeaseFlow(leaseId: string, spec: AssertFlowSpec): Promise<{ lease: Lease } & AssertFlowResult> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netProxy) throw new LeaseError("Network proxy is unavailable: no proxy is configured");
      const result = await this.netProxy.assertFlow(leaseId, spec);
      return { lease: found, ...result };
    });
  }

  /**
   * Insert or replace one map rule (map_local/map_remote). Only the holding
   * lease may map; the rule is validated before the holder check so a bad
   * file/URL/regex fails without needing a running proxy.
   */
  upsertLeaseMapRule(leaseId: string, rule: NetProxyRule): Promise<{ lease: Lease; ruleCount: number }> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      if (!this.netProxy) throw new LeaseError("Network proxy is unavailable: no proxy is configured");
      const ruleCount = await this.netProxy.upsertMapRule(leaseId, rule);
      return { lease: found, ruleCount };
    });
  }

  /** Global proxy state (any valid lease may view it), including the holder when running. */
  leaseProxyStatus(leaseId: string): Promise<{ lease: Lease } & NetProxyStatus> {
    return this.mutex.run(async () => {
      const found = await this.store.read((s) => s.leases.find((l) => l.leaseId === leaseId));
      if (!found) throw new LeaseError(`Unknown lease ${leaseId}`);
      const status = this.netProxy?.proxyStatus() ?? { running: false as const };
      return { lease: found, ...status };
    });
  }

  /**
   * Best-effort proxy teardown for release/sweep/expire paths; never throws
   * (and never fails the release). Only the holder's own teardown stops the
   * proxy — other leases' releases leave it running.
   */
  private async stopProxyQuiet(leaseId: string): Promise<void> {
    if (!this.netProxy) return;
    const status = this.netProxy.proxyStatus();
    if (!status.running || status.leaseId !== leaseId) return;
    try {
      await this.netProxy.stopProxy(leaseId);
    } catch (err) {
      console.error(`[orchestrator] Failed to stop network proxy for ${leaseId}: ${(err as Error).message}`);
    }
  }

  /**
   * Best-effort capture teardown for release/sweep/expire paths; never throws
   * (and never fails the release). Only the holder's own teardown stops the
   * capture — other leases' releases leave it running.
   */
  private async stopCaptureQuiet(leaseId: string): Promise<void> {
    if (!this.netCapture) return;
    const status = this.netCapture.captureStatus();
    if (!status.running || status.leaseId !== leaseId) return;
    try {
      // Skip the readback summary: this runs under the global mutex on every
      // release path and the result would be discarded anyway.
      await this.netCapture.stopCapture(leaseId, { summarize: false });
    } catch (err) {
      console.error(`[orchestrator] Failed to stop packet capture for ${leaseId}: ${(err as Error).message}`);
    }
  }

  /**
   * Best-effort slim; failures become a warning string, never a throw.
   * Returns the slim-step wall time plus the post-step slim class for LW0
   * telemetry (slimMs is -1 when the step was skipped, never attempted).
   */
  private async trySlim(udid: string, except?: string): Promise<{ warn: string | null; slimMs: number; slim: SlimClass }> {
    const t0 = Date.now();
    try {
      const status = await this.fleet.slimStatus(udid);
      // Only a stock sim (nothing disabled) is auto-slimmed. A partially
      // slimmed sim keeps its custom profile: re-slimming could disable
      // daemons its owner deliberately kept (e.g. --except store for push).
      if (!status || status.managedDisabled > 0) return { warn: null, slimMs: -1, slim: classifySlim(status) };
      await this.fleet.slimNoReboot(udid, except ? { except } : undefined);
      return { warn: null, slimMs: Date.now() - t0, slim: "slim" };
    } catch (err) {
      return {
        warn: `Slimming ${udid} failed, continuing stock: ${(err as Error).message}`,
        slimMs: Date.now() - t0,
        // The step may have partially disabled daemons; its outcome was not observed.
        slim: "unknown",
      };
    }
  }
}
