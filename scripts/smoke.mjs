// Committed CI smoke test: boots a real simulator through the daemon and
// exercises acquire → queue → ui ops → release → auto-dispatch → shutdown.
// Run from the repo root after `npm run build`: `node scripts/smoke.mjs`.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.SMOKE_PORT ?? "3210";
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const STATE_FILE = process.env.SMOKE_STATE_FILE ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-mcp-ci-")), "state.json");
const DEVICE_SUBSTR = (process.env.SMOKE_DEVICE_SUBSTR ?? "iPhone").toLowerCase();

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function fail(msg) {
  throw new Error(msg);
}

async function waitForHealth(timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) fail("daemon did not become healthy in time");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function startDaemon() {
  const entry = path.join(ROOT, "dist", "index.js");
  if (!fs.existsSync(entry)) fail("dist/index.js missing — run `npm run build` first");
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, SIM_MCP_PORT: PORT, SIM_MCP_STATE_FILE: STATE_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[daemon] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  return child;
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const start = Date.now();
  while (child.exitCode === null && Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function connect(name) {
  const client = new Client({ name, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE)));
  return client;
}

async function call(client, tool, args) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return {
    isError: result.isError === true,
    json: JSON.parse(text),
    hasImage: result.content.some((c) => c.type === "image"),
  };
}

// Raw variant: zod input failures arrive as plain-text errors, not {ok:false} JSON.
async function callRaw(client, tool, args) {
  const result = await client.callTool({ name: tool, arguments: args });
  return {
    isError: result.isError === true,
    text: result.content.find((c) => c.type === "text")?.text ?? "",
  };
}

function expectOk(res, what) {
  if (res.isError || res.json.ok !== true) {
    fail(`${what} failed: ${JSON.stringify(res.json).slice(0, 500)}`);
  }
}

// GET an infinite MJPEG stream just long enough to prove frames flow.
async function fetchStreamHead(url) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  try {
    const reader = res.body.getReader();
    try {
      await reader.read();
    } finally {
      controller.abort();
      try { await reader.cancel(); } catch { /* aborted */ }
    }
  } catch (err) {
    if (err?.name !== "AbortError") throw err;
  }
  return { status, contentType };
}

