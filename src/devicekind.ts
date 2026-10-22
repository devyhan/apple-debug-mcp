import type { Lease } from "./store.js";

export type DeviceKind = "sim" | "real";
export type DeviceTransport = "usb" | "wifi";

export type RealDevicePhase = "P1" | "P2" | "P3" | "P4" | "sim-only";

/** undefined ≡ "sim": tolerant read for in-flight/hand-built leases. */
export function deviceKindOf(lease: Pick<Lease, "deviceKind">): DeviceKind {
  return lease.deviceKind ?? "sim";
}

export function isRealLease(lease: Pick<Lease, "deviceKind">): boolean {
  return deviceKindOf(lease) === "real";
}

/** Throw an actionable error when the lease is real-kind. No-op for sim. */
export function requireSimLease(
  lease: Lease,
  opts: { verb: string; phase: RealDevicePhase; detail: string },
): void {
  if (!isRealLease(lease)) return;
  const where = opts.phase === "sim-only"
    ? "this verb is sim-only by design and has no real-device equivalent"
    : `real-device support lands in ${opts.phase} (${opts.detail})`;
  throw new Error(
    `${opts.verb} does not support real-device leases yet: ${where}. ` +
    `Lease ${lease.leaseId} holds real device ${lease.udid}. ` +
    `Acquire a simulator lease (device_kind "sim", the default) to use ${opts.verb}.`,
  );
}

export const REAL_LEASE_ENV = "SIM_MCP_REAL_LEASE";

/**
 * Experimental-hatch gate: `SIM_MCP_REAL_LEASE=1` allows constructing real-kind
 * leases with an explicit udid for live observability of the P0 fail-fast
 * errors. Default OFF. Fail-soft like the other env gates. P1 deletes this.
 */
export function allowRealLease(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return env[REAL_LEASE_ENV] === "1";
  } catch {
    return false;
  }
}
