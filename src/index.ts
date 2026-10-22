#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Axe } from "./axe.js";
import { isCliCommand, runCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { Llmdb } from "./llmdb.js";
import { migrateLegacyStateDir } from "./migrate.js";
import { NetCapture } from "./netcapture.js";
import { NetProxy } from "./netproxy.js";
import { Orchestrator } from "./orchestrator.js";
import { GO_IOS_INSTALL_HINT, RealDeviceApps, RealDevices } from "./realdevices.js";
import { RealSyslog } from "./realsyslog.js";
import { RealStreamer } from "./realstream.js";
import { RealUiDriver } from "./realui.js";
import { createMcpServer } from "./server.js";
import { ServeSim } from "./servesim.js";
import { SimApps } from "./simapps.js";
import { SimLog } from "./simlog.js";
import { Simslim } from "./simslim.js";
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
} from "./singleton.js";
import { Store } from "./store.js";
import { getServerInfo } from "./version.js";
import { XCTrace } from "./xctrace.js";

async function main(): Promise<void> {
  try {
    migrateLegacyStateDir();
  } catch (err) {
    console.warn(`[sim-mcp] WARNING: legacy state migration failed: ${(err as Error).message}`);
  }
  const cliArgs = process.argv.slice(2);
  if (isCliCommand(cliArgs)) {
    process.exit(await runCli(cliArgs));
  }
  const config = loadConfig();
  const simslim = new Simslim({
    bin: config.simslimBin,
    execTimeoutMs: config.execTimeoutMs,
    bootTimeoutMs: config.bootTimeoutMs,
  });
  const axe = new Axe({ bin: config.axeBin, execTimeoutMs: config.execTimeoutMs });
  const serveSim = new ServeSim({
    bin: config.serveSimBin,
    execTimeoutMs: config.execTimeoutMs,
    portBase: config.serveSimPortBase,
  });
  const simLog = new SimLog();
  const simApps = new SimApps({ execTimeoutMs: config.execTimeoutMs });
  const xctrace = new XCTrace();
  const lldmdb = new Llmdb({ bin: config.llmdbBin, execTimeoutMs: config.execTimeoutMs });
  const netProxy = new NetProxy({
    bin: config.mitmdumpBin,
    execTimeoutMs: config.execTimeoutMs,
    portBase: config.netProxyPortBase,
  });
  const netCapture = new NetCapture({ bin: config.tcpdumpBin });
  const realDevices = new RealDevices({ execTimeoutMs: config.execTimeoutMs });
  const realApps = new RealDeviceApps({ iosBin: config.iosBin, execTimeoutMs: config.execTimeoutMs });
  const realLog = new RealSyslog({ iosBin: config.iosBin });
  const realUi = new RealUiDriver({ iosBin: config.iosBin, execTimeoutMs: config.execTimeoutMs });
  const realStreamer = new RealStreamer({ iosBin: config.iosBin });

  for (const [name, check] of [
    ["simslim", () => simslim.checkAvailable()],
    ["axe", () => axe.checkAvailable()],
  ] as const) {
    try {
      const version = await check();
      console.log(`[sim-mcp] ${name}: ${version.split("\n")[0]}`);
    } catch (err) {
      console.error(`[sim-mcp] Required binary "${name}" is not usable: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Optional dependency: the daemon starts without serve-sim; the sim_rotate /
  // sim_ca_debug / sim_memory_warning tools fail at call time with an install hint.
  try {
    const version = await serveSim.checkAvailable();
    console.log(`[sim-mcp] serve-sim: ${version.split("\n")[0]}`);
  } catch {
    console.warn(
      `[sim-mcp] WARNING: optional binary "${config.serveSimBin}" is not usable; ` +
        `sim_rotate/sim_ca_debug/sim_memory_warning will fail until it is installed (npm install -g serve-sim)`,
    );
  }

  // Optional dependency: the daemon starts without llmdb; the debug_* tools
  // fail at call time with an install hint.
  try {
    const version = await lldmdb.checkAvailable();
    console.log(`[sim-mcp] llmdb: ${version.split("\n")[0]}`);
  } catch {
    console.warn(
      `[sim-mcp] WARNING: optional binary "${config.llmdbBin}" is not usable; ` +
        `debug_* tools will fail until it is installed (brew install alexmx/tools/llmdb)`,
    );
  }

  // Optional dependency: the daemon starts without mitmdump; the net_proxy_*
  // tools fail at call time with an install hint. No sudo/networksetup probe
  // here: every -set* subcommand mutates host state, so provisioning is gated
  // at call time instead (net_proxy_start fails with a clear sudoers hint).
  try {
    const version = await netProxy.checkAvailable();
    console.log(`[sim-mcp] mitmdump: ${version.split("\n")[0]}`);
  } catch {
    console.warn(
      `[sim-mcp] WARNING: optional binary "${config.mitmdumpBin}" is not usable; ` +
        `net_proxy_* tools will fail until it is installed (brew install mitmproxy)`,
    );
  }

  // Optional dependency: the daemon starts without tcpdump; the net_capture_*
  // tools fail at call time with an install hint. Capturing itself needs
  // passwordless sudo for tcpdump, gated at call time (see net_capture_start).
  try {
    const version = await netCapture.checkAvailable();
    console.log(`[sim-mcp] tcpdump: ${version.split("\n")[0]}`);
  } catch {
    console.warn(
      `[sim-mcp] WARNING: optional binary "${config.tcpdumpBin}" is not usable; ` +
        `net_capture_* tools will fail until it is installed`,
    );
  }

  // Optional dependency: the daemon starts without devicectl; real-device
  // inventory/acquire/listRunning fail at call time with a pairing checklist.
  try {
    const version = await realDevices.checkAvailable();
    console.log(`[sim-mcp] devicectl: ${version.split("\n")[0]}`);
  } catch {
    console.warn(
      `[sim-mcp] WARNING: optional binary "xcrun devicectl" is not usable; ` +
        `real-device inventory/acquire/listRunning will fail until Xcode is installed (xcode-select --install)`,
    );
  }

  // Optional dependency: the daemon starts without go-ios; the real-lease
  // app verbs, syslog relay, ui_* and stream_* fail at call time with an install hint.
  try {
    const version = await realApps.checkAvailable();
    console.log(`[sim-mcp] ios: ${version.split("\n")[0]}`);
  } catch {
    console.warn(
      `[sim-mcp] WARNING: optional binary "${config.iosBin}" is not usable; ` +
        `app_install/app_uninstall/app_launch/app_terminate, sim_log_stream, stream_start/stream_stop and ui_screenshot/ui_describe/ui_tap/ui_type/ui_swipe/ui_button/ui_batch on real-device leases ` +
        `will fail until it is installed (${GO_IOS_INSTALL_HINT}, or set IOS_BIN)`,
    );
  }

  const store = Store.load(config.stateFile);
  const orchestrator = new Orchestrator(simslim, store, {
    defaultTtlMs: config.leaseTtlMs,
    maxSims: config.maxSims,
    streamer: serveSim,
    realStreamer,
    streamPortBase: config.serveSimPortBase,
    debugger: lldmdb,
    proxy: netProxy,
    capture: netCapture,
    apps: simApps,
    realFleet: realDevices,
    realApps,
    contaminationCheck: config.contaminationCheck,
    contaminationCheckMinIntervalMs: config.contaminationCheckMinIntervalMs,
    traceDir: config.traceDir,
  });
  const mcpDeps = { orchestrator, simslim, axe, serveSim, simLog, simApps, xctrace, lldmdb, screenshotDir: config.screenshotDir, realApps, realLog, realUi };

  // One transport (= one MCP session) per client; the Orchestrator+Store behind
  // every session is shared, so pool/lease/queue state is truly global across
  // Orca, Claude Code, TMA, scripts, etc.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function newSessionTransport(): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      // Explicit generator = stateful mode (SDK defaults to one-shot stateless).
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        console.log(`[sim-mcp] session open: ${id} (${sessions.size} active)`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        console.log(`[sim-mcp] session closed: ${id} (${sessions.size} active)`);
      },
    });
    transport.onerror = (err) => console.error(`[sim-mcp] transport error: ${err?.stack ?? err}`);
    return transport;
  }

  const startedAt = Date.now();
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              ...getServerInfo(),
              uptimeMs: Date.now() - startedAt,
              mcpSessions: sessions.size,
            }),
          );
          return;
        }
        if (url.pathname === "/mcp") {
          // Do NOT pre-read the body: the transport converts the live stream itself.
          const incomingId = req.headers["mcp-session-id"];
          const sessionId = Array.isArray(incomingId) ? incomingId[0] : incomingId;
          if (sessionId) {
            const transport = sessions.get(sessionId);
            if (!transport) {
              res.writeHead(404, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: `Unknown MCP session ${sessionId}` }));
              return;
            }
            await transport.handleRequest(req, res);
            return;
          }
          if (req.method === "POST") {
            // New client: fresh transport + server view over the shared orchestrator.
            const transport = newSessionTransport();
            await createMcpServer(mcpDeps).connect(transport);
            await transport.handleRequest(req, res);
            return;
          }
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing mcp-session-id header" }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Use POST /mcp (Streamable HTTP) or GET /health" }));
      } catch (err) {
        console.error(`[sim-mcp] request failed: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        } else {
          res.end();
        }
      }
    })();
  });

  const sweepTimer = setInterval(() => {
    void orchestrator
      .sweepStale()
      .then(({ swept, dispatched }) => {
        if (swept.length > 0 || dispatched.length > 0) {
          console.log(`[sim-mcp] sweep: released=${swept.join(",") || "-"} dispatched=${dispatched.length}`);
        }
      })
      .catch((err) => console.error(`[sim-mcp] sweep failed: ${(err as Error).message}`));
  }, config.sweepIntervalMs);
  sweepTimer.unref();

  // Singleton guard: a live lockfile means another daemon owns this state dir.
  // Never start a second daemon against the same state file (leases would split).
  const lockPath = lockFilePath(config.stateFile);
  const existing = checkNotRunning(lockPath);
  if (existing.running) {
    console.error(alreadyRunningMessage(existing.pid!));
    process.exit(EXIT_ALREADY_RUNNING);
  }

  // A second daemon on the same port (different state file) fails at bind time.
  httpServer.on("error", (err: unknown) => {
    if (isAddrInUse(err)) {
      console.error(portInUseMessage(config.port));
      process.exit(EXIT_PORT_IN_USE);
    }
    console.error(`[sim-mcp] http server error: ${(err as Error)?.message ?? err}`);
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  writeLock(lockPath, { pid: process.pid, port: config.port, startedAt: new Date().toISOString() });
  console.log(`[sim-mcp] listening on http://${config.host}:${config.port}/mcp (state: ${config.stateFile})`);

  const shutdown = () => {
    clearInterval(sweepTimer);
    removeLock(lockPath);
    // Never strands the host proxy on or a root tcpdump running: both
    // forceStops are best-effort and never throw.
    void (async () => {
      await netProxy.forceStop();
      await netCapture.forceStop();
      await realStreamer.stopAll();
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => console.error(`[sim-mcp] uncaught: ${err.stack ?? err}`));
process.on("unhandledRejection", (reason) => console.error(`[sim-mcp] unhandled rejection: ${reason}`));

main().catch((err) => {
  console.error(`[sim-mcp] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
