import { describe, expect, it } from "vitest";
import {
  PROXY_CAPTURE_BODIES_ENV,
  buildAddon,
  parseFlowLog,
  proxyCaptureBodiesEnabled,
} from "../src/netproxy.js";

// Binding P1 DECISION regression guard (improvement-research P1, proxy observability):
// metadata rows ON by default; body capture OFF by default behind an env gate
// plumbed via an addon template literal; old 3-field rows still parse;
// the addon logging path never throws.
describe("P1 observability binding", () => {
  it("logs metadata rows by default while body capture stays OFF", () => {
    const addon = buildAddon([], { flowLogPath: "/tmp/f.jsonl" });
    // Metadata rows are unconditional: request/response hooks always write.
    expect(addon).toContain('"phase": "request"');
    expect(addon).toContain('"phase": "response"');
    expect(addon).toContain('"flow_id"');
    // Bodies default OFF via the embedded literal.
    expect(addon).toContain("CAPTURE_BODIES = False");
    expect(addon).toContain("if not CAPTURE_BODIES or not FLOW_LOG:\n        return False");
  });

  it("gates body capture behind the env flag via the template literal", () => {
    expect(PROXY_CAPTURE_BODIES_ENV).toBe("SIM_MCP_PROXY_CAPTURE_BODIES");
    expect(proxyCaptureBodiesEnabled({})).toBe(false);
    expect(proxyCaptureBodiesEnabled({ [PROXY_CAPTURE_BODIES_ENV]: "1" })).toBe(true);
    expect(buildAddon([], { captureBodies: true })).toContain("CAPTURE_BODIES = True");
    // Only an explicit "1" enables; anything else stays OFF.
    expect(proxyCaptureBodiesEnabled({ [PROXY_CAPTURE_BODIES_ENV]: "true" })).toBe(false);
  });

  it("still parses old 3-field rows", () => {
    expect(parseFlowLog('{"ts": 1.5, "method": "GET", "url": "https://example.com/a"}\n')).toEqual([
      { ts: 1.5, method: "GET", url: "https://example.com/a" },
    ]);
  });

  it("never throws on the addon logging path", () => {
    const addon = buildAddon([], { flowLogPath: "/tmp/f.jsonl" });
    // Every hook entry funnels through try/except; the writer swallows OSError.
    expect(addon).toContain("def request(flow):\n    _log(flow)\n    try:");
    expect(addon).toContain("def response(flow):\n    try:");
    expect(addon).toContain("def error(flow):\n    try:");
    expect(addon).toContain("except OSError:\n        pass");
  });
});
