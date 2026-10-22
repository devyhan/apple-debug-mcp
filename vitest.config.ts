import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // P1 toolcall telemetry defaults ON in production, but the suite must
    // never append to the user's real ~/.apple-debug-mcp/toolcalls.jsonl.
    // Tests covering the telemetry set SIM_MCP_TOOLCALLS_FILE to a tmp dir
    // explicitly (see test/tool-metadata.test.ts).
    env: {
      SIM_MCP_TOOLCALLS: "0",
    },
  },
});
