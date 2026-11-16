// Tests of scripts/setup-env.mjs, which fills in the missing secrets in .env and
// creates the directories the app's container mounts.
// Each test runs the script in a directory of its own, as npm and the deploy do.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "setup-env.mjs");
const NAMES = ["SECRETS_KEY", "GUARD_MCP_TOKEN", "SEARCH_MCP_TOKEN", "BROWSER_MCP_TOKEN", "FILES_MCP_TOKEN", "SEARXNG_SECRET"];

const EXAMPLE = [
  'DATABASE_URL="file:./dev.db"',
  "# SECRETS_KEY=",
  "# SEARCH_MCP_URL=http://127.0.0.1:8790/mcp",
  "# SEARCH_MCP_TOKEN=",
  "GUARD_MCP_TOKEN=",
  "",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmlynx-env-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(file: string, text: string) {
  fs.writeFileSync(path.join(dir, file), text);
}

function env(): string {
  return fs.readFileSync(path.join(dir, ".env"), "utf8");
}

/** Runs the script, without the settings of the test environment. */
function run(extra: Record<string, string> = {}) {
  const environment = { ...process.env, ...extra };
  for (const name of [...NAMES, "DATA_DIR", "LOGS_DIR"]) if (!(name in extra)) delete environment[name];
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: environment, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** The value of each line that sets `name` in .env. */
function values(name: string): string[] {
  return env()
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));
}

describe("setup-env", () => {
  it("creates .env from .env.example in a new checkout, with every secret filled in where the example has it", () => {
    write(".env.example", EXAMPLE);
    const output = run();

    const lines = env().split("\n");
    expect(lines[0]).toBe('DATABASE_URL="file:./dev.db"');
    expect(lines[1]).toMatch(/^SECRETS_KEY=[A-Za-z0-9+/]{43}=$/);
    expect(lines[2]).toBe("# SEARCH_MCP_URL=http://127.0.0.1:8790/mcp");
    expect(lines[3]).toMatch(/^SEARCH_MCP_TOKEN=[0-9a-f]{64}$/);
    expect(lines[4]).toMatch(/^GUARD_MCP_TOKEN=[0-9a-f]{64}$/);
    expect(Buffer.from(values("SECRETS_KEY")[0], "base64")).toHaveLength(32);
    for (const name of ["BROWSER_MCP_TOKEN", "FILES_MCP_TOKEN", "SEARXNG_SECRET"]) {
      expect(values(name)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    }
    expect(new Set(NAMES.map((name) => values(name)[0])).size).toBe(NAMES.length);

    expect(output).toContain("created .env");
    for (const name of NAMES) expect(output).not.toContain(values(name)[0]);
  });

  it("never changes a value that is set, and does nothing when nothing is missing", () => {
    write(".env.example", EXAMPLE);
    write(".env", 'GUARD_MCP_TOKEN="kept"\nSEARCH_MCP_TOKEN=kept # a comment\nBROWSER_MCP_TOKEN=\n# SECRETS_KEY=an-old-key\n');
    run();
    expect(values("GUARD_MCP_TOKEN")).toEqual(['"kept"']);
    expect(values("SEARCH_MCP_TOKEN")).toEqual(["kept # a comment"]);
    expect(values("BROWSER_MCP_TOKEN")).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(env()).toContain("# SECRETS_KEY=an-old-key\n");
    expect(values("SECRETS_KEY")).toHaveLength(1);

    const before = env();
    expect(run()).toBe("");
    expect(env()).toBe(before);
  });

  it("leaves out what the environment or .env.local sets, and copies the tokens compose needs from .env.local", () => {
    write(".env.example", EXAMPLE);
    write(".env", "DATABASE_URL=file:./dev.db\r\n");
    write(".env.local", "SECRETS_KEY=local-key\nFILES_MCP_TOKEN=local-token\n");
    const output = run({ GUARD_MCP_TOKEN: "from-the-environment" });

    expect(values("SECRETS_KEY")).toEqual([]);
    expect(values("GUARD_MCP_TOKEN")).toEqual([]);
    expect(values("FILES_MCP_TOKEN")).toEqual(["local-token"]);
    expect(output).toContain("copied FILES_MCP_TOKEN from .env.local");
    // Added at the end, with the file's own line endings
    expect(env()).toMatch(/^DATABASE_URL=file:\.\/dev\.db\r\n\r\n# --- Secrets added by scripts\/setup-env\.mjs\r\n/);
    expect(env().replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("starts a new .env with the secrets only when .env.local exists", () => {
    write(".env.example", EXAMPLE);
    write(".env.local", "DATABASE_URL=file:./other.db\n");
    run();
    expect(env()).not.toContain("DATABASE_URL");
    expect(values("GUARD_MCP_TOKEN")).toHaveLength(1);
  });

  it("creates the directories the app's container mounts, unless .env moves them", () => {
    write(".env.example", EXAMPLE);
    write(".env", "LOGS_DIR=/var/log/llmlynx\n");
    expect(run()).toContain("created data for the app's container");
    expect(fs.statSync(path.join(dir, "data")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(false);
  });

  it("does nothing outside a checkout, as in the Docker build", () => {
    expect(run()).toBe("");
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
