import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // P1 toolcall telemetry defaults ON in production, but the suite must
    // never append to the user's real ~/.apple-debug-mcp/toolcalls.jsonl.
    // Tests covering the telemetry set SIM_MCP_TOOLCALLS_FILE to a tmp dir
    // explicitly (see test/tool-metadata.test.ts). Same for LW0 boot
    // telemetry (see test/boot-telemetry.test.ts).
    env: {
      SIM_MCP_TOOLCALLS: "0",
      SIM_MCP_BOOT_TELEMETRY: "0",
    },
  },
});
