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

