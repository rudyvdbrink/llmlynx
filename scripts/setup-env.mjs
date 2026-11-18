// Prepares a checkout for the stack, so a new checkout or a deploy needs no
// hand work: it fills in the secrets that llmlynx needs in .env with random
// values, adds the SETTINGS that are missing with their values, and creates
// the directories the app's container mounts. It runs on
// npm install, npm run dev and npm run build, and in the deploy workflow before
// the images are built (docker compose reads the tokens from .env, and stops
// when the guard's token is missing). Run it by hand with:
//   node scripts/setup-env.mjs
//
// The directories (data/ and logs/) must exist before compose starts the app:
// compose would create them owned by root, and the app's container, which runs
// as uid 1000, could then not write its database. A directory moved elsewhere
// with DATA_DIR or LOGS_DIR is left to whoever set it.
//
// It never changes a value that is set. A secret or setting counts as set when
// it has a value in the environment, in .env or in .env.local. Compose reads
// .env only, so a value that is only in .env.local is copied to .env: the app and its
// container then keep the same one. A missing .env starts as a copy of
// .env.example, unless .env.local exists. Without .env.example (outside a
// checkout, such as in the Docker build, whose context leaves out .env*) it
// does nothing. It prints the names of what it added, never the values.
//
// A new container with a token: add the token to SECRETS.

import crypto from "node:crypto";
import fs from "node:fs";

// The secrets, and how each is encoded
const SECRETS = {
  // Encrypts the users' API keys (src/server/secrets.ts). Safe to create when
  // it is missing: without it no key can be saved, so no saved key is lost.
  SECRETS_KEY: "base64",
  GUARD_MCP_TOKEN: "hex",
  SEARCH_MCP_TOKEN: "hex",
  BROWSER_MCP_TOKEN: "hex",
  FILES_MCP_TOKEN: "hex",
  CODE_MCP_TOKEN: "hex",
  SEARXNG_SECRET: "hex",
};

// Settings that compose and the app both read, with the values llmlynx is set
// up for and the note that goes above one that is appended (see .env.example)
const SETTINGS = {
  CODE_PACKAGES_DOWNLOAD_GB: ["5", "Most one install of a chat's packages may download, in GB"],
  CODE_PACKAGES_INSTALLED_GB: ["10", "Most a chat's installed packages may take, in GB"],
  CODE_PACKAGES_EXPIRE_DAYS: ["7", "Days without use after which a chat's packages are removed"],
};

// Only the app reads these, which also finds them in .env.local
const APP_ONLY = new Set(["SECRETS_KEY"]);

// The directories docker-compose.yml mounts into the app's container, and the
// settings that move them
const MOUNTS = { DATA_DIR: "data", LOGS_DIR: "logs" };

// The user the app's container runs as (see Dockerfile)
const CONTAINER_UID = 1000;

const HEADER = "# --- Secrets added by scripts/setup-env.mjs";
const SETTINGS_HEADER = "# --- Settings added by scripts/setup-env.mjs";

/** The file's text, or null when it does not exist. */
function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** A value as dotenv reads it: without quotes or a trailing comment. */
function unquote(raw) {
  const value = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) return quoted[2];
  return value.replace(/\s+#.*$/, "").trim();
}

/** The last line that sets `name` (the one dotenv keeps), or null. */
function findSetting(lines, name) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = pattern.exec(lines[i]);
    if (match) return { index: i, value: unquote(match[1]) };
  }
  return null;
}

/**
 * The last commented-out placeholder for `name`, such as "# SEARCH_MCP_TOKEN=",
 * or -1. A commented value, such as an old key kept as a note, stays.
 */
function findPlaceholder(lines, name) {
  const pattern = new RegExp(`^\\s*#\\s*${name}\\s*=\\s*$`);
  return lines.findLastIndex((line) => pattern.test(line));
}

/** Creates the directories the app's container mounts that are missing, and tells who must own them. */
function createMounts(lines) {
  const created = [];
  for (const [name, dir] of Object.entries(MOUNTS)) {
    // Compose reads these from the environment and .env only
    const moved = process.env[name]?.trim() || findSetting(lines, name)?.value;
    if (moved || fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    created.push(dir);
  }
  if (!created.length) return;
  console.log(`setup-env: created ${created.join(", ")} for the app's container.`);
  if (process.platform !== "win32" && process.getuid() !== CONTAINER_UID) {
    console.log(`setup-env: the container runs as uid ${CONTAINER_UID}, which must own them: sudo chown ${CONTAINER_UID}:${CONTAINER_UID} ${created.join(" ")}`);
  }
}

function main() {
  const example = read(".env.example");
  if (example === null) return;
  const existing = read(".env");
  const local = read(".env.local");
  const text = existing ?? (local === null ? example : "");

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const localLines = (local ?? "").split(/\r?\n/);
  createMounts(lines);

  const generated = [];
  const copied = [];
  const added = [];
  const appended = { [HEADER]: [], [SETTINGS_HEADER]: [] };

  const entries = [
    ...Object.entries(SECRETS).map(([name, encoding]) => ({ name, value: () => crypto.randomBytes(32).toString(encoding) })),
    ...Object.entries(SETTINGS).map(([name, [value, note]]) => ({ name, value: () => value, note })),
  ];
  for (const { name, value, note } of entries) {
    const setting = findSetting(lines, name);
    if (process.env[name]?.trim() || setting?.value) continue;
    const fromLocal = findSetting(localLines, name)?.value;
    if (fromLocal && APP_ONLY.has(name)) continue;
    const line = `${name}=${fromLocal || value()}`;
    (fromLocal ? copied : note ? added : generated).push(name);

    // In the place .env.example gives it, when there is one
    const index = setting ? setting.index : findPlaceholder(lines, name);
    if (index >= 0) lines[index] = line;
    else if (note) appended[SETTINGS_HEADER].push(`# ${note}`, line);
    else appended[HEADER].push(line);
  }
  if (generated.length + copied.length + added.length === 0) return;

  for (const [header, block] of Object.entries(appended)) {
    if (!block.length) continue;
    if (lines.length && lines.at(-1).trim() !== "") lines.push("");
    if (!lines.includes(header)) lines.push(header);
    lines.push(...block);
  }
  // Only the owner may read a new .env; an existing one keeps its permissions
  fs.writeFileSync(".env", lines.join(eol) + eol, { mode: 0o600 });

  const done = [];
  if (generated.length) done.push(`generated ${generated.join(", ")}`);
  if (added.length) done.push(`added ${added.join(", ")}`);
  if (copied.length) done.push(`copied ${copied.join(", ")} from .env.local`);
  console.log(`setup-env: ${existing === null ? "created .env, " : ""}${done.join("; ")}.`);
  console.log("setup-env: running containers and the app use them once restarted (docker compose up -d).");
}

main();
