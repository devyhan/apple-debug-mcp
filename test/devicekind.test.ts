import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deviceKindOf, isRealLease, requireSimLease } from "../src/devicekind.js";
import type { RealDevicePhase } from "../src/devicekind.js";
import type { Lease } from "../src/store.js";
import { Store } from "../src/store.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-devicekind-")), "state.json");
}

function lease(kind: Lease["deviceKind"]): Lease {
  return {
    leaseId: "lease_test_1", udid: "UDID-1", sessionId: "s1", client: "vitest",
    createdAt: 1, lastHeartbeat: Date.now(), ttlMs: 60_000, deviceKind: kind,
  };
}

describe("deviceKindOf / isRealLease", () => {
  it("reads explicit kinds", () => {
    expect(deviceKindOf(lease("sim"))).toBe("sim");
    expect(deviceKindOf(lease("real"))).toBe("real");
    expect(isRealLease(lease("sim"))).toBe(false);
    expect(isRealLease(lease("real"))).toBe(true);
  });

  it("treats a missing deviceKind as sim (tolerant read)", () => {
    const legacy = { leaseId: "l", udid: "U" } as Pick<Lease, "deviceKind">;
    expect(deviceKindOf(legacy)).toBe("sim");
    expect(isRealLease(legacy)).toBe(false);
  });
});

describe("requireSimLease", () => {
  it("is a no-op for sim leases", () => {
    expect(() => requireSimLease(lease("sim"), { verb: "ui_tap", phase: "P2", detail: "x" })).not.toThrow();
  });

  // One verb per still-gated fail-fast group (P1 promoted 7 verbs to GO —
  // app_install/uninstall/launch/terminate, sim_log_stream/show, profile_trace;
  // those are covered by dispatch tests, not this table).
  const cases: { verb: string; phase: RealDevicePhase; token: string }[] = [
    { verb: "ui_tap", phase: "P2", token: "P2" },
    { verb: "app_open_url", phase: "P2", token: "P2" },
    { verb: "app_cache_clear", phase: "P2", token: "P2" },
    { verb: "debug_attach", phase: "P3", token: "P3" },
    { verb: "stream_start", phase: "P3", token: "P3" },
    { verb: "net_proxy_start", phase: "P4", token: "P4" },
    { verb: "sim_shutdown", phase: "sim-only", token: "sim-only" },
    { verb: "camera_mirror", phase: "sim-only", token: "sim-only" },
  ];
  for (const { verb, phase, token } of cases) {
    it(`names verb, lease, udid and phase for ${verb}`, () => {
      const real = lease("real");
      let message = "";
      try {
        requireSimLease(real, { verb, phase, detail: "test detail" });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(verb);
      expect(message).toContain(real.leaseId);
      expect(message).toContain(real.udid);
      expect(message).toContain(token);
    });
  }
});

describe("Store.load migration", () => {
  it("defaults leases without deviceKind to sim", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      seq: 1,
      leases: [{
        leaseId: "lease_old", udid: "U1", sessionId: "s", client: "c",
        createdAt: 1, lastHeartbeat: Date.now(), ttlMs: 60_000,
      }],
      tickets: [],
    }));
    const store = Store.load(file);
    const leases = await store.read((s) => s.leases);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.deviceKind).toBe("sim");
  });

  it("preserves explicit real leases", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      seq: 1, leases: [{ ...lease("real"), transport: "usb" }], tickets: [],
    }));
    const store = Store.load(file);
    const leases = await store.read((s) => s.leases);
    expect(leases[0]?.deviceKind).toBe("real");
    expect(leases[0]?.transport).toBe("usb");
  });

  it("fails closed on unknown deviceKind values (fresh state + stderr note)", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      seq: 1, leases: [{ ...lease("sim"), deviceKind: "hologram" }], tickets: [],
    }));
    const store = Store.load(file);
    expect(await store.read((s) => s.leases)).toHaveLength(0);
    expect(await store.read((s) => s.seq)).toBe(0);
  });
});

