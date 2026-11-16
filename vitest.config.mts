// Unit tests: npm test. The tests use a scratch SQLite database (see
// src/test/globalSetup.ts) and stand-ins for the scanners and the tool
// servers (src/test/fakes.ts), so they need no containers.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A directory of its own for this run, in the system's temporary directory
const databaseDir = path.join(os.tmpdir(), `llmlynx-test-${process.pid}`);

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: "./src/test/globalSetup.ts",
    // The test files share the scratch database
    fileParallelism: false,
    env: {
      DATABASE_URL: `file:${path.join(databaseDir, "test.db")}`,
      // Never called: the tests replace what talks to these (src/test/fakes.ts)
      GUARD_MCP_URL: "http://guard.test/mcp",
      GUARD_MCP_TOKEN: "test-token",
      CLAMAV_HOST: "clamd.test",
      FILES_MCP_URL: "http://files.test/mcp",
      SEARCH_MCP_URL: "http://search.test/mcp",
      BROWSER_MCP_URL: "http://browser.test/mcp",
    },
  },
});