async function main() {
  const daemon = startDaemon();
  try {
    await waitForHealth();
    log("daemon healthy");

    const a = await connect("smoke-a");
    const b = await connect("smoke-b");

    const pool = await call(a, "pool_status", {});
    expectOk(pool, "pool_status");
    const target = pool.json.simulators
      .filter((s) => s.name.toLowerCase().includes(DEVICE_SUBSTR))
      .sort((x, y) => Number(x.state === "Booted") - Number(y.state === "Booted"))[0];
    if (!target) fail(`no simulator matching ${DEVICE_SUBSTR}`);
    const udid = target.udid;
    log(`target: ${target.name} (${udid}, ${target.state})`);

    // serve-sim is an optional dependency: gate streaming + rotate assertions on it.
    let haveServeSim = true;
    try {
      execSync("which serve-sim", { stdio: "ignore" });
    } catch {
      haveServeSim = false;
    }

    // llmdb is likewise optional: attach-failure assertions expect the install
    // hint instead when the binary is absent.
    let haveLlmdb = true;
    try {
      execSync("which llmdb", { stdio: "ignore" });
    } catch {
      haveLlmdb = false;
    }

    const leaseA = await call(a, "lease_acquire", {
      session_id: "ci-smoke-a", client: "ci", task: "ci smoke", udid, slim: true, stream: true,
    });
    expectOk(leaseA, "lease_acquire A");
    if (leaseA.json.queued) fail("A should have received a lease, not a ticket");
    log(`A leased ${leaseA.json.lease.leaseId}`);

    if (haveServeSim) {
      const streamUrl = leaseA.json.lease.streamUrl;
      if (typeof streamUrl !== "string" || !streamUrl.includes("/stream.mjpeg")) {
        fail(`expected lease.streamUrl, got ${JSON.stringify(leaseA.json.lease)}`);
      }
      log(`A streaming at ${streamUrl} (port ${leaseA.json.lease.streamPort})`);
      const head = await fetchStreamHead(streamUrl);
      if (head.status !== 200) fail(`stream GET status ${head.status}`);
      if (!/multipart|video/i.test(head.contentType)) fail(`stream content-type ${head.contentType}`);
      log(`stream GET ok (${head.contentType}, first frame received)`);

      const stop1 = await call(a, "stream_stop", { lease_id: leaseA.json.lease.leaseId });
      expectOk(stop1, "stream_stop");
      if (stop1.json.stopped !== true) fail("stream_stop should report stopped=true");
      const stop2 = await call(a, "stream_stop", { lease_id: leaseA.json.lease.leaseId });
      expectOk(stop2, "stream_stop idempotent");
      if (stop2.json.stopped !== false) fail("second stream_stop should report stopped=false");
      const restart = await call(a, "stream_start", { lease_id: leaseA.json.lease.leaseId });
      expectOk(restart, "stream_start");
      if (typeof restart.json.url !== "string") fail("stream_start returned no url");
      log(`stream restart ok: ${restart.json.url}`);
    } else {
      log("SKIP streaming assertions: serve-sim not on PATH");
    }

    const sessions = await call(b, "sessions_list", {});
    expectOk(sessions, "sessions_list");
    if (!sessions.json.sessions.some((s) => s.sessionId === "ci-smoke-a")) {
      fail("A's session missing from sessions_list");
    }

    const ticketB = await call(b, "lease_acquire", {
      session_id: "ci-smoke-b", client: "ci", task: "waiter", udid, auto_boot: false,
    });
    expectOk(ticketB, "lease_acquire B");
    if (!ticketB.json.queued) fail("B should have queued");
    log(`B queued at position ${ticketB.json.position}`);

    const ui = await call(a, "ui_describe", { lease_id: leaseA.json.lease.leaseId, max_chars: 1000 });
    expectOk(ui, "ui_describe");
    if (typeof ui.json.ui !== "string" || ui.json.ui.length < 10) fail("ui_describe returned no hierarchy");

    const shot = await call(a, "ui_screenshot", { lease_id: leaseA.json.lease.leaseId });
    expectOk(shot, "ui_screenshot");
    if (!shot.hasImage) fail("ui_screenshot returned no image");

    if (haveServeSim) {
      // The sim is leased to A, so force is required (no session identity on this tool).
      const rot = await call(a, "sim_rotate", { udid, orientation: "portrait", force: true });
      expectOk(rot, "sim_rotate");
      log("sim_rotate ok");

      // No camera started: status must report the idle {alive:false} shape.
      // Full start/switch E2E needs a debuggable (get-task-allow) app, which
      // CI does not have, so no app relaunch is attempted here.
      const cam = await call(a, "camera_status", { udid });
      expectOk(cam, "camera_status");
      if (cam.json.alive !== false) fail(`expected camera alive=false, got ${JSON.stringify(cam.json)}`);
      log("camera_status ok (alive:false, no camera started)");
    } else {
      log("SKIP sim_rotate: serve-sim not on PATH");
    }

    // Log capture only needs xcrun, so it always runs. Marker-based: launch the
    // stock Settings app mid-window and require its process name in the output.
    // process-filtered so the tail-kept window deterministically contains the marker
    // (unfiltered info-level volume would push a mid-window marker out of the cap).
    const streamP = call(a, "sim_log_stream", { udid, timeout_sec: 10, level: "info", process: "Preferences" });
    await new Promise((r) => setTimeout(r, 2000));
    execSync(`xcrun simctl launch ${udid} com.apple.Preferences`, { stdio: "pipe" });
    const stream = await streamP;
    expectOk(stream, "sim_log_stream");
    if (typeof stream.json.log !== "string" || !stream.json.log.includes("Preferences")) {
      fail("sim_log_stream missing the Preferences launch marker");
    }
    if (stream.json.timedOut !== true) fail("sim_log_stream should report timedOut=true");
    const show = await call(a, "sim_log_show", { udid, last: "5m", process: "Preferences", info: true });
    expectOk(show, "sim_log_show");
    if (typeof show.json.log !== "string" || !show.json.log.includes("Preferences")) {
      fail("sim_log_show missing the Preferences marker");
    }
    log("sim_log_stream + sim_log_show ok (Preferences marker present)");

    // App lifecycle tools (all lease-gated, stock Apple apps only).
    const launched = await call(a, "app_launch", {
      lease_id: leaseA.json.lease.leaseId, bundle_id: "com.apple.Preferences",
    });
    expectOk(launched, "app_launch");
    if (typeof launched.json.pid !== "number" || launched.json.pid <= 0) {
      fail(`app_launch returned no pid: ${JSON.stringify(launched.json)}`);
    }
    const terminated = await call(a, "app_terminate", {
      lease_id: leaseA.json.lease.leaseId, bundle_id: "com.apple.Preferences",
    });
    expectOk(terminated, "app_terminate");
    const opened = await call(a, "app_open_url", {
      lease_id: leaseA.json.lease.leaseId, url: "https://www.apple.com",
    });
    expectOk(opened, "app_open_url");
    // terminate fails with "found nothing to terminate" unless the app is
    // running, so (re)launch Safari explicitly instead of relying on the
    // openurl side effect.
    const safariUp = await call(a, "app_launch", {
      lease_id: leaseA.json.lease.leaseId, bundle_id: "com.apple.mobilesafari",
    });
    expectOk(safariUp, "app_launch Safari");
    const safariDown = await call(a, "app_terminate", {
      lease_id: leaseA.json.lease.leaseId, bundle_id: "com.apple.mobilesafari",
    });
    expectOk(safariDown, "app_terminate Safari");
    log(`app_launch (pid ${launched.json.pid}) + app_terminate + app_open_url ok`);

    // app_install has no CI-safe live artifact (nothing to install without a
    // third-party .app), so assert lease resolution + simctl error surfacing
    // via a missing path. app_uninstall is idempotent in simctl (unknown
    // bundle exits 0), so assert ok-shape there plus lease gating instead.
    const badInstall = await call(a, "app_install", {
      lease_id: leaseA.json.lease.leaseId, app_path: "/nonexistent/ci-smoke.app",
    });
    if (!badInstall.isError) fail("app_install of a missing .app should fail");
    const idemUninstall = await call(a, "app_uninstall", {
      lease_id: leaseA.json.lease.leaseId, bundle_id: "com.example.ci-smoke-does-not-exist",
    });
    expectOk(idemUninstall, "app_uninstall idempotent");
    const gatedUninstall = await call(a, "app_uninstall", {
      lease_id: "lease_nope", bundle_id: "com.example.App",
    });
    if (!gatedUninstall.isError || !/unknown lease/i.test(JSON.stringify(gatedUninstall.json))) {
      fail(`app_uninstall should reject an unknown lease: ${JSON.stringify(gatedUninstall.json)}`);
    }
    log("app_install + app_uninstall wiring ok");

    // profile_trace: live sim-device xctrace recording hangs after "Starting
    // recording..." on this host family (host-side recording verified working),
    // so CI must not invoke a real recording. Assert the full MCP path (lease
    // resolve + validation, no xctrace spawn) via a blank template instead.
    const badTrace = await call(a, "profile_trace", {
      lease_id: leaseA.json.lease.leaseId, template: "  ",
    });
    if (!badTrace.isError || !/template/i.test(JSON.stringify(badTrace.json))) {
      fail(`profile_trace validation failed: ${JSON.stringify(badTrace.json)}`);
    }
    log("profile_trace validation ok (no live recording in CI)");

    // debug_* tools: validation paths ONLY. A live attach is impossible here:
    // it needs a debuggable (get-task-allow) third-party app plus the host's
    // one-time Developer-Tools authorization (not granted on CI hosts), and
    // stock Apple apps refuse attach — so assert gating + error surfacing only.
    const dbgGated = await call(a, "debug_bt", { lease_id: "lease_nope" });
    if (!dbgGated.isError || !/unknown lease/i.test(JSON.stringify(dbgGated.json))) {
      fail(`debug_bt should reject an unknown lease: ${JSON.stringify(dbgGated.json)}`);
    }
    const dbgMode = await callRaw(a, "debug_step", {
      lease_id: leaseA.json.lease.leaseId, mode: "sideways",
    });
    if (!dbgMode.isError || !/Invalid arguments|mode/i.test(dbgMode.text)) {
      fail(`debug_step should reject an invalid mode: ${dbgMode.text.slice(0, 300)}`);
    }
    const dbgNoSession = await call(a, "debug_break", {
      lease_id: leaseA.json.lease.leaseId, file: "a.swift", line: 1,
    });
    if (!dbgNoSession.isError || !/no debug session/i.test(JSON.stringify(dbgNoSession.json))) {
      fail(`debug_break should require an attached session: ${JSON.stringify(dbgNoSession.json)}`);
    }
    // llmdb resolves the pid before any host auth, so a bogus pid fails fast
    // with the adapter error and no sim interaction.
    const dbgAttach = await call(a, "debug_attach", {
      lease_id: leaseA.json.lease.leaseId, pid: 99999999,
    });
    if (haveLlmdb) {
      if (!dbgAttach.isError || !/attach failed|no process/i.test(JSON.stringify(dbgAttach.json))) {
        fail(`debug_attach failure should surface cleanly: ${JSON.stringify(dbgAttach.json)}`);
      }
    } else if (!dbgAttach.isError || !/llmdb is not installed|LLMDB_BIN/i.test(JSON.stringify(dbgAttach.json))) {
      fail(`debug_attach should hint at the missing binary: ${JSON.stringify(dbgAttach.json)}`);
    }
    const dbgDetach = await call(a, "debug_detach", { lease_id: leaseA.json.lease.leaseId });
    expectOk(dbgDetach, "debug_detach idempotent");
    if (dbgDetach.json.stopped !== false) fail("debug_detach with no session should report stopped=false");

    // Round-2 debug tools: same policy (gating + validation only, no session).
    // debug_sessions/doctor need no session, so they run live when llmdb is
    // present (read-only daemon queries) and hint at the binary otherwise.
    for (const tool of ["debug_sessions", "debug_doctor"]) {
      const res = await call(a, tool, { lease_id: leaseA.json.lease.leaseId });
      if (haveLlmdb) {
        expectOk(res, tool);
      } else if (!res.isError || !/llmdb is not installed|LLMDB_BIN/i.test(JSON.stringify(res.json))) {
        fail(`${tool} should hint at the missing binary: ${JSON.stringify(res.json)}`);
      }
    }
    for (const [tool, args] of [
      ["debug_threads", {}],
      ["debug_scopes", {}],
      ["debug_expand", { ref: 3 }],
      ["debug_set_var", { target: "x", value: "1" }],
      ["debug_output", {}],
      ["debug_run_until", { file: "a.swift", line: 1 }],
      ["debug_wait", {}],
      ["debug_interrupt", {}],
      ["debug_break", { list: true }],
      ["debug_break", { delete: 1 }],
      ["debug_break", { exception: [] }],
      ["debug_bt", { thread: 2 }],
    ]) {
      const res = await call(a, tool, { lease_id: leaseA.json.lease.leaseId, ...args });
      if (!res.isError || !/no debug session/i.test(JSON.stringify(res.json))) {
        fail(`${tool} should require an attached session: ${JSON.stringify(res.json)}`);
      }
    }
    // Op dispatch is validated before the session check, so combos fail
    // deterministically without a session.
    const dbgCombo = await call(a, "debug_break", {
      lease_id: leaseA.json.lease.leaseId, file: "a.swift", line: 1, list: true,
    });
    if (!dbgCombo.isError || !/exactly one op/i.test(JSON.stringify(dbgCombo.json))) {
      fail(`debug_break should reject op combos: ${JSON.stringify(dbgCombo.json)}`);
    }
    const dbgNoPath = await callRaw(a, "debug_launch", { lease_id: leaseA.json.lease.leaseId });
    if (!dbgNoPath.isError || !/path/i.test(dbgNoPath.text)) {
      fail(`debug_launch should require a path: ${dbgNoPath.text.slice(0, 300)}`);
    }
    const dbgBadRef = await callRaw(a, "debug_expand", { lease_id: leaseA.json.lease.leaseId, ref: 0 });
    if (!dbgBadRef.isError || !/ref/i.test(dbgBadRef.text)) {
      fail(`debug_expand should reject ref 0: ${dbgBadRef.text.slice(0, 300)}`);
    }
    // llmdb resolves the launch path before any host auth, so a bogus path
    // fails fast with the adapter error and no sim interaction.
    const dbgLaunch = await call(a, "debug_launch", {
      lease_id: leaseA.json.lease.leaseId, path: "/nonexistent/ci-smoke-debug-app",
    });
    if (haveLlmdb) {
      if (!dbgLaunch.isError) fail("debug_launch of a missing binary should fail");
    } else if (!dbgLaunch.isError || !/llmdb is not installed|LLMDB_BIN/i.test(JSON.stringify(dbgLaunch.json))) {
      fail(`debug_launch should hint at the missing binary: ${JSON.stringify(dbgLaunch.json)}`);
    }
    // symbolicate is host-local (atos): lease gating + validation only, no
    // live symbolication in CI.
    const symGated = await call(a, "symbolicate", { pcs: "0x1000", binary: "/bin/ls", lease_id: "lease_nope" });
    if (!symGated.isError || !/unknown lease/i.test(JSON.stringify(symGated.json))) {
      fail(`symbolicate should reject an unknown lease: ${JSON.stringify(symGated.json)}`);
    }
    const symNoBin = await call(a, "symbolicate", { pcs: "0x1000", lease_id: leaseA.json.lease.leaseId });
    if (!symNoBin.isError || !/binary/i.test(JSON.stringify(symNoBin.json))) {
      fail(`symbolicate should require a binary: ${JSON.stringify(symNoBin.json)}`);
    }
    const symBadPc = await call(a, "symbolicate", { pcs: "not-an-address", binary: "/bin/ls" });
    if (!symBadPc.isError || !/pc/i.test(JSON.stringify(symBadPc.json))) {
      fail(`symbolicate should reject a bad pc: ${JSON.stringify(symBadPc.json)}`);
    }
    log("debug_* validation paths ok (no live attach in CI)");

    // net_proxy_*: plumbing ONLY — starting the proxy would toggle the CI
    // host's own network settings, so CI must never call net_proxy_start with
    // valid rules. Assert the stopped shape, lease gating, and pre-flight
    // rule validation (invalid rules fail before any host change) instead.
    const proxyStatus = await call(a, "net_proxy_status", { lease_id: leaseA.json.lease.leaseId });
    expectOk(proxyStatus, "net_proxy_status");
    if (proxyStatus.json.running !== false) fail(`expected proxy running=false, got ${JSON.stringify(proxyStatus.json)}`);
    const proxyGated = await call(a, "net_proxy_start", { lease_id: "lease_nope" });
    if (!proxyGated.isError || !/unknown lease/i.test(JSON.stringify(proxyGated.json))) {
      fail(`net_proxy_start should reject an unknown lease: ${JSON.stringify(proxyGated.json)}`);
    }
    const proxySetGated = await call(a, "net_proxy_set_rules", { lease_id: "lease_nope", rules: [] });
    if (!proxySetGated.isError || !/unknown lease/i.test(JSON.stringify(proxySetGated.json))) {
      fail(`net_proxy_set_rules should reject an unknown lease: ${JSON.stringify(proxySetGated.json)}`);
    }
    const proxyBadStatus = await callRaw(a, "net_proxy_start", {
      lease_id: leaseA.json.lease.leaseId, rules: [{ action: { status: 99 } }],
    });
    if (!proxyBadStatus.isError || !/status|599/i.test(proxyBadStatus.text)) {
      fail(`net_proxy_start should reject an invalid status: ${proxyBadStatus.text.slice(0, 300)}`);
    }
    const proxyBadRegex = await callRaw(a, "net_proxy_set_rules", {
      lease_id: leaseA.json.lease.leaseId, rules: [{ match: { url_regex: "(unclosed" }, action: { delay_ms: 10 } }],
    });
    if (!proxyBadRegex.isError || !/regular expression/i.test(proxyBadRegex.text)) {
      fail(`net_proxy_set_rules should reject a bad regex: ${proxyBadRegex.text.slice(0, 300)}`);
    }
    const proxyEmptyAction = await callRaw(a, "net_proxy_start", {
      lease_id: leaseA.json.lease.leaseId, rules: [{ action: {} }],
    });
    if (!proxyEmptyAction.isError || !/at least one/i.test(proxyEmptyAction.text)) {
      fail(`net_proxy_start should reject an empty action: ${proxyEmptyAction.text.slice(0, 300)}`);
    }
    const proxyStop = await call(a, "net_proxy_stop", { lease_id: leaseA.json.lease.leaseId });
    expectOk(proxyStop, "net_proxy_stop idempotent");
    if (proxyStop.json.stopped !== false) fail("net_proxy_stop with no proxy should report stopped=false");

    // Round-2 proxy tools: same policy (gating + validation only, never a
    // live interception). net_assert_flow fails cleanly with no proxy;
    // map_local validates the file before the holder check, so a missing
    // file fails without needing a running proxy.
    for (const [tool, args] of [
      ["net_assert_flow", { url_regex: "example\\.com" }],
      ["map_local", { url_regex: "example\\.com", file: "/etc/hosts" }],
      ["map_remote", { url_regex: "example\\.com", url: "https://example.com/" }],
    ]) {
      const gated = await call(a, tool, { lease_id: "lease_nope", ...args });
      if (!gated.isError || !/unknown lease/i.test(JSON.stringify(gated.json))) {
        fail(`${tool} should reject an unknown lease: ${JSON.stringify(gated.json)}`);
      }
    }
    const assertIdle = await call(a, "net_assert_flow", {
      lease_id: leaseA.json.lease.leaseId, url_regex: "example\\.com", timeout_sec: 0,
    });
    if (!assertIdle.isError || !/no network proxy is running/i.test(JSON.stringify(assertIdle.json))) {
      fail(`net_assert_flow should fail cleanly with no proxy: ${JSON.stringify(assertIdle.json)}`);
    }
    const assertRegex = await callRaw(a, "net_assert_flow", {
      lease_id: leaseA.json.lease.leaseId, url_regex: "(unclosed",
    });
    if (!assertRegex.isError || !/regular expression/i.test(assertRegex.text)) {
      fail(`net_assert_flow should reject a bad regex: ${assertRegex.text.slice(0, 300)}`);
    }
    const mapMissing = await call(a, "map_local", {
      lease_id: leaseA.json.lease.leaseId, url_regex: "example\\.com", file: "/nonexistent/ci-smoke-map-body.json",
    });
    if (!mapMissing.isError || !/map_local.*not found or unreadable/i.test(JSON.stringify(mapMissing.json))) {
      fail(`map_local should reject a missing file: ${JSON.stringify(mapMissing.json)}`);
    }
    const mapIdle = await call(a, "map_local", {
      lease_id: leaseA.json.lease.leaseId, url_regex: "example\\.com", file: "/etc/hosts",
    });
    if (!mapIdle.isError || !/no network proxy is running/i.test(JSON.stringify(mapIdle.json))) {
      fail(`map_local should fail cleanly with no proxy: ${JSON.stringify(mapIdle.json)}`);
    }
    const mapBadUrl = await callRaw(a, "map_remote", {
      lease_id: leaseA.json.lease.leaseId, url_regex: "example\\.com", url: "ftp://example.com/x",
    });
    if (!mapBadUrl.isError || !/absolute http/i.test(mapBadUrl.text)) {
      fail(`map_remote should reject a non-http URL: ${mapBadUrl.text.slice(0, 300)}`);
    }
    const mapRemoteIdle = await call(a, "map_remote", {
      lease_id: leaseA.json.lease.leaseId, url_regex: "example\\.com", url: "https://example.com/",
    });
    if (!mapRemoteIdle.isError || !/no network proxy is running/i.test(JSON.stringify(mapRemoteIdle.json))) {
      fail(`map_remote should fail cleanly with no proxy: ${JSON.stringify(mapRemoteIdle.json)}`);
    }
    // The extended rule schema (request/map fields) must pass zod and reach
    // the holder check: with no proxy running that surfaces as the
    // not-running error, never a schema error and never a host change.
    const proxyExtended = await call(a, "net_proxy_set_rules", {
      lease_id: leaseA.json.lease.leaseId,
      rules: [
        { match: { url_regex: "api\\.example\\.com" }, action: { request: { method: "post", body: "{}" } } },
        { match: { url_regex: "cdn\\.example\\.com" }, action: { map_local: "/etc/hosts" } },
        { action: { map_remote: "https://staging.example.com/" } },
      ],
    });
    if (!proxyExtended.isError || !/no network proxy is running/i.test(JSON.stringify(proxyExtended.json))) {
      fail(`net_proxy_set_rules should accept request/map rules: ${JSON.stringify(proxyExtended.json)}`);
    }
    const proxyMapCombo = await callRaw(a, "net_proxy_set_rules", {
      lease_id: leaseA.json.lease.leaseId,
      rules: [{ action: { map_local: "/etc/hosts", map_remote: "https://example.com/" } }],
    });
    if (!proxyMapCombo.isError || !/mutually exclusive/i.test(proxyMapCombo.text)) {
      fail(`net_proxy_set_rules should reject map_local+map_remote: ${proxyMapCombo.text.slice(0, 300)}`);
    }
    log("net_proxy_* plumbing ok (no host proxy changes in CI)");

    const actions = await call(a, "lease_actions", { lease_id: leaseA.json.lease.leaseId });
    expectOk(actions, "lease_actions");
    if (!Array.isArray(actions.json.actions) || actions.json.actions.length < 2) {
      fail(`expected ui actions recorded, got ${JSON.stringify(actions.json.actions)}`);
    }
    if (!actions.json.actions.some((e) => e.tool === "app_launch")) {
      fail(`expected app_launch in lease actions, got ${JSON.stringify(actions.json.actions)}`);
    }

    const rel = await call(a, "lease_release", {
      lease_id: leaseA.json.lease.leaseId, session_id: "ci-smoke-a",
    });
    expectOk(rel, "lease_release A");
    if (rel.json.dispatched?.length !== 1 || rel.json.dispatched[0].sessionId !== "ci-smoke-b") {
      fail(`expected auto-dispatch to B, got ${JSON.stringify(rel.json.dispatched)}`);
    }
    log(`auto-dispatched to B as ${rel.json.dispatched[0].leaseId}`);

    const qs = await call(b, "queue_status", { ticket_id: ticketB.json.ticket.ticketId });
    expectOk(qs, "queue_status");
    if (qs.json.ticket.status !== "assigned") fail("B ticket was not assigned");

    if (haveServeSim) {
      // A's restarted stream must die with its release; B's ticket asked for none.
      const list = JSON.parse(execSync(`serve-sim --list ${udid}`, { encoding: "utf8" }));
      if (list.running !== false) fail(`expected no serve-sim helper after release, got ${JSON.stringify(list)}`);
      log("no serve-sim helper after release (stream stopped)");
    }

    const relB = await call(b, "lease_release", {
      lease_id: rel.json.dispatched[0].leaseId, session_id: "ci-smoke-b",
    });
    expectOk(relB, "lease_release B");

    const down = await call(a, "sim_shutdown", { udid });
    expectOk(down, "sim_shutdown");

    const poolAfter = await call(a, "pool_status", {});
    expectOk(poolAfter, "pool_status after");
    const row = poolAfter.json.simulators.find((s) => s.udid === udid);
    if (!row || row.state !== "Shutdown") fail("target sim is not shut down");
    if (poolAfter.json.queue.waiting !== 0) fail("queue not drained");

    log("SMOKE OK");
  } finally {
    await stopDaemon(daemon);
  }
}

main().catch((err) => {
  console.error(`[smoke] FAILED: ${err.stack ?? err}`);
  process.exit(1);
});
