import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT_ALREADY_RUNNING,
  EXIT_PORT_IN_USE,
  alreadyRunningMessage,
  checkNotRunning,
  isAddrInUse,
  lockFilePath,
  portInUseMessage,
  removeLock,
  writeLock,
} from "../src/singleton.js";

describe("singleton exit codes", () => {
  it("uses distinct nonzero codes that are not 1", () => {
    expect(EXIT_PORT_IN_USE).not.toBe(1);
    expect(EXIT_ALREADY_RUNNING).not.toBe(1);
    expect(EXIT_PORT_IN_USE).not.toBe(EXIT_ALREADY_RUNNING);
  });

  it("port-in-use message names the port and points at launchd restart", () => {
    const msg = portInUseMessage(3100);
    expect(msg).toMatch(/3100/);
    expect(msg).toMatch(/already in use/);
    expect(msg).toMatch(/launchd restart/);
  });

  it("already-running message points at launchd restart", () => {
    expect(alreadyRunningMessage(1234)).toMatch(/already running.*1234/);
    expect(alreadyRunningMessage(1234)).toMatch(/launchd restart/);
  });
});

describe("EADDRINUSE detection (stubbed server)", () => {
  it("classifies EADDRINUSE errors and nothing else", () => {
    const eaddr = new Error("listen EADDRINUSE") as NodeJS.ErrnoException;
    eaddr.code = "EADDRINUSE";
    expect(isAddrInUse(eaddr)).toBe(true);
    const other = new Error("boom") as NodeJS.ErrnoException;
    other.code = "EACCES";
    expect(isAddrInUse(other)).toBe(false);
    expect(isAddrInUse(new Error("plain"))).toBe(false);
  });

  it("wires the exit path the way index.ts does: stub emits, handler exits 10", async () => {
    // Mirror of the httpServer 'error' listener in src/index.ts.
    const stub = new EventEmitter() as EventEmitter & { listen: () => void };
    let exitCode: number | null = null;
    let logged = "";
    stub.on("error", (err: unknown) => {
      if (isAddrInUse(err)) {
        logged = portInUseMessage(3100);
        exitCode = EXIT_PORT_IN_USE;
      }
    });
    const eaddr = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException;
    eaddr.code = "EADDRINUSE";
    stub.emit("error", eaddr);
    expect(exitCode).toBe(10);
    expect(logged).toMatch(/already in use/);
  });

  it("a real second bind surfaces EADDRINUSE", async () => {
    const first = http.createServer();
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const port = (first.address() as { port: number }).port;
    const second = http.createServer();
    const err = await new Promise<NodeJS.ErrnoException>((resolve) =>
      second.on("error", resolve).listen(port, "127.0.0.1"),
    );
    expect(isAddrInUse(err)).toBe(true);
    first.close();
    second.close();
  });
});

describe("lockfile", () => {
  function tmpState(): { stateFile: string; lockPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-lock-"));
    const stateFile = path.join(dir, "state.json");
    return { stateFile, lockPath: lockFilePath(stateFile) };
  }

  it("sits next to the state file", () => {
    expect(lockFilePath("/a/b/state.json")).toBe(path.join("/a", "b", "daemon.lock"));
  });

  it("reports not-running when the lock is missing", () => {
    const { lockPath } = tmpState();
    expect(checkNotRunning(lockPath)).toEqual({ running: false });
  });

  it("reports running for a live pid and clears stale locks", () => {
    const { lockPath } = tmpState();
    writeLock(lockPath, { pid: process.pid, port: 3100, startedAt: new Date().toISOString() });
    expect(checkNotRunning(lockPath)).toEqual({ running: true, pid: process.pid });

    // Dead pid (assume nothing uses 2^30-1) → stale, removed.
    writeLock(lockPath, { pid: 1073741823, port: 3100, startedAt: "" });
    expect(checkNotRunning(lockPath)).toEqual({ running: false });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("removeLock only removes its own pid's lock", () => {
    const { lockPath } = tmpState();
    writeLock(lockPath, { pid: 999999999, port: 3100, startedAt: "" });
    removeLock(lockPath, process.pid);
    expect(fs.existsSync(lockPath)).toBe(true);
    writeLock(lockPath, { pid: process.pid, port: 3100, startedAt: "" });
    removeLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
